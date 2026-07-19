/**
 * PR-UI-IPC-2 (@kenji msg 0474c3fe + @xuan msg 88d96a87):
 * User-visible session name normalization contract.
 *
 * `SessionHeader.name` is the title users see in the sidebar list,
 * tab headers, and any future export/share surfaces. It's
 * user-typed (sidebar inline rename) or runtime-derived (default
 * "New Chat", branch "${parent} · 分支") — both paths need the
 * same gate so the store only ever sees safe text.
 *
 * The contract is **a single pure helper** in this `@maka/core`
 * module so every write path can call it:
 *   - `sessions:create`  IPC → runtime.create → store.create
 *   - `sessions:rename`  IPC → runtime.renameSession → store.rename
 *   - `sessions:branchFromTurn`  IPC → runtime.branchFromTurn → store.create
 *
 * Pipeline (applied in order):
 *   1. **Runtime type guard**: `typeof input !== 'string'` → typed
 *      reject. IPC payloads cross a process boundary; TypeScript
 *      signature alone is not enough.
 *   2. **NFC canonicalization**: `input.normalize('NFC')`. Combines
 *      composed forms so visually-identical strings hash equally.
 *      NOT a security boundary — it doesn't prevent bidi spoofing
 *      or zero-width injection.
 *   3. **C0/C1 control character → single space**: matches
 *      `\u0000-\u001F` (NUL through US), `\u007F` (DEL),
 *      `\u0080-\u009F` (C1 controls). Replaced with space (not
 *      removed) so `foo\nbar` becomes `foo bar`, not `foobar`.
 *   4. **Bidi format chars → single space**: U+202A..U+202E
 *      (LRE/RLE/PDF/LRO/RLO) and U+2066..U+2069 (LRI/RLI/FSI/PDI).
 *      Defense against right-to-left override spoofs that could
 *      make a session name display as something other than the
 *      stored bytes.
 *   5. **Zero-width format chars → removed**: U+200B (ZWSP),
 *      U+200C (ZWNJ), U+200D (ZWJ), U+FEFF (BOM). These are
 *      invisible characters that can be used to inject deceptive
 *      content into otherwise-identical-looking strings; removing
 *      (not space-replacing) avoids gratuitous spaces in legitimate
 *      Chinese/emoji text (which uses ZWJ internally for compound
 *      emoji).
 *   6. **Whitespace collapse**: any `\s+` → single space.
 *   7. **Trim**: leading/trailing whitespace removed.
 *   8. **Empty check**: if the result is empty, typed reject. The
 *      caller decides whether to fall back to a default or
 *      surface the error.
 *   9. **Code-point length cap (80)**: not byte length, not UTF-16
 *      code unit length — uses `Array.from(...)` to iterate by
 *      code points so a surrogate pair (emoji) isn't cut in half.
 *      80 matches the existing `store.rename` cap.
 *
 * Returns `{ ok: true; value }` with the normalized canonical
 * string, or `{ ok: false; error }` with a typed reason.
 *
 * Scope (out of bounds for this contract — single-responsibility):
 *   - HTML/Markdown escaping for display: the renderer/Markdown
 *     layer handles output encoding; this helper only sanitizes
 *     storage input.
 *   - URL/path encoding: session names are NEVER used as path
 *     segments (the session id is the path; name is metadata).
 *     `assertSafeSessionId` covers the id path.
 *   - Default value selection: callers decide what to do when
 *     `input === undefined` (e.g. `sessions:create` uses
 *     `'New Chat'`); this helper only accepts string inputs.
 */

export type NormalizeSessionNameResult = { ok: true; value: string } | { ok: false; error: string };

export const DEFAULT_SESSION_NAME = 'New Chat';

/**
 * @kenji + @xuan: code-point cap. 80 chars matches the existing
 * `store.rename` behavior; do NOT change here.
 */
export const SESSION_NAME_MAX_CODE_POINTS = 80;

// PR-UI-IPC-2 review fixup v2 (@kenji msg f5daa4d4):
// Regex character classes MUST use escaped `\uXXXX` ranges, NOT
// literal control bytes. Literal U+0000 / bidi / zero-width
// bytes in source make git treat the TS file as binary, which
// breaks diff/patch review and the merge gate's source grep.
// The `\u....` form compiles to an identical regex at runtime
// but keeps the source readable as plain text.

// C0 control characters: U+0000..U+001F (NUL through US),
// U+007F (DEL), U+0080..U+009F (C1 controls). Replaced with
// single space so multi-line input becomes readable single-line.
const CONTROL_CHARS_REGEX = /[\u0000-\u001F\u007F-\u009F]/g;

// Bidi format characters that can spoof display direction.
// Replaced with space (not removed) so adjacent words remain
// separated.
//   U+202A LRE, U+202B RLE, U+202C PDF, U+202D LRO, U+202E RLO
//   U+2066 LRI, U+2067 RLI, U+2068 FSI, U+2069 PDI
const BIDI_FORMAT_REGEX = /[\u202A-\u202E\u2066-\u2069]/g;

// Zero-width format characters. Removed entirely (no replacement)
// because they're meant to be invisible and replacing with space
// would inject visible whitespace into legitimate CJK/emoji
// sequences that may contain ZWJ for compound emoji.
//   U+200B ZWSP, U+200C ZWNJ, U+200D ZWJ, U+FEFF BOM
const ZERO_WIDTH_REGEX = /[\u200B-\u200D\uFEFF]/g;

export function normalizeUserSessionName(input: unknown): NormalizeSessionNameResult {
  // L1: runtime type guard — IPC payloads cross process boundary.
  if (typeof input !== 'string') {
    return { ok: false, error: 'Session name must be a string' };
  }
  // L2: NFC canonicalization. Visually-equivalent composed forms
  // get a single canonical representation. NOT a security
  // boundary by itself — see L3-L5 for spoofing defenses.
  const canonical = input.normalize('NFC');
  // L3: C0/C1 controls → single space. `foo\nbar` becomes
  // `foo bar`, not `foobar`.
  const noControls = canonical.replace(CONTROL_CHARS_REGEX, ' ');
  // L4: bidi format chars → single space. Defense against
  // right-to-left override display spoofs.
  const noBidi = noControls.replace(BIDI_FORMAT_REGEX, ' ');
  // L5: zero-width format chars → removed. Defense against
  // invisible-character injection. NOT space-replaced because
  // legitimate compound emoji (e.g. 👨\u200D👩\u200D👧) use ZWJ internally
  // and we want to remove them entirely from the title rather
  // than visibly fragment text.
  const noZeroWidth = noBidi.replace(ZERO_WIDTH_REGEX, '');
  // L6: collapse internal whitespace runs to a single space.
  const collapsed = noZeroWidth.replace(/\s+/g, ' ');
  // L7: trim leading/trailing whitespace.
  const trimmed = collapsed.trim();
  // L8: empty-after-sanitize → reject. Caller decides whether to
  // fall back to a default (e.g. `'New Chat'` for create) or
  // surface the error (e.g. inline rename).
  if (trimmed === '') {
    return { ok: false, error: 'Session name cannot be empty after sanitization' };
  }
  // L9: code-point cap. `Array.from(string)` iterates by code
  // points so a surrogate pair (e.g. emoji `🦊` = U+1F98A,
  // encoded as 2 UTF-16 code units) counts as one code point and
  // never gets cut in half.
  const codePoints = Array.from(trimmed);
  if (codePoints.length > SESSION_NAME_MAX_CODE_POINTS) {
    const capped = codePoints.slice(0, SESSION_NAME_MAX_CODE_POINTS).join('');
    return { ok: true, value: capped };
  }
  return { ok: true, value: trimmed };
}
