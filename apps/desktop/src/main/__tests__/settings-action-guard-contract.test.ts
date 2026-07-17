import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const repoRoot = process.cwd().endsWith('apps/desktop')
  ? join(process.cwd(), '..', '..')
  : process.cwd();

async function readRepo(path: string): Promise<string> {
  return readFile(join(repoRoot, path), 'utf8');
}

/**
 * Source contract for the shared Settings action-guard hooks.
 *
 * Before #1041 every Settings page hand-rolled the same synchronous
 * `xRef.current` re-entrancy guard plus an unmount cleanup resetting it, and
 * each page's contract test pinned that text. The guards now live in
 * use-action-guard.ts (wrapping the unit-tested createOneShotActionGuard /
 * createKeyedActionGuard seams), so the ownership invariants are pinned once
 * here; per-page contracts only assert that pages route through the hooks.
 */
describe('Settings action guard hook contract', () => {
  it('wraps the tested framework-free seams instead of new guard logic', async () => {
    const hook = await readRepo('apps/desktop/src/renderer/settings/use-action-guard.ts');

    assert.match(
      hook,
      /import \{ createOneShotActionGuard, type OneShotActionGuard \} from '\.\/oauth-login-flow-guard'/,
      'useActionGuard must reuse the unit-tested one-shot seam behind useOAuthLoginFlow',
    );
    assert.match(
      hook,
      /import \{ createKeyedActionGuard, type KeyedActionGuard \} from '\.\/action-guard'/,
      'useKeyedActionGuard must reuse the unit-tested keyed seam',
    );
    assert.match(
      hook,
      /export function useActionGuard<Action>\(\): OneShotActionGuard<Action> \{[\s\S]*createOneShotActionGuard<Action>\(\)/,
      'useActionGuard must hold the one-shot guard in a ref so the check stays synchronous across renders',
    );
    assert.match(
      hook,
      /export function useKeyedActionGuard<Key>\(\): KeyedActionGuard<Key> \{[\s\S]*createKeyedActionGuard<Key>\(\)/,
      'useKeyedActionGuard must hold the keyed guard in a ref so the check stays synchronous across renders',
    );
  });

  it('releases every guard hold on unmount', async () => {
    const hook = await readRepo('apps/desktop/src/renderer/settings/use-action-guard.ts');

    const oneShot = hook.match(/export function useActionGuard[\s\S]*?export function useKeyedActionGuard/)?.[0] ?? '';
    assert.match(
      oneShot,
      /useEffect\(\(\) => \{[\s\S]*return \(\) => \{[\s\S]*guard\.finish\(\);[\s\S]*\};[\s\S]*\}, \[\]\);/,
      'useActionGuard must release the pending action on unmount (replaces per-page xRef.current = false cleanups)',
    );
    const keyed = hook.match(/export function useKeyedActionGuard[\s\S]*$/)?.[0] ?? '';
    assert.match(
      keyed,
      /useEffect\(\(\) => \{[\s\S]*return \(\) => \{[\s\S]*guard\.reset\(\);[\s\S]*\};[\s\S]*\}, \[\]\);/,
      'useKeyedActionGuard must drop every key hold on unmount',
    );
  });

  it('keeps keyed-guard release ownership safe across reset', async () => {
    const guard = await readRepo('apps/desktop/src/renderer/settings/action-guard.ts');

    assert.match(
      guard,
      /const owners = new Map<Key, number>\(\)/,
      'the keyed guard must track an owner token per key',
    );
    assert.match(
      guard,
      /const owner = \+\+sequence;[\s\S]*owners\.set\(key, owner\);[\s\S]*if \(owners\.get\(key\) === owner\) owners\.delete\(key\);/,
      'a release must only drop its own token so a late release after reset cannot strip a newer hold',
    );
    assert.match(
      guard,
      /begin\(key: Key\): \(\(\) => void\) \| null \{[\s\S]*if \(owners\.has\(key\)\) return null;/,
      'same-key re-entry must be rejected synchronously',
    );
    assert.match(
      guard,
      /beginExclusive\(key: Key\): \(\(\) => void\) \| null \{[\s\S]*if \(owners\.size > 0\) return null;/,
      'exclusive acquisition must be rejected while any action is in flight',
    );
  });
});
