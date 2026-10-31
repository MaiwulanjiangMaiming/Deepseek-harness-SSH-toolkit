// dsh-ssh-toolkit — import hosts from the user's existing OpenSSH client config.
// VS Code's Remote-SSH extension reads the same `~/.ssh/config`, so one scanner
// serves both tools: the settings page offers the discovered aliases for import
// instead of asking the user to retype hosts they already have.
//
// Scope is deliberately read-only and conservative: Host blocks with a literal
// alias are listed, wildcard-only blocks (`Host *`) only contribute defaults,
// `Match` blocks are skipped, and the first value per option wins (OpenSSH
// semantics). ProxyJump is reported but not imported — the plugin is single-hop.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Include expansion stops here; a self-including config must not loop forever. */
const MAX_INCLUDE_DEPTH = 5;
/** Patterns that name a set rather than one host are not importable. */
const WILDCARD = /[*?!]/;

/** Strip an inline comment (` # ...`), keeping values that merely contain '#'... */
function stripInlineComment(value) {
  return value.replace(/\s+#.*$/, '').trim();
}

/** Parse one option line: `Key value` or `Key=value`. Returns null for non-options. */
function optionOf(line) {
  const match = /^([A-Za-z][A-Za-z0-9]*)\s*(?:=\s*|\s+)(.*)$/.exec(line);
  if (!match) return null;
  return { key: match[1].toLowerCase(), value: stripInlineComment(match[2]) };
}

function toPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 22;
}

/**
 * Parse OpenSSH client-config text into importable hosts.
 * Pure (no I/O) so the grammar is unit-testable.
 * @param text - ssh_config contents.
 * @returns hosts in file order, deduplicated by alias:
 *   { alias, host, port, user, identityFile, proxyJump }
 */
export function parseSshConfig(text) {
  const globalOptions = {};
  const blocks = [];
  let current = null;
  let inMatch = false;

  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const lower = line.toLowerCase();
    if (lower === 'host' || lower.startsWith('host ') || lower.startsWith('host=') || lower.startsWith('host\t')) {
      const value = stripInlineComment(line.replace(/^host\s*=?\s*/i, ''));
      current = { patterns: value.split(/\s+/).filter(Boolean), options: {} };
      blocks.push(current);
      inMatch = false;
      continue;
    }
    if (lower === 'match' || lower.startsWith('match ') || lower.startsWith('match=')) {
      current = null;
      inMatch = true;
      continue;
    }
    const option = optionOf(line);
    if (!option) continue;
    // Options before the first Host block are global; Match blocks are not modelled.
    if (inMatch) continue;
    const target = current ? current.options : globalOptions;
    if (!(option.key in target)) target[option.key] = option.value;
  }

  // `Host *` (and other wildcard-only blocks) act as defaults for every host,
  // while a literal block's own values win over them.
  const wildcardDefaults = {};
  for (const block of blocks) {
    if (block.patterns.length === 0 || !block.patterns.every((pattern) => WILDCARD.test(pattern))) continue;
    for (const [key, value] of Object.entries(block.options)) {
      if (!(key in wildcardDefaults)) wildcardDefaults[key] = value;
    }
  }

  const hosts = [];
  const seen = new Set();
  for (const block of blocks) {
    const aliases = block.patterns.filter((pattern) => pattern !== '' && !WILDCARD.test(pattern));
    if (aliases.length === 0) continue; // `Host *` blocks only supply defaults
    const options = { ...globalOptions, ...wildcardDefaults, ...block.options };
    if (options.hostname && (WILDCARD.test(options.hostname) || options.hostname.includes('%'))) continue;
    for (const alias of aliases) {
      if (seen.has(alias) || alias.includes('%')) continue; // % tokens are not literal hosts
      // Without HostName each alias resolves to itself (OpenSSH behaviour).
      const host = options.hostname || alias;
      seen.add(alias);
      hosts.push({
        alias,
        host,
        port: toPort(options.port),
        user: options.user || '',
        identityFile: options.identityfile || '',
        proxyJump: options.proxyjump || '',
      });
    }
  }
  return hosts;
}

/** Turn a simple `*`/`?` glob into a basename regex (no character classes). */
function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp('^' + escaped + '$');
}

/** Expand `~`, relative paths and one-level globs into existing files. */
async function expandPattern(pattern, baseDir) {
  let target = pattern;
  if (target === '~') target = os.homedir();
  else if (target.startsWith('~/')) target = path.join(os.homedir(), target.slice(2));
  if (!path.isAbsolute(target)) target = path.resolve(baseDir, target);

  if (!WILDCARD.test(target)) {
    try {
      const stat = await fs.stat(target);
      return stat.isFile() ? [target] : [];
    } catch {
      return [];
    }
  }
  const dir = path.dirname(target);
  const matcher = globToRegExp(path.basename(target));
  let names;
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  return names.filter((name) => matcher.test(name)).sort().map((name) => path.join(dir, name));
}

/** `Include` directives of one file, expanded relative to that file. */
function includePatterns(text) {
  const patterns = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const match = /^\s*include\s+(.+)$/i.exec(raw);
    if (!match) continue;
    patterns.push(...stripInlineComment(match[1]).split(/\s+/).filter(Boolean));
  }
  return patterns;
}

/**
 * Scan the OpenSSH client configuration for importable hosts.
 * Reads `~/.ssh/config` plus `~/.ssh/config.d/*`, following `Include`
 * (bounded). Missing files are not an error — an empty result just means there
 * is nothing to import and the UI falls back to manual entry.
 * @param options - `{ home?, configFiles? }` (injectable for tests).
 * @returns { sources, hosts, errors }
 */
export async function scanSshConfig(options = {}) {
  const home = options.home ?? os.homedir();
  const roots = options.configFiles ?? [
    path.join(home, '.ssh', 'config'),
    path.join(home, '.ssh', 'config.d', '*'),
  ];
  const sources = [];
  const errors = [];
  const texts = [];
  const seen = new Set();

  async function collect(file, depth) {
    if (depth > MAX_INCLUDE_DEPTH) return;
    let real;
    try {
      real = await fs.realpath(file);
    } catch {
      return;
    }
    if (seen.has(real)) return;
    seen.add(real);
    let text;
    try {
      text = await fs.readFile(real, 'utf8');
    } catch (error) {
      errors.push(file + ': ' + (error?.message ?? String(error)));
      return;
    }
    sources.push(real);
    texts.push(text);
    for (const pattern of includePatterns(text)) {
      for (const included of await expandPattern(pattern, path.dirname(real))) await collect(included, depth + 1);
    }
  }

  for (const root of roots) for (const file of await expandPattern(root, home)) await collect(file, 0);

  return { sources, hosts: parseSshConfig(texts.join('\n')), errors };
}
