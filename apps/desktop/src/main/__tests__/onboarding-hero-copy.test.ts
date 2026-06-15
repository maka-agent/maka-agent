/**
 * Tests for `getOnboardingHeroCopy` (PR110c).
 *
 * Locks the per-`OnboardingState.kind` copy + CTA mapping:
 *  - every variant returns a structure (or null for `ready_with_history`)
 *  - no raw `state.kind` enum identifier leaks into eyebrow / title /
 *    body / cta.label
 *  - Chinese-only copy
 *  - slug-only promise for per-connection variants (no connectionName /
 *    model list leaked)
 *  - `blocked: all_connections_unhealthy` is labeled (not a generic
 *    default), and its CTA points to `account` (not `models`)
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readFile } from 'node:fs/promises';
import type { OnboardingState } from '@maka/core';
import { getOnboardingHeroCopy, getOnboardingSetupSteps } from '../../renderer/onboarding-hero-copy.js';

// Every OnboardingState.kind string. Any rendered field MUST NOT
// contain one of these as a substring — Chinese-only copy.
const RAW_KINDS = [
  'needs_connection',
  'needs_default_connection',
  'needs_connection_credentials',
  'needs_default_model',
  'ready_empty',
  'ready_with_history',
  'blocked',
  'all_connections_unhealthy',
] as const;

function renderedFields(copy: ReturnType<typeof getOnboardingHeroCopy>): string[] {
  if (!copy) return [];
  return [copy.eyebrow, copy.title, copy.body, copy.cta.label];
}

describe('getOnboardingHeroCopy — per-variant mapping', () => {
  it('needs_connection produces a welcome eyebrow + models CTA', () => {
    const copy = getOnboardingHeroCopy({ kind: 'needs_connection' } as OnboardingState);
    assert.ok(copy);
    assert.equal(copy.kind, 'needs_connection');
    assert.equal(copy.cta.settingsSection, 'models');
    assert.match(copy.title, /[一-鿿]/);
    assert.equal(copy.showQuickChat, undefined);
  });

  it('needs_default_connection routes to settings · models', () => {
    const copy = getOnboardingHeroCopy({ kind: 'needs_default_connection' } as OnboardingState);
    assert.ok(copy);
    assert.equal(copy.cta.settingsSection, 'models');
    assert.match(copy.body, /默认/);
  });

  it('needs_connection_credentials carries the connectionSlug but no connectionName promise', () => {
    const copy = getOnboardingHeroCopy({
      kind: 'needs_connection_credentials',
      connectionSlug: 'anthropic-live',
    } as OnboardingState);
    assert.ok(copy);
    assert.equal(copy.connectionSlug, 'anthropic-live');
    assert.equal(copy.cta.settingsSection, 'models');
    // PR110c slug-only promise: body must NOT include something that
    // looks like a fabricated connectionName / human label. The body
    // string from the helper itself doesn't reference the slug — the
    // hero component renders the slug via the `connectionSlug` field
    // as a `<code>`. The body MUST NOT include the literal slug to
    // avoid promising a sanitized name.
    assert.equal(
      copy.body.includes('anthropic-live'),
      false,
      'body should not embed the raw slug; component renders it as a separate <code>',
    );
    assert.match(copy.body, /等待填写 API key/);
    assert.doesNotMatch(copy.body, /缺少可用的 API key/);
  });

  it('needs_default_model carries the connectionSlug and points to models', () => {
    const copy = getOnboardingHeroCopy({
      kind: 'needs_default_model',
      connectionSlug: 'openai-live',
    } as OnboardingState);
    assert.ok(copy);
    assert.equal(copy.connectionSlug, 'openai-live');
    assert.equal(copy.cta.settingsSection, 'models');
    assert.match(copy.body, /模型/);
  });

  it('ready_empty sets showQuickChat = true', () => {
    const copy = getOnboardingHeroCopy({
      kind: 'ready_empty',
      defaultConnectionSlug: 'a',
      defaultModel: 'm',
    } as OnboardingState);
    assert.ok(copy);
    assert.equal(copy.showQuickChat, true);
    assert.match(copy.cta.label, /开始对话/);
  });

  it('blocked: all_connections_unhealthy is labeled, routes to settings · account, warning tone', () => {
    // @kenji PR110c review gate: blocked must NOT fall through a
    // generic default. The branch is labeled and routes to account
    // (where lastTestStatus / re-test surfaces live), not models.
    const copy = getOnboardingHeroCopy({
      kind: 'blocked',
      reason: 'all_connections_unhealthy',
    } as OnboardingState);
    assert.ok(copy);
    assert.equal(copy.kind, 'blocked');
    assert.equal(copy.tone, 'warning');
    assert.equal(copy.cta.settingsSection, 'account');
    assert.match(copy.eyebrow, /等待恢复模型连接/);
    assert.match(copy.title, /没有通过验证/);
    assert.doesNotMatch(renderedFields(copy).join('\n'), /连接暂不可用|所有模型连接都不可用/);
  });

  it('ready_with_history returns null (hero must NOT mount)', () => {
    const copy = getOnboardingHeroCopy({
      kind: 'ready_with_history',
      defaultConnectionSlug: 'a',
      defaultModel: 'm',
    } as OnboardingState);
    assert.equal(copy, null);
  });
});

describe('getOnboardingHeroCopy — invariants', () => {
  // Every state variant we currently render.
  const ALL_VARIANTS: OnboardingState[] = [
    { kind: 'needs_connection' },
    { kind: 'needs_default_connection' },
    { kind: 'needs_connection_credentials', connectionSlug: 'anthropic-live' },
    { kind: 'needs_default_model', connectionSlug: 'openai-live' },
    { kind: 'ready_empty', defaultConnectionSlug: 'a', defaultModel: 'm' },
    { kind: 'blocked', reason: 'all_connections_unhealthy' },
  ];

  it('no raw state.kind / blocked.reason identifier leaks into rendered copy', () => {
    for (const variant of ALL_VARIANTS) {
      const copy = getOnboardingHeroCopy(variant);
      assert.ok(copy, `${variant.kind} should produce copy`);
      for (const field of renderedFields(copy)) {
        for (const token of RAW_KINDS) {
          assert.equal(
            field.includes(token),
            false,
            `${variant.kind} rendered field "${field}" leaks raw token "${token}"`,
          );
        }
      }
    }
  });

  it('every rendered field is Chinese (no English / ASCII-only labels)', () => {
    for (const variant of ALL_VARIANTS) {
      const copy = getOnboardingHeroCopy(variant);
      assert.ok(copy);
      // Eyebrow is allowed to include uppercase Latin tags (e.g.
      // "READY · 开始对话") because the design uses it as a small
      // banner; title / body / cta.label must contain Chinese.
      for (const [name, value] of [
        ['title', copy.title],
        ['body', copy.body],
        ['cta.label', copy.cta.label],
      ] as const) {
        assert.match(value, /[一-鿿]/, `${variant.kind} ${name} should contain Chinese: "${value}"`);
      }
    }
  });

  it('CTA settingsSection is always a known SettingsSection', () => {
    // Soft sanity — the type system already enforces this, but
    // anchor the gate so a future loosening to `string` is caught.
    const knownSections = new Set([
      'general',
      'personalization',
      'theme',
      'daily-review',
      'models',
      'usage',
      'voice-models',
      'open-gateway',
      'bot-chat',
      'search',
      'network',
      'data',
      'account',
      'about',
    ]);
    for (const variant of ALL_VARIANTS) {
      const copy = getOnboardingHeroCopy(variant);
      assert.ok(copy);
      assert.ok(knownSections.has(copy.cta.settingsSection), `${variant.kind} bad CTA section`);
    }
  });

  it('only ready_empty enables Quick Chat surface', () => {
    for (const variant of ALL_VARIANTS) {
      const copy = getOnboardingHeroCopy(variant);
      assert.ok(copy);
      if (variant.kind === 'ready_empty') {
        assert.equal(copy.showQuickChat, true);
      } else {
        assert.notEqual(copy.showQuickChat, true, `${variant.kind} must not enable Quick Chat`);
      }
    }
  });

  it('only blocked carries warning tone', () => {
    for (const variant of ALL_VARIANTS) {
      const copy = getOnboardingHeroCopy(variant);
      assert.ok(copy);
      if (variant.kind === 'blocked') {
        assert.equal(copy.tone, 'warning');
      } else {
        assert.equal(copy.tone, undefined, `${variant.kind} must not have warning tone`);
      }
    }
  });
});

describe('getOnboardingSetupSteps — first-run AI setup guide', () => {
  it('guides completely new users through AI setup before first chat', () => {
    const steps = getOnboardingSetupSteps({ kind: 'needs_connection' } as OnboardingState);
    assert.ok(steps);
    assert.deepEqual(
      steps.map((step) => step.state),
      ['active', 'pending', 'pending'],
    );
    assert.match(steps.map((step) => step.label).join('\n'), /选择 AI 接入/);
    assert.match(steps.map((step) => step.detail).join('\n'), /API key|OAuth/);
    assert.match(steps.map((step) => step.detail).join('\n'), /测试并设默认|开始第一条对话/);
  });

  it('moves the active setup step to the exact missing AI configuration', () => {
    const cases: Array<[OnboardingState, string]> = [
      [{ kind: 'needs_default_connection' } as OnboardingState, '设为默认'],
      [
        {
          kind: 'needs_connection_credentials',
          connectionSlug: 'anthropic-live',
        } as OnboardingState,
        '补齐认证',
      ],
      [
        {
          kind: 'needs_default_model',
          connectionSlug: 'openai-live',
        } as OnboardingState,
        '选择聊天模型',
      ],
      [
        {
          kind: 'blocked',
          reason: 'all_connections_unhealthy',
        } as OnboardingState,
        '修复认证或网络',
      ],
    ];

    for (const [state, expectedActiveLabel] of cases) {
      const steps = getOnboardingSetupSteps(state);
      assert.ok(steps, `${state.kind} should expose setup steps`);
      assert.equal(steps.length, 3);
      const activeSteps = steps.filter((step) => step.state === 'active');
      assert.equal(activeSteps.length, 1, `${state.kind} should have exactly one active setup step`);
      assert.equal(activeSteps[0]?.label, expectedActiveLabel);
    }
  });

  it('does not render setup steps once Quick Chat or history takes over', () => {
    assert.equal(
      getOnboardingSetupSteps({
        kind: 'ready_empty',
        defaultConnectionSlug: 'a',
        defaultModel: 'm',
      } as OnboardingState),
      null,
    );
    assert.equal(
      getOnboardingSetupSteps({
        kind: 'ready_with_history',
        defaultConnectionSlug: 'a',
        defaultModel: 'm',
      } as OnboardingState),
      null,
    );
  });

  it('renderer uses the setup helper rather than a disconnected static checklist', async () => {
    const hero = await readFile(new URL('../../../src/renderer/OnboardingHero.tsx', import.meta.url), 'utf8');
    const styles = await readFile(new URL('../../../src/renderer/styles.css', import.meta.url), 'utf8');

    assert.match(hero, /import \{ getOnboardingSetupSteps, type OnboardingSetupStep \} from '\.\/onboarding-hero-copy'/);
    assert.match(hero, /function SetupProgress\(props: \{ steps: readonly OnboardingSetupStep\[\] \}\)/);
    assert.match(hero, /aria-label="配置 AI 进度"/);
    assert.match(hero, /SETUP_STEP_STATUS_LABELS/);
    assert.match(hero, /getOnboardingSetupSteps\(\{ kind: 'needs_connection' \}\)/);
    assert.match(hero, /setupSteps=\{getOnboardingSetupSteps\(\{ kind: 'needs_default_connection' \}\)\}/);
    assert.match(hero, /setupSteps=\{getOnboardingSetupSteps\(\{[\s\S]*kind: 'needs_connection_credentials'/);
    assert.match(hero, /setupSteps=\{getOnboardingSetupSteps\(\{[\s\S]*kind: 'needs_default_model'/);
    assert.match(hero, /setupSteps=\{getOnboardingSetupSteps\(\{[\s\S]*kind: 'blocked'/);
    assert.match(styles, /\.maka-onboarding-setup-steps\s*\{/);
    assert.match(styles, /\.maka-onboarding-setup-steps > li\[data-state="active"\]/);
    assert.match(styles, /@media \(max-width: 620px\)[\s\S]*\.maka-onboarding-setup-step-state/);
  });
});

describe('OnboardingHero Quick Chat draft lifecycle', () => {
  it('keeps the first prompt when quick chat submission fails', async () => {
    const source = await readFile(new URL('../../../src/renderer/OnboardingHero.tsx', import.meta.url), 'utf8');
    const propsBlock = source.match(/export interface OnboardingHeroProps \{[\s\S]*?\n\}/)?.[0] ?? '';
    const readyBlock = source.match(/function ReadyEmptyHero[\s\S]*?interface SetupHeroProps/)?.[0] ?? '';

    assert.match(
      propsBlock,
      /onQuickChatSubmit: \(prompt: string, mode\?: QuickChatMode\) => boolean \| Promise<boolean>/,
      'Quick Chat submit prop must report success/failure to the presentational hero',
    );
    assert.match(
      readyBlock,
      /const submit = useCallback\(async \(\) => \{[\s\S]*?const submitted = await props\.onQuickChatSubmit\(draft, draftMode\);[\s\S]*?if \(!submitted\) return;[\s\S]*?setDraft\(''\);[\s\S]*?setDraftMode\(undefined\);/,
      'ReadyEmptyHero must clear the draft only after the parent reports a successful session creation',
    );
  });

  it('locally gates first-run quick chat submit before parent pending re-renders', async () => {
    const source = await readFile(new URL('../../../src/renderer/OnboardingHero.tsx', import.meta.url), 'utf8');
    const readyBlock = source.match(/function ReadyEmptyHero[\s\S]*?interface SetupHeroProps/)?.[0] ?? '';
    const submitBlock = readyBlock.match(/const submit = useCallback\(async \(\) => \{[\s\S]*?\n  \}, \[draft, draftMode, props\]\);/)?.[0] ?? '';

    assert.match(readyBlock, /const \[submitPending, setSubmitPending\] = useState\(false\)/);
    assert.match(readyBlock, /const submitPendingRef = useRef\(false\)/);
    assert.match(readyBlock, /const readyHeroMountedRef = useRef\(true\)/);
    assert.match(
      readyBlock,
      /useEffect\(\(\) => \{[\s\S]*readyHeroMountedRef\.current = true;[\s\S]*return \(\) => \{[\s\S]*readyHeroMountedRef\.current = false;[\s\S]*submitPendingRef\.current = false;[\s\S]*pendingImportActionRef\.current = null;[\s\S]*pendingSuggestionActionRef\.current = null;[\s\S]*\};[\s\S]*\}, \[\]\)/,
      'ReadyEmptyHero must clear async pending owners on unmount and restore mounted state during StrictMode replay',
    );
    assert.match(readyBlock, /const quickChatBusy = props\.quickChatPending \|\| submitPending/);
    assert.match(
      submitBlock,
      /if \(props\.quickChatPending \|\| submitPendingRef\.current\) return;[\s\S]*submitPendingRef\.current = true;[\s\S]*setSubmitPending\(true\);[\s\S]*await props\.onQuickChatSubmit\(draft, draftMode\)[\s\S]*if \(!readyHeroMountedRef\.current\) return;[\s\S]*submitPendingRef\.current = false;[\s\S]*if \(readyHeroMountedRef\.current\) setSubmitPending\(false\);/,
      'ReadyEmptyHero must synchronously drop duplicate Enter/click submits while the parent pending prop is still one render behind',
    );
    assert.match(source, /disabled=\{quickChatBusy\}/);
    assert.match(source, /aria-busy=\{quickChatBusy \? 'true' : undefined\}/);
    assert.match(source, /quickChatBusy \? copy\.submitPendingLabel : copy\.submitIdleLabel/);
  });

  it('clears first-run drag highlight when files leave the window', async () => {
    const source = await readFile(new URL('../../../src/renderer/OnboardingHero.tsx', import.meta.url), 'utf8');
    const readyBlock = source.match(/function ReadyEmptyHero[\s\S]*?interface SetupHeroProps/)?.[0] ?? '';

    assert.match(readyBlock, /if \(!dragActive\) return;/);
    assert.match(readyBlock, /window\.addEventListener\('blur', clearDragActive\)/);
    assert.match(readyBlock, /window\.addEventListener\('dragend', clearDragActive\)/);
    assert.match(readyBlock, /window\.addEventListener\('drop', clearDragActive\)/);
    assert.match(source, /window\.removeEventListener\('blur', clearDragActive\)/);
    assert.match(source, /window\.removeEventListener\('dragend', clearDragActive\)/);
    assert.match(source, /window\.removeEventListener\('drop', clearDragActive\)/);
  });
});
