import { micromark } from 'micromark';
import { gfm, gfmHtml } from 'micromark-extension-gfm';
import { redactSecrets } from '../redact.js';

export const TOOL_LINE_CAP = 500;

/** Same syntax surface as MarkdownBody (remark-gfm over the CommonMark
 * core — both stacks share micromark's tokenizer, so the parse is
 * identical; only the serialization differs). */
const MICROMARK_OPTIONS = { extensions: [gfm()], htmlExtensions: [gfmHtml()] };

/** micromark encodes `<`, `>`, `"`, and `&` everywhere it emits source
 * text (element content and attribute values alike), so `>` inside a tag
 * is always the tag's own closer and this strip is exact. */
const HTML_TAG = /<[^>]*>/g;

/** Invert micromark's text encoding — it emits exactly these five
 * references. `&amp;` must decode last so `&amp;lt;` (source text `&lt;`)
 * comes back as the glyphs `&lt;`, not `<`. */
function decodeMicromarkText(html: string): string {
  return html
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Glyphs visually indistinguishable from `-` / `_` — the two secret-token
 * charset members that HTML named references can produce (`&hyphen;` and
 * `&dash;` decode to U+2010, `&lowbar;` to a real `_`). The old <pre> path
 * showed those references as literal bytes; only the markdown decode turns
 * them into look-alike glyphs, so the projection folds the dash and
 * low-line families back to ASCII before re-running the redactor. */
const HYPHEN_GLYPHS = /[‐-―−﹘﹣－]/g;
const UNDERSCORE_GLYPHS = /[‗﹍-﹏＿]/g;

/**
 * Would markdown rendering reassemble redactable content the raw-text
 * redactor never matched? `sk&#45;…`, `sk\-…`, `sk*-*…`, `[sk-](x "t")…`
 * all hide the secret from `redactSecrets` while the RENDERED text shows
 * it contiguous (or as a visually identical glyph) — markdown acts as a
 * decode oracle (codex review P1, rounds 2–6). Hand-rolled projections of
 * that grammar lost an arms race four rounds running, so this asks the
 * grammar itself: render with micromark (the same tokenizer MarkdownBody
 * uses), take the visible text back out, and let the caller degrade to
 * the literal <pre> path when redaction would fire on it. The raw text
 * was already redacted (primary defense); a false positive here merely
 * costs the mono <pre> presentation.
 */
function markdownWouldRevealRedactable(text: string): boolean {
  let html: string;
  try {
    html = micromark(text, MICROMARK_OPTIONS);
  } catch {
    return true; // cannot prove the render safe — degrade
  }
  const projection = decodeMicromarkText(html.replace(HTML_TAG, ''))
    .replace(HYPHEN_GLYPHS, '-')
    .replace(UNDERSCORE_GLYPHS, '_');
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
