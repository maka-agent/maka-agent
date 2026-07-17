import { strict as assert } from 'node:assert';
import { readdir, readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { describe, it } from 'node:test';

const REPO_ROOT = resolve(import.meta.dirname, '../../../..');
const PATH_CONTAINMENT_HOME = resolve(REPO_ROOT, 'packages/runtime/src/path-containment.ts');

// Production source roots that may define path-containment predicates.
const SCAN_ROOTS = ['packages/runtime/src', 'packages/headless/src', 'packages/storage/src', 'apps/desktop/src/main'];

// Names retired in #1145 when every "inside or equal to root" caller moved to
// the shared `isPathInside`. Defining one again re-introduces a parallel
// containment implementation; new callers must import `isPathInside` from
// `@maka/runtime` (or `./path-containment.js` inside the runtime package). The
// strict-interior family (`isInsideOrSamePath` / `isInsideCwd`, where the target
// may not equal root) is a deliberately different semantic and stays allowed.
const RETIRED = ['isInside', 'isContainedPath', 'isInsidePosix', 'pathWithinRoot'];
const RETIRED_RE = new RegExp(`(?:export\\s+)?function\\s+(${RETIRED.join('|')})\\b`);

async function* walk(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (['node_modules', '__tests__', 'dist', '.worktree', '.pi'].includes(entry.name)) continue;
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.name.endsWith('.ts')) yield full;
  }
}

describe('containment-guard contract', () => {
  it('the shared isPathInside home exists and exports isPathInside', async () => {
    const home = await readFile(PATH_CONTAINMENT_HOME, 'utf8');
    assert.match(home, /export function isPathInside\b/, 'path-containment.ts must export isPathInside');
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
