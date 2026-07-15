import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readAllRendererCss, stripCssComments } from './css-test-helpers.js';

describe('docked composer boundary contract', () => {
  it('lets the message viewport meet the composer card without a background strip', async () => {
    const css = stripCssComments(await readAllRendererCss());
    const dockedComposerRule = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .find(([, selector]) =>
        selector.includes('.mainColumn:not([data-home-surface="true"])') &&
        /\.composer\s*$/.test(selector.trim()),
      );

    assert.ok(dockedComposerRule, 'expected a docked active-session composer rule');
    assert.match(
      dockedComposerRule[2],
      /padding-top\s*:\s*0\s*;/,
      'the docked composer top padding exposes the panel background between the transcript and card',
    );
  });
});
