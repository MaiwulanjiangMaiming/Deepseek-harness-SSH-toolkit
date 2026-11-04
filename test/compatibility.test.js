// dsh-app-boot's compatibility gate reads engines.dsh (which wins over peers) or
// every @deepseek-ai/dsh* peer. Both must cover the RC line the DSH next channel
// ships, or an otherwise working plugin is rejected on install.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('DSH requirement range covers 0.2.1-rc.4 through 0.2.x', () => {
  assert.equal(pkg.engines.dsh, '>=0.2.1-rc.4 <0.3.0');
  for (const [name, range] of Object.entries(pkg.peerDependencies)) {
    if (name.startsWith('@deepseek-ai/dsh')) {
      assert.equal(range, pkg.engines.dsh, 'peer range for ' + name + ' must match engines.dsh');
    }
  }
});
