/**
 * Tests for the turn lineage badge derivation (#546).
 *
 * retry was merged into regenerate, so the badge vocabulary is uniform:
 * "重新生成自" (forward) and "已重新生成" (reverse), regardless of which
 * path wrote the lineage. Legacy retried* fields from old sessions are
 * read back as regenerate lineages.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { deriveTurnLineageBadges } from '../../renderer/derive-turn-lineage-badges.js';

describe('deriveTurnLineageBadges (#546 retry→regenerate merge)', () => {
  it('legacy retriedFromTurnId shows a forward "重新生成自" badge, never "重试自"', () => {
    const badges = deriveTurnLineageBadges({
      turnId: 'turn-retry-new',
      retriedFromTurnId: 'turn-retry-origin',
      existsTurn: () => true,
    });
    const forward = badges.find((b) => b.direction === 'forward');
    assert.match(forward?.label ?? '', /重新生成自/);
    assert.doesNotMatch(forward?.label ?? '', /重试自/);
  });

  it('legacy retriedToTurnId shows a reverse "已重新生成" badge, never "已重试"', () => {
    const badges = deriveTurnLineageBadges({
      turnId: 'turn-retry-origin',
      retriedToTurnId: 'turn-retry-new',
      existsTurn: () => true,
    });
    const reverse = badges.find((b) => b.direction === 'reverse');
    assert.match(reverse?.label ?? '', /已重新生成/);
    assert.doesNotMatch(reverse?.label ?? '', /已重试/);
  });

  it('regeneratedFromTurnId shows "重新生成自" (unchanged path)', () => {
    const badges = deriveTurnLineageBadges({
      turnId: 'turn-regen-new',
      regeneratedFromTurnId: 'turn-regen-origin',
      existsTurn: () => true,
    });
    const forward = badges.find((b) => b.direction === 'forward');
    assert.match(forward?.label ?? '', /重新生成自/);
  });

  it('prefers regenerated over legacy retried when both are present', () => {
    const badges = deriveTurnLineageBadges({
      turnId: 't',
      retriedFromTurnId: 'origin-a',
      regeneratedFromTurnId: 'origin-b',
      existsTurn: () => true,
    });
    const forward = badges.find((b) => b.direction === 'forward');
    assert.equal(forward?.targetTurnId, 'origin-b');
  });

  it('omits a badge when the target turn does not exist', () => {
    const badges = deriveTurnLineageBadges({
      turnId: 't',
      regeneratedFromTurnId: 'gone',
      existsTurn: () => false,
    });
    assert.equal(badges.length, 0);
  });

  it('emits no badges for a turn with no lineage', () => {
    const badges = deriveTurnLineageBadges({ turnId: 'solo', existsTurn: () => true });
    assert.equal(badges.length, 0);
  });
});
