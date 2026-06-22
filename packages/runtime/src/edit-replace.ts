// packages/runtime/src/edit-replace.ts
//
// Shared, fault-tolerant string-edit logic used by BOTH Edit tool
// implementations:
//   - the in-process builtin Edit tool (packages/runtime/src/builtin-tools.ts),
//     which imports and calls computeEditedSource directly, and
//   - the isolated headless Edit tool (packages/headless/src/tools.ts), which
//     embeds COMPUTE_EDITED_SOURCE_FN_SOURCE into a `node -e` script that runs
//     inside the isolated executor process (the actual benchmark path).
//
// CONSTRAINT: computeEditedSource must stay fully self-contained — no imports,
// no references to module-scope bindings, every helper a nested *function
// declaration* (hoisted, so order-independent), no generators — so that
// `.toString()` yields a standalone definition that runs unchanged inside the
// isolated process. This keeps a single source of truth for both call sites.
//
// SAFETY MODEL (the point of this module): exact-match drift (whitespace,
// indentation, escaping) is forgiven, but a fuzzy match must never silently
// land in the wrong place. Every fuzzy strategy here verifies the FULL span is
// structurally equivalent to old_string (not just anchors), and a strategy is
// only accepted when it produces exactly ONE candidate occurring exactly ONCE.
// Any ambiguity throws instead of guessing.
//
// Strategies are adapted from opencode's edit.ts (sourced from cline diff-apply
// + gemini-cli editCorrector). We keep the three distinctly-reachable full-span
// matchers (line-trimmed, whitespace-normalized, escape-normalized) and omit:
//   - indentation-flexible and trimmed-boundary, which are strictly shadowed by
//     line-trimmed / whitespace-normalized here (they add no reachable match);
//   - block-anchor and context-aware, which match on partial signal (first/last
//     line + similarity) and need a tuned similarity threshold — deliberately
//     deferred to keep wrong-location risk out.

export type EditMatchStrategy =
  | 'exact'
  | 'line-trimmed'
  | 'whitespace'
  | 'escape';

export interface EditMatch {
  /** The full new file content after the replacement. */
  content: string;
  /** Which strategy located old_string ('exact' or a fuzzy strategy name). */
  matchedVia: EditMatchStrategy;
  /** 1-based first line of the matched span in the original source. */
  startLine: number;
  /** 1-based last line (inclusive) of the matched span in the original source. */
  endLine: number;
}

/**
 * Apply a single, unambiguous replacement of `oldString` with `newString` in
 * `source`, tolerating whitespace/indentation/escape drift via a guarded fuzzy
 * cascade. `where` is the caller's relative path, embedded in error messages.
 *
 * @returns the new content plus which strategy matched and the matched line
 *   range (so the caller can show the model where the edit landed).
 * @throws when old_string is absent, ambiguous, identical to new_string, too
 *   short to fuzzy-match safely, or matches a disproportionately large span.
 */
export function computeEditedSource(
  source: string,
  oldString: string,
  newString: string,
  where: string,
): EditMatch {
  // Declared inside the function (not module scope) so .toString() carries it
  // into the isolated EDIT_SCRIPT — module-scope references do not survive
  // serialization. Minimum trimmed old_string length for a non-exact match.
  const MIN_FUZZY_OLD_STRING_LENGTH = 5;

  if (oldString === newString) {
    throw new Error(`No changes to apply in ${where}: old_string and new_string are identical`);
  }
  if (oldString === '') {
    throw new Error(`old_string must not be empty in ${where}`);
  }

  // Exact match first — preserves the prior behavior, including the informative
  // match count, and short-circuits before any fuzzy work.
  const exactCount = source.split(oldString).length - 1;
  if (exactCount === 1) {
    return finish(source, oldString, newString, 'exact');
  }
  if (exactCount > 1) {
    throw new Error(`old_string is not unique in ${where} (${exactCount} matches)`);
  }

  // Fuzzy strategies, increasing tolerance. Each returns FULL-span candidates
  // structurally equivalent to old_string; the loop below requires exactly one.
  const strategies: Array<[EditMatchStrategy, (content: string, find: string) => string[]]> = [
    ['line-trimmed', lineTrimmedSpans],
    ['whitespace', whitespaceNormalizedSpans],
    ['escape', escapeNormalizedSpans],
  ];

  for (const [name, finder] of strategies) {
    const spans = dedupeInContent(source, finder(source, oldString));
    if (spans.length === 0) continue;
    if (spans.length > 1) {
      throw new Error(
        `old_string matched ${spans.length} different ${name} candidates in ${where}; provide more exact context to disambiguate`,
      );
    }
    const span = spans[0];
    if (source.indexOf(span) !== source.lastIndexOf(span)) {
      throw new Error(
        `old_string matched a ${name} span that occurs more than once in ${where}; provide more exact context to disambiguate`,
      );
    }
    if (oldString.trim().length < MIN_FUZZY_OLD_STRING_LENGTH) {
      throw new Error(
        `old_string is too short for a non-exact match in ${where}; provide a longer, exact snippet`,
      );
    }
    if (isDisproportionate(span, oldString)) {
      throw new Error(
        `Refusing ${name} match in ${where}: the matched span is much larger than old_string. Re-read the file and pass the exact text to replace.`,
      );
    }
    return finish(source, span, newString, name);
  }

  throw new Error(
    `old_string not found in ${where}; it must match the file's text including whitespace and indentation`,
  );

  // ---- nested helpers (kept inside for self-contained .toString() embedding) ----

  function finish(
    content: string,
    span: string,
    replacement: string,
    matchedVia: EditMatchStrategy,
  ): EditMatch {
    const index = content.indexOf(span);
    const before = content.slice(0, index);
    const startLine = before.split('\n').length;
    // A trailing newline in the span is the last line's terminator, not an
    // extra line, so it must not bump endLine.
    const spanLineCount = span.split('\n').length - (span.endsWith('\n') ? 1 : 0);
    const endLine = startLine + Math.max(spanLineCount, 1) - 1;
    // slice-join (not String.replace) so `$&`/`$1` in newString are literal.
    const next = before + replacement + content.slice(index + span.length);
    return { content: next, matchedVia, startLine, endLine };
  }

  function dedupeInContent(content: string, candidates: string[]): string[] {
    const out: string[] = [];
    for (const candidate of candidates) {
      if (!candidate) continue;
      if (content.indexOf(candidate) === -1) continue;
      if (out.indexOf(candidate) === -1) out.push(candidate);
    }
    return out;
  }

  function lineTrimmedSpans(content: string, find: string): string[] {
    const out: string[] = [];
    const originalLines = content.split('\n');
    const findEndsWithNewline = find.endsWith('\n');
    const searchLines = find.split('\n');
    if (searchLines.length > 0 && searchLines[searchLines.length - 1] === '') {
      searchLines.pop();
    }
    if (searchLines.length === 0) return out;
    for (let i = 0; i <= originalLines.length - searchLines.length; i++) {
      let matches = true;
      for (let j = 0; j < searchLines.length; j++) {
        if (originalLines[i + j].trim() !== searchLines[j].trim()) {
          matches = false;
          break;
        }
      }
      if (!matches) continue;
      let startIndex = 0;
      for (let k = 0; k < i; k++) startIndex += originalLines[k].length + 1;
      let endIndex = startIndex;
      for (let k = 0; k < searchLines.length; k++) {
        endIndex += originalLines[i + k].length;
        if (k < searchLines.length - 1) endIndex += 1;
      }
      // If old_string ended with a newline, the matched span must include the
      // file's newline after the last matched line; otherwise the replacement
      // would drop or duplicate a line break. When there is no such newline
      // (EOF with no trailing newline) this is not a faithful match — skip it.
      if (findEndsWithNewline) {
        const lastLine = i + searchLines.length - 1;
        if (lastLine >= originalLines.length - 1) continue;
        endIndex += 1;
      }
      out.push(content.substring(startIndex, endIndex));
    }
    return out;
  }

  function whitespaceNormalizedSpans(content: string, find: string): string[] {
    const out: string[] = [];
    const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
    const normalizedFind = normalize(find);
    if (normalizedFind === '') return out;
    const lines = content.split('\n');
    const findLines = find.split('\n');
    if (findLines.length === 1) {
      // Single-line old_string: match individual lines only. A multi-line
      // old_string must never collapse onto one physical line — normalize()
      // turns newlines into spaces, so an unguarded single-line scan would let
      // `a\nb` match the line `a b`, which is a wrong-location edit.
      for (let i = 0; i < lines.length; i++) {
        if (normalize(lines[i]) === normalizedFind) out.push(lines[i]);
      }
    } else {
      for (let i = 0; i <= lines.length - findLines.length; i++) {
        const block = lines.slice(i, i + findLines.length).join('\n');
        if (normalize(block) === normalizedFind) out.push(block);
      }
    }
    return out;
  }

  function escapeNormalizedSpans(content: string, find: string): string[] {
    const out: string[] = [];
    const unescape = (str: string) =>
      str.replace(/\\(n|t|r|'|"|`|\\|\n|\$)/g, (match: string, ch: string) => {
        if (ch === 'n') return '\n';
        if (ch === 't') return '\t';
        if (ch === 'r') return '\r';
        if (ch === "'") return "'";
        if (ch === '"') return '"';
        if (ch === '`') return '`';
        if (ch === '\\') return '\\';
        if (ch === '\n') return '\n';
        if (ch === '$') return '$';
        return match;
      });
    const unescapedFind = unescape(find);
    if (content.includes(unescapedFind)) out.push(unescapedFind);
    const lines = content.split('\n');
    const findLines = unescapedFind.split('\n');
    for (let i = 0; i <= lines.length - findLines.length; i++) {
      const block = lines.slice(i, i + findLines.length).join('\n');
      if (unescape(block) === unescapedFind) out.push(block);
    }
    return out;
  }

  function isDisproportionate(span: string, find: string): boolean {
    const oldLines = find.split('\n').length;
    const spanLines = span.split('\n').length;
    if (spanLines >= Math.max(oldLines + 3, oldLines * 2)) return true;
    if (oldLines === 1) return false;
    return span.trim().length > Math.max(find.trim().length + 500, find.trim().length * 4);
  }
}

/**
 * Serialized source of computeEditedSource, captured once at module load for
 * embedding into the isolated headless EDIT_SCRIPT. Using the live function's
 * own source avoids drift between the in-process and serialized forms.
 */
export const COMPUTE_EDITED_SOURCE_FN_SOURCE: string = computeEditedSource.toString();
