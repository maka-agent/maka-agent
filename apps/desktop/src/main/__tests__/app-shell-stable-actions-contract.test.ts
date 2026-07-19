/**
 * Contract for the app-shell action-factory stabilization (issue #1043).
 *
 * The 9 `createAppShell*Actions` factories run in the AppShell render body, so
 * every render allocates fresh handler identities. That churn is observable:
 * the streaming-settle fallback effect lists `settleAssistantStreaming` in its
 * deps and therefore tears down/re-arms its 1s timer on every render while the
 * fallback is armed.
 *
 * The fix wraps every factory in `useStableActions`, which returns a facade
 * created once per component instance. The facade delegates each call to the
 * latest committed render's factory result, so handlers are both
 * identity-stable and always see fresh deps. These tests pin the delegation behavior (pure seam)
 * and the wiring contract (source seam, the repo's renderer-test idiom).
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { createDelegatingActions } from '../../renderer/stable-actions.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');

function rendererSource(file: string): string {
  return readFileSync(resolve(REPO_ROOT, 'apps/desktop/src/renderer', file), 'utf8');
}

describe('createDelegatingActions', () => {
  it('keeps facade identity stable while delegating to the latest actions', () => {
    const latest = { current: { greet: (name: string) => `hello ${name}` } };
    const facade = createDelegatingActions(latest);
    const stableGreet = facade.greet;

    // A later render re-runs the factory and swaps the ref contents.
    latest.current = { greet: (name: string) => `hi ${name}` };

    assert.equal(facade.greet, stableGreet, 'facade method identity must not change');
    assert.equal(facade.greet('maka'), 'hi maka', 'calls must reach the latest closure');
  });

  it('forwards all arguments and the return value', () => {
    const latest = { current: { add: (a: number, b: number) => a + b } };
    const facade = createDelegatingActions(latest);
    assert.equal(facade.add(2, 3), 5);
    latest.current = { add: () => 42 };
    assert.equal(facade.add(2, 3), 42);
  });

  it('fixes the key set at creation even if a later result changes shape', () => {
    const latest = { current: { a: () => 'a', b: () => 'b' } as Record<string, () => string> };
    const facade = createDelegatingActions(latest);
    latest.current = { a: () => 'A2', c: () => 'c' };
    assert.deepEqual(Object.keys(facade), ['a', 'b'], 'facade keys are fixed at creation');
    assert.equal(facade.a(), 'A2', 'surviving keys still delegate to the latest result');
  });
});

describe('AppShell action-factory stabilization', () => {
  it('runs every object-returning factory through useStableActions', () => {
    const shell = rendererSource('app-shell.tsx');
    assert.doesNotMatch(
      shell,
      /= createAppShell\w+(Actions|Handlers)\(\{/,
      'no object-returning factory may run unwrapped in the render body',
    );
    const wrapped =
      shell.match(/useStableActions\(createAppShell\w+, \{/g) ?? [];
    assert.equal(
      wrapped.length,
      9,
      `expected 9 useStableActions-wrapped factories, found ${wrapped.length}`,
    );
  });

  it('stabilizes the session-event handlers that feed effect deps', () => {
    const shell = rendererSource('app-shell.tsx');
    assert.match(
      shell,
      /\} = useStableActions\(createAppShellSessionEventHandlers, \{/,
      'settleAssistantStreaming must be identity-stable so the settle fallback timer arms once',
    );
  });

  it('removes the manual sessionRowActionHandlers ref-mirror superseded by the facade', () => {
    const shell = rendererSource('app-shell.tsx');
    assert.doesNotMatch(shell, /sessionRowActionHandlersRef/);
  });

  it('publishes the latest actions at commit time, never during render', () => {
    const hook = rendererSource('use-stable-actions.ts');
    // Lazy initialization is the only render-phase ref write React permits;
    // on updates the ref is already populated and only the layout effect
    // publishes, so an interrupted render cannot leak uncommitted closures.
    assert.match(hook, /if \(latestRef\.current === null\) latestRef\.current = actions;/);
    assert.match(hook, /useLayoutEffect\(\(\) => \{\s*latestRef\.current = actions;\s*\}\)/);
    assert.doesNotMatch(hook, /^ {2}latestRef\.current = factory\(deps\);/m);
    assert.match(hook, /useState\(\(\) => createDelegatingActions\(latestRef/);
  });
});
