import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { REPO_ROOT, readCssTree } from './css-test-helpers.js';

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
    fileSuffix: 'apps/desktop/src/renderer/styles/module-pages.css',
    anchor: '.maka-skill-library-row',
    reason: 'shared ghost button layout override',
  },
  {
    fileSuffix: 'apps/desktop/src/renderer/styles/module-pages.css',
    anchor: ':where(input, select, textarea):focus',
    reason: 'shared field ring shadow override',
  },
  {
    fileSuffix: 'apps/desktop/src/renderer/styles/module-pages.css',
    anchor: '.maka-skill-search input',
    reason: 'shared input ring reset inside wrapper-owned surface, defensive against the global focus rule above being scoped away',
  },
  {
    fileSuffix: 'apps/desktop/src/renderer/styles/onboarding.css',
    anchor: '.maka-onboarding-quickchat-input',
    reason: 'shared textarea chrome reset inside wrapper-owned surface',
  },
  {
    fileSuffix: 'apps/desktop/src/renderer/styles/onboarding.css',
    anchor: '.maka-onboarding-quickchat-input:focus-visible',
    reason: 'shared textarea ring reset inside wrapper-owned surface',
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
  {
    fileSuffix: 'apps/desktop/src/renderer/styles/tool-output.css',
    anchor: '.composer .maka-composer-textarea',
    reason: 'shared textarea chrome reset inside composer wrapper',
  },
  {
    fileSuffix: 'apps/desktop/src/renderer/styles/tool-output.css',
    anchor: '.composer textarea:focus',
    reason: 'shared textarea ring reset inside composer wrapper',
  },
  {
    fileSuffix: 'apps/desktop/src/renderer/styles/tool-output.css',
    anchor: '.composer textarea:focus-visible',
    reason: 'shared textarea ring reset inside composer wrapper',
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
});
