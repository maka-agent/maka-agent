import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { getDailyReviewCopy, getSharedUiCopy } from '@maka/ui';
import {
  findInlineCjkLiterals,
  findSilentCatalogFallbacks,
  formatSourceViolations,
} from './localized-source-contract-helpers.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');

const PR4_SHARED_UI_PRESENTATION_FILES = [
  'packages/ui/src/capability-audit-strip.tsx',
  'packages/ui/src/daily-review-helpers.ts',
  'packages/ui/src/daily-review-panel.tsx',
  'packages/ui/src/markdown-body.tsx',
  'packages/ui/src/model-picker.tsx',
  'packages/ui/src/module-pages.tsx',
  'packages/ui/src/primitives/spinner.tsx',
  'packages/ui/src/task-ledger-panel.tsx',
  'packages/ui/src/toast.tsx',
  'packages/ui/src/ui.tsx',
] as const;

const PR4_SHARED_UI_CATALOG_FILES = [
  'packages/ui/src/daily-review-copy.ts',
  'packages/ui/src/shared-ui-copy.ts',
] as const;

function repoSource(file: string): string {
  return readFileSync(resolve(REPO_ROOT, file), 'utf8');
}

describe('PR4 remaining shared UI copy contract', () => {
  it('selects complete independent copy for both locales', () => {
    assert.equal(getSharedUiCopy('zh').modelPicker.empty, '没有匹配的模型');
    assert.equal(getSharedUiCopy('en').modelPicker.empty, 'No matching models');
    assert.equal(getSharedUiCopy('en').taskLedger.status.pending, 'Pending');
    assert.equal(getDailyReviewCopy('zh').page.title, '每日回顾');
    assert.equal(getDailyReviewCopy('en').page.title, 'Daily review');
  });

  it('contains no inline user-visible Chinese in migrated shared UI owners', () => {
    const violations = PR4_SHARED_UI_PRESENTATION_FILES.flatMap((file) =>
      findInlineCjkLiterals(repoSource(file), file),
    );
    assert.equal(violations.length, 0, formatSourceViolations(violations));
  });

  it('does not silently fall English copy back to Chinese', () => {
    const violations = PR4_SHARED_UI_CATALOG_FILES.flatMap((file) =>
      findSilentCatalogFallbacks(repoSource(file), file),
    );
    assert.equal(violations.length, 0, formatSourceViolations(violations));
  });
});
