// dsh-ssh-toolkit — client bundle runtime smoke test.
// The static self-check parses client.js but never calls apply(); this loads the
// bundle the way the module loader does and runs apply() against a stubbed cordis
// context, so a load-time crash (bad hook, missing guard, wrong ctx key) fails CI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const code = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const element = (type, props, ...children) => ({ type, props, children });
const reactStub = {
  createElement: element,
  useState: () => [{}, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: null }),
  Fragment: 'Fragment',
};
const zodStub = { z: { any: () => ({}) } };
const primitivesStub = new Proxy({}, {
  get: (target, key) => (typeof key === 'string' ? (props) => element(key, props) : undefined),
});
const requireStub = (id) => {
  if (id === 'react') return reactStub;
  if (id === 'zod') return zodStub;
  if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitivesStub;
  throw new Error('client.js required an unexpected module: ' + id);
};

let loaded = null;
const intervals = [];
globalThis.window = {
  setTimeout: (fn) => { fn(); return 1; },
  clearTimeout: () => {},
  setInterval: (fn) => { intervals.push(fn); return intervals.length; },
  clearInterval: () => {},
  localStorage: { getItem: () => null, setItem: () => {} },
};
window.__ModuleLoader__ = { load: (options) => { loaded = options; } };
(0, eval)(code);
assert.ok(loaded, 'window.__ModuleLoader__.load was not called');

// Minimal DOM: the bundle injects one stylesheet at load and the presence dots
// read workspace rows plus their title span.
function fakeRow(workspaceId, { title = null } = {}) {
  const attrs = new Map([['data-row-key', 'workspace:' + workspaceId]]);
  const titleNode = title === null ? null : {
    attrs: new Map(),
    getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; },
    setAttribute(name, value) { this.attrs.set(name, value); },
    hasAttribute(name) { return this.attrs.has(name); },
    removeAttribute(name) { this.attrs.delete(name); },
  };
  return {
    attrs,
    titleNode,
    getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; },
    setAttribute(name, value) { this.attrs.set(name, value); },
    hasAttribute(name) { return this.attrs.has(name); },
    removeAttribute(name) { this.attrs.delete(name); },
    children: [],
    querySelector(selector) { return selector.includes('_title') ? titleNode : null; },
  };
}

let rows = [];
globalThis.document = {
  body: {},
  documentElement: {},
  querySelector: () => null,
  createElement: () => ({ dataset: {}, textContent: '' }),
  head: { appendChild: () => {} },
  querySelectorAll: () => rows,
};
globalThis.MutationObserver = class {
  observe() {}
  disconnect() {}
};

const tick = () => new Promise((resolve) => setImmediate(resolve));

function makeCtx(ssh) {
  const effects = [];
  const slots = [];
  const ctx = {
    locale: {
      register: () => {},
      bind: () => (key, params) => (params ? key + JSON.stringify(params) : key),
      getSnapshot: () => ({ active: 'en' }),
    },
    effect(fn) { effects.push(fn()); },
    on() { return () => {}; },
    inject(deps, fn) { fn({ remote: { ssh } }); },
    slots: {
      inject(name, fn) { slots.push(name); try { fn(); } catch { /* generator bodies do not run here */ } },
      register() { return () => {}; },
    },
    remote: {
      $mount: () => Promise.resolve(),
      $on: () => () => {},
      $stream: () => ({ dispose: () => {}, [Symbol.asyncIterator]: async function* () {} }),
    },
    uiWorkspace: {},
  };
  return { ctx, effects, slots };
}

test('apply() runs against a stubbed context and registers its seams', () => {
  const { ctx, slots, effects } = makeCtx(undefined);
  const mod = loaded.factory(requireStub);
  assert.equal(typeof mod.apply, 'function');
  assert.doesNotThrow(() => mod.apply(ctx));
  assert.ok(slots.includes('settings.section'));
  assert.ok(slots.includes('tool.call.toolview'));
  assert.ok(slots.includes('conversation.hero.workspace.directoryFlow'));
  assert.ok(effects.length >= 2);
});

test('presence paint marks remote rows and clears them when the host state disappears', async () => {
  rows = [fakeRow('w1', { title: true }), fakeRow('w2', { title: true })];
  let states = [
    { workspaceId: 'w1', hostId: 'h1', hostName: 'build-box', status: 'online' },
    { workspaceId: 'w2', hostId: 'h2', hostName: 'devuser', status: 'offline' },
  ];
  const ssh = { workspacePresence: async () => ({ ok: true, value: { states } }) };
  const { ctx } = makeCtx(ssh);
  loaded.factory(requireStub).apply(ctx);
  await tick();
  await tick();

  assert.equal(rows[0].getAttribute('data-ssh-presence'), 'online');
  assert.equal(rows[0].getAttribute('data-ssh-remote'), '');
  assert.equal(rows[0].titleNode.getAttribute('data-ssh-host'), 'build-box');
  assert.equal(rows[1].getAttribute('data-ssh-presence'), 'offline');
  assert.equal(rows[1].titleNode.getAttribute('data-ssh-host'), 'devuser');

  // The host dropped the remote workspace: the next poll paints it away.
  rows = [fakeRow('w2', { title: true })];
  rows[0].setAttribute('data-ssh-presence', 'offline');
  rows[0].setAttribute('data-ssh-remote', '');
  rows[0].titleNode.setAttribute('data-ssh-host', 'devuser');
  states = [{ workspaceId: 'w1', hostId: 'h1', hostName: 'build-box', status: 'online' }];
  await intervals[intervals.length - 1]();
  await tick();
  assert.equal(rows[0].hasAttribute('data-ssh-presence'), false);
  assert.equal(rows[0].hasAttribute('data-ssh-remote'), false);
  assert.equal(rows[0].titleNode.hasAttribute('data-ssh-host'), false);
});
