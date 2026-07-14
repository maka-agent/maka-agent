import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const source = await readFile(
  new URL('../../../src/overlay/cursor-overlay-preload.ts', import.meta.url),
  'utf8',
);

test('cursor overlay preload exposes only fixed presentation acknowledgements', () => {
  assert.match(source, /ipcRenderer\.send\('overlay:presentation-phase'/);
  assert.equal(source.match(/ipcRenderer\.send\(/g)?.length, 1);
  assert.match(
    source,
    /ipcRenderer\.send\('overlay:presentation-phase', \{[\s\S]*sessionId,[\s\S]*generation,[\s\S]*actionId,[\s\S]*phase,[\s\S]*\}\)/,
  );
  assert.match(source, /typeof sessionId !== 'string'/);
  assert.match(source, /Number\.isInteger\(generation\)/);
  assert.match(source, /phase !== 'readyForInteraction'/);
  assert.match(source, /phase !== 'finished'/);
  assert.match(source, /ipcRenderer\.on\('overlay:cancel'/);
  assert.doesNotMatch(source, /ipcRenderer\.(?:invoke|sendSync)\(/);
  assert.doesNotMatch(source, /screenX|screenY|CuAction/);
});
