import type { StoredMessage } from '@maka/core';
import {
  deriveTurnLineageMap,
  materializeTurns,
  type ToolActivityItem,
  type TurnFooterActionMeta,
  type TurnLineageBadge,
} from '@maka/ui';
import { deriveFailedTurnRecovery, describeTurnErrorClass } from './session-status-presentation';
import { deriveTurnFooterActions } from './turn-footer-actions';

export interface AppShellTurnViewModel {
  turnFooterActionsByTurn: Record<string, ReadonlyArray<TurnFooterActionMeta>>;
  turnFailedReasonLabels: Record<string, string>;
  turnFailedRecoveryLabels: Record<string, string>;
  turnLineageBadgesByTurn: Record<string, TurnLineageBadge[]>;
}

export function deriveAppShellTurnViewModel(input: {
  activeId: string | undefined;
  messages: StoredMessage[];
  liveTools: ToolActivityItem[];
  pendingTurnActions: ReadonlySet<string>;
  pendingKeyOf(sessionId: string, turnId: string, actionId: TurnFooterActionMeta['id']): string;
}): AppShellTurnViewModel {
  const turnsForLineage = materializeTurns(input.messages, input.liveTools);
  const lineage = deriveTurnLineageMap(turnsForLineage);
  const turnsById = new Map(turnsForLineage.map((turn) => [turn.turnId, turn]));
  // Strip the `turn-` id prefix before truncating — labels interpolate as
  // `turn ${shortId(...)}`, so a raw slice rendered「已重新生成 → turn
  // turn-r」: doubled word, one useful character of id left.
  const shortId = (turnId: string) => turnId.replace(/^turn-/, '').slice(0, 6);
  const footer: Record<string, ReadonlyArray<TurnFooterActionMeta>> = {};
  const failedLabels: Record<string, string> = {};
  const failedRecoveryLabels: Record<string, string> = {};
  const badges: Record<string, TurnLineageBadge[]> = {};

  for (const turn of turnsForLineage) {
    const lineageEntry = lineage.get(turn.turnId);
    const pendingForTurn = new Set<TurnFooterActionMeta['id']>();
    for (const id of ['retry', 'regenerate', 'branch', 'copy'] as const) {
      if (input.activeId && input.pendingTurnActions.has(input.pendingKeyOf(input.activeId, turn.turnId, id))) {
        pendingForTurn.add(id);
      }
    }
    footer[turn.turnId] = deriveTurnFooterActions({
      status: turn.status,
      hasContent: Boolean(turn.assistant?.text && turn.assistant.text.trim().length > 0),
      ...(lineageEntry?.retriedToTurnId ? { alreadyRetried: true } : {}),
      ...(lineageEntry?.regeneratedToTurnId ? { alreadyRegenerated: true } : {}),
      ...(pendingForTurn.size > 0 ? { pendingActions: pendingForTurn } : {}),
    });

    if (turn.status === 'failed') {
      failedLabels[turn.turnId] = describeTurnErrorClass(turn.errorClass);
      failedRecoveryLabels[turn.turnId] = deriveFailedTurnRecovery({
        errorClass: turn.errorClass,
        partialOutputRetained: turn.partialOutputRetained,
        toolActivityCount: turn.tools.length,
        erroredToolCount: turn.tools.filter((tool) => tool.status === 'errored').length,
      }).label;
    }

    const turnBadges: TurnLineageBadge[] = [];
    if (turn.retriedFromTurnId && turnsById.has(turn.retriedFromTurnId)) {
      turnBadges.push({
        id: `forward-retry-${turn.turnId}`,
        label: `重试自 turn ${shortId(turn.retriedFromTurnId)}`,
        tooltip: `这是对上一轮回答的重试`,
        targetTurnId: turn.retriedFromTurnId,
        direction: 'forward',
      });
    }
    if (turn.regeneratedFromTurnId && turnsById.has(turn.regeneratedFromTurnId)) {
      turnBadges.push({
        id: `forward-regen-${turn.turnId}`,
        label: `重新生成自 turn ${shortId(turn.regeneratedFromTurnId)}`,
        tooltip: `保留旧回答，重新生成的并行回答`,
        targetTurnId: turn.regeneratedFromTurnId,
        direction: 'forward',
      });
    }
    if (lineageEntry?.retriedToTurnId && turnsById.has(lineageEntry.retriedToTurnId)) {
      turnBadges.push({
        id: `reverse-retry-${turn.turnId}`,
        label: `已重试 → turn ${shortId(lineageEntry.retriedToTurnId)}`,
        tooltip: `跳转到对此回答的重试`,
        targetTurnId: lineageEntry.retriedToTurnId,
        direction: 'reverse',
      });
    }
    if (lineageEntry?.regeneratedToTurnId && turnsById.has(lineageEntry.regeneratedToTurnId)) {
      turnBadges.push({
        id: `reverse-regen-${turn.turnId}`,
        label: `已重新生成 → turn ${shortId(lineageEntry.regeneratedToTurnId)}`,
        tooltip: `跳转到对此回答的重新生成`,
        targetTurnId: lineageEntry.regeneratedToTurnId,
        direction: 'reverse',
      });
    }
    if (turnBadges.length > 0) badges[turn.turnId] = turnBadges;
  }

  return {
    turnFooterActionsByTurn: footer,
    turnFailedReasonLabels: failedLabels,
    turnFailedRecoveryLabels: failedRecoveryLabels,
    turnLineageBadgesByTurn: badges,
  };
}
