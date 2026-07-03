import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

test('dev launcher bundles app main sources without compiling main-process tests', async () => {
  const cwd = process.cwd();
  const desktopRoot = cwd.endsWith(join('apps', 'desktop')) ? cwd : join(cwd, 'apps', 'desktop');
  const devScript = await readFile(join(desktopRoot, 'scripts', 'dev.mjs'), 'utf8');
  // dev.mjs now calls esbuild's JS API instead of `node bin/esbuild`
  // (postinstall replaces that file with a platform-native binary that
  // node cannot execute) — assert on the API options instead of CLI flags.
  assert.match(devScript, /esbuildBuild\(/);
  assert.match(devScript, /src\/main\/main\.ts/);
  assert.match(devScript, /bundle:\s*true/);
  assert.match(devScript, /packages:\s*'external'/);
  assert.doesNotMatch(devScript, /\['tsc', '-p'/);
  assert.doesNotMatch(devScript, /tsconfig\.main\.app\.json/);
});

test('dev launcher tears down the Electron process tree on Windows', async () => {
  const cwd = process.cwd();
  const desktopRoot = cwd.endsWith(join('apps', 'desktop')) ? cwd : join(cwd, 'apps', 'desktop');
  const devScript = await readFile(join(desktopRoot, 'scripts', 'dev.mjs'), 'utf8');

  assert.match(devScript, /taskkill/);
  assert.match(devScript, /\/T/);
  assert.match(devScript, /\/F/);
});
