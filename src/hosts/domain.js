// dsh-ssh-toolkit — durable host storage on the DSH 0.2 domain data form.
// DSH 0.2 removed the settings-namespace seam (`settingsNamespace`,
// `ctx.settings.get/mutate`): `ctx.settings` is now a form projection over each
// plugin's own Cordis Config, with no writable namespace KV. The official
// replacement for mutable plugin records is the storage domain
// (`ctx.storageDomain.open(spec)` — the same seam dsh-workspace uses for
// `workspaces`). We therefore keep the SSH hosts in a `dsh-ssh-hosts` domain
// with one `hosts` table keyed by host id.
//
// Secrets: auth.password is still stored write-only from the UI's point of
// view (listHosts redacts it, a blank form field keeps the stored value), but
// the value now lives in the same domain JSON file as the rest of the record.
// This matches the previous settings.yaml behavior (plaintext at rest) and its
// documented known limitation.
import { z } from 'zod';
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';

// One SSH auth method. `privateKeyPath` is optional (falls back to ssh-agent);
// `password` is optional on the schema so a password-auth host can be created
// before its first secret is typed (validateHostConfig enforces the rest).
export const KeyAuthSchema = z.object({
  type: z.literal('key'),
  privateKeyPath: z.string().optional(),
});

export const PasswordAuthSchema = z.object({
  type: z.literal('password'),
  password: z.string().optional(),
});

// HostConfig — one SSH target. Mirrors the ssh-core HostConfig shape.
export const HostConfigSchema = z.object({
  id: z.string().describe('稳定 id(占位目录路径依赖, 如 uuid)'),
  name: z.string().describe('显示名'),
  host: z.string().describe('主机名或 IP'),
  port: z.number().int().min(1).max(65535).default(22).describe('SSH 端口'),
  user: z.string().describe('登录用户'),
  auth: z.union([KeyAuthSchema, PasswordAuthSchema]).default({ type: 'key' }).describe('认证方式'),
  knownHostsPath: z.string().optional().describe('known_hosts 路径; 缺省 ~/.ssh/known_hosts'),
  connectTimeoutMs: z.number().min(500).default(10_000).describe('连接超时(ms)'),
  keepaliveIntervalMs: z.number().min(1_000).default(15_000).describe('keepalive 间隔(ms)'),
  proxyJump: z.string().optional().describe('跳板机 host id（指向另一台已配置主机，可链式多跳）'),
});

/**
 * The SSH-host domain: one `hosts` table keyed by host id. Opening the same
 * spec twice in one process throws (`already-open`), so the domain is owned by
 * the plugin fiber (see index.js) and closed with it.
 */
// Domain names must match /^[a-z][a-z0-9_]*$/ (no hyphens), unlike the old
// settings namespaces — hence dsh_ssh_hosts rather than dsh-ssh-hosts.
export const HOSTS_DOMAIN_SPEC = defineDomain({
  name: 'dsh_ssh_hosts',
  version: 1,
  tables: { hosts: domainTable(HostConfigSchema) },
});

/**
 * Open the hosts domain on a storage-capable ctx.
 * @param ctx - ctx carrying `storageDomain` (from ctx.inject(['storageDomain'])).
 * @returns { domain, table } — the caller owns `domain.close()`.
 */
export async function openHostsDomain(ctx) {
  const domain = await ctx.storageDomain.open(HOSTS_DOMAIN_SPEC);
  return { domain, table: domain.table('hosts') };
}

/** Extract the hosts dict from a domain table snapshot (tolerant of undefined). */
export function hostsOfTable(table) {
  const hosts = {};
  if (!table || typeof table.entries !== 'function') return hosts;
  for (const [id, cfg] of table.entries()) hosts[id] = cfg;
  return hosts;
}

/**
 * Read the host config document from the domain table.
 * @param table - the opened `hosts` table handle, or null before the domain opens.
 * @returns { doc, hosts } — an empty doc before the domain is ready.
 */
export function readHostsDoc(table) {
  const hosts = hostsOfTable(table);
  return { doc: { hosts }, hosts };
}
