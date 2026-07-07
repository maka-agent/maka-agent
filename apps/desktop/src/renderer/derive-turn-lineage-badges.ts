/**
 * Pure derivation of a turn's lineage badges.
 *
 * Extracted from `app-shell-turn-view-model` so the badge matrix is
 * unit-testable without dragging in the renderer's relative-import
 * graph (which node ESM can't resolve extension-less).
 *
 * #546: retry was merged into regenerate. The badge vocabulary is now
 * uniform — "重新生成自" (forward) and "已重新生成" (reverse) — regardless
 * of which path wrote the lineage. Old sessions may still carry
 * `retriedFromTurnId` / `retriedToTurnId` (written by the since-removed
 * retryTurn path); those are read back as regenerate lineages via the
 * `?? ` fallback, never shown as the legacy "重试自" / "已重试".
 */

import type { TurnLineageBadge } from '@maka/ui';

/** Strip the `turn-` id prefix before truncating, matching the view-model. */
function shortId(turnId: string): string {
  return turnId.replace(/^turn-/, '').slice(0, 6);
}

export interface TurnLineageBadgeInput {
  turnId: string;
  /** Legacy retry lineage (old data). Falls back behind regenerated. */
  retriedFromTurnId?: string;
  regeneratedFromTurnId?: string;
  /** Legacy reverse retry target (old data). Falls back behind regenerated. */
  retriedToTurnId?: string;
  regeneratedToTurnId?: string;
  /** True when the target turn id still exists in the materialized view. */
  existsTurn(turnId: string): boolean;
}

export function deriveTurnLineageBadges(input: TurnLineageBadgeInput): TurnLineageBadge[] {
  const badges: TurnLineageBadge[] = [];

  const forwardFrom = input.regeneratedFromTurnId ?? input.retriedFromTurnId;
  if (forwardFrom && input.existsTurn(forwardFrom)) {
    badges.push({
      id: `forward-regen-${input.turnId}`,
      label: `重新生成自 turn ${shortId(forwardFrom)}`,
      tooltip: `保留旧回答，重新生成的并行回答`,
      targetTurnId: forwardFrom,
      direction: 'forward',
    });
  }

  const reverseTo = input.regeneratedToTurnId ?? input.retriedToTurnId;
  if (reverseTo && input.existsTurn(reverseTo)) {
    badges.push({
      id: `reverse-regen-${input.turnId}`,
      label: `已重新生成 → turn ${shortId(reverseTo)}`,
      tooltip: `跳转到对此回答的重新生成`,
      targetTurnId: reverseTo,
      direction: 'reverse',
    });
  }

  return badges;
}
