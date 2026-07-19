import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normalizeCuaDriverOutcome, type JsonRpcToolResult } from '../cua-driver-result.js';

function result(structuredContent: Record<string, unknown>): JsonRpcToolResult {
  return { content: [], structuredContent };
}

describe('normalizeCuaDriverOutcome', () => {
  it('maps AX confirmed evidence to a verified AX success', () => {
    assert.deepEqual(
      normalizeCuaDriverOutcome(
        result({
          path: 'ax',
          verified: true,
          effect: 'confirmed',
        }),
      ),
      {
        ok: true,
        tier: 'ax',
        verified: true,
        evidence: { path: 'ax', effect: 'confirmed' },
      },
    );
  });

  it('maps CGEvent unverifiable evidence to an unverified background success', () => {
    assert.deepEqual(
      normalizeCuaDriverOutcome(
        result({
          path: 'cgevent',
          verified: false,
          effect: 'unverifiable',
          escalation: {
            recommended: 'foreground',
            reason: 'background delivery was dropped',
          },
        }),
      ),
      {
        ok: true,
        tier: 'coordinate-background',
        verified: false,
        evidence: {
          path: 'cgevent',
          effect: 'unverifiable',
        },
      },
    );
  });

  it('maps page/CDP evidence to semantic background dispatch', () => {
    assert.deepEqual(
      normalizeCuaDriverOutcome(
        result({
          path: 'cdp',
          verified: true,
          effect: 'confirmed',
        }),
      ),
      {
        ok: true,
        tier: 'semantic-background',
        verified: true,
        evidence: { path: 'cdp', effect: 'confirmed' },
      },
    );
  });

  it('fails suspected no-ops closed as capture_failed while preserving evidence', () => {
    const outcome = normalizeCuaDriverOutcome({
      content: [{ type: 'text', text: 'AXPress produced no observable change' }],
      structuredContent: {
        path: 'ax',
        verified: false,
        effect: 'suspected_noop',
        escalation: {
          recommended: 'px',
          reason: 'element does not advertise this action',
        },
      },
    });

    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.error, 'capture_failed');
    assert.equal(outcome.message, 'AXPress produced no observable change');
    assert.deepEqual(outcome.evidence, {
      path: 'ax',
      effect: 'suspected_noop',
    });
  });

  it('ignores malformed escalation evidence instead of inventing a fallback', () => {
    const outcome = normalizeCuaDriverOutcome(
      result({
        path: 'cgevent',
        effect: 'unverifiable',
        escalation: 'foreground',
      }),
    );

    assert.equal(outcome.ok, true);
    assert.deepEqual(outcome.evidence, {
      path: 'cgevent',
      effect: 'unverifiable',
    });
  });

  it('rejects every foreground path suffix instead of accepting focus steal', () => {
    for (const path of ['cgevent_fg', 'ax_fg', 'key_events_fg']) {
      const outcome = normalizeCuaDriverOutcome(
        result({
          path,
          verified: false,
          effect: 'unverifiable',
        }),
      );
      assert.equal(outcome.ok, false);
      if (!outcome.ok) {
        assert.equal(outcome.error, 'unsupported_action');
        assert.equal(outcome.evidence?.path, path);
      }
    }
  });

  it('derives verification from a recognized effect when the boolean is absent', () => {
    const confirmed = normalizeCuaDriverOutcome(result({ path: 'ax', effect: 'confirmed' }));
    const unverifiable = normalizeCuaDriverOutcome(
      result({ path: 'cgevent', effect: 'unverifiable' }),
    );

    assert.equal(confirmed.ok, true);
    if (confirmed.ok) assert.equal(confirmed.verified, true);
    assert.equal(unverifiable.ok, true);
    if (unverifiable.ok) assert.equal(unverifiable.verified, false);
  });

  it('preserves driver typed errors and their evidence', () => {
    assert.deepEqual(
      normalizeCuaDriverOutcome({
        isError: true,
        content: [{ type: 'text', text: 'Accessibility permission was revoked' }],
        structuredContent: {
          error: 'permission_missing',
          path: 'ax',
          effect: 'unverifiable',
        },
      }),
      {
        ok: false,
        error: 'permission_missing',
        message: 'Accessibility permission was revoked',
        evidence: { path: 'ax', effect: 'unverifiable' },
      },
    );
  });

  it('classifies missing results and untyped driver errors as capture_failed', () => {
    const missing = normalizeCuaDriverOutcome(undefined);
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.error, 'capture_failed');

    const untyped = normalizeCuaDriverOutcome({
      isError: true,
      content: [{ type: 'text', text: 'opaque driver failure' }],
      structuredContent: { error: 'unknown_driver_error' },
    });
    assert.equal(untyped.ok, false);
    if (!untyped.ok) {
      assert.equal(untyped.error, 'capture_failed');
      assert.equal(untyped.message, 'opaque driver failure');
    }
  });
});
