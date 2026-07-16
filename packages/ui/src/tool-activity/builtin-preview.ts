/**
 * Re-export the shared quiet-panel formatting from `@maka/core` (#1065).
 *
 * `formatToolInvocationLine` and `formatQuietJsonValue` are pure functions
 * extracted from this module into `@maka/core` so the CLI/TUI can consume
 * the same path. Desktop passes `detectUiLocale()` — the default `'zh'`
 * locale preserves byte-identical output to the previous inline implementation.
 *
 * The desktop `ToolActivityItem`-typed signature is adapted here so existing
 * call sites (`tool-activity.tsx`, `tool-result-preview.tsx`) keep their
 * `Pick<ToolActivityItem, ...>` parameter without depending on the core
 * `ToolInvocationInput` type.
 */
import {
  formatQuietJsonValue as coreFormatQuietJsonValue,
  formatToolInvocationLine as coreFormatToolInvocationLine,
} from '@maka/core';
import { detectUiLocale } from '../locale-helpers.js';
import type { ToolActivityItem } from '../materialize.js';

export type { QuietPreview } from '@maka/core';

/** Desktop-adapted wrapper that injects the detected UI locale. */
export function formatToolInvocationLine(
  item: Pick<ToolActivityItem, 'toolName' | 'args' | 'activityKind'>,
): string | undefined {
  return coreFormatToolInvocationLine(
    { toolName: item.toolName, args: item.args },
    detectUiLocale(),
  );
}

/** Desktop-adapted wrapper that injects the detected UI locale. */
export function formatQuietJsonValue(value: unknown): import('@maka/core').QuietPreview {
  return coreFormatQuietJsonValue(value, detectUiLocale());
}