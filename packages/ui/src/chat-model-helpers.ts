/**
 * Pure value-codec helpers backing the ChatModelSwitcher: group an
 * unsorted list of `ChatModelChoice`s by their connection, and
 * encode/decode the `<connection>:<model>` pair that becomes the
 * Select item value.
 *
 * PR-UI-LIB-EXTRACT-3 (WAWQAQ msg `510fef52`, round 4/10): pulled
 * out of `components.tsx`. `ChatModelChoice` itself was already
 * a public type (consumed by the renderer's main.tsx); the three
 * helpers were panel-internal. byte-for-byte equivalent; behavior
 * unchanged; `index.ts` re-exports the new module so the
 * `@maka/ui` public API surface stays identical.
 *
 * Why this seam: the encode/decode pair is the trust boundary
 * between Select-item string values and structured
 * `{ llmConnectionSlug, model }` records. Living next to ~600
 * lines of ChatModelSwitcher JSX made the codec hard to find and
 * impossible to unit-test in isolation — but it's exactly the
 * kind of pure boundary that benefits from a separate test
 * harness (URI-encoded delimiters, malformed input fall-through).
 */

import { PROVIDER_DEFAULTS, type ProviderType } from '@maka/core';

export interface ChatModelChoice {
  connectionSlug: string;
  providerType: ProviderType;
  model: string;
  label: string;
  /**
   * User-chosen connection label — ONLY for non-OAuth providers (`api_key` /
   * `none` auth), where `connection.name` is a plain label the user typed in
   * Settings when adding the connection (e.g. "OpenRouter", "My Together AI
   * key"). Must stay `undefined` for `claude-subscription` /
   * `codex-subscription` / `gemini-cli`, whose `connection.name` embeds the
   * OAuth account email (PR-CHAT-CHROME-FIX-0) — those three keep falling
   * back to the leak-safe provider label in `modelMenuGroups`. Callers
   * populate this field; `@maka/ui` doesn't know about `LlmConnection` and
   * can't enforce the guard itself.
   */
  connectionName?: string;
}

/**
 * Short, leak-safe provider labels for menu headings. UI display copy lives in
 * the UI layer (not `@maka/core`). `satisfies` keeps it exhaustive over
 * `ProviderType`. models.dev-backed providers fall through to the shared
 * registry label so this UI does not become another provider fact table.
 */
const PROVIDER_SHORT_LABEL: Partial<Record<ProviderType, string>> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  deepseek: 'DeepSeek',
  moonshot: 'Moonshot',
  ollama: 'Ollama',
  'kimi-coding-plan': 'Kimi',
  'zai-coding-plan': 'Z.AI',
  MiniMax: 'MiniMax',
  'MiniMax-cn': 'MiniMax 中国站',
  'openai-compatible': '自定义',
  'claude-subscription': 'Claude 订阅',
  'codex-subscription': 'OpenAI OAuth',
  'gemini-cli': 'Gemini CLI',
};

export interface ModelMenuGroup {
  connectionSlug: string;
  /** Provider of this group, so the menu can render its brand mark on the heading. */
  providerType: ProviderType;
  /**
   * De-duplicated heading. The user's own connection name when one was
   * safely supplied (see `ChatModelChoice.connectionName`); otherwise the
   * short provider label, plus the slug when the same provider has multiple
   * connections. Never derived from an OAuth connection's `connection.name`.
   */
  heading: string;
  choices: ChatModelChoice[];
}

/**
 * Group choices by connection and give each group a distinguishable heading.
 * Prefers the user's own connection name (`ChatModelChoice.connectionName`)
 * when the caller supplied one — safe by construction, since callers only
 * populate it for non-OAuth providers. Falls back to the short provider
 * label, with the connection slug appended when two or more connections of
 * the SAME provider are present and neither supplied a name (e.g. two OpenAI
 * keys) — the slug is a safe `[a-z0-9-]` identifier, never the OAuth
 * account email `connection.name` carries for `claude-subscription` /
 * `codex-subscription` / `gemini-cli`.
 */
export function modelMenuGroups(choices: ChatModelChoice[]): ModelMenuGroup[] {
  const bySlug = new Map<string, { connectionSlug: string; providerType: ProviderType; connectionName?: string; choices: ChatModelChoice[] }>();
  for (const choice of choices) {
    const group = bySlug.get(choice.connectionSlug);
    if (group) {
      group.choices.push(choice);
    } else {
      bySlug.set(choice.connectionSlug, {
        connectionSlug: choice.connectionSlug,
        providerType: choice.providerType,
        connectionName: choice.connectionName,
        choices: [choice],
      });
    }
  }
  const groups = [...bySlug.values()];
  const connectionsPerType = new Map<ProviderType, number>();
  const connectionsPerName = new Map<string, number>();
  for (const group of groups) {
    connectionsPerType.set(group.providerType, (connectionsPerType.get(group.providerType) ?? 0) + 1);
    const ownName = group.connectionName?.trim();
    if (ownName) connectionsPerName.set(ownName, (connectionsPerName.get(ownName) ?? 0) + 1);
  }
  return groups.map((group) => {
    const ownName = group.connectionName?.trim();
    if (ownName) {
      // Two connections can carry the same user-chosen name (the add form
      // defaults it to the provider's display label) — keep them
      // distinguishable with the same slug suffix the label path uses.
      const nameAmbiguous = (connectionsPerName.get(ownName) ?? 0) > 1;
      return {
        connectionSlug: group.connectionSlug,
        providerType: group.providerType,
        heading: nameAmbiguous ? `${ownName} · ${group.connectionSlug}` : ownName,
        choices: group.choices,
      };
    }
    const label = PROVIDER_SHORT_LABEL[group.providerType] ?? PROVIDER_DEFAULTS[group.providerType].label;
    const ambiguous = (connectionsPerType.get(group.providerType) ?? 0) > 1;
    return {
      connectionSlug: group.connectionSlug,
      providerType: group.providerType,
      heading: ambiguous ? `${label} · ${group.connectionSlug}` : label,
      choices: group.choices,
    };
  });
}

export function modelChoiceValue(connectionSlug: string, model: string): string {
  return `${encodeURIComponent(connectionSlug)}:${encodeURIComponent(model)}`;
}

export function parseModelChoiceValue(value: string): { llmConnectionSlug: string; model: string } | undefined {
  const idx = value.indexOf(':');
  if (idx <= 0) return undefined;
  try {
    const llmConnectionSlug = decodeURIComponent(value.slice(0, idx));
    const model = decodeURIComponent(value.slice(idx + 1));
    if (!llmConnectionSlug || !model) return undefined;
    return { llmConnectionSlug, model };
  } catch {
    return undefined;
  }
}
