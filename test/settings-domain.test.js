// dsh-ssh-toolkit — storage-domain tests (DSH 0.2 hosts storage).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HOSTS_DOMAIN_SPEC,
  HostConfigSchema,
  KeyAuthSchema,
  PasswordAuthSchema,
  openHostsDomain,
  readHostsDoc,
  hostsOfTable,
} from '../src/hosts/domain.js';

test('hosts domain spec: dsh_ssh_hosts, version 1, one hosts table', () => {
  assert.equal(HOSTS_DOMAIN_SPEC.name, 'dsh_ssh_hosts');
  assert.match(HOSTS_DOMAIN_SPEC.name, /^[a-z][a-z0-9_]*$/);
  assert.equal(HOSTS_DOMAIN_SPEC.version, 1);
  assert.deepEqual(Object.keys(HOSTS_DOMAIN_SPEC.tables), ['hosts']);
});

test('HostConfigSchema applies port/auth/timeout defaults', () => {
  const parsed = HostConfigSchema.parse({ id: 'x', name: 'box', host: 'h', user: 'u' });
  assert.equal(parsed.port, 22);
  assert.deepEqual(parsed.auth, { type: 'key' });
  assert.equal(parsed.connectTimeoutMs, 10_000);
  assert.equal(parsed.keepaliveIntervalMs, 15_000);
});

test('HostConfigSchema keeps key and password auth shapes', () => {
  assert.equal(KeyAuthSchema.parse({ type: 'key', privateKeyPath: '~/.ssh/id' }).privateKeyPath, '~/.ssh/id');
  assert.equal(KeyAuthSchema.parse({ type: 'key' }).privateKeyPath, undefined);
  // password may be absent (write-only field left blank) but stays a string when present
  assert.equal(PasswordAuthSchema.parse({ type: 'password', password: 's3cret' }).password, 's3cret');
  assert.equal(PasswordAuthSchema.parse({ type: 'password' }).password, undefined);
  assert.throws(() => HostConfigSchema.parse({ id: 'x', name: 'n', host: 'h', user: 'u', auth: { type: 'agent' } }));
  assert.throws(() => HostConfigSchema.parse({ id: 'x', name: 'n', host: 'h', user: 'u', port: 0 }));
});

test('openHostsDomain opens the spec and returns the hosts table', async () => {
  const calls = [];
  const table = { entries: () => [] };
  const ctx = {
    storageDomain: {
      async open(spec) {
        calls.push(spec);
        return { table: (name) => (name === 'hosts' ? table : undefined), close: async () => {} };
      },
    },
  };
  const opened = await openHostsDomain(ctx);
  assert.equal(calls[0], HOSTS_DOMAIN_SPEC);
  assert.equal(opened.table, table);
  assert.equal(typeof opened.domain.close, 'function');
});

test('readHostsDoc maps table entries to the hosts dict; null table → empty', () => {
  const table = {
    entries: () => [['h1', { id: 'h1', name: 'box' }], ['h2', { id: 'h2', name: 'keybox' }]],
  };
  assert.deepEqual(readHostsDoc(table).hosts, {
    h1: { id: 'h1', name: 'box' },
    h2: { id: 'h2', name: 'keybox' },
  });
  assert.deepEqual(readHostsDoc(null).hosts, {});
  assert.deepEqual(hostsOfTable(undefined), {});
});
