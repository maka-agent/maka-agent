/**
 * Locks the observable signals for the
 * turn-control-history fixture, at the helper layer (no DOM /
 * Electron). The deterministic fixture verifies the same matrix against
 * rendered screenshots; this test exists so a regression in the
 * helpers gets caught before screenshot CI runs.
 *
 *  S1 Failed banner copy comes from `describeTurnErrorClass` — Chinese
 *     generalized phrasing, never the raw enum.
 *  S2 Aborted turn marker is muted "(已中断)" (presentation helper).
 *  S3 Lineage badges produce stable Chinese copy with direction tags.
 *  S4 Branch banner only renders when parent is in the sessions list
 *     (covered separately in branch-banner.test.ts; cross-linked here).
 *  S5 Visual-smoke flag is enough to collapse smooth scroll to auto
 *     (covered separately in scroll-motion-policy.test.ts).
 *  S6 No raw enum identifier from `errorClass` / `SessionBlockedReason`
 *     leaks into the user-facing strings.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  SESSION_BLOCKED_REASONS,
  SESSION_STATUSES,
  TURN_STATUSES,
} from '@maka/core';
import {
  deriveFailedTurnRecovery,
  describeBlockedReason,
  describeTurnErrorClass,
  presentSessionStatus,
  sessionStatusAriaLabel,
} from '../../renderer/session-status-presentation.js';
import { deriveTurnFooterActions } from '../../renderer/turn-footer-actions.js';
import { deriveBranchBanner } from '../../renderer/branch-banner.js';

// All `errorClass` values the fixture (or any realistic runtime) can
// emit. The S1 / S6 gates exercise the renderer's `describeTurnErrorClass`
// mapping against this list. Includes both the canonical raw enum
// identifiers AND the HTTP-status shortcuts the classifier accepts.
const FIXTURE_ERROR_CLASSES = [
  'timeout',
  'auth',
  '401',
  '403',
  'rate_limit',
  'rate_exceeded',
  'network',
  'fetch_failed',
  'econnrefused',
  'provider_unavailable',
  '500',
  '503',
  'tool_failed',
  'permission_required',
] as const;

// Sub-set of FIXTURE_ERROR_CLASSES that are raw enum identifiers (the
// strings the runtime emits as `errorClass`). The S6 substring sweep
// uses ONLY these — HTTP-status codes like '401' / '500' are accepted
// as input by the classifier but are not canonical enum identifiers
// and could legitimately appear in Chinese copy in the future (e.g.
// "服务返回 500 错误"). @kenji PR109f review caution: keep the sweep
// list to actual raw identifiers so it stays robust against innocent
// future copy changes.
const RAW_ENUM_ERROR_CLASSES = [
  'timeout',
  'auth',
  'rate_limit',
  'rate_exceeded',
  'network',
  'fetch_failed',
  'econnrefused',
  'provider_unavailable',
  'tool_failed',
  'permission_required',
] as const;

describe('turn-control-history matrix', () => {
  describe('S1 failed banner copy', () => {
    it('every fixture errorClass maps to a Chinese label', () => {
      for (const cls of FIXTURE_ERROR_CLASSES) {
        const label = describeTurnErrorClass(cls);
        assert.match(label, /[一-鿿]/, `${cls} should produce Chinese label`);
      }
    });

    it('the fixture seed uses `timeout` which maps to "请求超时"', () => {
      // Documents the exact seed → label binding so a reviewer reading
      // the screenshot knows what copy to expect.
      assert.match(describeTurnErrorClass('timeout'), /请求超时/);
    });
  });

  describe('S2 aborted turn presentation', () => {
    it('aborted session presentation is muted + non-interactive', () => {
      const presentation = presentSessionStatus('aborted');
      assert.equal(presentation.tone, 'muted');
      assert.equal(presentation.interactive, false);
      assert.match(presentation.label, /已中止/);
    });

    // The inline "(已中断)" marker for an aborted turn (not session)
    // is rendered directly in components.tsx; we don't unit-test the
    // copy here to avoid duplicating the JSX literal. Visual placement
    // is covered by the deterministic screenshot fixture.
  });

  describe('S6 no raw enum leaks (regression-proof)', () => {
    it('every blocked reason copy is Chinese with no raw enum', () => {
      for (const reason of SESSION_BLOCKED_REASONS) {
        const text = describeBlockedReason(reason);
        assert.match(text, /[一-鿿]/, `${reason} copy should be Chinese`);
        // Substring contains — @kenji review: identifiers with `_` (e.g.
        // `NO_REAL_CONNECTION`) behave non-obviously with `\b`, so use
        // plain substring contains which is both stricter and clearer.
        assert.ok(!text.includes(reason), `${reason} leaks enum identifier`);
      }
    });

    it('every fixture errorClass copy is Chinese with no raw enum', () => {
      for (const cls of FIXTURE_ERROR_CLASSES) {
        const text = describeTurnErrorClass(cls);
        assert.match(text, /[一-鿿]/, `${cls} copy should be Chinese`);
        // Chinese labels never legitimately contain English enum
        // identifiers; substring contains is the strict + unambiguous
        // check.
        assert.ok(!text.includes(cls), `${cls} leaks enum identifier verbatim`);
      }
    });

    it('the unknown fallback never echoes the input string', () => {
      for (const cls of ['xyz', 'something_new', 'NEW_RUNTIME_ERROR']) {
        const text = describeTurnErrorClass(cls);
        assert.doesNotMatch(text, new RegExp(cls, 'i'), `${cls} unknown fallback leaks input`);
        assert.match(text, /未知/);
      }
    });

    // @kenji PR109f (g) review: S6 matcher must cover ALL three enum
    // groups — TurnStatus, errorClass, SessionBlockedReason — not just
    // errorClass. Sweep every Chinese-producing helper and assert that
    // no enum identifier appears as a standalone word-bounded token.
    it('sweep: no enum identifier from TurnStatus / errorClass / SessionBlockedReason leaks into helper output', () => {
      // @kenji PR109f review: token list should be ONLY raw identifiers
      // — not HTTP-status numbers (which the classifier accepts as input
      // but might appear in legitimate Chinese copy like "服务返回 500
      // 错误" later), and not random English UI words.
      const allEnumTokens = [
        ...TURN_STATUSES,
        ...SESSION_STATUSES,
        ...SESSION_BLOCKED_REASONS,
        ...RAW_ENUM_ERROR_CLASSES,
      ];

      const helperOutputs: string[] = [];

      // Session status helpers
      for (const status of SESSION_STATUSES) {
        helperOutputs.push(presentSessionStatus(status).label);
        helperOutputs.push(sessionStatusAriaLabel(status));
        for (const reason of SESSION_BLOCKED_REASONS) {
          helperOutputs.push(sessionStatusAriaLabel(status, reason));
        }
      }
      // Blocked reason copy
      for (const reason of SESSION_BLOCKED_REASONS) {
        helperOutputs.push(describeBlockedReason(reason));
      }
      // Error class copy
      for (const cls of FIXTURE_ERROR_CLASSES) {
        helperOutputs.push(describeTurnErrorClass(cls));
        helperOutputs.push(deriveFailedTurnRecovery({
          errorClass: cls,
          partialOutputRetained: cls === 'timeout',
          toolActivityCount: cls === 'tool_failed' ? 1 : 0,
          erroredToolCount: cls === 'tool_failed' ? 1 : 0,
        }).label);
      }
      helperOutputs.push(describeTurnErrorClass(undefined));
      helperOutputs.push(deriveFailedTurnRecovery({
        partialOutputRetained: false,
        toolActivityCount: 0,
        erroredToolCount: 0,
      }).label);
      // Footer action labels + tooltips for every TurnStatus × hasContent
      for (const status of TURN_STATUSES) {
        for (const hasContent of [true, false]) {
          const actions = deriveTurnFooterActions({ status, hasContent });
          for (const action of actions) {
            helperOutputs.push(action.label);
            if (action.tooltip) helperOutputs.push(action.tooltip);
          }
        }
      }

      for (const text of helperOutputs) {
        // Each helper output must be non-empty and contain Chinese.
        assert.match(text, /[一-鿿]/, `helper output "${text}" should be Chinese`);
        // The sweep is the actual gate: no raw enum identifier appears
        // anywhere in any Chinese label. @kenji + @xuan PR109f review:
        // use plain substring contains, NOT regex `\b`, because
        // identifiers like `NO_REAL_CONNECTION` / `waiting_for_user`
        // contain `_` which IS a word character in JS regex (so
        // `\bNO_REAL_CONNECTION\b` behaves non-obviously around
        // adjacent word chars). Chinese labels never legitimately
        // contain English-only enum identifiers as substrings, so
        // substring contains is both strict enough and unambiguous.
        for (const token of allEnumTokens) {
          assert.ok(
            !text.includes(token),
            `helper output "${text}" leaks enum identifier "${token}"`,
          );
        }
      }
    });
  });

  describe('S4 branch banner has no DOM presence when parent is missing', () => {
    // @kenji PR109f (g) review: ensure the orphan branch produces NO
    // banner JSX (not a hidden container, not a disabled button). The
    // contract: when `deriveBranchBanner()` returns undefined, the
    // ChatView short-circuits the JSX entirely — verified by reading
    // the JSX in components.tsx (`{props.branchBanner && <SessionBranchBanner ... />}`).
    // The helper-level test below proves the falsy path triggers.

    it('orphan active session with parent absent from list returns undefined (no JSX mounted)', () => {
      // Reproduce the turn-control-branch-orphan fixture state at the
      // helper level: an active session with parentSessionId set, but
      // the parent is NOT in the sessions list.
      const orphanActive = {
        id: 'visual-smoke-turn-control-branch-orphan',
        name: '父会话已删除的分支',
        parentSessionId: 'visual-smoke-turn-control-deleted-parent',
      };
      const visibleSessions = [
        orphanActive,
        { id: 'visual-smoke-turn-control-primary', name: '回合控制示例（原会话）' },
        { id: 'visual-smoke-turn-control-branch-visible', name: '从原会话分出的探索', parentSessionId: 'visual-smoke-turn-control-primary' },
      ];
      const banner = deriveBranchBanner(orphanActive, visibleSessions);
      // ChatView renders banner via `{props.branchBanner && ...}` —
      // undefined collapses the JSX, so no container exists in the DOM.
      assert.equal(banner, undefined);
    });

    it('visible-parent active session with parent in list DOES return a banner (positive case)', () => {
      const primary = { id: 'visual-smoke-turn-control-primary', name: '回合控制示例（原会话）' };
      const branch = {
        id: 'visual-smoke-turn-control-branch-visible',
        name: '从原会话分出的探索',
        parentSessionId: 'visual-smoke-turn-control-primary',
      };
      const banner = deriveBranchBanner(branch, [primary, branch]);
      assert.ok(banner, 'visible-parent branch should produce a banner');
      assert.equal(banner.parentSessionName, '回合控制示例（原会话）');
      assert.equal(banner.fromAbortedTurn, undefined, 'v1 omits fromAbortedTurn');
    });
  });
});
