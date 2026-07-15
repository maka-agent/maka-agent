import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readAllRendererCss, stripCssComments } from './css-test-helpers.js';

describe('composer focus shadow contract', () => {
  it('keeps docked elevation shadows out of the focused composer state', async () => {
    const css = stripCssComments(await readAllRendererCss());
    const dockedShadowSelectors = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter(([, selector, body]) =>
        selector.includes('.mainColumn') &&
        selector.includes('.maka-composer-inner') &&
        /box-shadow\s*:\s*(?!none\b)/.test(body),
      )
      .map(([, selector]) => selector.trim().replace(/\s+/g, ' '));

    assert.ok(dockedShadowSelectors.length > 0, 'expected a docked composer elevation rule');
    assert.deepEqual(
      dockedShadowSelectors.filter((selector) => !selector.includes(':not(:focus-within)')),
      [],
      'docked elevation must be rest-only so :focus-within keeps the single focus ring',
    );
  });
});
