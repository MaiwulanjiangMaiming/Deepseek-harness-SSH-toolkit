// dsh-ssh-toolkit — UI bridge helpers (remote Files sidebar + terminal).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { remoteTarget, entryType, versionOf, pageOf, sshTerminalArgv, shellQuote, uniqueUploadName } from '../src/compat/ui-bridge.js';
import { mapRemoteToLocal, encodeRemotePath } from '../src/workspace/router.js';

const ROOT = path.join(os.tmpdir(), 'dsh-ui-bridge-root');
process.env.DSH_SSH_REMOTE_ROOT = ROOT;

test('remoteTarget maps a workspace-relative and an absolute path to the remote host', () => {
  const root = mapRemoteToLocal('host-1', '/srv/app');
  const rel = remoteTarget(root, 'src/index.js');
  assert.equal(rel.hostId, 'host-1');
  assert.equal(rel.remotePath, '/srv/app/src/index.js');
  assert.equal(rel.relativePath, 'src/index.js');
  const abs = remoteTarget(root, path.join(root, 'src', 'index.js'));
  assert.equal(abs.remotePath, '/srv/app/src/index.js');
  const self = remoteTarget(root, root);
  assert.equal(self.remotePath, '/srv/app');
  assert.equal(self.relativePath, '');
});

test('remoteTarget returns null for local workspaces and paths outside the workspace', () => {
  assert.equal(remoteTarget('/Users/me/project', 'a.txt'), null);
  const root = mapRemoteToLocal('host-1', '/srv/app');
  assert.equal(remoteTarget(root, ROOT + '/other'), null);
  assert.equal(remoteTarget(root, '/etc/passwd'), null);
});

test('remoteTarget ignores malformed placeholder roots', () => {
  assert.equal(remoteTarget(path.join(ROOT, 'host-1', 'not-base64!'), 'a'), null);
  assert.equal(remoteTarget(path.join(ROOT, '..', 'x', encodeRemotePath('/srv')), 'a'), null);
});

test('entryType maps SFTP types to the Files vocabulary', () => {
  assert.equal(entryType('dir'), 'directory');
  assert.equal(entryType('link'), 'symlink');
  assert.equal(entryType('file'), 'file');
  assert.equal(entryType('other'), 'other');
  assert.equal(entryType(undefined), 'other');
});

test('versionOf is stable for one stat and changes with size', () => {
  assert.equal(versionOf({ mtime: 10, size: 2 }), 'sftp:10:2');
  assert.notEqual(versionOf({ mtime: 10, size: 2 }), versionOf({ mtime: 10, size: 3 }));
});

test('pageOf slices lines with offset/limit and eof', () => {
  const text = 'a\nb\nc\nd';
  assert.deepEqual(pageOf(text, 1, 2, 1024), { text: 'a\nb', lines: 2, eof: false });
  assert.deepEqual(pageOf(text, 3, 10, 1024), { text: 'c\nd', lines: 2, eof: true });
  assert.deepEqual(pageOf(text, 2, 1, 1024), { text: 'b', lines: 1, eof: false });
  assert.throws(() => pageOf('x'.repeat(100), 1, 1, 10), /byte cap/);
});

test('sshTerminalArgv carries port, key and the remote cwd command', () => {
  const argv = sshTerminalArgv(
    { host: 'example.internal', port: 2222, user: 'dev', auth: { type: 'key', privateKeyPath: '/keys/id' } },
    '/srv/app dir',
  );
  assert.equal(argv[0], 'ssh');
  assert.ok(argv.includes('-tt'));
  assert.deepEqual(argv.slice(argv.indexOf('-p'), argv.indexOf('-p') + 2), ['-p', '2222']);
  assert.deepEqual(argv.slice(argv.indexOf('-i'), argv.indexOf('-i') + 2), ['-i', '/keys/id']);
  assert.ok(argv.includes('dev@example.internal'));
  assert.equal(argv.at(-1), "cd -- '/srv/app dir' && exec bash -l || exec sh -l");
});

test('shellQuote escapes single quotes', () => {
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
});

test('uniqueUploadName keeps names safe and avoids collisions', () => {
  assert.equal(uniqueUploadName('report.pdf', new Set()), 'report.pdf');
  assert.equal(uniqueUploadName('report.pdf', new Set(['report.pdf'])), 'report (1).pdf');
  assert.equal(uniqueUploadName('report.pdf', new Set(['report.pdf', 'report (1).pdf'])), 'report (2).pdf');
  assert.equal(uniqueUploadName('../../etc/passwd', new Set()), 'passwd');
  assert.equal(uniqueUploadName('', new Set()), 'upload');
});
