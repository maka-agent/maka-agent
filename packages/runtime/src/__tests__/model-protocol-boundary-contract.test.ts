/**
 * Source-contract guard for the ModelAdapter provider boundary (#1381 slice 1).
 *
 * Mirrors the `containment-guard-contract` pattern: scan the monorepo source
 * trees and fail if a file outside the adapter boundary re-introduces a direct
 * AI SDK *protocol* import. The seam established by #1390 means runtime/CLI
 * consumers import `ModelMessage` / `JSONValue` from `@maka/runtime`
 * (re-exported from `./model-protocol.js`) instead of from `ai`; this test
 * keeps that property cheap and enforceable as the codebase evolves.
 *
 * The two allowed homes are:
 *   - `packages/runtime/src/model-protocol.ts` — the type seam (the only place
 *     that may import the SDK message/value types).
 *   - `packages/runtime/src/model-adapter.ts` — the value/implementation
 *     boundary (dynamic `import('ai')` for `streamText` / `generateText` lives
 *     here; protocol lowering/normalization is owned here).
 *
 * Schema helpers (`jsonSchema` / `zodSchema`), `RetryError`, and
 * `generateText` / `LanguageModel` value imports are deliberately out of scope
 * for slice 1 (RFC #1381 follow-up Q2/Q4) and are NOT policed by this guard —
 * only the message/value protocol symbols are.
 */
import { strict as assert } from 'node:assert';
import { readdir, readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { describe, it } from 'node:test';

const REPO_ROOT = resolve(import.meta.dirname, '../../../..');
const PROTOCOL_HOME = resolve(REPO_ROOT, 'packages/runtime/src/model-protocol.ts');
const ADAPTER_HOME = resolve(REPO_ROOT, 'packages/runtime/src/model-adapter.ts');
const ALLOWED_HOMES = new Set([PROTOCOL_HOME, ADAPTER_HOME]);

// Scan every TypeScript source tree under the monorepo; `walk` prunes tests,
// build output, deps, worktrees, and Playwright e2e (mirrors the containment
// guard's traversal so the two contracts stay consistent).
const SCAN_ROOTS = ['packages', 'apps'];

// SDK protocol symbols that must not cross the ModelAdapter boundary into
// runtime/CLI consumers. Re-importing either from `ai` / `@ai-sdk/*` outside
// the two homes re-opens the leak #1390 closed.
const PROTOCOL_SYMBOLS = new Set(['ModelMessage', 'JSONValue']);
const IMPORT_RE = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"](?:ai|@ai-sdk\/[^'"]+)['"]/g;

async function* walk(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (['node_modules', '__tests__', 'dist', '.worktree', '.pi', 'e2e'].includes(entry.name))
      continue;
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) yield full;
  }
}

function importedProtocolSymbols(fileText: string): string[] {
  const found: string[] = [];
  for (const match of fileText.matchAll(IMPORT_RE)) {
    for (const spec of match[1].split(',')) {
      // `ModelMessage` or `ModelMessage as Foo` — flag the source binding.
      const name = spec.split(' as ')[0].trim();
      if (PROTOCOL_SYMBOLS.has(name)) found.push(name);
    }
  }
  return found;
}

describe('model-protocol boundary contract', () => {
  it('the protocol seam home exists and exports ModelMessage and JSONValue', async () => {
    const home = await readFile(PROTOCOL_HOME, 'utf8');
    assert.match(home, /export type ModelMessage\b/, 'model-protocol.ts must export ModelMessage');
    assert.match(home, /export type JSONValue\b/, 'model-protocol.ts must export JSONValue');
  });

  it('no source outside the adapter boundary imports ModelMessage/JSONValue from ai or @ai-sdk/*', async () => {
    const offenders: string[] = [];
    for (const root of SCAN_ROOTS) {
      for await (const file of walk(resolve(REPO_ROOT, root))) {
        if (ALLOWED_HOMES.has(file)) continue;
        const text = await readFile(file, 'utf8');
        const symbols = importedProtocolSymbols(text);
        if (symbols.length > 0) {
          offenders.push(
            `${relative(REPO_ROOT, file)} imports ${symbols.join(', ')} from ai/ai-sdk`,
          );
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      'ModelMessage/JSONValue must be imported from @maka/runtime (or ./model-protocol.js), not from ai. ' +
        'Re-introducing a direct SDK protocol import outside model-protocol.ts/model-adapter.ts re-opens the #1381 slice-1 leak.',
    );
  });
});
