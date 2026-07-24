import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { REPO_ROOT, stripCssComments } from './css-test-helpers.js';

const COMPOSER_CSS = join(
  REPO_ROOT,
  'apps/desktop/src/renderer/styles/composer.css',
);

interface CssRule {
  selectors: string[];
  body: string;
}

function rules(css: string): CssRule[] {
  return [...stripCssComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(
    (match) => ({
      selectors: match[1]
        .replace(/^[\s\S]*;/, '')
        .split(',')
        .map((selector) => selector.trim()),
      body: match[2],
    }),
  );
}

function declaration(body: string, property: string): string | undefined {
  const match = body.match(
    new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;}]+)`),
  );
  return match?.[1].trim().replace(/\s+/g, ' ');
}

describe('composer active-mode indicator visual contract', () => {
  it('shares the composer picker footprint and hover treatment without a private geometry path', async () => {
    const cssRules = rules(await readFile(COMPOSER_CSS, 'utf8'));
    const baseSelectors = [
      '.maka-composer-left-controls [data-slot="select-trigger"]',
      '.maka-composer-right-controls .maka-model-switcher-trigger',
      '.maka-composer-model-chip',
      '.maka-composer-mode-indicator',
    ];
    const baseRule = cssRules.find((rule) =>
      baseSelectors.every((selector) => rule.selectors.includes(selector)),
    );

    assert.ok(
      baseRule,
      'permission, model, and active-mode controls must share one base rule',
    );
    assert.equal(declaration(baseRule.body, 'height'), '26px');
    assert.equal(declaration(baseRule.body, 'gap'), 'var(--space-1)');
    assert.equal(
      declaration(baseRule.body, 'padding'),
      '0 var(--space-2)',
    );
    assert.equal(
      declaration(baseRule.body, 'border-radius'),
      'var(--radius-pill)',
    );

    const hoverSelectors = [
      '.maka-composer-left-controls [data-slot="select-trigger"]:hover',
      '.maka-composer-right-controls .maka-model-switcher-trigger:hover:not(:disabled):not([data-disabled])',
      '.maka-composer-model-chip:hover',
      '.maka-composer-mode-indicator:hover:not(:disabled)',
    ];
    const hoverRule = cssRules.find((rule) =>
      hoverSelectors.every((selector) => rule.selectors.includes(selector)),
    );
    assert.ok(
      hoverRule,
      'permission, model, and active-mode controls must share one hover rule',
    );
    assert.equal(
      declaration(hoverRule.body, 'background'),
      'var(--state-hover-bg)',
    );

    const privateBaseRules = cssRules.filter(
      (rule) =>
        rule !== baseRule &&
        rule.selectors.includes('.maka-composer-mode-indicator'),
    );
    for (const property of [
      'height',
      'min-height',
      'padding',
      'border',
      'border-radius',
      'background',
      'font-size',
      'line-height',
      'white-space',
    ]) {
      assert.equal(
        privateBaseRules
          .map((rule) => declaration(rule.body, property))
          .filter(Boolean).length,
        0,
        `${property} must come from the shared composer-control rule, not a private mode-indicator rule`,
      );
    }
  });
});
