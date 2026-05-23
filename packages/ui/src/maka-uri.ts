/**
 * PR-UI-RENDER-2 — Internal `maka://` markdown link router.
 *
 * Alma exposes a small allowlist of internal markdown links so the
 * assistant can drop "open Settings · 账号" style affordances directly
 * inside its prose. Maka mirrors that, but **strictly**: the parser
 * is a closed-world allowlist that only accepts the two destinations
 * we are willing to wire today.
 *
 * Locked scope (PR-RENDER-2 review gate, @kenji msg 1e9a9d96):
 *
 *   - `maka://settings/<section>` — navigate to a Settings section.
 *     `<section>` must be a member of the existing `SettingsSection`
 *     union from `@maka/core/settings.ts`. No parallel string table.
 *     Adding a section happens only in core; this allowlist follows.
 *   - `maka://compose?text=...` — prefill the composer. Empty text
 *     is rejected (return null). Raw URL is length-capped before
 *     parsing AND decoded text is length-capped after, so a
 *     `%xx`-encoded bomb can't expand past the budget.
 *
 * Explicitly NOT supported (and never will be at this layer — it's
 * a navigation affordance, not an action runner):
 *
 *   - `maka://session/<id>` — defer until a real session navigation
 *     API exists; URI router must not invent navigation contracts.
 *   - `maka://tool/*`, `maka://auth/*`, `maka://exec/*` — these are
 *     actions, not navigation. Routing markdown into them would let
 *     a prompt-injected assistant turn run tools / log in / execute
 *     commands behind the user's back. Hard `null`.
 *   - External schemes (`http:`, `https:`, `file:`, `javascript:`,
 *     `data:`) — those are not this parser's job. Caller treats
 *     `parseMakaUri(...) === null` as "not an internal link"; the
 *     renderer's normal `<a>` path or the broken-link fallback
 *     handles the rest.
 *
 * `null` covers four kinds of failure indistinguishably (malformed,
 * wrong scheme, unsupported namespace, invalid section). The
 * renderer's job is to render unsupported `maka://` as inline error
 * text — NEVER fall back to `openExternal`. That mapping happens in
 * `components.tsx`; this module is pure.
 */

import type { SettingsSection } from '@maka/core';

/**
 * Reference allowlist of section ids the URI router accepts. Mirrors
 * the `SettingsSection` union exactly. If `@maka/core` adds a new
 * section, TypeScript's exhaustiveness on the assignment below would
 * surface (the discriminated assertion at module load time would
 * tell us we're behind). We don't auto-derive at runtime because the
 * union is a TS-only construct; instead we keep the list right next
 * to the import so the divergence is visible.
 */
const ALLOWED_SETTINGS_SECTIONS = new Set<SettingsSection>([
  'general',
  'personalization',
  'theme',
  'daily-review',
  'models',
  'usage',
  'voice-models',
  'open-gateway',
  'bot-chat',
  'search',
  'network',
  'data',
  'account',
  'permissions',
  'health',
  'about',
]);

/**
 * Hard caps applied to incoming hrefs. The renderer never invokes
 * the parser on assistant-controlled strings longer than this; if
 * something is past these limits, treat it as unsupported.
 *
 *   - `RAW_HREF_MAX_LENGTH`: applied to the raw `href` BEFORE the
 *     URL constructor. Bounds CPU of `new URL()` on adversarial
 *     inputs.
 *   - `COMPOSE_TEXT_MAX_LENGTH`: applied to the DECODED compose
 *     text AFTER `searchParams.get`. A 4KB `%xx`-encoded blob
 *     could decode to ~1.3KB of text, but a 4KB `%E4%B8%80`-only
 *     blob decodes to ~1KB of CJK — both well under the cap. The
 *     cap is here for principle, not for the encoding-bomb case
 *     (URL already caps to ~2KB on most browsers).
 */
const RAW_HREF_MAX_LENGTH = 4096;
const COMPOSE_TEXT_MAX_LENGTH = 4096;

/**
 * Discriminated destination union. The renderer maps each variant to
 * an app-side callback; the parser itself never invokes anything.
 */
export type MakaUriDest =
  | { kind: 'settings'; section: SettingsSection }
  | { kind: 'compose'; text: string };

/**
 * Parse a candidate internal URI. Returns the typed destination on
 * success; `null` on ANY failure (wrong scheme, malformed, unknown
 * namespace, unknown section, oversized, empty compose text, etc.).
 *
 * Strict invariants:
 *   - `url.protocol === 'maka:'` (lowercase, exact). No
 *     case-insensitive scheme match; users typing `Maka://` get
 *     `null`.
 *   - `url.hostname` must be `settings` or `compose` exactly. Any
 *     other host (including empty) returns `null`.
 *   - `settings` requires a single path segment matching a known
 *     `SettingsSection`. No sub-paths, no query, no fragment.
 *   - `compose` requires a non-empty `text` query param within
 *     `COMPOSE_TEXT_MAX_LENGTH` decoded characters.
 *
 * The parser is intentionally narrow. Adding a destination is a code
 * change here AND in the renderer dispatcher AND in the test fixtures
 * AND in smoke.md Path 17 — by design.
 */
export function parseMakaUri(href: string): MakaUriDest | null {
  if (typeof href !== 'string') return null;
  if (href.length === 0 || href.length > RAW_HREF_MAX_LENGTH) return null;
  // Cheap scheme prefilter so we don't hand non-maka strings to
  // `new URL()`. Case-sensitive on purpose (@kenji review gate #2).
  if (!href.startsWith('maka:')) return null;

  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  // `URL` lowercases the scheme during parsing, so this is a no-op
  // sanity check — but documenting the invariant in code keeps the
  // gate visible to future readers.
  if (url.protocol !== 'maka:') return null;
  if (url.username !== '' || url.password !== '') return null;
  if (url.port !== '') return null;
  if (url.hash !== '') return null;

  const host = url.hostname;
  switch (host) {
    case 'settings': {
      // Disallow query and search params on settings — there's no
      // legitimate use today and any tolerance here invites future
      // injection ("?section=&debug=…").
      if (url.search !== '') return null;
      const segments = url.pathname.split('/').filter((seg) => seg.length > 0);
      if (segments.length !== 1) return null;
      const candidate = segments[0]!;
      if (!isSettingsSection(candidate)) return null;
      return { kind: 'settings', section: candidate };
    }
    case 'compose': {
      // `compose` MUST be path-less. Any pathname other than empty or
      // "/" rejects so `maka://compose/run?text=…` can't sneak in.
      if (url.pathname !== '' && url.pathname !== '/') return null;
      const text = url.searchParams.get('text');
      if (text === null) return null;
      if (text.length === 0) return null;
      if (text.length > COMPOSE_TEXT_MAX_LENGTH) return null;
      return { kind: 'compose', text };
    }
    default:
      return null;
  }
}

/**
 * Cheap probe: is `href` syntactically an internal `maka:` URI?
 * Used by the renderer to decide whether to call `parseMakaUri` and
 * branch into the internal-link path vs. the external-link path.
 *
 * Returns `true` even for invalid `maka:` URIs (unknown namespace,
 * malformed section); the caller distinguishes via `parseMakaUri`
 * and renders the broken-link inline error treatment.
 */
export function isMakaUri(href: string): boolean {
  if (typeof href !== 'string') return false;
  return href.startsWith('maka:');
}

function isSettingsSection(value: string): value is SettingsSection {
  // ReadonlySet#has accepts any string; the type predicate narrows
  // the result for the caller.
  return ALLOWED_SETTINGS_SECTIONS.has(value as SettingsSection);
}
