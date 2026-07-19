/**
 * Tests for the renderer-side derived connection UI status. The function lives
 * in `apps/desktop/src/renderer/connection-status.ts` but is a pure helper —
 * no React, no DOM — so we exercise it directly via node:test from the
 * desktop test runner.
 *
 * The invariants under test are the ones @kenji's status contract requires
 * (priority order, no mixed labels), plus the Ollama edge case (no secret
 * required but still needs a defaultModel) and the failure-doesn't-disable
 * invariant.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  connectionUiStatusFromRecord,
  deriveConnectionUiStatus,
  presentConnectionUiStatus,
  type ConnectionUiStatusInput,
} from '../../renderer/connection-status.js';
import type { LlmConnection, ProviderType } from '@maka/core';

function base(input: Partial<ConnectionUiStatusInput> = {}): ConnectionUiStatusInput {
  return {
    enabled: true,
    hasSecret: true,
    defaultModel: 'claude-sonnet-4-5-20250929',
    lastTestStatus: undefined,
    authKind: 'api_key',
    ...input,
  };
}

describe('deriveConnectionUiStatus', () => {
  describe('priority order (highest wins)', () => {
    it('disabled overrides every other signal', () => {
      // Even if everything else says verified, disabled is a user lifecycle
      // state that takes precedence — never produce "disabled + verified".
      assert.equal(
        deriveConnectionUiStatus(base({ enabled: false, lastTestStatus: 'verified' })),
        'disabled',
      );
      assert.equal(
        deriveConnectionUiStatus(base({ enabled: false, hasSecret: false, defaultModel: undefined })),
        'disabled',
      );
    });

    it('not_configured beats lastTestStatus when secret is missing', () => {
      // If the user wipes the API key, a stale verified state must NOT survive.
      // (Backend invalidation also clears lastTestStatus in this case, but the
      // UI derive layer is the second line of defense.)
      assert.equal(
        deriveConnectionUiStatus(base({ hasSecret: false, lastTestStatus: 'verified' })),
        'not_configured',
      );
    });

    it('not_configured beats lastTestStatus when defaultModel is missing', () => {
      assert.equal(
        deriveConnectionUiStatus(base({ defaultModel: undefined, lastTestStatus: 'verified' })),
        'not_configured',
      );
      assert.equal(
        deriveConnectionUiStatus(base({ defaultModel: '', lastTestStatus: 'verified' })),
        'not_configured',
      );
    });
  });

  describe('lastTestStatus mapping', () => {
    it('verified → verified', () => {
      assert.equal(deriveConnectionUiStatus(base({ lastTestStatus: 'verified' })), 'verified');
    });

    it('needs_reauth → needs_reauth', () => {
      assert.equal(deriveConnectionUiStatus(base({ lastTestStatus: 'needs_reauth' })), 'needs_reauth');
    });

    it('error → error', () => {
      assert.equal(deriveConnectionUiStatus(base({ lastTestStatus: 'error' })), 'error');
    });

    it('undefined (never tested but configured) → configured', () => {
      assert.equal(deriveConnectionUiStatus(base()), 'configured');
    });
  });

  describe('Ollama / authKind === "none" path', () => {
    it('does not require hasSecret when authKind is "none"', () => {
      // Local Ollama has no API key; hasSecret will report false from the
      // safeStorage check but the connection is still usable as long as
      // defaultModel is set.
      assert.equal(
        deriveConnectionUiStatus(
          base({ authKind: 'none', hasSecret: false, lastTestStatus: 'verified' }),
        ),
        'verified',
      );
      assert.equal(
        deriveConnectionUiStatus(
          base({ authKind: 'none', hasSecret: false, lastTestStatus: undefined }),
        ),
        'configured',
      );
    });

    it('still requires defaultModel when authKind is "none"', () => {
      // Per kenji's review: a no-secret local provider with no model picked
      // must NOT render as ready.
      assert.equal(
        deriveConnectionUiStatus(
          base({ authKind: 'none', hasSecret: false, defaultModel: undefined }),
        ),
        'not_configured',
      );
    });
  });

  describe('LocalAI / optional API key path', () => {
    it('does not make an absent optional key look unconfigured', () => {
      assert.equal(
        deriveConnectionUiStatus(
          base({ authKind: 'optional_api_key', hasSecret: false, lastTestStatus: undefined }),
        ),
        'configured',
      );
    });
  });

  describe('failure-does-not-disable invariant', () => {
    it('a connection that just errored stays enabled (status = error, not disabled)', () => {
      // Test invariant: backend never auto-disables on a test failure.
      // UI should reflect "error status on an enabled connection", not
      // collapse to disabled. This is the regression we'd see if the UI
      // ever wrote enabled=false on its own.
      assert.equal(
        deriveConnectionUiStatus(base({ enabled: true, lastTestStatus: 'error' })),
        'error',
      );
      assert.equal(
        deriveConnectionUiStatus(base({ enabled: true, lastTestStatus: 'needs_reauth' })),
        'needs_reauth',
      );
    });
  });
});

describe('presentConnectionUiStatus copy gates', () => {
  // Locks the provider-auth contract invariant:
  // `verified` is a credential-validation result only. The label
  // and detail MUST NOT conflate validation with operational
  // readiness ("可用" / "运行可用" / "ready" / etc.).
  //
  // History: the prior label "已验证可用" read as "validated and
  // operational" — a direct contract violation. This block fails
  // closed if a future change reintroduces operational language
  // into the `verified` presentation.

  it('verified label is credential-only, no operational claim', () => {
    const presentation = presentConnectionUiStatus('verified', 'zh');
    assert.equal(presentation.label, '凭据已验证');
    // Negative gate: the operational synonyms must not appear in
    // the label.
    assert.ok(!presentation.label.includes('可用'), 'verified label must not say 可用');
    assert.ok(!presentation.label.includes('运行'), 'verified label must not say 运行');
    assert.ok(!presentation.label.includes('operational'), 'verified label must not say operational');
  });

  it('verified detail acknowledges credential test scope and points to runtime probe', () => {
    const presentation = presentConnectionUiStatus('verified', 'zh');
    // Detail can mention 运行态 as long as it's framed as
    // "needs separate verification", not "this status proves it".
    assert.ok(
      presentation.detail.includes('运行态') || presentation.detail.includes('独立验证'),
      'verified detail should explicitly distinguish credential validation from runtime readiness',
    );
  });

  it('configured / not_configured / needs_reauth / error labels do not falsely claim ready state', () => {
    for (const status of ['configured', 'not_configured', 'needs_reauth', 'error'] as const) {
      const presentation = presentConnectionUiStatus(status, 'zh');
      assert.ok(!presentation.label.includes('运行可用'), `${status} label must not say 运行可用`);
      assert.ok(!presentation.label.includes('凭据已验证'), `${status} label must not say 凭据已验证`);
    }
  });

  it('configured copy uses actionable waiting language instead of unverified wording', () => {
    const presentation = presentConnectionUiStatus('configured', 'zh');
    assert.equal(presentation.label, '已配置 · 等待验证');
    assert.match(presentation.detail, /点测试连接确认服务可达/);
    assert.doesNotMatch(`${presentation.label}\n${presentation.detail}`, /未验证|还未真正调用/);
  });

  it('not_configured copy frames missing setup as a next action', () => {
    const presentation = presentConnectionUiStatus('not_configured', 'zh');
    assert.equal(presentation.label, '待补齐');
    assert.match(presentation.detail, /等待填写模型密钥或选择默认模型/);
    assert.doesNotMatch(`${presentation.label}\n${presentation.detail}`, /未配置|缺少 API key/);
  });

  it('error copy describes the failed test without saying the provider is unavailable', () => {
    const presentation = presentConnectionUiStatus('error', 'zh');
    assert.equal(presentation.label, '连接出错');
    assert.match(presentation.detail, /服务商返回错误/);
    assert.doesNotMatch(`${presentation.label}\n${presentation.detail}`, /provider 不可用/);
  });
});

describe('connectionUiStatusFromRecord unknown-provider fallback', () => {
  // A connection persisted on another branch with a provider this
  // build's PROVIDER_REGISTRY doesn't know) must not crash the settings row.
  // It surfaces as `unsupported_provider` — the connection isn't usable on
  // this build, but its saved configuration is not incomplete.
  function connectionWith(providerType: string, overrides: Partial<LlmConnection> = {}): LlmConnection {
    return {
      slug: 'test',
      name: 'test',
      providerType: providerType as ProviderType,
      defaultModel: 'some-model',
      enabled: true,
      createdAt: 0,
      updatedAt: 0,
      ...overrides,
    };
  }

  it('returns unsupported_provider for an unregistered providerType instead of throwing', () => {
    assert.equal(
      connectionUiStatusFromRecord(connectionWith('branch-only-provider'), true),
      'unsupported_provider',
    );
  });

  it('returns unsupported_provider even when enabled with a model and a secret', () => {
    // The connection may look fully configured, but its provider isn't
    // registered on this build, so it must not read as verified/configured.
    assert.equal(
      connectionUiStatusFromRecord(
        connectionWith('branch-only-provider', { defaultModel: 'branch-model', lastTestStatus: 'verified' }),
        true,
      ),
      'unsupported_provider',
    );
  });

  it('explains that the current version does not support the provider', () => {
    const presentation = presentConnectionUiStatus('unsupported_provider', 'zh');
    assert.equal(presentation.label, '当前版本不支持');
    assert.match(presentation.detail, /未在当前版本注册/);
    assert.doesNotMatch(presentation.detail, /模型密钥|默认模型/);
  });

  it('keeps disabled as the highest-priority status', () => {
    assert.equal(
      connectionUiStatusFromRecord(connectionWith('branch-only-provider', { enabled: false }), true),
      'disabled',
    );
  });

  it('still derives the real status for a registered provider', () => {
    assert.equal(
      connectionUiStatusFromRecord(
        connectionWith('anthropic', { defaultModel: 'claude-sonnet-4-5-20250929', lastTestStatus: 'verified' }),
        true,
      ),
      'verified',
    );
  });
});
