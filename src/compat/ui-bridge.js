// dsh-ssh-toolkit — make the built-in UI work inside a remote workspace.
//
// The agent tools are routed per session, but two UI surfaces still talk to the
// local machine: the Files sidebar (workspaceFiles service → ctx.fs) and the
// Terminal panel (subprocess.spawnTerminal). This module bridges both at their
// public seams, without forking DSH:
//
//   workspaceFiles.list/read/readBytes/stat/changes/relativePath
//     → placeholder-scoped paths are served over SFTP; local paths delegate to
//       the original implementation unchanged.
//   subprocess.spawnTerminal
//     → when the requested cwd is a placeholder, the local PTY runs
//       `ssh -tt <host> 'cd <remote> && exec bash -l'` instead of a local shell,
//       so resize/scrollback/input all keep working through the official
//       terminal implementation.
//
// Everything is additive: without a remote workspace both services behave
// exactly as before.
import os from 'node:os';
import path from 'node:path';
import { posix } from 'node:path';
import { mapLocalToRemote } from '../workspace/router.js';

/** Map a workspace root + target path to the remote host/path, or null when local. */
export function remoteTarget(workspaceRoot, targetPath) {
  if (typeof workspaceRoot !== 'string' || workspaceRoot.length === 0) return null;
  const root = mapLocalToRemote(workspaceRoot);
  if (root === null) return null;
  const target = typeof targetPath === 'string' && targetPath.length > 0
    ? (path.isAbsolute(targetPath) ? path.normalize(targetPath) : path.resolve(workspaceRoot, targetPath))
    : workspaceRoot;
  const rel = path.relative(workspaceRoot, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const relPosix = rel.split(path.sep).join('/');
  const remotePath = rel === '' ? root.remotePath : posix.join(root.remotePath, relPosix);
  return { hostId: root.hostId, remotePath, relativePath: relPosix, localPath: target };
}

/** SFTP entry type → the fs vocabulary the Files sidebar renders. */
export function entryType(type) {
  if (type === 'dir') return 'directory';
  if (type === 'link') return 'symlink';
  if (type === 'file') return 'file';
  return 'other';
}

/** Stable version token for one remote file (identity is content-ish, not a hash). */
export function versionOf(info) {
  return 'sftp:' + String(info?.mtime ?? 0) + ':' + String(info?.size ?? 0);
}

/** Slice one page of lines with the same offset/limit/eof semantics as the local reader. */
export function pageOf(text, offset, limit, maxBytes) {
  const start = Math.max(1, offset);
  const lines = String(text).split('\n');
  const slice = lines.slice(start - 1, start - 1 + Math.max(1, limit));
  const body = slice.join('\n');
  if (Buffer.byteLength(body, 'utf8') > maxBytes) {
    throw new Error(`lines ${start}-${start + slice.length - 1} exceed the ${maxBytes} byte cap`);
  }
  return {
    text: body,
    lines: slice.length,
    eof: start - 1 + slice.length >= lines.length,
  };
}

/** Quote one argument for a POSIX shell command line. */
export function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

/** argv for an interactive SSH shell that lands in `remoteCwd`. */
export function sshTerminalArgv(host, remoteCwd) {
  const args = ['-tt'];
  if (host.port && host.port !== 22) args.push('-p', String(host.port));
  if (host.auth && host.auth.type === 'key' && host.auth.privateKeyPath) {
    let keyPath = String(host.auth.privateKeyPath);
    if (keyPath === '~') keyPath = os.homedir();
    else if (keyPath.startsWith('~/')) keyPath = path.join(os.homedir(), keyPath.slice(2));
    args.push('-i', keyPath);
  }
  args.push('-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3');
  args.push(String(host.user) + '@' + String(host.host));
  args.push('cd -- ' + shellQuote(remoteCwd) + ' && exec bash -l || exec sh -l');
  return argv0().concat(args);
}

function argv0() {
  return ['ssh'];
}

/**
 * Install the UI bridge on a host context.
 * @param ctx - plugin context carrying workspaceFiles / subprocess / sshPool.
 */
export function installUiBridge(ctx) {
  ctx.inject(['workspaceFiles', 'sshPool'], (scope) => {
    installWorkspaceFiles(scope.workspaceFiles, scope.sshPool, scope);
  });
  ctx.inject(['subprocess', 'sshPool'], (scope) => {
    installTerminal(scope.subprocess, scope.sshPool);
  });
}

/** Acquire one pooled connection and always hand the slot back. */
async function withConn(pool, hostId, fn) {
  const cfg = pool.getHost(hostId);
  if (!cfg) throw new Error('SSH host "' + hostId + '" is not configured');
  const conn = await pool.acquire({ ...cfg, id: hostId });
  try {
    return await fn(conn);
  } finally {
    pool.release();
  }
}

function installWorkspaceFiles(service, pool, scope) {
  if (!service || service.__dshSshToolkitBridge) return service;
  const config = { maxLines: 5000, maxBytes: 2 * 1024 * 1024, maxFileBytes: 32 * 1024 * 1024, ...(service.config || {}) };
  const original = {
    list: service.list.bind(service),
    read: service.read.bind(service),
    readBytes: service.readBytes.bind(service),
    stat: service.stat.bind(service),
    changes: service.changes.bind(service),
    relativePath: service.relativePath.bind(service),
  };

  const remoteOf = (fileScope, p) => remoteTarget(fileScope?.workspaceRoot, p);

  service.list = async (fileScope, p, signal) => {
    const target = remoteOf(fileScope, p);
    if (target === null) return original.list(fileScope, p, signal);
    signal?.throwIfAborted?.();
    const entries = await withConn(pool, target.hostId, async (conn) => {
      const fs = await conn.fs();
      return fs.listDir(target.remotePath);
    });
    const capped = entries.slice(0, service.config?.maxEntries ?? 2000);
    return {
      path: target.relativePath,
      entries: capped.map((entry) => ({
        name: entry.name,
        type: entryType(entry.type),
        ...entry.size === undefined ? {} : { size: entry.size },
      })),
      truncated: entries.length > capped.length,
    };
  };

  service.stat = async (fileScope, p, signal) => {
    const target = remoteOf(fileScope, p);
    if (target === null) return original.stat(fileScope, p, signal);
    signal?.throwIfAborted?.();
    const info = await withConn(pool, target.hostId, async (conn) => (await conn.fs()).stat(target.remotePath));
    if (info === undefined) throw new Error('workspace-file/not-found: "' + p + '"');
    return { absolutePath: target.localPath, version: versionOf(info), ...info.size === undefined ? {} : { bytes: info.size } };
  };

  service.read = async (fileScope, p, range, signal) => {
    const target = remoteOf(fileScope, p);
    if (target === null) return original.read(fileScope, p, range, signal);
    signal?.throwIfAborted?.();
    const offset = range?.offset ?? 1;
    const limit = range?.limit ?? config.maxLines;
    const { info, text } = await withConn(pool, target.hostId, async (conn) => {
      const fs = await conn.fs();
      const st = await fs.stat(target.remotePath);
      if (st === undefined) throw new Error('workspace-file/not-found: "' + p + '"');
      if (st.size !== undefined && st.size > config.maxFileBytes) throw new Error('workspace-file/too-large: "' + p + '"');
      if (st.type !== 'file') throw new Error('workspace-file/not-file: "' + p + '"');
      return { info: st, text: await fs.readText(target.remotePath) };
    });
    if (text.includes('\u0000')) throw new Error('workspace-file/not-text: "' + p + '" contains NUL bytes');
    const page = pageOf(text, offset, limit, config.maxBytes);
    return {
      absolutePath: target.localPath,
      version: versionOf(info),
      ...info.size === undefined ? {} : { bytes: info.size },
      offset,
      text: page.text,
      lines: page.lines,
      eof: page.eof,
    };
  };

  service.readBytes = async (fileScope, p, options, signal) => {
    const target = remoteOf(fileScope, p);
    if (target === null) return original.readBytes(fileScope, p, options, signal);
    signal?.throwIfAborted?.();
    const resolved = options?.baseFile === undefined
      ? target
      : remoteTarget(fileScope?.workspaceRoot, path.resolve(path.dirname(options.baseFile), p));
    if (resolved === null) throw new Error('workspace-file/outside-workspace: "' + p + '"');
    const { info, data } = await withConn(pool, resolved.hostId, async (conn) => {
      const fs = await conn.fs();
      const st = await fs.stat(resolved.remotePath);
      if (st === undefined) throw new Error('workspace-file/not-found: "' + p + '"');
      if (st.size !== undefined && st.size > config.maxFileBytes) throw new Error('workspace-file/too-large: "' + p + '"');
      return { info: st, data: await fs.readBytes(resolved.remotePath) };
    });
    const window = options?.range;
    const offset = window?.offset ?? 0;
    const length = window?.length ?? data.length;
    const slice = data.subarray(offset, offset + length);
    return {
      absolutePath: resolved.localPath,
      version: versionOf(info),
      ...info.size === undefined ? {} : { bytes: info.size },
      offset,
      data: slice,
      eof: offset + slice.length >= (info.size ?? data.length),
    };
  };

  // The Files tree waits for a `ready` item before it lists. Remote workspaces
  // have no local watcher, so emit ready immediately and poll the directory for
  // later changes instead of erroring out.
  service.changes = async function* (fileScope, p, signal) {
    const target = remoteOf(fileScope, p);
    if (target === null) return yield* original.changes(fileScope, p, signal);
    signal?.throwIfAborted?.();
    yield { kind: 'ready' };
    let last = await withConn(pool, target.hostId, async (conn) => (await conn.fs()).stat(target.remotePath)).catch(() => undefined);
    while (!signal?.aborted) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 3000);
        signal?.addEventListener?.('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
      });
      if (signal?.aborted) return;
      const next = await withConn(pool, target.hostId, async (conn) => (await conn.fs()).stat(target.remotePath)).catch(() => undefined);
      if (versionOf(next) !== versionOf(last)) {
        last = next;
        yield { kind: 'change', absolutePath: target.localPath, version: versionOf(next) };
      }
    }
  };

  service.relativePath = async (fileScope, baseFile, p, signal) => {
    const base = remoteOf(fileScope, baseFile);
    if (base === null) return original.relativePath(fileScope, baseFile, p, signal);
    signal?.throwIfAborted?.();
    return path.resolve(path.dirname(base.localPath), p);
  };

  Object.defineProperty(service, '__dshSshToolkitBridge', { value: true, enumerable: false });
  scope?.logger?.info('[dsh-ssh-toolkit] Files sidebar bridged to remote workspaces');
  return service;
}

function installTerminal(subprocess, pool) {
  if (!subprocess || typeof subprocess.spawnTerminal !== 'function' || subprocess.__dshSshToolkitBridge) return subprocess;
  const original = subprocess.spawnTerminal.bind(subprocess);
  subprocess.spawnTerminal = (spec) => {
    const target = remoteTarget(spec?.cwd, spec?.cwd);
    if (target === null) return original(spec);
    const host = pool.getHost(target.hostId);
    if (!host) return original(spec);
    return original({
      ...spec,
      argv: sshTerminalArgv(host, target.remotePath),
      cwd: os.tmpdir(),
      env: { ...(spec.env || {}), DSH_SSH_HOST: host.host, DSH_SSH_CWD: target.remotePath },
    });
  };
  Object.defineProperty(subprocess, '__dshSshToolkitBridge', { value: true, enumerable: false });
  return subprocess;
}
