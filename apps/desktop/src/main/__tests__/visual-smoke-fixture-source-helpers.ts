import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Tests run from the compiled `dist/main/__tests__` tree, so climb back to
// the repo root and re-anchor on the SOURCE `apps/desktop/src/main` dir the
// way `renderer-shell-source-helpers` does.
const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');
const MAIN_ROOT = resolve(REPO_ROOT, 'apps', 'desktop', 'src', 'main');

// The visual-smoke fixture was split (arch Round 3) from a single
// ~2.5K-line module into a thin registry barrel
// (`visual-smoke-fixture.ts`) plus per-domain seeder modules under
// `visual-smoke/`. Source-scanning contracts (placeholder-copy hygiene,
// visible-copy hygiene) must aggregate ALL of these so the coverage that
// used to hit the monolith keeps hitting its new homes. Add a new module
// here whenever the fixture grows another domain file.
const sourcePaths = [
  'visual-smoke-fixture.ts',
  'visual-smoke/seed-helpers.ts',
  'visual-smoke/scenarios-settings.ts',
  'visual-smoke/scenarios-modules.ts',
  'visual-smoke/scenarios-artifacts.ts',
  'visual-smoke/scenarios-chat.ts',
  'visual-smoke/scenarios-sessions.ts',
] as const;

export const VISUAL_SMOKE_FIXTURE_SOURCE_REPO_PATHS: readonly string[] = sourcePaths.map(
  (sourcePath) => `apps/desktop/src/main/${sourcePath}`,
);

export async function readVisualSmokeFixtureCombinedSource(): Promise<string> {
  const sources = await Promise.all(
    sourcePaths.map((sourcePath) => readFile(resolve(MAIN_ROOT, sourcePath), 'utf8')),
  );
  return sources.join('\n');
}
