/**
 * Tests for the Turn footer action helper.
 *
 * @kenji review gate #1: footer action enabled set must come
 * exclusively from `TurnStatus` + lineage map — never from the turn's
 * text content or optimistic UI guesses. This matrix locks that down.
 *
 * #546: retry was merged into regenerate. The footer now has one
 * "重新生成" action that re-runs the turn regardless of how the
 * previous attempt ended (failed / aborted / completed).
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { SESSION_STATUSES } from '@maka/core';
import {
  deriveTurnFooterActions,
  enabledTurnFooterActions,
  type TurnFooterActionId,
  type TurnFooterContext,
} from '../../renderer/turn-footer-actions.js';

function ctx(partial: Partial<TurnFooterContext>): TurnFooterContext {
  return {
    status: 'completed',
    hasContent: true,
    ...partial,
  };
}

function enabledIds(input: TurnFooterContext): TurnFooterActionId[] {
  return enabledTurnFooterActions(input).map((a) => a.id);
}

describe('deriveTurnFooterActions', () => {
  it('always returns the same 3 actions in fixed order', () => {
    const ids = deriveTurnFooterActions(ctx({})).map((a) => a.id);
    assert.deepEqual(ids, ['regenerate', 'branch', 'copy']);
  });

  it('labels are Chinese', () => {
    for (const action of deriveTurnFooterActions(ctx({}))) {
      assert.match(action.label, /[一-鿿]/, `${action.id} label should be Chinese`);
      assert.doesNotMatch(action.label, /[a-zA-Z]/, `${action.id} should have no English`);
    }
  });

  describe('per-status enabled matrix (@kenji gate #1)', () => {
    it('running: only copy enabled', () => {
      assert.deepEqual(enabledIds(ctx({ status: 'running' })), ['copy']);
    });

    it('completed: regenerate + branch + copy enabled', () => {
      assert.deepEqual(enabledIds(ctx({ status: 'completed' })), ['regenerate', 'branch', 'copy']);
    });

    it('failed: regenerate + branch + copy enabled (retry merged into regenerate)', () => {
      assert.deepEqual(enabledIds(ctx({ status: 'failed' })), ['regenerate', 'branch', 'copy']);
    });

    it('aborted: regenerate + branch + copy enabled (retry merged into regenerate)', () => {
      assert.deepEqual(enabledIds(ctx({ status: 'aborted' })), ['regenerate', 'branch', 'copy']);
    });
  });

  describe('copy depends on hasContent only', () => {
    it('hasContent=false drops copy regardless of status', () => {
      for (const status of ['running', 'completed', 'aborted', 'failed'] as const) {
        const ids = enabledIds(ctx({ status, hasContent: false }));
        assert.equal(ids.includes('copy'), false, `${status} with empty content should not enable copy`);
      }
    });
  });

  describe('tooltip hints (no enum leak)', () => {
    it('tooltips are Chinese only', () => {
      for (const action of deriveTurnFooterActions(ctx({}))) {
        assert.match(action.tooltip ?? '', /[一-鿿]/, `${action.id} tooltip should be Chinese`);
        const TURN_STATUSES = new Set(['running', 'completed', 'aborted', 'failed']);
        for (const status of TURN_STATUSES) {
          assert.doesNotMatch(
            action.tooltip ?? '',
            new RegExp(`\\b${status}\\b`),
            `${action.id} tooltip should not expose enum identifier ${status}`,
          );
        }
      }
    });

    it('tooltip distinguishes aborted branch from running branch (per @kenji "从中断前分支")', () => {
      const abortedBranch = deriveTurnFooterActions(ctx({ status: 'aborted' })).find((a) => a.id === 'branch');
      assert.match(abortedBranch?.tooltip ?? '', /中断/);
    });

    it('alreadyRegenerated changes the regenerate tooltip hint without disabling the button', () => {
      const first = deriveTurnFooterActions(ctx({ status: 'completed' })).find((a) => a.id === 'regenerate');
      const second = deriveTurnFooterActions(ctx({ status: 'completed', alreadyRegenerated: true })).find(
        (a) => a.id === 'regenerate',
      );
      assert.equal(first?.enabled, true);
      assert.equal(second?.enabled, true);
      assert.notEqual(first?.tooltip, second?.tooltip);
      assert.match(second?.tooltip ?? '', /已重新生成/);
    });
  });

  describe('matrix invariants (regression-proof)', () => {
    it('action enabled-state does NOT depend on hasContent (except for copy)', () => {
      const withContent = deriveTurnFooterActions(ctx({ status: 'completed', hasContent: true }));
      const noContent = deriveTurnFooterActions(ctx({ status: 'completed', hasContent: false }));
      for (const action of withContent) {
        const counterpart = noContent.find((a) => a.id === action.id);
        if (action.id === 'copy') {
          assert.notEqual(action.enabled, counterpart?.enabled);
        } else {
          assert.equal(action.enabled, counterpart?.enabled);
        }
      }
    });

    it('every TurnStatus produces a non-empty enabled set (copy is always available with content)', () => {
      for (const status of ['running', 'completed', 'aborted', 'failed'] as const) {
        const ids = enabledIds(ctx({ status }));
        assert.ok(ids.length >= 1, `${status} should have at least 1 enabled action`);
      }
    });
  });

  describe('pending mask (@kenji review: double-click guard)', () => {
    it('pending regenerate returns enabled=false + "正在处理…" tooltip', () => {
      const actions = deriveTurnFooterActions(
        ctx({ status: 'completed', pendingActions: new Set(['regenerate']) }),
      );
      const regen = actions.find((a) => a.id === 'regenerate');
      assert.equal(regen?.enabled, false);
      assert.equal(regen?.tooltip, '正在处理…');
    });

    it('pending branch returns enabled=false + busy tooltip', () => {
      const actions = deriveTurnFooterActions(
        ctx({ status: 'completed', pendingActions: new Set(['branch']) }),
      );
      const branch = actions.find((a) => a.id === 'branch');
      assert.equal(branch?.enabled, false);
      assert.equal(branch?.tooltip, '正在处理…');
    });

    it('pending on one action does NOT disable other actions', () => {
      const actions = deriveTurnFooterActions(
        ctx({ status: 'completed', pendingActions: new Set(['regenerate']) }),
      );
      const branch = actions.find((a) => a.id === 'branch');
      assert.equal(branch?.enabled, true);
      assert.notEqual(branch?.tooltip, '正在处理…');
    });

    it('pending labels preserved (screen readers still hear which action)', () => {
      const actions = deriveTurnFooterActions(
        ctx({ status: 'completed', pendingActions: new Set(['regenerate']) }),
      );
      const regen = actions.find((a) => a.id === 'regenerate');
      assert.equal(regen?.label, '重新生成');
    });

    it('empty pending set behaves identically to undefined', () => {
      const baseline = deriveTurnFooterActions(ctx({ status: 'completed' }));
      const withEmpty = deriveTurnFooterActions(
        ctx({ status: 'completed', pendingActions: new Set() }),
      );
      assert.deepEqual(baseline, withEmpty);
    });

    it('pending mask overrides the "alreadyRegenerated" hint (busy tooltip wins)', () => {
      const actions = deriveTurnFooterActions(
        ctx({
          status: 'completed',
          alreadyRegenerated: true,
          pendingActions: new Set(['regenerate']),
        }),
      );
      const regen = actions.find((a) => a.id === 'regenerate');
      assert.equal(regen?.tooltip, '正在处理…');
    });

    it('copy is NOT affected by pending mask (it is in-component clipboard)', () => {
      const actions = deriveTurnFooterActions(
        ctx({ status: 'completed', pendingActions: new Set(['copy']) }),
      );
      const copy = actions.find((a) => a.id === 'copy');
      assert.equal(copy?.enabled, true);
    });
  });

  describe('info action carries the meta summary (#546)', () => {
    it('appends an info action whose tooltip is the meta summary, when provided', () => {
      const actions = deriveTurnFooterActions(
        ctx({ status: 'completed', metaSummary: 'gpt-5.5 · 4.9s · $0.0123' }),
      );
      const info = actions.find((a) => a.id === 'info');
      assert.ok(info, 'info action should be present when metaSummary is set');
      assert.equal(info?.tooltip, 'gpt-5.5 · 4.9s · $0.0123');
    });

    it('omits the info action when no meta summary is provided', () => {
      const actions = deriveTurnFooterActions(ctx({ status: 'completed' }));
      assert.equal(actions.find((a) => a.id === 'info'), undefined);
    });

    it('info action is always enabled (it is informational, not an operation)', () => {
      const actions = deriveTurnFooterActions(
        ctx({ status: 'running', metaSummary: 'gpt-5.5 · 进行中' }),
      );
      const info = actions.find((a) => a.id === 'info');
      assert.equal(info?.enabled, true);
    });
  });

  describe('copy action tooltip reflects enabled state (#546)', () => {
    it('shows the copy affordance when there is content', () => {
      const copy = deriveTurnFooterActions(ctx({ status: 'completed', hasContent: true })).find(
        (a) => a.id === 'copy',
      );
      assert.equal(copy?.enabled, true);
      assert.equal(copy?.tooltip, '复制回答到剪贴板');
    });

    it('shows the disabled reason when there is no content', () => {
      const copy = deriveTurnFooterActions(ctx({ status: 'completed', hasContent: false })).find(
        (a) => a.id === 'copy',
      );
      assert.equal(copy?.enabled, false);
      assert.equal(copy?.tooltip, '此回答尚无可复制的内容');
    });
  });

  it('SessionStatus and TurnStatus are kept distinct', () => {
    assert.ok(SESSION_STATUSES.includes('active'));
    assert.ok(SESSION_STATUSES.includes('blocked'));
  });
});
