import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readRendererShellSource } from './renderer-shell-source-helpers.js';

describe('AppShell effect stability contract', () => {
  it('keeps long-lived subscriptions on latest options instead of render-time callback closures', async () => {
    const src = await readRendererShellSource('app-shell-effects.ts');
    const bootstrapHook = extractFunction(src, 'useAppShellBootstrapSubscriptions');
    const activeSessionHook = extractFunction(src, 'useActiveSessionEvents');

    assert.match(
      src,
      /function useLatestRef<T>\(value: T\): RefBox<T> \{/,
      'AppShell effect hooks need a single latest-ref helper for long-lived subscriptions',
    );

    assert.match(
      bootstrapHook,
      /const latestOptionsRef = useLatestRef\(options\);/,
      'bootstrap subscriptions must read callbacks through a latest options ref',
    );
    assert.doesNotMatch(
      bootstrapHook,
      /const\s*\{[\s\S]*\}\s*=\s*options;/,
      'bootstrap subscriptions must not close over a hook-scope options destructure',
    );
    assert.match(
      extractUseEffect(bootstrapHook, '[]'),
      /latestOptionsRef\.current/,
      'the one-shot bootstrap effect must dereference latest options inside the mounted subscription boundary',
    );

    assert.match(
      activeSessionHook,
      /const latestOptionsRef = useLatestRef\(options\);/,
      'active-session subscriptions must read callbacks through a latest options ref',
    );
    assert.doesNotMatch(
      activeSessionHook,
      /const\s*\{[\s\S]*\b(?:handleEvent|markSessionReadLocally|setMessages|setMessageLoadErrorBySession|setSessionEventHealthBySession|toastApi)\b[\s\S]*\}\s*=\s*options;/,
      'active-session event effects may depend on activeId, but callbacks and setters must stay behind the latest options ref',
    );
    assert.match(
      extractUseEffect(activeSessionHook, '[activeId]'),
      /latestOptionsRef\.current/,
      'the active-session effect must resubscribe by activeId while reading current callbacks from latest options',
    );
  });
});

function extractFunction(src: string, functionName: string): string {
  const signatureIndex = src.indexOf(`function ${functionName}`);
  assert.notEqual(signatureIndex, -1, `${functionName} must exist`);
  const paramsStart = src.indexOf('(', signatureIndex);
  assert.notEqual(paramsStart, -1, `${functionName} must have params`);
  const paramsEnd = findMatchingPair(src, paramsStart, '(', ')');
  const bodyStart = src.indexOf('{', paramsEnd);
  assert.notEqual(bodyStart, -1, `${functionName} must have a body`);
  const bodyEnd = findMatchingBrace(src, bodyStart);
  return src.slice(signatureIndex, bodyEnd + 1);
}

function extractUseEffect(src: string, deps: string): string {
  const marker = 'useEffect(() => {';
  let searchFrom = 0;
  while (true) {
    const effectIndex = src.indexOf(marker, searchFrom);
    assert.notEqual(effectIndex, -1, `expected a useEffect with deps ${deps}`);
    const bodyStart = src.indexOf('{', effectIndex);
    const bodyEnd = findMatchingBrace(src, bodyStart);
    const afterBody = src.slice(bodyEnd, src.indexOf(');', bodyEnd) + 2);
    if (afterBody.includes(`}, ${deps});`)) {
      return src.slice(effectIndex, bodyEnd + 1);
    }
    searchFrom = bodyEnd + 1;
  }
}

function findMatchingBrace(src: string, openIndex: number): number {
  return findMatchingPair(src, openIndex, '{', '}');
}

function findMatchingPair(src: string, openIndex: number, open: string, close: string): number {
  let depth = 0;
  for (let index = openIndex; index < src.length; index += 1) {
    const char = src[index];
    if (char === open) depth += 1;
    if (char === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  assert.fail(`missing matching ${close}`);
}
