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

import type { ProviderType } from '@maka/core';

export interface ChatModelChoice {
  connectionSlug: string;
  providerType: ProviderType;
  model: string;
  /* Intentionally NO connection-name / label field. `connection.name`
     embeds the OAuth account email (PR-CHAT-CHROME-FIX-0); the menu heading
     is derived from `providerType` (+ slug on collision) in `modelMenuGroups`,
     never from the name. */
}

/**
 * Short, leak-safe provider labels for menu headings. UI display copy lives in
 * the UI layer (not `@maka/core`). `satisfies` keeps it exhaustive over
 * `ProviderType` at compile time without a hand-maintained list — add a
 * provider and this object stops type-checking until it gets a label.
 */
const PROVIDER_SHORT_LABEL = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  deepseek: 'DeepSeek',
  moonshot: 'Moonshot',
  ollama: 'Ollama',
  'kimi-coding-plan': 'Kimi',
  'zai-coding-plan': 'Z.AI',
  'openai-compatible': '自定义',
  'claude-subscription': 'Claude 订阅',
  'codex-subscription': 'Codex 订阅',
  'gemini-cli': 'Gemini CLI',
} satisfies Record<ProviderType, string>;

export interface ModelMenuGroup {
  connectionSlug: string;
  /**
   * Leak-safe, de-duplicated heading. Derived from `providerType` (plus the
   * slug when the same provider has multiple connections); never from
   * `connection.name`.
   */
  heading: string;
  choices: ChatModelChoice[];
}

/**
 * Group choices by connection and give each group a leak-safe, distinguishable
 * heading. The heading is the short provider label; when two or more
 * connections of the SAME provider are present (e.g. two OpenAI keys), the
 * connection slug is appended so the user can tell them apart. The slug is a
 * safe `[a-z0-9-]` identifier and never carries the account email that
 * `connection.name` does, so the heading is leak-safe by construction.
 */
export function modelMenuGroups(choices: ChatModelChoice[]): ModelMenuGroup[] {
  const bySlug = new Map<string, { connectionSlug: string; providerType: ProviderType; choices: ChatModelChoice[] }>();
  for (const choice of choices) {
    const group = bySlug.get(choice.connectionSlug);
    if (group) {
      group.choices.push(choice);
    } else {
      bySlug.set(choice.connectionSlug, {
        connectionSlug: choice.connectionSlug,
        providerType: choice.providerType,
        choices: [choice],
      });
    }
  }
  const groups = [...bySlug.values()];
  const connectionsPerType = new Map<ProviderType, number>();
  for (const group of groups) {
    connectionsPerType.set(group.providerType, (connectionsPerType.get(group.providerType) ?? 0) + 1);
  }
  return groups.map((group) => {
    const label = PROVIDER_SHORT_LABEL[group.providerType];
    const ambiguous = (connectionsPerType.get(group.providerType) ?? 0) > 1;
    return {
      connectionSlug: group.connectionSlug,
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
