import { redactSecrets } from '../redact.js';

export const TOOL_LINE_CAP = 500;

/** Numeric character references — micromark decodes `&#45;`/`&#x2D;` into
 * the clear during parse (one pass; CommonMark caps decimal references at
 * 7 digits, hex at 6), so the projection decodes them the same way. */
const NUMERIC_REFERENCE = /&#(?:(\d{1,7})|[xX]([0-9a-fA-F]{1,6}));/g;
/** Named character reference candidates. `&hyphen;` renders a glyph
 * visually identical to `-` and `&lowbar;` IS `_` — both members of the
 * secret token charsets — so the projection substitutes `-` (a charset
 * member) instead of carrying the HTML5 entity table. Unknown names cost
 * a false positive only (the mono <pre> presentation). */
const NAMED_REFERENCE = /&[a-zA-Z][a-zA-Z0-9]{1,31};/g;
/** ASCII punctuation range of a CommonMark backslash escape. */
const BACKSLASH_ESCAPE = /\\([\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e])/g;
/** Link / image destinations — `](…)` — vanish wholesale from rendered text. */
const LINK_DESTINATION = /\]\([^)]*\)/g;
/** Reference-style link labels — `][…]` — vanish from rendered text exactly
 * like inline destinations (`[sk-][.]1234` renders `<a>sk-</a>1234`, codex
 * review round 4). Covers full (`[text][label]`) and collapsed (`[text][]`)
 * references; shortcut references (`[text]`) are bare brackets, handled by
 * the char strip below. */
const REFERENCE_LABEL = /\]\[[^\]]*\]/g;
/** Raw HTML tags. react-markdown v9 without rehype-raw renders raw HTML as
 * literal TEXT (so `<redacted>` markers survive and `sk<b>-</b>123` displays
 * with its tags visible); stripping tags here models the skipHtml-style drop
 * anyway, as a defensive fallback against future pipeline config — a false
 * positive only costs the mono <pre> presentation. */
const RAW_HTML_TAG = /<[^>\n]*>/g;
/** Characters markdown rendering can consume out of the visible text:
 * escape backslashes, emphasis/strike/code delimiters, link/image/autolink
 * brackets, table pipes. Removing them approximates what a reader of the
 * rendered output would see as contiguous text. */
const MARKDOWN_CONSUMED_CHARS = /[\\*_~`[\]()<>!|]/g;

/** Mirror micromark's numeric-reference decode for the projection. NUL,
 * out-of-range, and surrogate code points decode to U+FFFD, as in HTML. */
function decodeNumericReference(dec: string | undefined, hex: string | undefined): string {
  const codePoint = dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex ?? '', 16);
  if (codePoint === 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
    return '�';
  }
  return String.fromCodePoint(codePoint);
}

/**
 * Would markdown rendering reassemble redactable content the raw-text
 * redactor never matched? `sk&#45;…`, `sk\-…`, `sk*-*…`, `[sk-](x)…`,
 * `sk<b>-</b>…` all hide the secret from `redactSecrets` while the
 * RENDERED text shows it contiguous (or a visually identical glyph) —
 * markdown acts as a decode oracle (codex review P1, rounds 2–4). The
 * channels can't be neutralized one-by-one without an arms race, so this
 * projects the text onto "what rendering could expose" and lets the
 * caller degrade to the literal <pre> path when the projection would be
 * redacted. Heuristic by design: the raw text was already redacted
 * (primary defense); this catches reference- and punctuation-hidden
 * shapes, and a false positive merely costs the mono <pre> presentation.
 */
function markdownWouldRevealRedactable(text: string): boolean {
  const projection = text
    .replace(NUMERIC_REFERENCE, (_, dec: string | undefined, hex: string | undefined) =>
      decodeNumericReference(dec, hex),
    )
    .replace(NAMED_REFERENCE, '-')
    .replace(BACKSLASH_ESCAPE, '$1')
    .replace(LINK_DESTINATION, ']')
    .replace(REFERENCE_LABEL, ']')
    .replace(RAW_HTML_TAG, '')
    .replace(MARKDOWN_CONSUMED_CHARS, '');
  return redactSecrets(projection) !== projection;
}

/**
 * Decide how a text-kind tool result renders (#546 PR6): redact, translate
 * the user-visible boilerplate, cap the line count, then either
 *
 * - `{ markdown }` — the common case: prose rendering of the text byte-
 *   identical. No blanket `&`→`&amp;` escaping: CommonMark keeps character
 *   references literal inside code spans/blocks, so escaping displayed
 *   `cmd && next` as `cmd &amp;&amp; next` and corrupted the code-copy
 *   payload (codex review round 5 P2). Entity-decode safety lives in the
 *   projection degrade below instead. Or
 * - `{ plain }` — the degraded case: markdown rendering (reference decode
 *   or consumed punctuation) would reassemble redactable content, so the
 *   caller must render the literal <pre> overlay (what every text result
 *   used before PR6).
 */
export function toolTextPreviewPlan(text: string): { markdown: string } | { plain: string } {
  const { body, capped } = capLines(formatUserVisibleToolText(redactSecrets(text)));
  const suffixed = capped > 0 ? `${body}\n\n… 已隐藏 ${capped} 行` : body;
  if (markdownWouldRevealRedactable(suffixed)) return { plain: suffixed };
  return { markdown: suffixed };
}

export function capLines(text: string): { body: string; capped: number } {
  const lines = text.split('\n');
  if (lines.length <= TOOL_LINE_CAP) return { body: text, capped: 0 };
  return {
    body: lines.slice(0, TOOL_LINE_CAP).join('\n'),
    capped: lines.length - TOOL_LINE_CAP,
  };
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDuration(ms: number | undefined): string | null {
  if (ms === undefined || ms < 0) return null;
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

export function formatUserVisibleToolText(text: string): string {
  return text.replace(/\bUser denied permission\b/g, '用户已拒绝权限请求');
}
