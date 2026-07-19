import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { applyAssistantComplete, getDailyReviewCopy, getPlanReminderCopy, getSharedUiCopy, getSkillsCopy, modelMenuGroups } from '@maka/ui';
import { getOpenGatewaySettingsCopy } from '../../renderer/locales/settings-open-gateway-copy.js';
import {
  findInlineCjkLiterals,
  findSilentCatalogFallbacks,
  formatSourceViolations,
} from './localized-source-contract-helpers.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');

const PR4_SHARED_UI_PRESENTATION_FILES = [
  'packages/ui/src/capability-audit-strip.tsx',
  'packages/ui/src/artifact-preview-registry.ts',
  'packages/ui/src/assistant-stream.ts',
  'packages/ui/src/chat-model-helpers.ts',
  'packages/ui/src/chat-model-switcher.tsx',
  'packages/ui/src/daily-review-helpers.ts',
  'packages/ui/src/daily-review-panel.tsx',
  'packages/ui/src/markdown-body.tsx',
  'packages/ui/src/model-picker.tsx',
  'packages/ui/src/module-pages.tsx',
  'packages/ui/src/plan-reminder-form-dialog.tsx',
  'packages/ui/src/plan-reminder-helpers.ts',
  'packages/ui/src/plan-reminder-panel.tsx',
  'packages/ui/src/skills-panel.tsx',
  'packages/ui/src/primitives/spinner.tsx',
  'packages/ui/src/task-ledger-panel.tsx',
  'packages/ui/src/thinking-stream.ts',
  'packages/ui/src/tool-output-stream.ts',
  'packages/ui/src/toast.tsx',
  'packages/ui/src/ui.tsx',
  'packages/ui/src/use-mention-popup.ts',
] as const;

const PR4_SHARED_UI_CATALOG_FILES = [
  'packages/ui/src/daily-review-copy.ts',
  'packages/ui/src/plan-reminder-copy.ts',
  'packages/ui/src/shared-ui-copy.ts',
  'packages/ui/src/skills-copy.ts',
] as const;

const PR4_DESKTOP_PRESENTATION_FILES = [
  'apps/desktop/src/renderer/settings/open-gateway-settings-page.tsx',
] as const;

const PR4_DESKTOP_CATALOG_FILES = [
  'apps/desktop/src/renderer/locales/settings-open-gateway-copy.ts',
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
    assert.equal(getPlanReminderCopy('zh').page.title, '定时任务');
    assert.equal(getPlanReminderCopy('en').page.title, 'Scheduled tasks');
    assert.equal(getSkillsCopy('zh').page.title, '技能');
    assert.equal(getSkillsCopy('en').page.title, 'Skills');
    assert.match(applyAssistantComplete('x'.repeat(100), { maxTotalChars: 40, locale: 'en' }).text, /remaining output truncated/);
    assert.equal(modelMenuGroups([{ connectionSlug: 'custom', providerType: 'openai-compatible', model: 'm', label: 'M' }], 'en')[0]?.heading, 'Custom');
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

describe('PR4 remaining desktop copy contract', () => {
  it('selects complete independent copy for both locales', () => {
    assert.equal(getOpenGatewaySettingsCopy('zh').summary.status, '状态');
    assert.equal(getOpenGatewaySettingsCopy('en').summary.status, 'Status');
    assert.equal(getOpenGatewaySettingsCopy('en').endpoints.health.title, 'Health check');
  });

  it('contains no inline user-visible Chinese in migrated desktop owners', () => {
    const violations = PR4_DESKTOP_PRESENTATION_FILES.flatMap((file) =>
      findInlineCjkLiterals(repoSource(file), file),
    );
    assert.equal(violations.length, 0, formatSourceViolations(violations));
  });

  it('does not silently fall English copy back to Chinese', () => {
    const violations = PR4_DESKTOP_CATALOG_FILES.flatMap((file) =>
      findSilentCatalogFallbacks(repoSource(file), file),
    );
    assert.equal(violations.length, 0, formatSourceViolations(violations));
  });
});
