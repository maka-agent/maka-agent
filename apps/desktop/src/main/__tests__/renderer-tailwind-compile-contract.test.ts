import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { compile } from 'tailwindcss';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');
const requireFromRepo = createRequire(resolve(REPO_ROOT, 'package.json'));
const STYLES_ENTRY = resolve(REPO_ROOT, 'apps/desktop/src/renderer/styles.css');

const CSS_EXPORT_ALIASES = new Map<string, string>([
  ['tailwindcss', 'tailwindcss/index.css'],
]);

describe('renderer Tailwind CSS compile contract', () => {
  it('compiles the renderer CSS entry and all imported CSS files', async () => {
    const css = await readFile(STYLES_ENTRY, 'utf8');

    await assert.doesNotReject(
      () => compile(css, {
        from: STYLES_ENTRY,
        base: dirname(STYLES_ENTRY),
        async loadStylesheet(id, base) {
          const path = id.startsWith('.')
            ? resolve(base, id)
            : requireFromRepo.resolve(CSS_EXPORT_ALIASES.get(id) ?? id);
          return {
            path,
            base: dirname(path),
            content: await readFile(path, 'utf8'),
          };
        },
      }),
    );
  });
});
