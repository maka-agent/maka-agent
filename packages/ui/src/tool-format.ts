import type { UiLocale } from './locale-helpers.js';
import { redactSecrets } from './redact.js';
import { getToolActivityCopy } from './tool-activity/copy.js';

/** Locale-aware display name for the group-activation connector. */
export function loadToolDisplayName(locale: UiLocale): string {
  return getToolActivityCopy(locale).loadTools.displayName;
}

interface LoadToolResultDescription {
  title: string;
  countLabel: string;
  toolsText: string;
  footer: string;
}

/**
 * Turn a `load_tools` call + its thin `{ loaded: [...] }` result into friendly,
 * locale-aware card copy. Reads the group id from `group` (current) or the
 * historical `namespace` arg (`load_tool`, PR #30) so replayed old sessions
 * still render. Returns `null` when the result is not the expected shape (e.g. a
 * load failure, a text/error result) so the caller falls back to the generic
 * preview.
 */
export function describeLoadToolResult(
  args: unknown,
  value: unknown,
  locale: UiLocale,
): LoadToolResultDescription | null {
  const loaded = (value as { loaded?: unknown } | null | undefined)?.loaded;
  if (!Array.isArray(loaded) || !loaded.every((name) => typeof name === 'string')) {
    return null;
  }
  const tools = loaded as string[];
  const argRecord = args as { group?: unknown; namespace?: unknown } | null | undefined;
  const rawGroup = argRecord?.group ?? argRecord?.namespace;
  const namespace =
    typeof rawGroup === 'string' && rawGroup.length > 0 ? rawGroup : undefined;
  const n = tools.length;
  const copy = getToolActivityCopy(locale).loadTools;
  return {
    title: copy.loaded(namespace),
    countLabel: copy.count(n),
    toolsText: tools.join(locale === 'en' ? ', ' : '、'),
    footer: copy.footer,
  };
}

export function formatRedactedJson(value: unknown): string {
  try {
    return redactSecrets(JSON.stringify(value, null, 2));
  } catch {
    return redactSecrets(String(value));
  }
}

export function formatToolIntent(intent: string): string {
  const safe = redactSecrets(intent.replace(/\s+/g, ' ').trim());
  return safe.length > 240 ? `${safe.slice(0, 240)}…` : safe;
}
