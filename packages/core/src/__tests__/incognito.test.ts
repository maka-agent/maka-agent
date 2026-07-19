/**
 * Tests for the `@maka/core/incognito` cross-cutting contract.
 *
 * Pins:
 *   - Default factory always returns `incognitoActive: false`.
 *   - `validateWorkspacePrivacyContext` rejects malformed input WITHOUT
 *     defaulting (per xuan `ece30c92` requirement #1).
 *   - Extra fields are stripped from the canonical return.
 *   - Type guard distinguishes valid vs invalid shapes.
 *
 * Authority rules are documented in `docs/workspace-privacy-context.md`
 * and enforced by consumers at
 * their respective IPC boundaries — this contract layer only validates
 * shape, not source authority.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  WORKSPACE_PRIVACY_CONTEXT_INVALID_REASONS,
  defaultWorkspacePrivacyContext,
  isWorkspacePrivacyContext,
  validateWorkspacePrivacyContext,
} from '../incognito.js';

describe('defaultWorkspacePrivacyContext', () => {
  it('returns incognitoActive=false', () => {
    const ctx = defaultWorkspacePrivacyContext();
    assert.deepEqual(ctx, { incognitoActive: false });
  });

  it('returns a fresh object every call (no shared mutation)', () => {
    const a = defaultWorkspacePrivacyContext();
    const b = defaultWorkspacePrivacyContext();
    assert.notEqual(a, b, 'expected distinct references');
    assert.deepEqual(a, b, 'expected identical content');
  });

  it('returned object is the only path to a default — validator does NOT default', () => {
    // Cross-check: validator must NOT produce the same shape from
    // malformed input. The default factory is the only legitimate
    // path. This guards against a regression where someone "helpfully"
    // adds a default fallback to the validator.
    const factoryDefault = defaultWorkspacePrivacyContext();
    const validatorOnMissing = validateWorkspacePrivacyContext({});
    if (validatorOnMissing.ok) {
      assert.fail(
        'validator must NOT produce a default for missing incognitoActive; got ' +
          JSON.stringify(validatorOnMissing.value),
      );
    }
    assert.equal(factoryDefault.incognitoActive, false);
  });
});

describe('validateWorkspacePrivacyContext (xuan ece30c92 #1: explicit boolean only)', () => {
  it('accepts {incognitoActive: false}', () => {
    const result = validateWorkspacePrivacyContext({ incognitoActive: false });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value.incognitoActive, false);
  });

  it('accepts {incognitoActive: true}', () => {
    const result = validateWorkspacePrivacyContext({ incognitoActive: true });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value.incognitoActive, true);
  });

  it('rejects missing incognitoActive (does NOT default)', () => {
    const result = validateWorkspacePrivacyContext({});
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'incognito_active_invalid');
  });

  it('rejects non-boolean incognitoActive', () => {
    for (const bad of [0, 1, 'true', 'false', null, undefined, [], {}, () => false]) {
      const result = validateWorkspacePrivacyContext({ incognitoActive: bad });
      assert.equal(result.ok, false, `bad=${String(bad)}`);
      if (!result.ok) assert.equal(result.reason, 'incognito_active_invalid', `bad=${String(bad)}`);
    }
  });

  it('rejects null payload', () => {
    const result = validateWorkspacePrivacyContext(null);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'not_object');
  });

  it('rejects undefined payload', () => {
    const result = validateWorkspacePrivacyContext(undefined);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'not_object');
  });

  it('rejects array payload', () => {
    const result = validateWorkspacePrivacyContext([]);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'not_object');
  });

  it('rejects primitive payloads', () => {
    for (const bad of ['true', 42, true, false]) {
      const result = validateWorkspacePrivacyContext(bad);
      assert.equal(result.ok, false, `bad=${String(bad)}`);
      if (!result.ok) assert.equal(result.reason, 'not_object', `bad=${String(bad)}`);
    }
  });

  it('strips extra fields on canonical return', () => {
    const result = validateWorkspacePrivacyContext({
      incognitoActive: true,
      shadowPolicy: 'evil',
      forcedFalse: false,
      __proto__: { foo: 'bar' },
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(Object.keys(result.value).sort(), ['incognitoActive']);
      assert.equal(result.value.incognitoActive, true);
    }
  });

  // Named test from xuan msg `0ee0a3b7` + kenji msg `64ba21cb`:
  // renderer payload that tries to bootstrap a durable-write policy
  // alongside the incognito flag must be stripped at the canonical
  // return. The renderer cannot self-attest its policy via extra
  // fields; only `incognitoActive` survives the validator.
  it('strips renderer-supplied durableWriteAllowed (renderer cannot self-attest policy)', () => {
    const result = validateWorkspacePrivacyContext({
      incognitoActive: false,
      durableWriteAllowed: true,
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.value, { incognitoActive: false });
      // Explicit: durableWriteAllowed must NOT survive.
      assert.equal(
        (result.value as unknown as Record<string, unknown>).durableWriteAllowed,
        undefined,
        'renderer-supplied policy fields must be stripped on canonical return',
      );
    }
  });

  // Per kenji `64ba21cb`: default false is not a write permission.
  // The validator returning {incognitoActive:false} for a valid input
  // does NOT mean consumers should treat false as "all writes allowed".
  // This test pins the contract output shape, NOT the consumer semantic;
  // consumers must wire their own policy gates per
  // `docs/workspace-privacy-context.md`.
  it('canonical false return contains only incognitoActive (consumers consult own policy gates)', () => {
    const result = validateWorkspacePrivacyContext({ incognitoActive: false });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.incognitoActive, false);
      // No write-permission field exists on the contract by design.
      assert.equal(
        (result.value as unknown as Record<string, unknown>).writeAllowed,
        undefined,
        'WorkspacePrivacyContext must NOT carry a generic write-permission boolean',
      );
      assert.equal(
        (result.value as unknown as Record<string, unknown>).durableWriteAllowed,
        undefined,
      );
    }
  });
});

describe('isWorkspacePrivacyContext type guard', () => {
  it('accepts valid shapes', () => {
    assert.equal(isWorkspacePrivacyContext({ incognitoActive: true }), true);
    assert.equal(isWorkspacePrivacyContext({ incognitoActive: false }), true);
  });

  it('rejects null / undefined / primitive / array', () => {
    for (const bad of [null, undefined, 'incognito', 42, true, false, []]) {
      assert.equal(isWorkspacePrivacyContext(bad), false, `bad=${String(bad)}`);
    }
  });

  it('rejects missing incognitoActive', () => {
    assert.equal(isWorkspacePrivacyContext({}), false);
  });

  it('rejects non-boolean incognitoActive', () => {
    assert.equal(isWorkspacePrivacyContext({ incognitoActive: 'true' }), false);
    assert.equal(isWorkspacePrivacyContext({ incognitoActive: 1 }), false);
  });

  it('accepts shapes with extra fields (type guard checks documented set)', () => {
    // Type guard differs from validator: it only confirms the
    // documented fields are correctly typed; extras don't make a
    // value fail the guard. (Validator strips extras on canonical
    // return; guard doesn't transform.)
    assert.equal(isWorkspacePrivacyContext({ incognitoActive: true, somethingElse: 'ok' }), true);
  });
});

describe('closed reason enum', () => {
  it('enumerates exactly the two reasons emitted by validateWorkspacePrivacyContext', () => {
    assert.deepEqual(
      [...WORKSPACE_PRIVACY_CONTEXT_INVALID_REASONS],
      ['not_object', 'incognito_active_invalid'],
    );
  });
});

describe('cross-lane consumption documentation', () => {
  // Consumer behavior is tested at each enforcement boundary. These
  // tests lock only the shared shape.
  it('shape contains exactly one field (extending is a contract change)', () => {
    const ctx = defaultWorkspacePrivacyContext();
    assert.deepEqual(Object.keys(ctx).sort(), ['incognitoActive']);
  });

  it('canonical return after validate also contains exactly one field', () => {
    const result = validateWorkspacePrivacyContext({ incognitoActive: true });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(Object.keys(result.value).sort(), ['incognitoActive']);
    }
  });
});
