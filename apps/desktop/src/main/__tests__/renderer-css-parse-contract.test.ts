import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import postcss from 'postcss';
import { REPO_ROOT, readCssTree, stripCssComments } from './css-test-helpers.js';

type RendererCssFile = {
  file: string;
  source: string;
};

async function readRendererCssFiles(): Promise<RendererCssFile[]> {
  const rendererRoot = `${REPO_ROOT}/apps/desktop/src/renderer`;
  const styleFiles = await readCssTree(rendererRoot);
  return Promise.all(styleFiles.map(async (file) => ({
    file,
    source: await readFile(file, 'utf8'),
  })));
}

describe('renderer CSS parse contract', () => {
  it('keeps every renderer CSS file parseable by a strict CSS parser', async () => {
    for (const { file, source } of await readRendererCssFiles()) {
      postcss.parse(source, { from: file });
    }
  });

  it('does not reintroduce retired data-theme selectors', async () => {
    for (const { file, source } of await readRendererCssFiles()) {
      assert.doesNotMatch(
        stripCssComments(source),
        /html\[\s*data-theme(?:\s*[~|^$*]?=|\s*\])/,
        `${file} must use .dark / [data-maka-theme], not retired html[data-theme] selectors`,
      );
    }
  });

  it('does not reintroduce self-referential font token declarations', async () => {
    for (const { file, source } of await readRendererCssFiles()) {
      assert.doesNotMatch(
        stripCssComments(source),
        /--font-(sans|mono)\s*:\s*var\(\s*--font-\1\s*\)\s*;/,
        `${file} must not declare self-referential --font-sans / --font-mono tokens`,
      );
    }
  });

  it('keeps renderer font tokens owned by maka-tokens.css', async () => {
    const entry = await readFile(`${REPO_ROOT}/apps/desktop/src/renderer/styles.css`, 'utf8');
    const tokens = await readFile(`${REPO_ROOT}/apps/desktop/src/renderer/maka-tokens.css`, 'utf8');
    assert.doesNotMatch(
      stripCssComments(entry),
      /--font-(sans|mono)\s*:/,
      'styles.css is an import/Tailwind bridge and must not redefine product font tokens',
    );
    assert.match(tokens, /--font-sans\s*:/, 'maka-tokens.css must own --font-sans');
    assert.match(tokens, /--font-mono\s*:/, 'maka-tokens.css must own --font-mono');
  });

  it('keeps one Tailwind theme bridge in styles.css', async () => {
    const owners = (await readRendererCssFiles())
      .filter(({ source }) => /@theme\s+inline\s*\{/.test(stripCssComments(source)))
      .map(({ file }) => file.replaceAll('\\', '/'));
    assert.deepEqual(owners, [`${REPO_ROOT}/apps/desktop/src/renderer/styles.css`]);
  });
});
