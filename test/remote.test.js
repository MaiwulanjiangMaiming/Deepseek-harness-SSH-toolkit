// dsh-ssh-toolkit — functional unit test of the host Typert remote service.
// Requires the peer deps installed by pnpm install (cordis + typert-protocol
// live under packages/dsh-ssh/node_modules). Verifies the service registers a
// visible typertRemote binding and that testConnection merges stored secrets
// before delegating to the pool.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { bindTypertRemote, remoteMethods } from '@deepseek-ai/dsh-typert-protocol';
import { SshRemoteService, parseSemver, compareSemver, latestVersionTag } from '../src/remote/service.js';
import { SshError, HOST_KEY_UNKNOWN_STAGE, sshKeyFingerprint, sshKeyTypeFromBlob, knownHostsLine } from '../src/ssh/pool.js';
import { encodeRemotePath } from '../src/workspace/router.js';
import { HOST_TYPERT_CONTRIBUTION } from '../src/remote/contract.js';

test('SshRemoteService registers a typertRemote binding for namespace ssh', () => {
  const ctx = new Context();
  const calls = [];
  const pool = { testConnection: async (cfg) => { calls.push(cfg); return { ok: true, banner: 'echo ok' }; } };
  const svc = new SshRemoteService(ctx, pool);
  // ctx.get returns a traced proxy; the gateway unwraps via symbols.original
  // and then requires binding.service === original — check that relation here.
  const proxy = ctx.get('ssh');
  assert.equal(typeof proxy.testConnection, 'function');
  assert.equal(svc.typertRemote.service, svc);
  assert.equal(svc.typertRemote.serviceKey, 'ssh');
  assert.equal(svc.typertRemote.namespace, 'ssh');
  ctx.dispose?.();
});

test('remoteMethods on the plain-JS service is empty (no decorators) — strict contribution carries the endpoint', () => {
  // Uses the strict-registry route (ctx.typert.register) over SRC decorators,
  // so the endpoint identity comes from HOST_TYPERT_CONTRIBUTION, not decorator markers.
  const ctx = new Context();
  const pool = { testConnection: async () => ({ ok: false, error: 'x' }) };
  const svc = new SshRemoteService(ctx, pool);
  assert.equal(remoteMethods(svc).length, 0);
  assert.equal(HOST_TYPERT_CONTRIBUTION.invocations[0].namespace + '/' + HOST_TYPERT_CONTRIBUTION.invocations[0].method, 'ssh/testConnection');
  assert.equal(HOST_TYPERT_CONTRIBUTION.invocations[0].service, 'ssh');
  ctx.dispose?.();
});

test('testConnection merges stored password into the pool call when the form left it blank', async () => {
  const ctx = new Context();
  const calls = [];
  const pool = { testConnection: async (cfg) => { calls.push(cfg); return { ok: true, banner: 'ok' }; } };
  const svc = new SshRemoteService(ctx, pool);
  svc.setStoredResolver((id) => (id === 'h1' ? {
    id: 'h1', host: 'h', port: 22, user: 'u',
    auth: { type: 'password', password: 'stored-secret' },
    knownHostsPath: '/tmp/kh',
  } : undefined));
  const result = await svc.testConnection({ cfg: { id: 'h1', host: 'h', port: 22, user: 'u', auth: { type: 'password' } } });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].auth.password, 'stored-secret');
  assert.equal(calls[0].knownHostsPath, '/tmp/kh');
  ctx.dispose?.();
});

test('testConnection passes a typed client password through (client wins)', async () => {
  const ctx = new Context();
  const calls = [];
  const pool = { testConnection: async (cfg) => { calls.push(cfg); return { ok: false, error: 'boom' }; } };
  const svc = new SshRemoteService(ctx, pool);
  const result = await svc.testConnection({ cfg: { id: 'h1', host: 'h', port: 22, user: 'u', auth: { type: 'password', password: 'typed' } } });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'boom');
  assert.equal(calls[0].auth.password, 'typed');
  ctx.dispose?.();
});

test('testConnection tolerates malformed requests (empty cfg -> key default, no throw)', async () => {
  const ctx = new Context();
  const calls = [];
  const pool = { testConnection: async (cfg) => { calls.push(cfg); return { ok: false, error: 'no host' }; } };
  const svc = new SshRemoteService(ctx, pool);
  const result = await svc.testConnection(null);
  assert.equal(result.ok, false);
  assert.equal(calls[0].auth.type, 'key');
  ctx.dispose?.();
});

test('bindTypertRemote is the exact binding shape the gateway validates', () => {
  // dsh-api-gateway readBinding requires service === original, serviceKey, namespace strings.
  const holder = { key: 'x' };
  const binding = bindTypertRemote(holder, 'ssh');
  assert.equal(binding.service, holder);
  assert.equal(binding.serviceKey, 'ssh');
  assert.equal(binding.namespace, 'ssh');
});

// ---------- CRUD over the Typert channel (storage-domain backed) ----------

/** Minimal in-memory `hosts` table double (get/entries/put/delete). */
function makeHostsTable(initialHosts) {
  const records = new Map(Object.entries(initialHosts ?? {}));
  return {
    lastWrite: null,
    get: (id) => records.get(id),
    entries: () => records.entries(),
    _records: records,
    async put(id, value) { this.lastWrite = { op: 'put', id, value }; records.set(id, value); },
    async delete(id) { this.lastWrite = { op: 'delete', id }; records.delete(id); },
  };
}

function makeService(pool, table) {
  const ctx = new Context();
  const svc = new SshRemoteService(ctx, pool ?? { testConnection: async () => ({ ok: false, error: 'x' }) });
  svc.setHostsTable(table);
  return { ctx, svc };
}

test('listHosts returns the REDACTED dict + secrets + writable', () => {
  const table = makeHostsTable({
    h1: { id: 'h1', name: 'box', host: 'h', port: 22, user: 'u', auth: { type: 'password', password: 's3cret' }, knownHostsPath: '/tmp/kh' },
    h2: { id: 'h2', name: 'keybox', host: 'k', port: 22, user: 'u', auth: { type: 'key', privateKeyPath: '~/.ssh/id' } },
  });
  const { ctx, svc } = makeService({}, table);
  const result = svc.listHosts();
  assert.deepEqual(result.hosts.h1.auth, { type: 'password' }); // password stripped
  assert.equal(result.hosts.h1.knownHostsPath, '/tmp/kh');       // non-secret fields survive
  assert.deepEqual(result.hosts.h2.auth, { type: 'key', privateKeyPath: '~/.ssh/id' });
  assert.equal(result.revision, 0);
  assert.deepEqual(result.secrets, [{ path: ['hosts', 'h1', 'auth', 'password'], set: true }]);
  assert.equal(result.writable, true);
  assert.equal(table.get('h1').auth.password, 's3cret'); // store untouched
  ctx.dispose?.();
});

test('listHosts tolerates a missing hosts table (empty state)', () => {
  const ctx = new Context();
  const svc = new SshRemoteService(ctx, { testConnection: async () => ({ ok: false, error: 'x' }) });
  const result = svc.listHosts();
  assert.deepEqual(result.hosts, {});
  assert.deepEqual(result.secrets, []);
  assert.equal(result.revision, 0);
  assert.equal(result.writable, true);
  ctx.dispose?.();
});

test('saveHost creates a new host (put op, id authoritative, no stored secret)', async () => {
  const table = makeHostsTable({});
  const { ctx, svc } = makeService({}, table);
  const result = await svc.saveHost('h-new', { id: 'spoofed', name: 'n', host: 'h', port: 22, user: 'u', auth: { type: 'key' } }, 0);
  assert.deepEqual(result, { ok: true });
  assert.equal(table.lastWrite.op, 'put');
  assert.equal(table.lastWrite.id, 'h-new');
  assert.equal(table.get('h-new').id, 'h-new'); // id forced, patch.id ignored
  assert.equal(table.get('h-new').name, 'n');
  ctx.dispose?.();
});

test('saveHost edit keeps the stored password when the patch omits it', async () => {
  const table = makeHostsTable({
    h1: { id: 'h1', name: 'box', host: 'h', port: 22, user: 'u', auth: { type: 'password', password: 'stored' } },
  });
  const { ctx, svc } = makeService({}, table);
  await svc.saveHost('h1', { id: 'h1', name: 'box2', host: 'h', port: 22, user: 'u', auth: { type: 'password' } }, 0);
  const saved = table.get('h1');
  assert.equal(saved.name, 'box2');
  assert.deepEqual(saved.auth, { type: 'password', password: 'stored' });
  ctx.dispose?.();
});

test('saveHost overwrites the password when the patch carries one', async () => {
  const table = makeHostsTable({
    h1: { id: 'h1', name: 'box', host: 'h', port: 22, user: 'u', auth: { type: 'password', password: 'old' } },
  });
  const { ctx, svc } = makeService({}, table);
  await svc.saveHost('h1', { id: 'h1', name: 'box', host: 'h', port: 22, user: 'u', auth: { type: 'password', password: 'new' } }, 0);
  assert.deepEqual(table.get('h1').auth, { type: 'password', password: 'new' });
  ctx.dispose?.();
});

test('saveHost switching to key auth clears the stored password', async () => {
  const table = makeHostsTable({
    h1: { id: 'h1', name: 'box', host: 'h', port: 22, user: 'u', auth: { type: 'password', password: 'stored' } },
  });
  const { ctx, svc } = makeService({}, table);
  await svc.saveHost('h1', { id: 'h1', name: 'box', host: 'h', port: 22, user: 'u', auth: { type: 'key', privateKeyPath: '~/.ssh/id' } }, 0);
  assert.deepEqual(table.get('h1').auth, { type: 'key', privateKeyPath: '~/.ssh/id' });
  assert.equal('password' in table.get('h1').auth, false);
  ctx.dispose?.();
});

test('saveHost rejects an invalid host config host-side (remote values not trusted)', async () => {
  const table = makeHostsTable({});
  const { ctx, svc } = makeService({}, table);
  await assert.rejects(() => svc.saveHost('h1', { name: '', host: 'h', user: 'u', auth: { type: 'key' } }, 0), /主机配置无效/);
  assert.equal(table.lastWrite, null); // nothing persisted
  ctx.dispose?.();
});

test('deleteHost deletes the entry and is idempotent for missing ids', async () => {
  const table = makeHostsTable({ h1: { id: 'h1', name: 'a', host: 'h', user: 'u', auth: { type: 'key' } } });
  const { ctx, svc } = makeService({}, table);
  const missing = await svc.deleteHost('nope', 0);
  assert.deepEqual(missing, { ok: true });
  assert.equal(table.lastWrite, null); // no write for a missing id

  await svc.deleteHost('h1', 0);
  assert.deepEqual(table.lastWrite, { op: 'delete', id: 'h1' });
  assert.equal(table.get('h1'), undefined);
  ctx.dispose?.();
});

test('saveHost throws a clear error when no storage table is wired', async () => {
  const ctx = new Context();
  const svc = new SshRemoteService(ctx, { testConnection: async () => ({ ok: false, error: 'x' }) });
  await assert.rejects(() => svc.saveHost('h1', { name: 'a', host: 'h', user: 'u', auth: { type: 'key' } }), /storage unavailable/);
  ctx.dispose?.();
});

// ---------- Remote directory browse + placeholder creation ----------

const M4_HOST = { id: 'h1', host: 'h', port: 22, user: 'u', auth: { type: 'key' } };

/** Fake connection pool: acquire captures received (STORED) config, returns fixed conn. */
function makeBrowsePool(conn, onAcquire) {
  return {
    acquire: async (cfg) => { if (onAcquire) onAcquire(cfg); return conn; },
    testConnection: async () => ({ ok: false, error: 'x' }),
  };
}

/** Service with settings + stored resolver (connection endpoints use resolveStored, placeholder uses settingsApi). */
function makeBrowseService(pool, table, stored) {
  const ctx = new Context();
  const svc = new SshRemoteService(ctx, pool ?? { testConnection: async () => ({ ok: false, error: 'x' }) });
  svc.setHostsTable(table);
  svc.setStoredResolver((id) => (stored && stored[id]) || undefined);
  return { ctx, svc };
}

test('listRemoteDir lists via SFTP and sorts directories first, then by name', async () => {
  const listDir = async () => [
    { name: 'zeta.txt', type: 'file', size: 3, mtime: 1 },
    { name: 'alpha', type: 'dir', size: 0, mtime: 1 },
    { name: 'beta.txt', type: 'file', size: 5, mtime: 2 },
    { name: 'Gamma', type: 'dir', size: 0, mtime: 3 },
  ];
  const conn = { sftp: async () => ({ listDir }), fs: async () => ({ listDir }), exec: async () => ({ code: 0, stdout: '', stderr: '' }) };
  let acquired = null;
  const { ctx, svc } = makeBrowseService(makeBrowsePool(conn, (cfg) => { acquired = cfg; }), makeHostsTable({ h1: M4_HOST }), { h1: M4_HOST });
  const result = await svc.listRemoteDir('h1', '/data');
  assert.deepEqual(result.map((e) => e.name), ['Gamma', 'alpha', 'beta.txt', 'zeta.txt']);
  assert.equal(result[0].type, 'dir');
  assert.deepEqual(acquired, { ...M4_HOST, id: 'h1' }); // acquire uses STORED config
  ctx.dispose?.();
});

test('listRemoteDir rejects a missing remote path and an unconfigured host (SshError)', async () => {
  const { ctx, svc } = makeBrowseService(makeBrowsePool(null), makeHostsTable({}), {});
  await assert.rejects(() => svc.listRemoteDir('h1', ''), (err) => err instanceof SshError && err.stage === 'sftp-readdir' && /path is required/.test(err.message));
  await assert.rejects(() => svc.listRemoteDir('nope', '/x'), (err) => err instanceof SshError && err.stage === 'resolve-host' && /not configured/.test(err.message));
  ctx.dispose?.();
});

test('statRemote reads raw SFTP stat with mtime; ENOENT maps to null', async () => {
  const statRaw = (p, cb) => cb(null, { size: 42, mtime: 1234, isDirectory: () => true, isFile: () => false });
  const conn = { sftp: async () => ({ listDir: async () => [] }), fs: async () => ({ stat: async () => ({ type: 'directory', size: 42, mtime: 1234 }) }), exec: async () => ({ code: 0, stdout: '', stderr: '' }) };
  const { ctx, svc } = makeBrowseService(makeBrowsePool(conn), makeHostsTable({ h1: M4_HOST }), { h1: M4_HOST });
  assert.deepEqual(await svc.statRemote('h1', '/data'), { type: 'directory', size: 42, mtime: 1234 });
  // ENOENT (ssh2 code 2) -> null
  const missingConn = { sftp: async () => ({ listDir: async () => [] }), fs: async () => ({ stat: async () => undefined }), exec: async () => ({ code: 0, stdout: '', stderr: '' }) };
  const svc2 = makeBrowseService(makeBrowsePool(missingConn), makeHostsTable({ h1: M4_HOST }), { h1: M4_HOST }).svc;
  assert.equal(await svc2.statRemote('h1', '/nope'), null);
  ctx.dispose?.();
});

test('resolveRemoteHome execs echo $HOME and returns the absolute home', async () => {
  const exec = async () => ({ code: 0, stdout: '/home/devuser\n', stderr: '' });
  const conn = { sftp: async () => ({ listDir: async () => [] }), exec };
  const { ctx, svc } = makeBrowseService(makeBrowsePool(conn), makeHostsTable({ h1: M4_HOST }), { h1: M4_HOST });
  assert.equal(await svc.resolveRemoteHome('h1'), '/home/devuser');
  // exec failure -> SshError(stage exec)
  const badExec = async () => ({ code: 127, stdout: '', stderr: 'command not found' });
  const svc2 = makeBrowseService(makeBrowsePool({ sftp: async () => ({ listDir: async () => [] }), exec: badExec }), makeHostsTable({ h1: M4_HOST }), { h1: M4_HOST }).svc;
  await assert.rejects(() => svc2.resolveRemoteHome('h1'), (err) => err instanceof SshError && err.stage === 'exec' && /exit 127/.test(err.message));
  ctx.dispose?.();
});

test('createPlaceholder validates the host in dsh-ssh-hosts and creates a real dir under env root', async () => {
  const fsMod = await import('node:fs');
  const osMod = await import('node:os');
  const pathMod = await import('node:path');
  const tmp = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'dsh-m4-svc-'));
  try {
    const { ctx, svc } = makeBrowseService(null, makeHostsTable({ h1: M4_HOST }), {});
    svc.env = { DSH_HOME: tmp };
    const result = await svc.createPlaceholder('h1', '/data/work');
    assert.equal(result.hostId, 'h1');
    assert.equal(result.remotePath, '/data/work');
    assert.ok(result.localPath.startsWith(tmp + pathMod.sep + 'remote' + pathMod.sep));
    assert.equal(result.localPath, pathMod.join(tmp, 'remote', 'h1', encodeRemotePath('/data/work')));
    assert.equal(fsMod.statSync(result.localPath).isDirectory(), true);
    // Real directory, not symlink (macOS /var -> /private canonical comparison)
    assert.equal(
      fsMod.realpathSync(result.localPath),
      pathMod.join(fsMod.realpathSync(tmp), 'remote', 'h1', encodeRemotePath('/data/work')),
    );
    // Idempotent
    assert.deepEqual(await svc.createPlaceholder('h1', '/data/work'), result);
    // Unconfigured host / relative path -> SshError
    await assert.rejects(() => svc.createPlaceholder('nope', '/x'), (err) => err instanceof SshError && err.stage === 'placeholder' && /not configured/.test(err.message));
    await assert.rejects(() => svc.createPlaceholder('h1', 'rel'), (err) => err instanceof SshError && err.stage === 'placeholder' && /must be absolute/.test(err.message));
    ctx.dispose?.();
  } finally {
    fsMod.rmSync(tmp, { recursive: true, force: true });
  }
});

test('createPlaceholder explicit registry: workspace title = bare remote basename', async () => {
  const fsMod = await import('node:fs');
  const osMod = await import('node:os');
  const pathMod = await import('node:path');
  const tmp = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'dsh-m4-svc-'));
  try {
    const creates = [];
    const registry = {
      create: async (path, title) => {
        creates.push({ path, title });
        return { title, setTitle: async () => {} };
      },
    };
    const { ctx, svc } = makeBrowseService(null, makeHostsTable({ h1: M4_HOST }), {});
    svc.env = { DSH_HOME: tmp };
    svc.setWorkspaceRegistry(() => registry);
    const result = await svc.createPlaceholder('h1', '/home/devuser/workspace');
    assert.equal(creates.length, 1);
    assert.equal(creates[0].path, result.localPath);
    // The host is metadata (sidebar chip), not part of the title.
    assert.equal(creates[0].title, 'workspace');
    ctx.dispose?.();
  } finally {
    fsMod.rmSync(tmp, { recursive: true, force: true });
  }
});

test('createPlaceholder auto-fixes legacy base64 title to basename, preserves user-edited title', async () => {
  const fsMod = await import('node:fs');
  const osMod = await import('node:os');
  const pathMod = await import('node:path');
  const tmp = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'dsh-m4-svc-'));
  try {
    const { ctx, svc } = makeBrowseService(null, makeHostsTable({ h1: M4_HOST }), {});
    svc.env = { DSH_HOME: tmp };
    // Legacy bug: title equals encoded segment -> auto-rename to basename
    const renames = [];
    svc.setWorkspaceRegistry(() => ({
      create: async (path, title) => ({
        title: encodeRemotePath('/data/work'),
        setTitle: async (t) => { renames.push(t); },
      }),
    }));
    await svc.createPlaceholder('h1', '/data/work');
    // Encoded segment upgrades to the plain basename.
    assert.deepEqual(renames, ['work']);
    // User-edited title (non-encoded) -> untouched
    const renames2 = [];
    svc.setWorkspaceRegistry(() => ({
      create: async () => ({
        title: 'my server',
        setTitle: async (t) => { renames2.push(t); },
      }),
    }));
    await svc.createPlaceholder('h1', '/data/work');
    assert.deepEqual(renames2, []);
    ctx.dispose?.();
  } finally {
    fsMod.rmSync(tmp, { recursive: true, force: true });
  }
});

test('createPlaceholder title stays the basename even when the host has a display name', async () => {
  const fsMod = await import('node:fs');
  const osMod = await import('node:os');
  const pathMod = await import('node:path');
  const tmp = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'dsh-m4-svc-'));
  try {
    const creates = [];
    const registry = { create: async (path, title) => { creates.push({ path, title }); return { title, setTitle: async () => {} }; } };
    const { ctx, svc } = makeBrowseService(null, makeHostsTable({ h1: { ...M4_HOST, name: 'devuser' } }), {});
    svc.env = { DSH_HOME: tmp };
    svc.setWorkspaceRegistry(() => registry);
    await svc.createPlaceholder('h1', '/home/devuser/workspace');
    assert.equal(creates[0].title, 'workspace');
    ctx.dispose?.();
  } finally {
    fsMod.rmSync(tmp, { recursive: true, force: true });
  }
});

test('createPlaceholder migrates the old `host / basename` title to the bare basename; idempotent', async () => {
  const fsMod = await import('node:fs');
  const osMod = await import('node:os');
  const pathMod = await import('node:path');
  const tmp = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'dsh-m4-svc-'));
  try {
    const { ctx, svc } = makeBrowseService(null, makeHostsTable({ h1: { ...M4_HOST, name: 'devuser' } }), {});
    svc.env = { DSH_HOME: tmp };
    // Previous public format: "host / basename" -> upgrade to the plain basename.
    const renames = [];
    svc.setWorkspaceRegistry(() => ({
      create: async () => ({ title: 'devuser / work', setTitle: async (t) => { renames.push(t); } }),
    }));
    await svc.createPlaceholder('h1', '/data/work');
    assert.deepEqual(renames, ['work']);
    // Idempotent: a plain basename, or a title the user typed, is left alone.
    const renames2 = [];
    svc.setWorkspaceRegistry(() => ({
      create: async () => ({ title: 'work', setTitle: async (t) => { renames2.push(t); } }),
    }));
    await svc.createPlaceholder('h1', '/data/work');
    assert.deepEqual(renames2, []);
    ctx.dispose?.();
  } finally {
    fsMod.rmSync(tmp, { recursive: true, force: true });
  }
});

test('createPlaceholder preserves user custom title containing host identifier, does not overwrite', async () => {
  const fsMod = await import('node:fs');
  const osMod = await import('node:os');
  const pathMod = await import('node:path');
  const tmp = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'dsh-m4-svc-'));
  try {
    const { ctx, svc } = makeBrowseService(null, makeHostsTable({ h1: { ...M4_HOST, name: 'devuser' } }), {});
    svc.env = { DSH_HOME: tmp };
    // User manually named title with host identifier (different from current format) -> untouched
    const renames = [];
    svc.setWorkspaceRegistry(() => ({
      create: async () => ({ title: 'work · my-note', setTitle: async (t) => { renames.push(t); } }),
    }));
    await svc.createPlaceholder('h1', '/data/work');
    assert.deepEqual(renames, []);
    ctx.dispose?.();
  } finally {
    fsMod.rmSync(tmp, { recursive: true, force: true });
  }
});

test('createPlaceholder migrates legacy `basename · host` format to the bare basename', async () => {
  const fsMod = await import('node:fs');
  const osMod = await import('node:os');
  const pathMod = await import('node:path');
  const tmp = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'dsh-m4-svc-'));
  try {
    const { ctx, svc } = makeBrowseService(null, makeHostsTable({ h1: { ...M4_HOST, name: 'devuser' } }), {});
    svc.env = { DSH_HOME: tmp };
    // Legacy auto title `work · devuser` (hostName=devuser) -> upgrade to the basename.
    const renames = [];
    svc.setWorkspaceRegistry(() => ({
      create: async () => ({ title: 'work · devuser', setTitle: async (t) => { renames.push(t); } }),
    }));
    await svc.createPlaceholder('h1', '/data/work');
    assert.deepEqual(renames, ['work']);
    // Already migrated -> idempotent no-op
    const renames2 = [];
    svc.setWorkspaceRegistry(() => ({
      create: async () => ({ title: 'work', setTitle: async (t) => { renames2.push(t); } }),
    }));
    await svc.createPlaceholder('h1', '/data/work');
    assert.deepEqual(renames2, []);
    ctx.dispose?.();
  } finally {
    fsMod.rmSync(tmp, { recursive: true, force: true });
  }
});

test('createPlaceholder registry failure -> SshError(stage placeholder), no silent fallback', async () => {
  const fsMod = await import('node:fs');
  const osMod = await import('node:os');
  const pathMod = await import('node:path');
  const tmp = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'dsh-m4-svc-'));
  try {
    const { ctx, svc } = makeBrowseService(null, makeHostsTable({ h1: M4_HOST }), {});
    svc.env = { DSH_HOME: tmp };
    svc.setWorkspaceRegistry(() => ({
      create: async () => { throw new Error('registry boom'); },
    }));
    await assert.rejects(
      () => svc.createPlaceholder('h1', '/data'),
      (err) => err instanceof SshError && err.stage === 'placeholder' && /registry boom/.test(err.message),
    );
    ctx.dispose?.();
  } finally {
    fsMod.rmSync(tmp, { recursive: true, force: true });
  }
});

// TOFU: host-side trust persistence + structured host-key-unknown browse results
test('trustHostKey appends the confirmed key to a temp known_hosts, idempotently, fingerprint-validated', async () => {
  const ctx = new Context();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-ssh-trust-'));
  const kh = path.join(dir, 'known_hosts');
  try {
    const svc = new SshRemoteService(ctx, null);
    svc.setStoredResolver((id) => (id === 'h1' ? {
      id: 'h1', host: 'tofu.example', port: 2222, user: 'u', auth: { type: 'key' }, knownHostsPath: kh,
    } : undefined));
    // Build a raw host key blob with algorithm prefix (matches ssh2 hostVerifier shape)
    const algo = 'ssh-ed25519';
    const pre = Buffer.alloc(4); pre.writeUInt32BE(algo.length, 0);
    const blob = Buffer.concat([pre, Buffer.from(algo), Buffer.from('pubkey-bytes-here')]);
    const b64 = blob.toString('base64');
    const fp = sshKeyFingerprint(blob);
    const keyType = sshKeyTypeFromBlob(blob);
    const first = await svc.trustHostKey('h1', b64, fp);
    assert.equal(first.ok, true);
    assert.equal(first.appended, true);
    assert.equal(first.keyType, 'ssh-ed25519');
    assert.ok(readFileSync(kh, 'utf8').includes(knownHostsLine('tofu.example', 2222, keyType, b64)));
    // Idempotent
    const second = await svc.trustHostKey('h1', b64, fp);
    assert.equal(second.appended, false);
    // Fingerprint mismatch -> reject write
    await assert.rejects(() => svc.trustHostKey('h1', b64, 'SHA256:WRONG'), /does not match/);
    // Host not configured -> reject
    await assert.rejects(() => svc.trustHostKey('nope', b64, fp), /not configured/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    ctx.dispose?.();
  }
});

test('resolveRemoteHome surfaces a host-key-unknown as a structured VALUE (not a throw) for TOFU', async () => {
  const ctx = new Context();
  const unknownErr = new SshError({
    hostId: 'h1', stage: HOST_KEY_UNKNOWN_STAGE, message: 'unknown host key',
    host: 'tofu.example', port: 2222, fingerprint: 'SHA256:abc', rawKeyBase64: 'Zm9v', keyType: 'ssh-ed25519',
  });
  const pool = { acquire: async () => { throw unknownErr; } };
  const svc = new SshRemoteService(ctx, pool);
  svc.setStoredResolver((id) => (id === 'h1' ? { id: 'h1', host: 'tofu.example', port: 2222, user: 'u', auth: { type: 'key' } } : undefined));
  const res = await svc.resolveRemoteHome('h1');
  assert.equal(res.stage, HOST_KEY_UNKNOWN_STAGE);
  assert.equal(res.ok, false);
  assert.equal(res.host, 'tofu.example');
  assert.equal(res.port, 2222);
  assert.equal(res.fingerprint, 'SHA256:abc');
  assert.equal(res.rawKeyBase64, 'Zm9v');
  assert.equal(res.keyType, 'ssh-ed25519');
  ctx.dispose?.();
});

test('workspacePresence maps placeholder workspaces to hosts and caches each probe', async () => {
  const ctx = new Context();
  const probed = [];
  const pool = {
    testConnection: async (cfg) => {
      probed.push(cfg.id);
      return cfg.id === 'h1' ? { ok: true, banner: 'ok' } : { ok: false, error: 'unreachable' };
    },
  };
  const svc = new SshRemoteService(ctx, pool);
  svc.env = { DSH_SSH_REMOTE_ROOT: '/tmp/dsh-presence-root' };
  const stored = {
    h1: { id: 'h1', host: 'a.example', port: 22, user: 'u', auth: { type: 'key' } },
    h2: { id: 'h2', host: 'b.example', port: 22, user: 'u', auth: { type: 'key' } },
  };
  svc.setStoredResolver((id) => stored[id]);
  svc.resolveWorkspaceRegistry = () => ({
    list: () => [
      { id: 'w1', path: '/tmp/dsh-presence-root/h1/' + encodeRemotePath('/srv/app') },
      { id: 'w2', path: '/tmp/dsh-presence-root/h2/' + encodeRemotePath('/data') },
      { id: 'w3', path: '/tmp/dsh-presence-root/gone/' + encodeRemotePath('/x') },
      { id: 'w4', path: '/Users/me/plain-local-folder' },
    ],
  });

  const first = await svc.workspacePresence();
  assert.deepEqual(first.states.map((s) => [s.workspaceId, s.hostId, s.remotePath, s.status]), [
    ['w1', 'h1', '/srv/app', 'online'],
    ['w2', 'h2', '/data', 'offline'],
  ]);
  assert.deepEqual(probed.sort(), ['h1', 'h2']);

  // Second poll inside the TTL reuses the cache (no new connections).
  await svc.workspacePresence();
  assert.equal(probed.length, 2);

  // Expired entries probe again.
  for (const entry of svc.presenceCache.values()) entry.at = 0;
  await svc.workspacePresence();
  assert.equal(probed.length, 4);
  ctx.dispose?.();
});

test('workspacePresence de-duplicates concurrent probes and survives a missing registry', async () => {
  const ctx = new Context();
  let opens = 0;
  const pool = {
    testConnection: async () => {
      opens += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { ok: true, banner: 'ok' };
    },
  };
  const svc = new SshRemoteService(ctx, pool);
  svc.env = { DSH_SSH_REMOTE_ROOT: '/tmp/dsh-presence-root' };
  svc.setStoredResolver((id) => ({ id, host: id + '.example', port: 22, user: 'u', auth: { type: 'key' } }));
  svc.resolveWorkspaceRegistry = () => ({
    list: () => [{ id: 'w1', path: '/tmp/dsh-presence-root/h9/' + encodeRemotePath('/repo') }],
  });
  const [a, b] = await Promise.all([svc.workspacePresence(), svc.workspacePresence()]);
  assert.equal(a.states[0].status, 'online');
  assert.equal(b.states[0].status, 'online');
  assert.equal(opens, 1);

  svc.resolveWorkspaceRegistry = () => undefined;
  assert.deepEqual(await svc.workspacePresence(), { states: [] });
  ctx.dispose?.();
});

test('migratePlaceholderTitles rewrites only auto-generated host-prefixed titles', async () => {
  const ctx = new Context();
  const svc = new SshRemoteService(ctx, { testConnection: async () => ({ ok: true }) });
  svc.env = { DSH_SSH_REMOTE_ROOT: '/tmp/dsh-migrate-root' };
  svc.setStoredResolver((id) => (id === 'h1' ? { id: 'h1', name: 'devuser' } : undefined));
  const renames = [];
  const placeholder = (id, remote, title) => ({
    id,
    path: '/tmp/dsh-migrate-root/h1/' + encodeRemotePath(remote),
    title,
    setTitle: async (value) => { renames.push([id, value]); },
  });
  const entities = [
    placeholder('w1', '/data/work', 'devuser / work'),
    placeholder('w2', '/data/other', 'other · devuser'),
    placeholder('w3', '/data/kept', 'my custom name'),
    placeholder('w4', '/data/base', 'base'),
    { id: 'w5', path: '/Users/me/local-folder', title: 'devuser / local-folder', setTitle: async (value) => { renames.push(['w5', value]); } },
  ];
  const renamed = await svc.migratePlaceholderTitles(entities);
  assert.equal(renamed, 2);
  assert.deepEqual(renames, [['w1', 'work'], ['w2', 'other']]);
  ctx.dispose?.();
});

test('workspacePresence reports the host display name for the sidebar chip', async () => {
  const ctx = new Context();
  const svc = new SshRemoteService(ctx, { testConnection: async () => ({ ok: true, banner: 'ok' }) });
  svc.env = { DSH_SSH_REMOTE_ROOT: '/tmp/dsh-presence-root' };
  svc.setStoredResolver((id) => (id === 'h1' ? { id: 'h1', name: '  build-box  ' } : undefined));
  svc.resolveWorkspaceRegistry = () => ({
    list: () => [{ id: 'w1', path: '/tmp/dsh-presence-root/h1/' + encodeRemotePath('/srv/app') }],
  });
  const result = await svc.workspacePresence();
  assert.deepEqual(result.states, [{
    workspaceId: 'w1', hostId: 'h1', hostName: 'build-box', remotePath: '/srv/app', status: 'online',
  }]);
  ctx.dispose?.();
});

test('update helpers: stable semver only, highest tag wins', () => {
  assert.deepEqual(parseSemver('1.2.3'), [1, 2, 3]);
  assert.deepEqual(parseSemver('v1.2.3'), [1, 2, 3]);
  assert.equal(parseSemver('1.2'), null);
  assert.equal(parseSemver('v1.4.0-rc.1'), null);
  assert.equal(parseSemver(undefined), null);
  assert.equal(compareSemver([1, 2, 3], [1, 3, 0]), -1);
  assert.equal(compareSemver([1, 10, 0], [1, 9, 9]), 1);
  assert.equal(compareSemver([1, 2, 3], [1, 2, 3]), 0);
  const best = latestVersionTag([{ name: 'v1.4.0' }, { name: 'v1.10.0' }, { name: 'nightly' }, { name: 'v1.9.9' }]);
  assert.equal(best.tag, 'v1.10.0');
  assert.equal(best.version, '1.10.0');
  assert.equal(latestVersionTag([]), null);
  assert.equal(latestVersionTag('nope'), null);
});

test('checkUpdate compares the highest tag with the package version and caches', async () => {
  const ctx = new Context();
  const svc = new SshRemoteService(ctx, {});
  svc.version = '1.3.0';
  let calls = 0;
  svc.fetchImpl = async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => [{ name: 'v1.4.0' }, { name: 'v1.2.0' }] };
  };
  const first = await svc.checkUpdate();
  assert.equal(first.current, '1.3.0');
  assert.equal(first.latest, '1.4.0');
  assert.equal(first.updateAvailable, true);
  assert.equal(first.error, null);
  assert.equal(first.url, 'https://github.com/MaiwulanjiangMaiming/Deepseek-harness-SSH-toolkit/releases/tag/v1.4.0');
  // Inside the 6h window the result is reused, without another request.
  await svc.checkUpdate();
  assert.equal(calls, 1);
  // force re-reads; same version as the newest tag is not an update.
  svc.version = '1.4.0';
  const same = await svc.checkUpdate(true);
  assert.equal(calls, 2);
  assert.equal(same.updateAvailable, false);
  ctx.dispose?.();
});

test('checkUpdate degrades to unreachable without throwing', async () => {
  const ctx = new Context();
  const svc = new SshRemoteService(ctx, {});
  svc.fetchImpl = async () => { throw new Error('offline'); };
  const result = await svc.checkUpdate();
  assert.equal(result.error, 'unreachable');
  assert.equal(result.latest, null);
  assert.equal(result.updateAvailable, false);
  ctx.dispose?.();
});

test('saveHost clears a stored jump host / ProxyCommand when the form sends them empty', async () => {
  const table = makeHostsTable({
    h1: {
      id: 'h1', name: 'box', host: 'h', port: 22, user: 'u', auth: { type: 'key' },
      proxyJump: 'jump-1', proxyCommand: 'ssh -W %h:%p bastion',
    },
  });
  const { ctx, svc } = makeService({}, table);
  await svc.saveHost('h1', {
    id: 'h1', name: 'box', host: 'h', port: 22, user: 'u', auth: { type: 'key' },
    proxyJump: '', proxyCommand: '',
  }, 0);
  const saved = table.get('h1');
  assert.equal('proxyJump' in saved, false);
  assert.equal('proxyCommand' in saved, false);
  ctx.dispose?.();
});

test('testConnection forwards the jump host to the pool (settings test follows the chain)', async () => {
  const ctx = new Context();
  const calls = [];
  const pool = { testConnection: async (cfg) => { calls.push(cfg); return { ok: true, banner: 'ok' }; } };
  const svc = new SshRemoteService(ctx, pool);
  svc.setStoredResolver((id) => (id === 'h1' ? { id: 'h1', host: 'target', user: 'u', auth: { type: 'key' }, proxyJump: 'jump-1' } : undefined));
  await svc.testConnection({ cfg: { id: 'h1', host: 'target', user: 'u', auth: { type: 'key' }, proxyJump: 'jump-1' } });
  assert.equal(calls[0].proxyJump, 'jump-1');
  // Clearing the jump in the editor tests a direct connection, not the stored jump.
  await svc.testConnection({ cfg: { id: 'h1', host: 'target', user: 'u', auth: { type: 'key' }, proxyJump: '' } });
  assert.equal('proxyJump' in calls[1], false);
  ctx.dispose?.();
});

test('checkUpdate caches a failure briefly instead of hammering GitHub', async () => {
  const ctx = new Context();
  const svc = new SshRemoteService(ctx, {});
  let calls = 0;
  svc.fetchImpl = async () => { calls += 1; throw new Error('offline'); };
  await svc.checkUpdate();
  await svc.checkUpdate();
  assert.equal(calls, 1);
  // force still re-reads (manual refresh path).
  await svc.checkUpdate(true);
  assert.equal(calls, 2);
  ctx.dispose?.();
});

test('checkUpdate de-duplicates concurrent probes', async () => {
  const ctx = new Context();
  const svc = new SshRemoteService(ctx, {});
  let calls = 0;
  let release;
  svc.fetchImpl = () => {
    calls += 1;
    return new Promise((resolve) => {
      release = () => resolve({ ok: true, status: 200, json: async () => [{ name: 'v1.4.3' }] });
    });
  };
  const first = svc.checkUpdate(true);
  const second = svc.checkUpdate(true);
  await new Promise((resolve) => setImmediate(resolve));
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(a, b);
  ctx.dispose?.();
});
