import { strict as assert } from 'node:assert';
import { readdir, readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { describe, it } from 'node:test';

const REPO_ROOT = resolve(import.meta.dirname, '../../../..');
const PATH_CONTAINMENT_HOME = resolve(REPO_ROOT, 'packages/runtime/src/path-containment.ts');

// Scan every TypeScript source tree under the monorepo; `walk` prunes tests,
// build output, deps, worktrees, and Playwright e2e.
const SCAN_ROOTS = ['packages', 'apps'];

// Names retired in #1145 when every "inside or equal to root" caller moved to
// the shared `isPathInside`. Defining one again — as a function, const, let, or
// var — re-introduces a parallel containment implementation; new callers must
// import `isPathInside` from `@maka/runtime` (or `./path-containment.js` inside
// the runtime package). The strict-interior family (`isInsideOrSamePath` /
// `isInsideCwd`) is a deliberately different semantic and stays allowed;
// unifying it with `isPathInside` is tracked separately (out of scope for #1145).
// `pathWithinRoot` is intentionally NOT
// retired: `packages/core` has same-named helpers that do POSIX policy-string
// prefix matching (`trimTrailingSlashes` + `startsWith`), not `node:path`
// relative containment, so the name is not a reliable signal across packages.
const RETIRED = ['isInside', 'isContainedPath', 'isInsidePosix'];
const RETIRED_RE = new RegExp(
  `(?:export\\s+)?(?:function|(?:const|let|var))\\s+(${RETIRED.join('|')})\\b`,
);

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

describe('containment-guard contract', () => {
  it('the shared isPathInside home exists and exports isPathInside', async () => {
    const home = await readFile(PATH_CONTAINMENT_HOME, 'utf8');
    assert.match(
      home,
      /export function isPathInside\b/,
      'path-containment.ts must export isPathInside',
    );
  });

  it('no retired private containment predicate is redefined outside the shared home', async () => {
    const offenders: string[] = [];
    for (const root of SCAN_ROOTS) {
      for await (const file of walk(resolve(REPO_ROOT, root))) {
        if (file === PATH_CONTAINMENT_HOME) continue;
        const text = await readFile(file, 'utf8');
        const match = text.match(RETIRED_RE);
        if (match) offenders.push(`${relative(REPO_ROOT, file)} redefines retired "${match[1]}"`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      'Retired containment predicates must not be redefined; import isPathInside from @maka/runtime instead.',
    );
  });
});
