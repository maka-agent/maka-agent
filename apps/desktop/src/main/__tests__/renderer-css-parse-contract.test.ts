import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import postcss from 'postcss';
import { REPO_ROOT, readCssTree } from './css-test-helpers.js';

describe('renderer CSS parse contract', () => {
  it('keeps every renderer CSS file parseable by a strict CSS parser', async () => {
    const rendererRoot = `${REPO_ROOT}/apps/desktop/src/renderer`;
    const styleFiles = [
      `${rendererRoot}/styles.css`,
      `${rendererRoot}/reference-shell.css`,
      `${rendererRoot}/maka-tokens.css`,
      ...(await readCssTree(`${rendererRoot}/styles`)),
    ];

    for (const file of styleFiles) {
      postcss.parse(await readFile(file, 'utf8'), { from: file });
    }
  });
});
