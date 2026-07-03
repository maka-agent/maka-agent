import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { resolve } from 'node:path';
import { RENDERER_STYLES_DIR, stripCssComments } from './css-test-helpers.js';

const MODULE_PAGES_ENTRY = resolve(RENDERER_STYLES_DIR, 'module-pages.css');

const EXPECTED_MODULE_PAGE_IMPORTS = [
  './module-pages/plan-reminders.css',
  './module-pages/capability-audit.css',
  './module-pages/module-shell.css',
  './module-pages/skills.css',
];

function readCssImports(source: string): string[] {
  return [...source.matchAll(/@import\s+"([^"]+)";/g)].map((match) => match[1]);
}

describe('renderer module styles contract', () => {
  it('keeps module-pages.css as an ordered import manifest', async () => {
    const source = await readFile(MODULE_PAGES_ENTRY, 'utf8');

    assert.deepEqual(readCssImports(source), EXPECTED_MODULE_PAGE_IMPORTS);

    const nonImportSource = stripCssComments(source)
      .replace(/@import\s+"[^"]+";\s*/g, '')
      .trim();

    assert.equal(
      nonImportSource,
      '',
      'module-pages.css should only import focused module style files; put new rules in the owned child stylesheet.',
    );
  });
});
