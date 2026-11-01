// dsh-ssh-toolkit — host-side Typert remote for the settings-page host editor.
// Settings are not exposed to configuration clients over the wire (the official
// gateway hard-whitelists namespaces — dsh-host-apiproxy/lib/index.js:888
// WEB_SETTINGS_NAMESPACES), so the whole host CRUD lives here:
//   - SshRemoteService: a Cordis Service under key 'ssh' carrying a visible
//     typertRemote binding (bindTypertRemote) — the gateway's validateBinding
//     requires exactly this shape (dsh-api-gateway/lib/index.js:282).
//   - ctx.typert.register(HOST_TYPERT_CONTRIBUTION): strict descriptors so the
//     gateway claims /api/ssh/{testConnection,listHosts,saveHost,deleteHost}
//     (claimsEndpoint) and dispatches to ctx.get('ssh').<method>(...).
// The unredacted stored hosts come from ctx.settings.get('dsh-ssh-hosts') so a
// password-auth host can be tested/saved even when the form left the password
// blank; listHosts redacts before the value leaves the process.
import { Service } from '@deepseek-ai/cordis';
import { bindTypertRemote } from '@deepseek-ai/dsh-typert-protocol';
import { SshError, HOST_KEY_UNKNOWN_STAGE, sshKeyFingerprint, sshKeyTypeFromBlob, appendKnownHost, defaultKnownHostsPath } from '../ssh/pool.js';
import { createPlaceholderDir, hostDisplayName, placeholderDisplayName, placeholderWorkspaceTitle } from '../workspace/placeholder.js';
import { encodeRemotePath, mapLocalToRemote } from '../workspace/router.js';
import { HOST_TYPERT_CONTRIBUTION, REMOTE_SERVICE, assertContributionShape } from './contract.js';
import { mergeTestConfig, mergeHostPatch, validateHostConfig, formatHostErrors, redactHosts, hostsSecretsList } from '../hosts/model.js';
import { readHostsDoc } from '../hosts/domain.js';
import { scanSshConfig as scanLocalSshConfig } from '../hosts/config-scan.js';

// ── TOFU host-side structured error surface ────────────────────────────────
// The gateway (dsh-api-gateway) serializes only the message of a thrown error
// (see rpcFailure: code/message/details), dropping structured fields
// (stage/fingerprint/rawKeyBase64 etc.). So host-key-unknown is always reported as
// a method return value, not thrown — testConnection already returns {ok:false,error};
// browsing methods (resolveRemoteHome/listRemoteDir) return the same shape on a
// connect-stage host-key-unknown, which the frontend uses to show the trust dialog.
function isHostKeyUnknown(err) {
  return err instanceof SshError && err.isHostKeyUnknown;
}
// Unified structured host-key-unknown return value (same fields as ssh-core's testConnection).
function hostKeyUnknownResult(err) {
  return {
    ok: false,
    stage: HOST_KEY_UNKNOWN_STAGE,
    hostId: err.hostId,
    host: err.host,
    port: err.port,
    fingerprint: err.fingerprint,
    rawKeyBase64: err.rawKeyBase64,
    keyType: err.keyType,
    message: err.message,
  };
}
// Try to connect with the stored cfg. Returns { result: 'host-key-unknown', ... } on
// a host-key-unknown, rethrows other errors, and { result: 'conn', conn } on success.
async function acquireStoredOrHostKeyUnknown(acquireFn, id) {
  try {
    const conn = await acquireFn(id);
    return { result: 'conn', conn };
  } catch (err) {
    if (isHostKeyUnknown(err)) return { result: 'host-key-unknown', err };
    throw err;
  }
}

/**
 * True when a stored title is one of the shapes this plugin auto-generated for a
 * placeholder workspace and can therefore be safely rewritten: the base64
 * segment, "basename · host" (older), or "host / basename" (previous). A title a
 * user typed themselves matches none of these and is preserved.
 * @param title current stored title.
 * @param remotePath absolute remote path of the placeholder.
 * @param hostName host display name (or host id) for the host-prefixed shapes.
 */
function isLegacyPlaceholderTitle(title, remotePath, hostName) {
  if (typeof title !== 'string' || title.length === 0) return false;
  const base = remotePath.split('/').filter(Boolean).pop() || 'root';
  return title === encodeRemotePath(remotePath)
    || title === hostName + ' / ' + base
    || title === base + ' · ' + hostName;
}

// Reachability cache for the sidebar dots. The client polls every 20s and this
// window is deliberately longer than one poll: an idle sidebar then dials each
// host about once a minute instead of every tick, and a slow/offline host is
// never redialed while its last result is still fresh.
const PRESENCE_TTL_MS = 45_000;

export class SshRemoteService extends Service {
  constructor(ctx, sshPool) {
    super(ctx, REMOTE_SERVICE);
    this.typertRemote = bindTypertRemote(this, REMOTE_SERVICE);
    this.sshPool = sshPool;
    this.resolveStored = () => undefined;
    this.hostsTable = null; // opened dsh-ssh-hosts `hosts` table — set inside ctx.inject
    // workspaceRegistry resolved lazily (defaults to Cordis ctx.get; a test can inject a stub).
    // A placeholder workspace record's title must be written explicitly at creation
    // (the official workspace.create wire carries no title).
    this.resolveWorkspaceRegistry = () => this.ctx?.get?.('workspaceRegistry');
    this.env = process.env; // environment for placeholder-root resolution (DSH_SSH_REMOTE_ROOT > DSH_HOME > ~/.dsh); injectable in tests
    // Sidebar presence probes: cached per host id (see workspacePresence) and
    // de-duplicated so overlapping polls never open parallel connections.
    this.presenceCache = new Map(); // hostId → { at, status }
    this.presenceInflight = new Map(); // hostId → Promise<'online' | 'offline'>
    this.titlesMigrated = false; // one legacy auto-title pass per process (first presence poll)
  }

  /** Inject-time hook: supply the stored-host lookup (domain access is only safe inside ctx.inject). */
  setStoredResolver(fn) {
    this.resolveStored = typeof fn === 'function' ? fn : () => undefined;
  }

  /** Inject-time hook: supply the opened domain `hosts` table for CRUD reads/writes. */
  setHostsTable(table) {
    this.hostsTable = table && typeof table.entries === 'function' ? table : null;
  }

  /** The stored (unredacted) HostConfig for one host id, or undefined. */
  getStoredHost(id) {
    if (!id || !this.hostsTable) return undefined;
    try {
      return this.hostsTable.get(String(id)) ?? undefined;
    } catch {
      return undefined;
    }
  }

  /** Inject-time hook: supply the workspaceRegistry lookup (defaults to lazy ctx.get). */
  setWorkspaceRegistry(fn) {
    this.resolveWorkspaceRegistry = typeof fn === 'function' ? fn : () => undefined;
  }

  /** Current hosts state: resolved dict (UNREDACTED) and writability. */
  readState() {
    const { hosts } = readHostsDoc(this.hostsTable);
    // The domain form serializes writes itself and has no namespace revision;
    // listHosts keeps the `revision` field (always 0) so the existing client
    // contract and its optimistic-concurrency code path stay wire-compatible.
    return { hosts, revision: 0, writable: true };
  }

  /** Map a storage write rejection to a clear, wire-safe error. */
  wrapWriteError(error, verb) {
    const raw = error instanceof Error ? error : error && typeof error === 'object' ? error : { message: String(error) };
    const text = String(raw.message ?? '');
    return new Error(verb + '失败: ' + text);
  }

  /**
   * Test a connection. request = { cfg: partial HostConfig }. Secret/auth
   * gaps are filled from the stored (unredacted) settings value when present.
   * @returns { ok: true, banner? } | { ok: false, error }  (SshPool.testConnection)
   */
  testConnection(request) {
    const req = request && typeof request === 'object' ? request : {};
    const cfg = req.cfg && typeof req.cfg === 'object' ? req.cfg : {};
    let stored;
    try {
      stored = this.resolveStored(cfg.id) ?? undefined;
    } catch {
      stored = undefined;
    }
    return this.sshPool.testConnection(mergeTestConfig(cfg, stored));
  }

  /**
   * List hosts for the editor: REDACTED dict + revision (optimistic
   * concurrency for saveHost/deleteHost) + secrets + writability.
   * @returns { hosts: {id: redacted HostConfig}, secrets: [{path, set}], revision, writable }
   */
  listHosts() {
    const { hosts, revision, writable } = this.readState();
    return { hosts: redactHosts(hosts), secrets: hostsSecretsList(hosts), revision, writable };
  }

  /**
   * Discover hosts already configured for the local OpenSSH client
   * (~/.ssh/config, ~/.ssh/config.d/* and Include files). VS Code's Remote-SSH
   * extension reads the same file, so this is the "import what I already have"
   * source for the settings page. Read-only; never throws for a missing file.
   * @returns { sources: string[], hosts: [{alias,host,port,user,identityFile,proxyJump}], errors: string[] }
   */
  async scanSshConfig() {
    const result = await scanLocalSshConfig();
    return { sources: result.sources, hosts: result.hosts, errors: result.errors };
  }

  /**
   * Create or update one host. Positional wire args (Typert dispatch order):
   *   id     the host id the entry is written under (authoritative).
   *   patch  the form HostConfig (auth.password present ONLY when the user
   *          typed a new one; omitted/blank = keep the stored secret).
   *   revision  the settings revision listHosts returned — optimistic
   *          concurrency: a namespace that moved past it rejects the write
   *          with SETTINGS_CONFLICT so the client can prompt a refresh.
   * The patch is merged over the stored entry with the write-only-password
   * semantics (blank = keep stored; switch to key = clear), re-validated
   * host-side (remote values are not trusted), then written as one settings
   * mutate set-op. @returns { ok: true }
   */
  async saveHost(id, patch, revision) {
    const hostId = id != null ? String(id) : '';
    if (!hostId) throw new Error('saveHost: host id is required');
    const table = this.hostsTable;
    if (!table) throw new Error('saveHost: storage unavailable');
    const current = this.getStoredHost(hostId);
    const next = mergeHostPatch(current, patch, hostId);
    const checked = validateHostConfig(next);
    if (!checked.ok) throw new Error('saveHost: 主机配置无效 (' + formatHostErrors(checked.errors) + ')');
    try {
      await table.put(hostId, { ...next, id: hostId });
    } catch (error) {
      throw this.wrapWriteError(error, '保存主机');
    }
    return { ok: true };
  }

  /**
   * Delete one host entry (settings mutate unset of ['hosts', id]). Missing
   * ids are idempotent. revision is the same optimistic-concurrency guard as
   * saveHost. @returns { ok: true }
   */
  async deleteHost(id, revision) {
    const hostId = id != null ? String(id) : '';
    if (!hostId) throw new Error('deleteHost: host id is required');
    const table = this.hostsTable;
    if (!table) throw new Error('deleteHost: storage unavailable');
    if (this.getStoredHost(hostId) === undefined) return { ok: true };
    try {
      await table.delete(hostId);
    } catch (error) {
      throw this.wrapWriteError(error, '删除主机');
    }
    return { ok: true };
  }

  // ---------- Remote directory browsing + placeholder creation ----------
  // Connection endpoints resolve the STORED (unredacted) HostConfig and reuse the
  // connection pool; failures become SshError.
  async _acquireStored(hostId) {
    const id = hostId != null ? String(hostId) : '';
    if (!id) throw new SshError({ hostId: id, stage: 'resolve-host', message: 'host id is required' });
    const cfg = this.resolveStored(id);
    if (!cfg || typeof cfg !== 'object') {
      throw new SshError({ hostId: id, stage: 'resolve-host', message: 'remote host "' + id + '" is not configured in dsh-ssh-hosts' });
    }
    return this.sshPool.acquire({ ...cfg, id });
  }

  /**
   * List a remote directory. request = { hostId, path } (wire positional args hostId, path).
   * @returns DirEntry[] = [{ name, type: 'dir'|'file'|'link'|'other', size?, mtime? }],
   *   sorted directories-first then by name.
   */
  async listRemoteDir(hostId, path) {
    const id = hostId != null ? String(hostId) : '';
    const target = typeof path === 'string' ? path : '';
    if (!target) throw new SshError({ hostId: id, stage: 'sftp-readdir', message: 'listRemoteDir: remote path is required' });
    const aq = await acquireStoredOrHostKeyUnknown((h) => this._acquireStored(h), id);
    if (aq.result === 'host-key-unknown') return hostKeyUnknownResult(aq.err); // TOFU: return a value, not throw (the gateway drops structured fields)
    const conn = aq.conn;
    const fs = await conn.fs();
    const entries = await fs.listDir(target);
    return entries
      .map((e) => ({ name: e.name, type: e.type, size: e.size, mtime: e.mtime }))
      .sort((a, b) => {
        const ad = a.type === 'dir' ? 0 : 1;
        const bd = b.type === 'dir' ? 0 : 1;
        if (ad !== bd) return ad - bd;
        return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
      });
  }

  /**
   * Metadata for a single remote path. request = { hostId, path }.
   * @returns { type: 'directory'|'file'|'other', size?, mtime? } | null (missing).
   * Does not use SftpWrapper.stat — it discards mtime; this reads the raw handle
   * (ssh-core's SftpWrapper exposes this.sftp, an existing API surface).
   */
  async statRemote(hostId, path) {
    const id = hostId != null ? String(hostId) : '';
    const target = typeof path === 'string' ? path : '';
    if (!target) throw new SshError({ hostId: id, stage: 'sftp-stat', message: 'statRemote: remote path is required' });
    const aq = await acquireStoredOrHostKeyUnknown((h) => this._acquireStored(h), id);
    if (aq.result === 'host-key-unknown') return hostKeyUnknownResult(aq.err); // TOFU: return a value, not throw
    const conn = aq.conn;
    // Use conn.fs() uniformly (SFTP or exec fallback) and fs.stat directly (carries mtime; missing → undefined).
    const fs = await conn.fs();
    const st = await fs.stat(target);
    return st === undefined ? null : st;
  }

  /**
   * The remote login user's $HOME (exec echo $HOME). request = { hostId }.
   * @returns home absolute path string.
   */
  async resolveRemoteHome(hostId) {
    const id = hostId != null ? String(hostId) : '';
    const aq = await acquireStoredOrHostKeyUnknown((h) => this._acquireStored(h), id);
    if (aq.result === 'host-key-unknown') return hostKeyUnknownResult(aq.err); // TOFU: return a value, not throw
    const conn = aq.conn;
    const r = await conn.exec('echo $HOME', { timeoutMs: 15_000 });
    if (r.code !== 0) {
      throw new SshError({ hostId: id, stage: 'exec', message: 'resolveRemoteHome failed: exit ' + r.code + ': ' + r.stderr.trim() });
    }
    const home = r.stdout.trim();
    if (!home || !home.startsWith('/')) {
      throw new SshError({ hostId: id, stage: 'exec', message: 'resolveRemoteHome: unexpected $HOME value ' + JSON.stringify(home) });
    }
    return home;
  }

  /**
   * Save trust for a host key the user confirmed (TOFU trust-save): append it to
   * known_hosts. Inputs (passed back verbatim from what the frontend captured on
   * failure) are hostId + rawKeyBase64 + fingerprint.
   * TOCTOU guard: the key appended must be the exact one the user saw in the dialog —
   * the host never re-handshakes to fetch the key; before writing, the raw key's
   * fingerprint is checked against the confirmed fingerprint, and a mismatch is rejected.
   * The path is host.knownHostsPath || defaultKnownHostsPath() (same as connect).
   * appendKnownHost makes it idempotent (no duplicate when host+keytype+key exists).
   * @returns { ok: true, path, appended, keyType }
   */
  async trustHostKey(hostId, rawKeyBase64, fingerprint) {
    const id = hostId != null ? String(hostId) : '';
    const cfg = this.resolveStored(id);
    if (!cfg || typeof cfg !== 'object') {
      throw new Error('trustHostKey: remote host "' + id + '" is not configured in dsh-ssh-hosts');
    }
    if (typeof rawKeyBase64 !== 'string' || rawKeyBase64 === '') {
      throw new Error('trustHostKey: raw host key is required');
    }
    let key;
    try { key = Buffer.from(rawKeyBase64, 'base64'); } catch { key = Buffer.alloc(0); }
    if (!key || key.length === 0) throw new Error('trustHostKey: invalid raw host key');
    // Fingerprint recheck: refuse a key whose fingerprint differs from the confirmed
    // one, preventing a tampered/miswritten key from landing on disk.
    const computed = sshKeyFingerprint(key);
    if (typeof fingerprint === 'string' && fingerprint !== '' && computed !== fingerprint) {
      throw new Error('trustHostKey: fingerprint does not match the confirmed key (refuse to write)');
    }
    const keyType = sshKeyTypeFromBlob(key) || 'ssh-unknown';
    const path = cfg.knownHostsPath || defaultKnownHostsPath();
    const res = await appendKnownHost(path, cfg.host, cfg.port ?? 22, keyType, rawKeyBase64, { hostId: id });
    return { ok: true, path, appended: res.appended, keyType };
  }

  /**
   * Create the local placeholder directory for a remote directory (purely local, no connect).
   * request = { hostId, remotePath }. Validates that hostId exists in dsh-ssh-hosts;
   * encodes with src/router.js mapRemoteToLocal (root =
   * <DSH_SSH_REMOTE_ROOT | $DSH_HOME || ~/.dsh>/remote), fs.mkdir recursive creates the
   * real directory; idempotent when it already exists. @returns { localPath, hostId, remotePath }.
   *
   * The placeholder workspace record's title is written as host display name / basename
   * (e.g. ubuntu / my-project) so the sidebar can distinguish hosts. The official
   * workspace.create wire only accepts { path } (dsh-host-apiproxy
   * workspaceCreateRequestSchema) and defaults the title to the directory basename, which
   * for a placeholder is the base64-encoded segment (unreadable, e.g. L2hvbWUv...; the actual
   * placeholder directory name stays encoded — only the display title is overridden).
   * We go through workspaceRegistry.create(path, title) directly (explicit titles are not
   * required to be unique, matching the local same-name convention). When the official flow
   * later adopts the same path, resolveByPath hits the existing record (created:false) and
   * the title is preserved. Old-signature titles are upgraded idempotently: ① base64-encoded
   * segment, ② bare basename (no host marker); anything else (user-edited or already the new
   * format) is left alone. Because localPath is built by this plugin's mapRemoteToLocal, the
   * upgrade only touches placeholder workspace records, never ordinary local workspaces. When
   * the registry is unavailable, fall back to the old behavior (no record write).
   */
  async createPlaceholder(hostId, remotePath) {
    const id = hostId != null ? String(hostId) : '';
    const target = typeof remotePath === 'string' ? remotePath : '';
    const { hosts } = this.readState();
    if (!Object.prototype.hasOwnProperty.call(hosts, id)) {
      throw new SshError({ hostId: id, stage: 'placeholder', message: 'createPlaceholder: remote host "' + id + '" is not configured in dsh-ssh-hosts' });
    }
    if (!target.startsWith('/')) {
      throw new SshError({ hostId: id, stage: 'placeholder', message: 'createPlaceholder: remote path must be absolute' });
    }
    try {
      const result = await createPlaceholderDir({ hostId: id, remotePath: target, env: this.env });
      const registry = this.resolveWorkspaceRegistry();
      if (registry && typeof registry.create === 'function') {
        // Title = bare remote basename. The host is not part of the name any more:
        // the sidebar draws it as a separate chip from ssh/workspacePresence, so
        // "host / project" would print the host twice. This is also the idempotent
        // upgrade target for auto-generated legacy titles (base64 segment,
        // "basename · host", "host / basename"); a user-edited title is left alone.
        // create() returns the existing entity when the path already has a record; because
        // localPath is built by this plugin's mapRemoteToLocal (placeholder-root/<hostId>/<base64>),
        // the upgrade only touches placeholder workspace records, never ordinary local workspaces.
        const title = placeholderWorkspaceTitle(target);
        const entity = await registry.create(result.localPath, title);
        if (entity && typeof entity.setTitle === 'function') {
          const legacy = typeof entity.title === 'string' ? entity.title : '';
          if (isLegacyPlaceholderTitle(legacy, target, hostDisplayName(hosts, id)) && legacy !== title) {
            await entity.setTitle(title);
          }
        }
      }
      return result;
    } catch (err) {
      if (err instanceof SshError) throw err;
      throw new SshError({ hostId: id, stage: 'placeholder', message: 'createPlaceholder: ' + (err?.message ?? String(err)), cause: err });
    }
  }

  // ---------- Sidebar presence (online / offline dots) ----------
  /**
   * Remote workspace health for the sidebar dots.
   *
   * Workspaces whose path is a placeholder (`<root>/<hostId>/<base64url>`, see
   * src/workspace/router.js) are mapped back to their host through the
   * reversible router, then each distinct host is probed once. A failed probe
   * (unreachable, auth rejected, unknown host key) is reported as "offline"
   * instead of thrown, so one dead host never blanks the whole list. Hosts that
   * are no longer configured are skipped — their rows get no dot.
   * @returns { states: [{ workspaceId, hostId, remotePath, status: 'online'|'offline' }] }
   */
  async workspacePresence() {
    const registry = this.resolveWorkspaceRegistry();
    if (!registry || typeof registry.list !== 'function') return { states: [] };
    let entities;
    try {
      entities = registry.list();
    } catch {
      return { states: [] };
    }
    // One-time upgrade of the old auto titles (host baked into the name) to the
    // bare basename; the chip now carries the host. Fire-and-forget: this poll
    // still reports the old titles, the next one shows the migrated names.
    if (!this.titlesMigrated) {
      this.titlesMigrated = true;
      this.migratePlaceholderTitles(entities).catch(() => {});
    }
    const states = [];
    for (const entity of Array.isArray(entities) ? entities : []) {
      const localPath = entity && typeof entity.path === 'string' ? entity.path : '';
      let mapped;
      try {
        mapped = mapLocalToRemote(localPath, this.env);
      } catch {
        mapped = null;
      }
      if (!mapped) continue;
      let cfg;
      try {
        cfg = this.resolveStored(mapped.hostId);
      } catch {
        cfg = undefined;
      }
      if (!cfg || typeof cfg !== 'object') continue;
      const hostName = typeof cfg.name === 'string' && cfg.name.trim().length > 0 ? cfg.name.trim() : mapped.hostId;
      states.push({ workspaceId: String(entity.id ?? ''), hostId: mapped.hostId, hostName, remotePath: mapped.remotePath });
    }
    const hostIds = [...new Set(states.map((state) => state.hostId))];
    const probed = await Promise.all(hostIds.map((hostId) => this.probeHostPresence(hostId)));
    const statusOf = new Map(hostIds.map((hostId, index) => [hostId, probed[index]]));
    return {
      states: states.map((state) => ({ ...state, status: statusOf.get(state.hostId) ?? 'offline' })),
    };
  }

  /**
   * Rewrite legacy auto-generated placeholder titles to the bare basename.
   *
   * Older releases encoded the host into the title ("host / project" or
   * "project · host") because the sidebar had no chip. The host is metadata now,
   * so leaving it in the name would print it twice. Only exact auto shapes are
   * touched (see isLegacyPlaceholderTitle); anything the user typed is kept.
   * @param entities workspace registry entities (registry.list()).
   * @returns number of titles rewritten.
   */
  async migratePlaceholderTitles(entities) {
    if (!Array.isArray(entities)) return 0;
    let renamed = 0;
    for (const entity of entities) {
      if (!entity || typeof entity.setTitle !== 'function' || typeof entity.path !== 'string') continue;
      let mapped;
      try {
        mapped = mapLocalToRemote(entity.path, this.env);
      } catch {
        mapped = null;
      }
      if (!mapped) continue;
      let cfg;
      try {
        cfg = this.resolveStored(mapped.hostId);
      } catch {
        cfg = undefined;
      }
      if (!cfg || typeof cfg !== 'object') continue;
      const hostName = typeof cfg.name === 'string' && cfg.name.trim().length > 0 ? cfg.name.trim() : mapped.hostId;
      const title = typeof entity.title === 'string' ? entity.title : '';
      const base = placeholderDisplayName(mapped.remotePath);
      if (title !== base && isLegacyPlaceholderTitle(title, mapped.remotePath, hostName)) {
        try {
          await entity.setTitle(base);
          renamed += 1;
        } catch {
          // A failed rename is harmless: the row still renders (host chip + old title).
        }
      }
    }
    return renamed;
  }

  /**
   * One cached reachability probe for a host. Result reuse window is
   * PRESENCE_TTL_MS; concurrent callers share one in-flight connection so a
   * slow/offline host is never dialed twice in parallel.
   * @param hostId configured host id.
   * @returns 'online' when the SSH banner/auth round-trip succeeds, else 'offline'.
   */
  async probeHostPresence(hostId) {
    const cached = this.presenceCache.get(hostId);
    if (cached && Date.now() - cached.at < PRESENCE_TTL_MS) return cached.status;
    const inflight = this.presenceInflight.get(hostId);
    if (inflight !== undefined) return inflight;
    const probe = (async () => {
      let status = 'offline';
      try {
        const cfg = this.resolveStored(hostId);
        if (cfg && typeof cfg === 'object') {
          const result = await this.sshPool.testConnection(mergeTestConfig({ id: hostId }, cfg));
          status = result && result.ok === true ? 'online' : 'offline';
        }
      } catch {
        status = 'offline';
      }
      this.presenceCache.set(hostId, { at: Date.now(), status });
      return status;
    })();
    this.presenceInflight.set(hostId, probe);
    try {
      return await probe;
    } finally {
      if (this.presenceInflight.get(hostId) === probe) this.presenceInflight.delete(hostId);
    }
  }
}

/**
 * Register the remote service + typert contribution on a host ctx that already
 * owns the sshPool service. The typert registry and the hosts domain table are
 * reached through ctx.inject so activation never blocks on them.
 */
export function registerRemote(ctx, sshPool) {
  const service = new SshRemoteService(ctx, sshPool);
  ctx.inject(['typert'], (scope) => {
    // Fail fast on a malformed contribution instead of a silent gateway miss.
    assertContributionShape(HOST_TYPERT_CONTRIBUTION);
    scope.typert.register(HOST_TYPERT_CONTRIBUTION);
    scope.logger?.info('[dsh-ssh-toolkit] typert remote ' + HOST_TYPERT_CONTRIBUTION.package
      + ' registered (ssh/testConnection, ssh/listHosts, ssh/saveHost, ssh/deleteHost,'
      + ' ssh/listRemoteDir, ssh/statRemote, ssh/resolveRemoteHome, ssh/createPlaceholder, ssh/trustHostKey,'
      + ' ssh/workspacePresence)');
  });
  return service;
}
