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
import { getOnboardingHeroCopy } from '../../renderer/onboarding-hero-copy.js';

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

describe('OnboardingHero Quick Chat draft lifecycle', () => {
  it('keeps the first prompt when quick chat submission fails', async () => {
    const source = await readFile(new URL('../../../src/renderer/OnboardingHero.tsx', import.meta.url), 'utf8');
    const propsBlock = source.match(/export interface OnboardingHeroProps \{[\s\S]*?\n\}/)?.[0] ?? '';
    const readyBlock = source.match(/function ReadyEmptyHero[\s\S]*?return \(/)?.[0] ?? '';

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
});
