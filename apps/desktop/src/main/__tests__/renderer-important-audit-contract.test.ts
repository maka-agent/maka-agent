import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import postcss from 'postcss';
import { REPO_ROOT, readCssTree, stripCssComments } from './css-test-helpers.js';

type ImportantAllowance = {
  fileSuffix: string;
  anchor: string;
  reason: string;
};

const ALLOWLIST: ImportantAllowance[] = [
  {
    fileSuffix: 'apps/desktop/src/renderer/styles/base.css',
    anchor: '.maka-visually-hidden',
    reason: 'a11y hidden content utility',
  },
  {
    fileSuffix: 'apps/desktop/src/renderer/styles/chat-header.css',
    anchor: '.maka-palette-input-wrap input:focus',
    reason: 'a11y focus reset — palette input uses outline ring, suppress inherited box-shadow',
  },
  {
    fileSuffix: 'apps/desktop/src/renderer/styles/base.css',
    anchor: '[data-maka-reduced-motion="true"] *',
    reason: 'reduced-motion smoke/a11y override',
  },
  {
    fileSuffix: 'apps/desktop/src/renderer/styles/base.css',
    anchor: '[data-maka-visual-smoke="true"] *',
    reason: 'deterministic visual smoke fixture override',
  },
  {
    fileSuffix: 'apps/desktop/src/renderer/maka-tokens.css',
    anchor: '@media (prefers-reduced-motion: reduce)',
    reason: 'global reduced-motion token override',
  },
  {
    fileSuffix: 'apps/desktop/src/renderer/reference-shell.css',
    anchor: '.agents-sidebar',
    reason: 'shared sidebar/session primitive chrome reset',
  },
  {
    fileSuffix: 'apps/desktop/src/renderer/reference-shell.css',
    anchor: '.agents-sidebar[data-resizing="true"]',
    reason: 'shared sidebar/session primitive chrome reset',
  },
  {
    fileSuffix: 'apps/desktop/src/renderer/reference-shell.css',
    anchor: '.maka-session-panel.agents-sidebar',
    reason: 'shared sidebar/session primitive chrome reset',
  },
  {
    fileSuffix: 'apps/desktop/src/renderer/styles/module-pages/skills.css',
    anchor: '.maka-skill-library-row',
    reason: 'shared ghost button layout override',
  },
  {
    fileSuffix: 'apps/desktop/src/renderer/styles/field-focus.css',
    anchor: ':where(input, select, textarea):focus',
    reason: 'shared field ring shadow override',
  },
  {
    fileSuffix: 'apps/desktop/src/renderer/styles/onboarding.css',
    anchor: '.maka-session-list .maka-session-empty-state',
    reason: 'shared empty-state card reset in sidebar surface',
  },
  {
    fileSuffix: 'apps/desktop/src/renderer/styles/settings/nav-sidebar.css',
    anchor: '@media (prefers-reduced-motion: reduce)',
    reason: 'reduced-motion override',
  },
  {
    fileSuffix: 'apps/desktop/src/renderer/styles/sidebar.css',
    anchor: '.maka-session-panel[data-collapsed="true"] .maka-list-stack',
    reason: 'shared list/empty-state collapse override',
  },
];

const RETIRED_RING_RESET_BLOCKS = [
  {
    fileSuffix: 'apps/desktop/src/renderer/styles/module-pages/skills.css',
    anchor: '.maka-skill-search input',
  },
  {
    fileSuffix: 'apps/desktop/src/renderer/styles/onboarding.css',
    anchor: '.maka-onboarding-quickchat .maka-onboarding-quickchat-input',
  },
  {
    fileSuffix: 'apps/desktop/src/renderer/styles/composer.css',
    anchor: '.composer .maka-composer-textarea',
  },
];

function isAllowed(file: string, source: string): boolean {
  return ALLOWLIST.some((entry) => file.endsWith(entry.fileSuffix) && source.includes(entry.anchor));
}

function isA11yOnlyFile(file: string): boolean {
  return (
    file.endsWith('apps/desktop/src/renderer/styles/base.css') ||
    file.endsWith('apps/desktop/src/renderer/maka-tokens.css') ||
    file.endsWith('apps/desktop/src/renderer/styles/settings/nav-sidebar.css')
  );
}

function readRuleBody(source: string, anchor: string): string | null {
  const start = source.indexOf(anchor);
  if (start === -1) return null;

  const open = source.indexOf('{', start);
  if (open === -1) return null;

  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const ch = source[index];
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(open + 1, index);
      }
    }
  }

  return null;
}

function findFieldFocusSelector(source: string): string | null {
  const root = postcss.parse(source);
  let selector: string | null = null;
  root.walkRules((rule) => {
    if (rule.selector.includes('data-maka-field-chrome') && rule.selector.includes(':focus')) {
      selector = rule.selector;
    }
  });
  return selector;
}

describe('renderer !important audit contract', () => {
  it('keeps non-a11y `!important` sites explicitly justified and allowlisted', async () => {
    const rendererRoot = `${REPO_ROOT}/apps/desktop/src/renderer`;
    const styleFiles = [
      `${rendererRoot}/reference-shell.css`,
      `${rendererRoot}/maka-tokens.css`,
      ...(await readCssTree(`${rendererRoot}/styles`)),
    ];

    const violations: string[] = [];
    for (const file of styleFiles.sort()) {
      const source = await readFile(file, 'utf8');
      if (!source.includes('!important')) continue;

      const importantSites = [...source.matchAll(/!important/g)];
      if (importantSites.length === 0) continue;

      if (isA11yOnlyFile(file)) {
        continue;
      }

      if (!source.includes('Justified:') || !isAllowed(file, source)) {
        violations.push(file.replace(REPO_ROOT + '/', ''));
      }
    }

    assert.deepEqual(
      violations,
      [],
      'Non-a11y `!important` usage must be explicitly justified in-file and tracked in renderer-important-audit-contract.test.ts.',
    );
  });

  it('keeps embedded bare fields off page-level important ring resets', async () => {
    const fieldFocus = stripCssComments(await readFile(`${REPO_ROOT}/apps/desktop/src/renderer/styles/field-focus.css`, 'utf8'));
    const fieldFocusSelector = findFieldFocusSelector(fieldFocus);
    assert.equal(
      fieldFocusSelector,
      ':where(input, select, textarea):focus:not(:where([data-maka-field-chrome="none"]))',
      'the global renderer field focus rule must skip explicit bare fields without increasing selector specificity',
    );

    for (const entry of RETIRED_RING_RESET_BLOCKS) {
      const file = `${REPO_ROOT}/${entry.fileSuffix}`;
      const source = stripCssComments(await readFile(file, 'utf8'));
      const body = readRuleBody(source, entry.anchor);
      assert.notEqual(body, null, `${entry.anchor} rule not found in ${entry.fileSuffix}`);
      assert.doesNotMatch(
        body ?? '',
        /!important|--tw-ring-(?:offset-)?shadow/,
        `${entry.anchor} must route through the explicit bare field path instead of resetting primitive ring chrome in page CSS.`,
      );
    }
  });
});
