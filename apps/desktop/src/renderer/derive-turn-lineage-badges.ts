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
      label: `重新生成自旧回答`,
      tooltip: `这是重新生成的并行回答，点击查看被保留的旧回答`,
      targetTurnId: forwardFrom,
      direction: 'forward',
    });
  }

  const reverseTo = input.regeneratedToTurnId ?? input.retriedToTurnId;
  if (reverseTo && input.existsTurn(reverseTo)) {
    badges.push({
      id: `reverse-regen-${input.turnId}`,
      label: `已重新生成 → 新回答`,
      tooltip: `点击跳转到重新生成的新回答`,
      targetTurnId: reverseTo,
      direction: 'reverse',
    });
  }

  return badges;
}
