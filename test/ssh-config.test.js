// dsh-ssh-toolkit — ~/.ssh/config scanner tests (import existing hosts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseSshConfig, scanSshConfig } from '../src/hosts/config-scan.js';

const CONFIG = `
# personal hosts
Host dev-vpn
  HostName 172.16.1.52
  User rock

Host lab
  HostName 100.99.100.1
  User rock
  Port 2222
  IdentityFile ~/.ssh/id_ed25519

Host *
  User defaultuser
  IdentityFile ~/.ssh/default_key
`;

test('parseSshConfig: literal aliases, host/user/port/identity', () => {
  const hosts = parseSshConfig(CONFIG);
  assert.deepEqual(hosts.map((h) => h.alias), ['dev-vpn', 'lab']);
  assert.equal(hosts[0].host, '172.16.1.52');
  assert.equal(hosts[0].user, 'rock');
  assert.equal(hosts[0].port, 22);
  assert.equal(hosts[0].identityFile, '~/.ssh/default_key'); // Host * default applies
  assert.equal(hosts[1].port, 2222);
  assert.equal(hosts[1].identityFile, '~/.ssh/id_ed25519'); // block value wins over default
});

test('parseSshConfig: wildcard-only blocks supply defaults but are not hosts', () => {
  const hosts = parseSshConfig('Host *\n  User u\n  IdentityFile ~/.ssh/k\n');
  assert.deepEqual(hosts, []);
});

test('parseSshConfig: HostName falls back to the alias, multiple aliases expand', () => {
  const hosts = parseSshConfig('Host a1 b1\n  User u\n');
  assert.deepEqual(hosts.map((h) => h.alias), ['a1', 'b1']);
  assert.equal(hosts[0].host, 'a1');
  assert.equal(hosts[1].host, 'b1');
});

test('parseSshConfig: Match blocks never become hosts; % tokens are skipped', () => {
  const hosts = parseSshConfig('Host ok\n  HostName real\nMatch host x\n  User u\nHost %h.bad\n  User u\n');
  assert.deepEqual(hosts.map((h) => h.alias), ['ok']);
});

test('parseSshConfig: Key=value syntax and inline comments', () => {
  const hosts = parseSshConfig('Host box\nHostName=1.2.3.4\nUser=root # admin\nPort=2200\n');
  assert.equal(hosts[0].host, '1.2.3.4');
  assert.equal(hosts[0].user, 'root');
  assert.equal(hosts[0].port, 2200);
});

test('parseSshConfig: invalid port falls back to 22; duplicates keep the first', () => {
  const hosts = parseSshConfig('Host a\n  Port 99999\nHost a\n  Port 2222\n');
  assert.equal(hosts.length, 1);
  assert.equal(hosts[0].port, 22);
});

test('scanSshConfig: missing config yields an empty result, not an error', async () => {
  const result = await scanSshConfig({ home: path.join(os.tmpdir(), 'dsh-ssh-no-such-home') });
  assert.deepEqual(result.hosts, []);
  assert.deepEqual(result.sources, []);
  assert.deepEqual(result.errors, []);
});

test('scanSshConfig: reads ~/.ssh/config and config.d, follows Include', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ssh-scan-'));
  try {
    await fs.mkdir(path.join(home, '.ssh', 'config.d'), { recursive: true });
    await fs.writeFile(path.join(home, '.ssh', 'config'), 'Include config.d/*\nHost main\n  HostName 10.0.0.1\n  User u\n');
    await fs.writeFile(path.join(home, '.ssh', 'config.d', 'extra'), 'Host extra\n  HostName 10.0.0.2\n  User u\n  Port 2200\n');
    const result = await scanSshConfig({ home });
    assert.deepEqual(result.hosts.map((h) => h.alias), ['main', 'extra']);
    assert.equal(result.sources.length, 2);
    assert.deepEqual(result.errors, []);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});
