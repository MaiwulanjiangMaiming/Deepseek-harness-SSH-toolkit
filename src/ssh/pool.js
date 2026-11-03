// dsh-ssh-toolkit — SSH connection core.
// Plain ESM, depends only on ssh2. Provides:
//   SshError, shellQuoteSingle/buildRemoteCommand, known_hosts helpers,
//   SshConn (exec / execStream / sftp), SshPool (acquire/release/invalidate/testConnection/dispose).
import { Client } from 'ssh2';
import { createHmac, createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { Duplex } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import { ExecFs } from './exec-fs.js'; // exec+base64 fallback used when SFTP is disabled

// TOFU structured error stage: when the hostVerifier hits 'unknown', the SshError
// carries this stage plus fingerprint/rawKeyBase64/keyType for the frontend dialog
// to show the fingerprint and save trust.
export const HOST_KEY_UNKNOWN_STAGE = 'host-key-unknown';

export class SshError extends Error {
  constructor({ hostId, stage, message, cause, host, port, fingerprint, rawKeyBase64, keyType }) {
    super(message);
    this.name = 'SshError';
    this.hostId = hostId ?? '';
    this.stage = stage ?? 'unknown';
    if (host !== undefined) this.host = host;
    if (port !== undefined) this.port = port;
    if (fingerprint !== undefined) this.fingerprint = fingerprint;
    if (rawKeyBase64 !== undefined) this.rawKeyBase64 = rawKeyBase64;
    if (keyType !== undefined) this.keyType = keyType;
    if (cause !== undefined) this.cause = cause;
  }

  // Hitting 'unknown' (not 'mismatch') is the trustable path (TOFU).
  get isHostKeyUnknown() { return this.stage === HOST_KEY_UNKNOWN_STAGE; }

  // Explicit JSON serialization so structured fields survive in-process JSON round-trips (wire/debug).
  toJSON() {
    const out = { name: this.name, message: this.message, hostId: this.hostId, stage: this.stage };
    if (this.host !== undefined) out.host = this.host;
    if (this.port !== undefined) out.port = this.port;
    if (this.fingerprint !== undefined) out.fingerprint = this.fingerprint;
    if (this.rawKeyBase64 !== undefined) out.rawKeyBase64 = this.rawKeyBase64;
    if (this.keyType !== undefined) out.keyType = this.keyType;
    return out;
  }
}

function isNotConnectedError(err) {
  const msg = err?.message ?? String(err);
  return msg.includes('Not connected');
}

// ---------- command assembly (single-quote escape: ' -> '\'' ) ----------
export function shellQuoteSingle(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

export function buildRemoteCommand(cmd, cwd) {
  return cwd ? "cd " + shellQuoteSingle(cwd) + " && " + cmd : cmd;
}

// ---------- known_hosts ----------
// Line: [marker] hostpat keytype base64key [comment]; hostpat = host | host:port | [host]:port | hashed | wildcard.
// Supports exact host/port match plus OpenSSH hashed entries (|1|<saltB64>|<hashB64>,
// HashKnownHosts yes). Wildcard host patterns remain unsupported (documented).
export function parseKnownHosts(text) {
  const entries = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    let i = 0;
    let marker;
    if (parts[i] === '@cert-authority' || parts[i] === '@revoked') marker = parts[i++];
    const hostPat = parts[i++];
    const keyType = parts[i++];
    const key = parts[i++];
    if (!hostPat || !keyType || !key) continue;
    const entry = { marker, hostPat, keyType, key };
    // hashed hostpat: |1|<saltB64>|<hashB64> — OpenSSH host_hash = HMAC-SHA1(salt, host)
    if (hostPat.startsWith('|')) {
      const seg = hostPat.split('|'); // ['', '1', salt, hash]
      if (seg[1] === '1' && seg[2] && seg[3]) {
        entry.hashed = true;
        entry.hashedSalt = seg[2];
        entry.hashedHash = seg[3];
      }
    }
    entries.push(entry);
  }
  return entries;
}

export function knownHostsPatterns(host, port) {
  const patterns = [host];
  if (port && port !== 22) patterns.push('[' + host + ']:' + port);
  return patterns;
}

// key: raw host key Buffer (ssh2 hostVerifier input). Returns 'match' | 'mismatch' | 'unknown'.
export function checkHostKey(host, port, key, entries) {
  const patterns = knownHostsPatterns(host, port);
  const b64 = key.toString('base64');
  let seen = false;
  for (const e of entries) {
    if (e && e.hashed) {
      // OpenSSH hashed host: digest = HMAC-SHA1(key=salt, msg=host), stored base64.
      const digest = createHmac('sha1', Buffer.from(e.hashedSalt, 'base64')).update(host).digest('base64');
      if (digest === e.hashedHash) {
        seen = true;
        if (e.key === b64) return 'match';
      }
      continue;
    }
    if (!patterns.includes(e.hostPat)) continue;
    seen = true;
    if (e.key === b64) return 'match';
  }
  return seen ? 'mismatch' : 'unknown';
}

// OpenSSH-style SHA256 fingerprint: base64(SHA256(rawKey)) without trailing '=' padding,
// prefixed "SHA256:" (matches ssh-keygen -lf).
export function sshKeyFingerprint(key) {
  const b64 = createHash('sha256').update(key).digest('base64');
  return 'SHA256:' + b64.replace(/=+$/, '');
}

// Parse the algorithm name from the first field of an SSH public-key blob:
// <uint32 len><algo bytes><...>. Returns '' on failure.
export function sshKeyTypeFromBlob(key) {
  try {
    if (!Buffer.isBuffer(key) || key.length < 5) return '';
    const len = key.readUInt32BE(0);
    if (len <= 0 || 4 + len > key.length) return '';
    return key.toString('utf8', 4, 4 + len);
  } catch {
    return '';
  }
}

// Throws SshError on mismatch (hard reject, stage 'verify-host-key'; v1 offers no
// "still trust" override) or — unless acceptNew — on unknown, in which case the stage
// is 'host-key-unknown' with host/port/fingerprint/rawKeyBase64/keyType set for the
// frontend TOFU dialog.
export function verifyHostKey(host, port, key, entries, opts = {}) {
  const v = checkHostKey(host, port, key, entries);
  const where = opts.knownHostsPath ? ' (' + opts.knownHostsPath + ')' : '';
  if (v === 'match') return;
  if (v === 'unknown' && opts.acceptNew) return; // dev/test fallback only
  const addr = host + ':' + (port ?? 22);
  if (v === 'unknown') {
    throw new SshError({
      hostId: opts.hostId ?? '',
      stage: HOST_KEY_UNKNOWN_STAGE,
      message: 'unknown host key for ' + addr + where,
      host,
      port: port ?? 22,
      fingerprint: sshKeyFingerprint(key),
      rawKeyBase64: key.toString('base64'),
      keyType: sshKeyTypeFromBlob(key),
    });
  }
  // mismatch: stay a hard reject (current stage; no fingerprint/rawKey; no trust option)
  throw new SshError({
    hostId: opts.hostId ?? '',
    stage: 'verify-host-key',
    message: 'host key mismatch for ' + addr + where,
  });
}

// ssh2 hostVerifier: records rejection reason on connState for surfacing as SshError.
export function makeHostVerifier(connState, opts) {
  return (key, verify) => {
    let err = null;
    try { verifyHostKey(opts.host, opts.port, key, opts.entries, opts); }
    catch (e) { err = e; }
    connState.verifyError = err;
    verify(err == null);
  };
}

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

// OpenSSH default known_hosts path: ~/.ssh/known_hosts (os.homedir() resolves on Windows).
// Single source of truth for settings.js HostConfigSchema.knownHostsPath's default.
export function defaultKnownHostsPath() {
  return path.join(os.homedir(), '.ssh', 'known_hosts');
}

// Build one known_hosts line (no newline): <hostpat> <keytype> <base64>.
// hostpat uses the non-default-port form from knownHostsPatterns ([host]:port or host), matching verification.
export function knownHostsLine(host, port, keyType, keyBase64) {
  const pats = knownHostsPatterns(host, port);
  return pats[pats.length - 1] + ' ' + keyType + ' ' + keyBase64;
}

// Append one user-confirmed host public key to known_hosts (TOFU trust-save path).
// Idempotent: does not re-append when host+keytype+key (plain entry) already exists;
// newline-safe (appends fine whether or not the file ends with a newline / is empty).
// Security: the caller must pass the exact key the user saw (the frontend returns the
// rawKeyBase64 captured on failure); the host never re-handshakes to fetch the key
// (avoids TOCTOU). keyType is derived from rawKey as a fallback.
// @returns { appended: boolean, path }
export async function appendKnownHost(path, host, port, keyType, keyBase64, opts = {}) {
  const fp = expandHome(path);
  let text = '';
  try {
    text = await readFile(fp, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') text = '';
    else {
      throw new SshError({
        hostId: opts.hostId ?? '',
        stage: 'trust-host-key',
        message: 'cannot read known_hosts ' + path + ': ' + err.message,
        cause: err,
      });
    }
  }
  const patterns = knownHostsPatterns(host, port);
  for (const e of parseKnownHosts(text)) {
    if (e && e.hashed) continue; // hashed entries cannot be compared as plaintext; skip
    if (patterns.includes(e.hostPat) && e.keyType === keyType && e.key === keyBase64) {
      return { appended: false, path };
    }
  }
  const line = knownHostsLine(host, port, keyType, keyBase64);
  const body = text.trim();
  const next = (body === '' ? '' : (text.endsWith('\n') ? text : text + '\n')) + line + '\n';
  await writeFile(fp, next, 'utf8');
  return { appended: true, path };
}

// ---------- SshConn ----------
export class SshConn {
  constructor(cfg = {}, options = {}) {
    this.id = cfg.id ?? '';
    this.cfg = cfg;
    this.options = options;
    this.client = null;
    this._ready = null;       // connect promise (idempotent)
    this._sftpPromise = null;
    this._sftpUnavailable = false; // whether SFTP probing failed on this connection (decided on first fs())
    this.verifyError = null;  // set by makeHostVerifier
    this._dead = false; // becomes true when the underlying ssh2 client emits close unexpectedly
    this.busy = 0; // in-flight exec/execStream calls; the pool never evicts a busy connection
    this.lastUsed = Date.now();
    this.isJump = false; // set when another host tunnels through this connection (never evict)
    this._isClosing = false; // true while dispose() is intentionally closing the client
    // Called when the ssh2 client dies unexpectedly (keepalive failure, network drop, remote close).
    // Marks the connection as dead and clears cached state so the next connect() can rebuild.
    // Ignored when the close was caused by an intentional dispose().
    this._onClose = () => {
      if (this._isClosing) return;
      this._dead = true;
      this.client = null;
      this._ready = null;
      this._sftpPromise = null;
      this._sftpUnavailable = false;
    };
  }

  get hostId() { return this.id; }

  // Clear cached state after a dead connection so the next connect() rebuilds from scratch.
  _resetDeadState() {
    this._dead = false;
    this._isClosing = false;
    this._ready = null;
    this.client = null;
    this._sftpPromise = null;
    this._sftpUnavailable = false;
    this.verifyError = null;
  }

  async _loadPrivateKey() {
    const auth = this.cfg.auth;
    if (auth && auth.type === 'key' && auth.privateKeyPath) return readFile(expandHome(auth.privateKeyPath));
    // No explicit identity: prefer the agent, but fall back to the standard
    // ~/.ssh identities. The desktop app is launched by launchd and often has no
    // SSH_AUTH_SOCK, which would otherwise leave key-auth hosts unusable.
    if (process.env.SSH_AUTH_SOCK) return undefined;
    const fallback = await defaultIdentity();
    return fallback === undefined ? undefined : readFile(fallback);
  }

  async _readKnownHosts() {
    const p = this.cfg.knownHostsPath || defaultKnownHostsPath();
    try { return parseKnownHosts(await readFile(expandHome(p), 'utf8')); }
    catch (err) {
      if (err && err.code === 'ENOENT') return []; // missing file = no records (same meaning as OpenSSH), not a config error
      if (this.cfg.acceptNew) return [];
      throw new SshError({ hostId: this.id, stage: 'known-hosts', message: 'cannot read known_hosts ' + p + ': ' + err.message, cause: err });
    }
  }

  async connect() {
    // Lazy reconnect: a dead connection clears its cached promise so the next call rebuilds.
    if (this._dead) this._resetDeadState();
    if (this._ready) return this._ready;
    this._ready = (async () => {
      try {
        return await this._connectInner();
      } catch (err) {
        // Keep the failure visible but allow a later retry: clear the rejected promise
        // when the error indicates the connection is dead.
        if (isNotConnectedError(err) || (err instanceof SshError && err.stage === 'not-connected')) {
          this._ready = null;
          this._dead = true;
        }
        // Unified error surface: bottom-level errors (private key / known_hosts reads) carry hostId/stage too
        if (err instanceof SshError) throw err;
        throw new SshError({ hostId: this.id, stage: 'connect', message: err?.message ?? String(err), cause: err });
      }
    })();
    return this._ready;
  }

  async _connectInner() {
      const entries = await this._readKnownHosts();
      const privateKey = await this._loadPrivateKey();
      const client = new Client();
      this.client = client;
      // Track intentional close to avoid marking dispose as a dead connection.
      this._isClosing = false;
      this._dead = false;
      const { host, port = 22, user } = this.cfg;
      const opts = {
        host, port, username: user,
        readyTimeout: this.cfg.connectTimeoutMs ?? 10_000,
        keepaliveInterval: this.cfg.keepaliveIntervalMs ?? 15_000,
        hostVerifier: makeHostVerifier(this, {
          host, port, entries,
          acceptNew: this.cfg.acceptNew,
          hostId: this.id,
          knownHostsPath: this.cfg.knownHostsPath,
        }),
      };
      if (typeof this.options.sock === 'function') opts.sock = await this.options.sock();
      const auth = this.cfg.auth;
      if (auth?.type === 'password') opts.password = auth.password;
      else if (privateKey) opts.privateKey = privateKey;
      if (process.env.SSH_AUTH_SOCK) opts.agent = process.env.SSH_AUTH_SOCK; // agent auth fallback
      await new Promise((resolve, reject) => {
        let settled = false;
        client.on('ready', () => { if (!settled) { settled = true; resolve(); } });
        client.on('error', (err) => {
          if (settled) return;
          settled = true;
          // When the hostVerifier rejects (unknown/mismatch), ssh2 only reports
          // "Host denied (verification failed)" — override with our own verify-host-key
          // category message so the user/UI sees the concrete reason. On unknown (TOFU)
          // the fingerprint/rawKeyBase64/keyType/host/port are carried out for the
          // frontend dialog to show the fingerprint and call trustHostKey.
          const vErr = this.verifyError;
          reject(new SshError({
            hostId: this.id,
            stage: vErr ? vErr.stage : 'connect',
            message: vErr ? vErr.message : err.message,
            cause: err,
            ...(vErr ? {
              host: vErr.host, port: vErr.port, fingerprint: vErr.fingerprint,
              rawKeyBase64: vErr.rawKeyBase64, keyType: vErr.keyType,
            } : {}),
          }));
        });
        client.connect(opts);
      });
      if (this.verifyError) { await this._close(); throw this.verifyError; }
      // Detect remote-initiated or keepalive-driven disconnects. ssh2 emits 'close'
      // for network failures, keepalive timeouts, and remote sshd closes; dispose()
      // sets _isClosing so the handler ignores intentional shutdowns.
      client.on('close', this._onClose);
      client.on('end', this._onClose);
      client.on('error', this._onClose);
      return this;
  }

  async _close() {
    if (this.client) {
      const c = this.client;
      // Mark intentional shutdown so the 'close' handler does not flag this as dead.
      this._isClosing = true;
      try { c.removeListener('close', this._onClose); } catch { /* noop */ }
      try { c.removeListener('end', this._onClose); } catch { /* noop */ }
      try { c.removeListener('error', this._onClose); } catch { /* noop */ }
      this.client = null;
      this._sftpPromise = null;
      this._sftpUnavailable = false; // reset the probe after reconnect (a fresh SshConn already resets; this is a safety net)
      try { c.end(); } catch { /* noop */ }
    } else {
      // Even without a client, clear dead state on explicit dispose so a later
      // connect starts clean.
      this._isClosing = true;
    }
    // Reset closing flag after the synchronous end() call; asynchronous 'close'
    // will be ignored due to listener removal, but keep flag for safety.
    this._isClosing = false;
    // Clear dead marker on intentional close so a subsequent connect rebuilds normally.
    this._dead = false;
    this._ready = null;
  }

  _ensureOpen() {
    if (!this.client) throw new SshError({ hostId: this.id, stage: 'not-connected', message: 'connection not open (host ' + (this.cfg.host ?? this.id) + ')' });
  }

  async _doExecChannel(cmd, opts = {}) {
    this._ensureOpen();
    const full = buildRemoteCommand(cmd, opts.cwd);
    const stream = await new Promise((resolve, reject) => {
      let s;
      try {
        // ssh2 throws "Not connected" synchronously when the connection is dead — wrap in SshError
        s = this.client.exec(full, (err, opened) => {
          if (err) reject(new SshError({ hostId: this.id, stage: 'exec-open', message: err.message, cause: err }));
          else resolve(opened);
        });
      } catch (err) {
        reject(new SshError({ hostId: this.id, stage: 'exec-open', message: err?.message ?? String(err), cause: err }));
      }
    });
    // Hold the connection out of the pool's eviction set until the channel closes;
    // a long exec must never be evicted to make room for another host.
    this.busy += 1;
    let released = false;
    const releaseBusy = () => {
      if (released) return;
      released = true;
      this.busy = Math.max(0, this.busy - 1);
      this.lastUsed = Date.now();
    };
    stream.once('close', releaseBusy);
    stream.once('error', releaseBusy);
    return stream;
  }

  async _execChannel(cmd, opts = {}) {
    try {
      await this.connect();
      return await this._doExecChannel(cmd, opts);
    } catch (err) {
      if (!isNotConnectedError(err)) throw err;
      // Transparent single retry: clear dead state, reconnect, and re-attempt once.
      // Streaming exec that has already started is not retried (caller handles mid-stream errors).
      this._dead = true;
      this._resetDeadState();
      try {
        await this.connect();
        return await this._doExecChannel(cmd, opts);
      } catch (err2) {
        throw new SshError({ hostId: this.id, stage: 'exec-open', message: 'reconnect failed after disconnect: ' + (err2?.message ?? String(err2)), cause: err2 });
      }
    }
  }

  async exec(cmd, opts = {}) {
    const stream = await this._execChannel(cmd, opts);
    const out = [];
    const errOut = [];
    let outBytes = 0;
    let errBytes = 0;
    const settled = await new Promise((resolve, reject) => {
      let done = false;
      const finish = (fn, value) => { if (done) return; done = true; if (timer) clearTimeout(timer); fn(value); };
      const timer = opts.timeoutMs
        ? setTimeout(() => {
            try { stream.close(); } catch { /* noop */ }
            finish(reject, new SshError({ hostId: this.id, stage: 'exec-timeout', message: 'exec timed out after ' + opts.timeoutMs + 'ms: ' + cmd }));
          }, opts.timeoutMs)
        : null;
      stream.on('data', (d) => {
        outBytes += d.length;
        if (opts.maxStdoutBytes !== undefined && outBytes > opts.maxStdoutBytes) {
          // Large-output guard: abort once output exceeds the bound (the tool layer maps
          // it to SEARCH_RAW_OUTPUT_OVERFLOW), preventing memory blowup.
          try { stream.close(); } catch { /* noop */ }
          finish(reject, new SshError({ hostId: this.id, stage: 'exec-output-overflow', message: 'exec output exceeded ' + opts.maxStdoutBytes + ' bytes: ' + cmd }));
          return;
        }
        out.push(d);
      });
      stream.stderr.on('data', (d) => {
        // Count stderr against the same bound: a command that floods stderr would
        // otherwise grow the host heap without limit.
        errBytes += d.length;
        if (opts.maxStdoutBytes !== undefined && outBytes + errBytes > opts.maxStdoutBytes) {
          try { stream.close(); } catch { /* noop */ }
          finish(reject, new SshError({ hostId: this.id, stage: 'exec-output-overflow', message: 'exec output exceeded ' + opts.maxStdoutBytes + ' bytes: ' + cmd }));
          return;
        }
        errOut.push(d);
      });
      stream.on('close', (c, sig) => finish(resolve, { code: c ?? -1, signal: sig ?? null }));
      stream.on('error', (e) => finish(reject, new SshError({ hostId: this.id, stage: 'exec', message: e.message, cause: e })));
    });
    return { code: settled.code, signal: settled.signal, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(errOut).toString('utf8') };
  }

  // Yields {stream:'stdout'|'stderr', chunk:Buffer}, then a final {exitCode:number}.
  async *execStream(cmd, opts = {}) {
    const stream = await this._execChannel(cmd, opts);
    const queue = [];
    let ended = false;
    let err = null;
    let exitCode = -1;
    let wake;
    const notify = () => { if (wake) { const w = wake; wake = undefined; w(); } };
    stream.on('data', (d) => { queue.push({ w: 'stdout', c: d }); notify(); });
    stream.stderr.on('data', (d) => { queue.push({ w: 'stderr', c: d }); notify(); });
    stream.on('error', (e) => { err = e; ended = true; notify(); });
    stream.on('close', (c) => { exitCode = c ?? -1; ended = true; notify(); });
    for (;;) {
      if (queue.length) { const it = queue.shift(); yield { stream: it.w, chunk: it.c }; continue; }
      if (ended) break;
      await new Promise((r) => { wake = r; if (queue.length || ended) { wake = undefined; r(); } });
    }
    if (err) throw new SshError({ hostId: this.id, stage: 'exec-stream', message: err.message, cause: err });
    yield { exitCode };
  }

  async _doSftpOpen() {
    this._ensureOpen();
    if (!this._sftpPromise) {
      this._sftpPromise = new Promise((resolve, reject) => {
        try {
          this.client.sftp((err, sftp) => {
            if (err) reject(new SshError({ hostId: this.id, stage: 'sftp-open', message: err.message, cause: err }));
            else resolve(sftp);
          });
        } catch (err) {
          // ssh2 throws "Not connected" synchronously when the connection is dead — wrap in SshError
          reject(new SshError({ hostId: this.id, stage: 'sftp-open', message: err?.message ?? String(err), cause: err }));
        }
      });
    }
    return new SftpWrapper(this, await this._sftpPromise);
  }

  async sftp() {
    try {
      await this.connect();
      return await this._doSftpOpen();
    } catch (err) {
      if (!isNotConnectedError(err)) throw err;
      this._dead = true;
      this._resetDeadState();
      try {
        await this.connect();
        return await this._doSftpOpen();
      } catch (err2) {
        throw new SshError({ hostId: this.id, stage: 'sftp-open', message: 'reconnect failed after disconnect: ' + (err2?.message ?? String(err2)), cause: err2 });
      }
    }
  }

  // Unified file-access entry. When SFTP is available -> SftpWrapper (byte-identical
  // behavior); when the SFTP subsystem is disabled / channel refused -> mark this
  // connection sftpAvailable=false and return ExecFs (exec channel + base64 fallback,
  // see exec-fs.js). Capability probing happens once on first call and is cached;
  // reconnects (pool.invalidate creates a fresh SshConn) reset it.
  // cfg.forceExecFs is a test switch that forces the exec fallback (for real no-sftp
  // simulation) without touching the remote sshd.
  async fs() {
    this.lastUsed = Date.now();
    await this.connect();
    this._ensureOpen();
    if (this.cfg.forceExecFs || this._sftpUnavailable) return new ExecFs(this);
    try {
      return await this.sftp();
    } catch (err) {
      // SFTP subsystem unavailable -> fall back; do not cache the failed sftp promise
      // (avoid later sftp() reusing a rejected promise).
      this._sftpUnavailable = true;
      this._sftpPromise = null;
      return new ExecFs(this);
    }
  }

  async dispose() { await this._close(); }
}

// Minimal SFTP wrapper over the ssh2 SFTPWrapper: readText/listDir plus raw-handle file IO.
export class SftpWrapper {
  constructor(conn, sftp) {
    this.conn = conn;
    this.sftp = sftp;
  }

  _wrap(err, stage, p) {
    return new SshError({ hostId: this.conn.hostId, stage, message: p + ': ' + err.message, cause: err });
  }

  readText(p) {
    return new Promise((resolve, reject) => {
      this.sftp.readFile(p, 'utf8', (err, data) => err ? reject(this._wrap(err, 'sftp-read', p)) : resolve(data));
    });
  }

  listDir(p) {
    return new Promise((resolve, reject) => {
      this.sftp.readdir(p, (err, list) => {
        if (err) return reject(this._wrap(err, 'sftp-readdir', p));
        resolve(list.map((e) => {
          const a = e.attrs;
          const type = typeof a.isDirectory === 'function' ? (a.isDirectory() ? 'dir' : a.isFile() ? 'file' : a.isSymbolicLink() ? 'link' : 'other') : 'other';
          return { name: e.filename, type, size: a.size, mtime: a.mtime };
        }));
      });
    });
  }

  // stat metadata; returns undefined when the target does not exist (ENOENT); other errors become SshError.
  stat(p) {
    return new Promise((resolve, reject) => {
      this.sftp.stat(p, (err, attrs) => {
        if (err) {
          if (err && (err.code === 2 || err.code === 'ENOENT')) return resolve(undefined);
          return reject(this._wrap(err, 'sftp-stat', p));
        }
        const type = typeof attrs.isDirectory === 'function'
          ? (attrs.isDirectory() ? 'directory' : attrs.isFile() ? 'file' : 'other')
          : 'other';
        resolve({ type, size: attrs.size, mtime: attrs.mtime });
      });
    });
  }

  // Read the whole file as raw bytes (the maxBytes bound is decided by the caller
  // after stat; this only does a full read).
  // Pipelined: several reads in flight concurrently, cutting throughput loss on
  // high-RTT links (a single readFile is a small-window serial round trip; ~1 MiB/s
  // on public internet; pipelining gives ~N×).
  // ssh2 raw-read contract: read(handle, buf, off, len, position, cb) →
  // cb(err, bytesRead, data, position). At EOF ssh2 swallows the EOF status (cb has
  // no err and bytesRead=0) and does not close the handle — this method closes it.
  // Completion of pipelined reads cannot rely on EOF: OpenSSH's sftp-server replies
  // EOF immediately (no disk IO) to a READ past the file end but does disk IO for a
  // valid-position READ, so responses arrive out of order (EOF before late data).
  // Slot assembly: each request occupies a slot (in issue order) and writes only its
  // own slot; once all in-flight requests settle, slots are concatenated in slot
  // order. No new requests are issued after EOF (0 bytes).
  readBytes(p, { pipeline = 16, chunk = 256 * 1024, offset: startOffset = 0, length } = {}) {
    return new Promise((resolve, reject) => {
      this.sftp.open(p, 'r', (err, handle) => {
        if (err) return reject(this._wrap(err, 'sftp-read', p));
        const slots = []; // idx → { buf, n }; assembled by request slot
        let offset = Math.max(0, Number(startOffset) || 0); // advanced as requests are issued
        const limit = length === undefined ? Infinity : offset + Math.max(0, Number(length) || 0);
        let pending = 0;
        let eofSeen = false;
        let done = false;
        let failed = false;
        const assemble = () => {
          const total = slots.reduce((a, s) => a + s.n, 0);
          const out = Buffer.allocUnsafe(total);
          let o = 0;
          for (const s of slots) {
            if (s.n > 0) { s.buf.copy(out, o, 0, s.n); o += s.n; }
          }
          return out;
        };
        const finish = () => {
          if (done) return;
          done = true;
          this.sftp.close(handle, () => resolve(assemble()));
        };
        const fail = (e) => {
          if (failed) return;
          failed = true;
          try { this.sftp.close(handle, () => {}); } catch { /* noop */ }
          reject(this._wrap(e, 'sftp-read', p));
        };
        const pump = () => {
          if (failed || done || eofSeen) return;
          while (pending < pipeline) {
            if (failed || done || eofSeen) break; // guards against an infinite loop under synchronous callbacks
            if (offset >= limit) { eofSeen = true; break; }
            const idx = slots.length;
            const buf = Buffer.allocUnsafe(chunk);
            slots.push({ buf, n: 0 });
            const pos = offset;
            const len = Math.min(chunk, limit - pos);
            offset += len;
            pending++;
            this.sftp.read(handle, buf, 0, len, pos, (err2, bytesRead) => {
              pending--;
              if (failed || done) return;
              if (err2) return fail(err2);
              slots[idx].n = bytesRead;
              if (bytesRead === 0) eofSeen = true;
              // Refill before deciding we are done: with pipeline=1 the old order
              // finished after the first chunk and truncated the read.
              pump();
              if (pending === 0 && !done) return finish();
            });
          }
        };
        pump();
        if (eofSeen && pending === 0) finish();
      });
    });
  }

  // Atomic write: temp file in the same directory (owner-only) -> rename publish; temp cleaned up on failure.
  writeFileAtomic(p, data) {
    const dir = path.dirname(p);
    const base = path.basename(p);
    const tmp = path.join(dir, '.dsh-tmp-' + base + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
    return new Promise((resolve, reject) => {
      this.sftp.writeFile(tmp, data, (err) => {
        if (err) return reject(this._wrap(err, 'sftp-write', tmp));
        const retryAfterUnlink = (renameErr) => {
          // OpenSSH's basic SSH_FXP_RENAME returns Failure when the target exists (when the
          // posix-rename@openssh.com extension is not advertised). Fallback: unlink the
          // target then retry rename (equivalent semantics; tiny non-atomic window; local
          // fs atomic replace has no standard SFTP guarantee).
          this.sftp.unlink(p, (err3) => {
            if (err3 && err3.code !== 2 /* SSH_FX_NO_SUCH_FILE */) {
              this.sftp.unlink(tmp, () => {});
              return reject(this._wrap(renameErr, 'sftp-rename', tmp + ' -> ' + p));
            }
            this.sftp.rename(tmp, p, (err4) => {
              if (err4) {
                this.sftp.unlink(tmp, () => {});
                return reject(this._wrap(err4, 'sftp-rename', tmp + ' -> ' + p));
              }
              resolve();
            });
          });
        };
        if (this.sftp.extensions?.['posix-rename@openssh.com'] === '1') {
          this.sftp.ext_openssh_rename(tmp, p, (err2) => (err2 ? retryAfterUnlink(err2) : resolve()));
        } else {
          this.sftp.rename(tmp, p, (err2) => (err2 ? retryAfterUnlink(err2) : resolve()));
        }
      });
    });
  }

  unlink(p) {
    return new Promise((resolve, reject) => {
      this.sftp.unlink(p, (err) => err ? reject(this._wrap(err, 'sftp-unlink', p)) : resolve());
    });
  }

  rmdir(p) {
    return new Promise((resolve, reject) => {
      this.sftp.rmdir(p, (err) => err ? reject(this._wrap(err, 'sftp-rmdir', p)) : resolve());
    });
  }
}

// ---------- SshPool ----------
/** Expand OpenSSH ProxyCommand tokens (%h/%p/%r/%%); ssh itself does the same for terminals. */
export function expandProxyCommand(template, { host, port, user }) {
  return String(template).replace(/%%|%[hpr]/g, (token) => {
    if (token === '%%') return '%';
    if (token === '%h') return String(host ?? '');
    if (token === '%p') return String(port ?? 22);
    return String(user ?? '');
  });
}

/** Run a local ProxyCommand and expose its stdio as the ssh2 transport. */
export function spawnProxyCommand(cfg) {
  const command = expandProxyCommand(cfg.proxyCommand, { host: cfg.host, port: cfg.port ?? 22, user: cfg.user });
  const child = spawn('/bin/sh', ['-c', command], { stdio: ['pipe', 'pipe', 'ignore'] });
  const stream = Duplex.from({ readable: child.stdout, writable: child.stdin });
  child.on('error', (error) => stream.destroy(error));
  stream.on('close', () => { try { child.kill(); } catch { /* already gone */ } });
  return stream;
}

/** First conventional private key under ~/.ssh, in OpenSSH preference order. */
export async function defaultIdentity(home = os.homedir()) {
  for (const name of ['id_ed25519', 'id_ecdsa', 'id_rsa']) {
    const candidate = path.join(home, '.ssh', name);
    try {
      const info = await stat(candidate);
      if (info.isFile()) return candidate;
    } catch {
      // try the next conventional name
    }
  }
  return undefined;
}

// A full pool used to block forever (browse/probe acquires never call release()).
// Instead, evict a connection that has been idle for a moment; only when every
// connection is actively executing does the acquire wait, and then it fails with
// a clear error rather than hanging the caller.
const POOL_IDLE_EVICT_MS = 2_000;
const POOL_CAPACITY_WAIT_MS = 15_000;

export class SshPool {
  constructor(options = {}) {
    this.maxConnections = options.maxConnections ?? 4;
    this.idleEvictMs = options.idleEvictMs ?? POOL_IDLE_EVICT_MS;
    this.capacityWaitMs = options.capacityWaitMs ?? POOL_CAPACITY_WAIT_MS;
    this.conns = new Map();  // hostId -> SshConn
    this.waiters = [];
    this.disposed = false;
    this.getHost = typeof options.getHost === 'function' ? options.getHost : () => undefined;
  }

  /** Build the transport factory for one host: ProxyCommand process, jump tunnel, or direct. */
  async _sock(cfg, seen) {
    if (cfg.proxyCommand) {
      // Same trust model as OpenSSH: the command comes from the user's own host
      // configuration and runs through /bin/sh on this machine.
      return async () => spawnProxyCommand(cfg);
    }
    if (!cfg.proxyJump) return undefined;
    const jumpCfg = this.getHost(cfg.proxyJump);
    if (!jumpCfg) throw new SshError({ hostId: cfg.id ?? '', stage: 'proxy-jump', message: 'ProxyJump host "' + cfg.proxyJump + '" is not configured' });
    const jumpConn = await this._acquire(jumpCfg, seen);
    // A live tunnel depends on this connection; evicting it would cut the target
    // session mid-run, so keep it out of the capacity eviction set.
    jumpConn.isJump = true;
    return async () => {
      await jumpConn.connect(); // reconnect the jump if it dropped
      return new Promise((resolve, reject) => {
        jumpConn.client.forwardOut('127.0.0.1', 0, cfg.host, cfg.port ?? 22, (err, stream) => {
          if (err) reject(new SshError({ hostId: cfg.id ?? '', stage: 'proxy-jump', message: 'tunnel through "' + cfg.proxyJump + '" failed: ' + err.message, cause: err }));
          else resolve(stream);
        });
      });
    };
  }

  async acquire(cfg) {
    return this._acquire(cfg, new Set());
  }

  /** Idle connection eligible for eviction (oldest first); never one that is executing. */
  _idleVictim(now) {
    let victim = null;
    for (const conn of this.conns.values()) {
      if (!conn || conn.busy > 0 || conn.isJump) continue;
      if (now - (conn.lastUsed || 0) < this.idleEvictMs) continue;
      if (victim === null || (conn.lastUsed || 0) < (victim.lastUsed || 0)) victim = conn;
    }
    return victim;
  }

  /** Least-recently-used connection that is not executing (last-resort eviction). */
  _lruIdleVictim() {
    let victim = null;
    for (const conn of this.conns.values()) {
      if (!conn || conn.busy > 0 || conn.isJump) continue;
      if (victim === null || (conn.lastUsed || 0) < (victim.lastUsed || 0)) victim = conn;
    }
    return victim;
  }

  /** Remove a specific connection from the pool by identity and dispose it. */
  async _evictConn(conn) {
    for (const [key, value] of this.conns) {
      if (value === conn) this.conns.delete(key);
    }
    if (conn && typeof conn.dispose === 'function') await conn.dispose().catch(() => {});
  }

  /** Wake one waiter (capacity freed) or time out; false means nothing was released. */
  _waitForCapacity() {
    return new Promise((resolve) => {
      let settled = false;
      const waiter = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        resolve(false);
      }, this.capacityWaitMs);
      // Deliberately referenced: Node's test runner cancels a pending promise once
      // the event loop has nothing left (ERR_TEST_FAILURE cancelledByParent).
      this.waiters.push(waiter);
    });
  }

  /** Make room for one more connection without blocking indefinitely. */
  async _ensureCapacity(cfg) {
    if (this.conns.size < this.maxConnections) return;
    let victim = this._idleVictim(Date.now());
    if (victim === null) {
      await this._waitForCapacity();
      // A waiter woken by dispose() must not proceed.
      if (this.disposed) throw new SshError({ hostId: cfg?.id ?? '', stage: 'pool-disposed', message: 'ssh pool is disposed' });
      victim = this._lruIdleVictim();
    }
    if (victim === null) {
      throw new SshError({
        hostId: cfg?.id ?? '',
        stage: 'pool-capacity',
        message: 'too many open SSH connections (max ' + this.maxConnections + '); close a session and retry',
      });
    }
    await this._evictConn(victim);
  }

  /** Connect one host, tunnelling through its configured jump host first. */
  async _acquire(cfg, seen) {
    if (this.disposed) throw new SshError({ hostId: cfg?.id ?? '', stage: 'pool-disposed', message: 'ssh pool is disposed' });
    const id = cfg.id ?? cfg.host;
    if (seen.has(id)) throw new SshError({ hostId: id, stage: 'proxy-jump', message: 'ProxyJump cycle detected at "' + id + '"' });
    seen.add(id);
    const existing = this.conns.get(id);
    if (existing) {
      // Only an explicitly dead connection (close event fired) is invalidated and rebuilt.
      // A missing client alone does not qualify: during an in-flight first connect the
      // client is not yet created, and that acquire must reuse the pending connect()
      // promise, not race it with a second connection.
      if (existing._dead) {
        await this.invalidate(id);
      } else {
        existing.lastUsed = Date.now();
        return existing.connect(); // reuse open conn; idempotent connect()
      }
    }
    await this._ensureCapacity(cfg);
    const sock = await this._sock(cfg, seen);
    const conn = new SshConn(cfg, { sock });
    conn.lastUsed = Date.now();
    this.conns.set(id, conn);
    try {
      return await conn.connect();
    } catch (err) {
      if (this.conns.get(id) === conn) this.conns.delete(id);
      throw err;
    }
  }

  // Keep the connection open for reuse; wake one waiter (capacity freed).
  release(conn) {
    if (conn && typeof conn === 'object') conn.lastUsed = Date.now();
    const w = this.waiters.shift();
    if (w) w();
  }

  invalidate(hostId) {
    const conn = this.conns.get(hostId);
    if (!conn) return Promise.resolve();
    this.conns.delete(hostId);
    return conn.dispose().catch(() => {});
  }

  async testConnection(cfg) {
    const resolved = { ...cfg, connectTimeoutMs: cfg.connectTimeoutMs ?? 6_000 };
    const seen = new Set([resolved.id]);
    const sock = await this._sock(resolved, seen);
    const conn = new SshConn(resolved, { sock });
    try {
      await conn.connect();
      const r = await conn.exec('echo ok', { timeoutMs: 5_000 });
      const ok = r.code === 0;
      return ok ? { ok, banner: r.stdout.trim() } : { ok, error: 'exit ' + r.code + ': ' + r.stderr.trim() };
    } catch (err) {
      // On unknown (TOFU), return the structured fields (same as the SshError thrown by
      // verifyHostKey) so the frontend dialog can show the fingerprint and call
      // trustHostKey; mismatch stays a hard reject (no trust option).
      if (err instanceof SshError && err.isHostKeyUnknown) {
        return {
          ok: false,
          error: err.message,
          stage: HOST_KEY_UNKNOWN_STAGE,
          hostId: err.hostId,
          host: err.host,
          port: err.port,
          fingerprint: err.fingerprint,
          rawKeyBase64: err.rawKeyBase64,
          keyType: err.keyType,
        };
      }
      return { ok: false, error: err instanceof SshError ? err.message : String(err?.message ?? err) };
    } finally {
      await conn.dispose().catch(() => {});
    }
  }

  async dispose() {
    this.disposed = true;
    await Promise.all([...this.conns.values()].map((c) => c.dispose().catch(() => {})));
    this.conns.clear();
    for (const w of this.waiters.splice(0)) w();
  }
}
