/**
 * Small pure helpers backing the chat surface (TurnView,
 * RelativeTime, StreamingAssistantBubble, etc.) —
 * time formatters, turn duration + abort marker copy.
 *
 * PR-UI-LIB-EXTRACT-4 (round 5/10) introduced this module with a
 * deliberate ESM circular import on `./components.js` for
 * `detectUiLocale`. PR-UI-LIB-EXTRACT-5 (round 6/10) broke the
 * cycle by lifting `detectUiLocale` into a new `locale-helpers`
 * leaf module; this file now depends on that leaf instead.
 *
 * Why this seam: duration formatting has ms→s→m bucket rules, and
 * the abort-marker label is i18n-able copy. Each rule was
 * previously buried between TurnView's 200-line JSX block and
 * StreamingAssistantBubble's stream-snap hookup; the bundle now
 * sits as short pure functions easy to unit-test in isolation.
 *
 * PR-CHAT-CHROME-FOLLOWUP-0: `messageRoleLabel` / `avatarInitial`
 * were removed — the chat surface dropped per-message avatars and
 * name labels (MessageMeta), leaving both helpers with zero call
 * sites.
 */

import { detectUiLocale } from './locale-helpers.js';

export function createAbsoluteTimeFormat(): Intl.DateTimeFormat {
  if (typeof Intl === 'undefined' || typeof Intl.DateTimeFormat !== 'function') {
    return { format: (d: Date) => d.toISOString() } as unknown as Intl.DateTimeFormat;
  }
  return new Intl.DateTimeFormat(
    detectUiLocale() === 'en' ? 'en' : 'zh-CN',
    { dateStyle: 'medium', timeStyle: 'short' },
  );
}

export function formatAbsoluteTimestamp(ts: number): string {
  return createAbsoluteTimeFormat().format(new Date(ts));
}

export function formatTurnDuration(ms: number): string {
  // Same shape as tool-activity's formatDuration — the turn meta chip
  // and tool cards sit stacked in one view;「1 m 0 s」vs「8.2s」read as
  // two different products.
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

export function turnAbortMarkerLabel(abortSource: string | undefined): string {
  switch (abortSource) {
    case 'renderer.stop_button': return '(已中断 · 由停止按钮触发)';
    default: return '(已中断)';
  }
}
