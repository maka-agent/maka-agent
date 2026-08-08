const BEGIN_PATCH_MARKER = '*** Begin Patch';
const END_PATCH_MARKER = '*** End Patch';
const ADD_FILE_MARKER = '*** Add File: ';
const DELETE_FILE_MARKER = '*** Delete File: ';
const UPDATE_FILE_MARKER = '*** Update File: ';
const MOVE_TO_MARKER = '*** Move to: ';
const EOF_MARKER = '*** End of File';
const CHANGE_CONTEXT_MARKER = '@@';

export type ApplyPatchHunk =
  | { kind: 'add'; path: string; contents: string }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; chunks: ApplyPatchUpdateChunk[] };

export interface ApplyPatchUpdateChunk {
  changeContext?: string;
  oldLines: string[];
  newLines: string[];
  isEndOfFile: boolean;
}

export type ApplyPatchParseError =
  | { code: 'invalid_patch'; message: string }
  | { code: 'invalid_hunk'; message: string; lineNumber: number };

export type ApplyPatchParseOutcome =
  | { ok: true; value: { hunks: ApplyPatchHunk[] } }
  | { ok: false; error: ApplyPatchParseError };

export type ApplyPatchContentOutcome =
  | { ok: true; content: string }
  | { ok: false; error: { code: 'hunk_mismatch'; path: string; message: string } };

export type ApplyPatchPathState =
  | { readonly kind: 'missing' }
  | { readonly kind: 'file'; readonly content: string }
  | { readonly kind: 'symlink' }
  | { readonly kind: 'other' };

export type PlannedPatchMutation =
  | { operation: 'add'; path: string; content: string }
  | { operation: 'update'; path: string; content: string }
  | { operation: 'delete'; path: string };

export function parseApplyPatch(input: string): ApplyPatchParseOutcome {
  let lines = input
    .replace(/^\uFEFF/, '')
    .trim()
    .split(/\r\n?|\n/);
  const first = lines[0]?.trim();
  if (
    lines.length >= 4 &&
    (first === '<<EOF' || first === "<<'EOF'" || first === '<<"EOF"') &&
    lines.at(-1)?.trim() === 'EOF'
  ) {
    lines = lines.slice(1, -1);
  }
  if (lines[0]?.trim() !== BEGIN_PATCH_MARKER || lines.at(-1)?.trim() !== END_PATCH_MARKER) {
    return {
      ok: false,
      error: {
        code: 'invalid_patch',
        message: `Patch must start with ${BEGIN_PATCH_MARKER} and end with ${END_PATCH_MARKER}`,
      },
    };
  }

  const hunks: ApplyPatchHunk[] = [];
  let index = 1;
  while (index < lines.length - 1) {
    const line = lines[index]!;
    const header = line.trim();
    const lineNumber = index + 1;
    if (header.startsWith(ADD_FILE_MARKER)) {
      const path = header.slice(ADD_FILE_MARKER.length).trim();
      if (!path) return invalidHunk('Add File header is missing a path', lineNumber);
      index += 1;
      const content: string[] = [];
      while (index < lines.length - 1 && lines[index]!.startsWith('+')) {
        content.push(lines[index]!.slice(1));
        index += 1;
      }
      hunks.push({
        kind: 'add',
        path,
        contents: content.length === 0 ? '' : `${content.join('\n')}\n`,
      });
      continue;
    }

    if (header.startsWith(DELETE_FILE_MARKER)) {
      const path = header.slice(DELETE_FILE_MARKER.length).trim();
      if (!path) return invalidHunk('Delete File header is missing a path', lineNumber);
      hunks.push({ kind: 'delete', path });
      index += 1;
      continue;
    }

    if (header.startsWith(UPDATE_FILE_MARKER)) {
      const path = header.slice(UPDATE_FILE_MARKER.length).trim();
      if (!path) return invalidHunk('Update File header is missing a path', lineNumber);
      index += 1;
      if (lines[index]?.trim().startsWith(MOVE_TO_MARKER)) {
        return invalidHunk('Move to is not supported', index + 1);
      }
      const chunks: ApplyPatchUpdateChunk[] = [];
      while (index < lines.length - 1 && !isFileOperationHeader(lines[index]!)) {
        let changeContext: string | undefined;
        const chunkHeader = lines[index]!.trim();
        if (chunkHeader === CHANGE_CONTEXT_MARKER || chunkHeader.startsWith('@@ ')) {
          changeContext = chunkHeader === CHANGE_CONTEXT_MARKER ? undefined : chunkHeader.slice(3);
          index += 1;
        }
        const chunk = readChunk(lines, index, lines.length - 1);
        if (!chunk.ok) return chunk;
        index = chunk.nextIndex;
        chunks.push({
          ...(changeContext ? { changeContext } : {}),
          oldLines: chunk.oldLines,
          newLines: chunk.newLines,
          isEndOfFile: chunk.isEndOfFile,
        });
      }
      if (chunks.length === 0) {
        return invalidHunk('Update File must include at least one non-empty hunk', lineNumber);
      }
      hunks.push({ kind: 'update', path, chunks });
      continue;
    }

    return invalidHunk(`Expected a file operation header, got: ${line}`, lineNumber);
  }

  if (hunks.length === 0) {
    return {
      ok: false,
      error: { code: 'invalid_patch', message: 'Patch contains no file operations' },
    };
  }
  return { ok: true, value: { hunks } };
}

export function canonicalizeApplyPatchHunks(hunks: readonly ApplyPatchHunk[]): ApplyPatchHunk[] {
  return hunks.map((hunk) => ({ ...hunk, path: canonicalApplyPatchPath(hunk.path) }));
}

export function canonicalApplyPatchPath(path: string): string {
  const segments: string[] = [];
  for (const segment of path.replaceAll('\\', '/').trim().split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  return segments.join('/') || '.';
}

export function assertSafePatchPath(path: string): string | null {
  const normalized = path.replaceAll('\\', '/').trim();
  if (!normalized || normalized === '.') return 'path is empty';
  if (normalized.includes('\0')) return 'path must not contain NUL bytes';
  if (normalized.startsWith('/') || /^[A-Za-z]:\//u.test(normalized)) {
    return 'path must be relative';
  }
  if (normalized.includes(':')) {
    return 'path must not use drive-relative or alternate-stream syntax';
  }
  if (normalized.split('/').some((segment) => segment === '..')) {
    return 'path must not contain parent-directory segments';
  }
  return null;
}

export function applyUpdateChunksToContent(
  original: string,
  chunks: readonly ApplyPatchUpdateChunk[],
  path: string,
): ApplyPatchContentOutcome {
  const sourceLines = splitContentLinesWithEnds(original);
  let bodies = sourceLines.map((line) => line.body);
  let endings = sourceLines.map((line) => line.ending);
  const defaultEnding = detectDefaultLineEnding(original);
  let cursor = 0;

  for (const chunk of chunks) {
    let searchFrom = cursor;
    if (chunk.changeContext) {
      const contextIndex = findSequence(bodies, [chunk.changeContext], cursor, false);
      if (contextIndex < 0) return hunkMismatch(path, chunk.changeContext);
      searchFrom = contextIndex + 1;
    }
    const start = findSequence(bodies, chunk.oldLines, searchFrom, chunk.isEndOfFile);
    if (start < 0) return hunkMismatch(path, chunk.changeContext);
    const end = start + chunk.oldLines.length;
    const removedEndings = endings.slice(start, end);
    const insertedEndings = chunk.newLines.map((_, index) => {
      if (index < chunk.newLines.length - 1) return defaultEnding;
      if (removedEndings.length > 0) return removedEndings.at(-1) === '' ? '' : defaultEnding;
      if (start < bodies.length || bodies.length === 0) return defaultEnding;
      return endings.at(-1) ? defaultEnding : '';
    });
    if (
      start === bodies.length &&
      chunk.oldLines.length === 0 &&
      chunk.newLines.length > 0 &&
      bodies.length > 0 &&
      endings.at(-1) === ''
    ) {
      endings[endings.length - 1] = defaultEnding;
    }
    bodies = [...bodies.slice(0, start), ...chunk.newLines, ...bodies.slice(end)];
    endings = [...endings.slice(0, start), ...insertedEndings, ...endings.slice(end)];
    cursor = start + chunk.newLines.length;
  }

  return {
    ok: true,
    content: bodies.map((body, index) => body + (endings[index] ?? '')).join(''),
  };
}

export function planApplyPatchMutations(
  hunks: readonly ApplyPatchHunk[],
  initialState: ReadonlyMap<string, ApplyPatchPathState>,
): PlannedPatchMutation[] {
  const state = new Map(initialState);
  const planned: PlannedPatchMutation[] = [];
  for (const hunk of hunks) {
    const current = state.get(hunk.path) ?? { kind: 'missing' as const };
    if (hunk.kind === 'add') {
      if (current.kind !== 'missing') {
        throw new Error(`ApplyPatch Add File target already exists: ${hunk.path}`);
      }
      planned.push({ operation: 'add', path: hunk.path, content: hunk.contents });
      state.set(hunk.path, { kind: 'file', content: hunk.contents });
      continue;
    }
    if (hunk.kind === 'delete') {
      if (current.kind === 'missing') {
        throw new Error(`ApplyPatch Delete File target missing: ${hunk.path}`);
      }
      if (current.kind !== 'file' && current.kind !== 'symlink') {
        throw new Error(`ApplyPatch Delete File target must be a file or symlink: ${hunk.path}`);
      }
      planned.push({ operation: 'delete', path: hunk.path });
      state.set(hunk.path, { kind: 'missing' });
      continue;
    }
    if (current.kind === 'missing') {
      throw new Error(`ApplyPatch Update File target missing: ${hunk.path}`);
    }
    if (current.kind !== 'file') {
      throw new Error(`ApplyPatch Update File target must be a regular file: ${hunk.path}`);
    }
    const applied = applyUpdateChunksToContent(current.content, hunk.chunks, hunk.path);
    if (!applied.ok) throw new Error(applied.error.message);
    planned.push({ operation: 'update', path: hunk.path, content: applied.content });
    state.set(hunk.path, { kind: 'file', content: applied.content });
  }
  return planned;
}

function readChunk(
  lines: readonly string[],
  start: number,
  endExclusive: number,
):
  | {
      ok: true;
      nextIndex: number;
      oldLines: string[];
      newLines: string[];
      isEndOfFile: boolean;
    }
  | { ok: false; error: ApplyPatchParseError } {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  let index = start;
  let isEndOfFile = false;
  while (index < endExclusive) {
    const line = lines[index]!;
    const trimmed = line.trim();
    if (
      isFileOperationHeader(line) ||
      trimmed === CHANGE_CONTEXT_MARKER ||
      trimmed.startsWith('@@ ')
    ) {
      break;
    }
    if (trimmed === EOF_MARKER) {
      isEndOfFile = true;
      index += 1;
      break;
    }
    const prefix = line[0];
    if (prefix === ' ') {
      oldLines.push(line.slice(1));
      newLines.push(line.slice(1));
    } else if (prefix === '-') {
      oldLines.push(line.slice(1));
    } else if (prefix === '+') {
      newLines.push(line.slice(1));
    } else {
      return invalidHunk(`Invalid hunk line: ${line}`, index + 1);
    }
    index += 1;
  }
  if (oldLines.length === 0 && newLines.length === 0) {
    return invalidHunk('Update hunk is empty', start + 1);
  }
  return { ok: true, nextIndex: index, oldLines, newLines, isEndOfFile };
}

function isFileOperationHeader(line: string): boolean {
  const header = line.trim();
  return (
    header.startsWith(ADD_FILE_MARKER) ||
    header.startsWith(DELETE_FILE_MARKER) ||
    header.startsWith(UPDATE_FILE_MARKER)
  );
}

function invalidHunk(
  message: string,
  lineNumber: number,
): { ok: false; error: ApplyPatchParseError } {
  return { ok: false, error: { code: 'invalid_hunk', message, lineNumber } };
}

function findSequence(
  lines: readonly string[],
  pattern: readonly string[],
  start: number,
  preferEnd: boolean,
): number {
  if (pattern.length === 0) return lines.length;
  if (pattern.length > lines.length) return -1;
  const transforms: ReadonlyArray<(line: string) => string> = [
    (line) => line,
    (line) => line.trimEnd(),
    (line) => line.trim(),
    normalizePatchMatchLine,
  ];
  for (const transform of transforms) {
    const matchesAt = (index: number): boolean =>
      pattern.every((line, offset) => transform(lines[index + offset]!) === transform(line));
    const endStart = lines.length - pattern.length;
    if (preferEnd && endStart >= start && matchesAt(endStart)) return endStart;
    for (let index = start; index + pattern.length <= lines.length; index += 1) {
      if (matchesAt(index)) return index;
    }
  }
  return -1;
}

function normalizePatchMatchLine(line: string): string {
  return [...line.trim()]
    .map((character) => {
      if (/[‐-―−]/u.test(character)) return '-';
      if (/[‘-‛]/u.test(character)) return "'";
      if (/[“-‟]/u.test(character)) return '"';
      if (/[  -   　]/u.test(character)) return ' ';
      return character;
    })
    .join('');
}

function detectDefaultLineEnding(content: string): string {
  if (content.includes('\r\n')) return '\r\n';
  if (content.includes('\r') && !content.includes('\n')) return '\r';
  return '\n';
}

function splitContentLinesWithEnds(content: string): Array<{ body: string; ending: string }> {
  if (content.length === 0) return [];
  const lines: Array<{ body: string; ending: string }> = [];
  let body = '';
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index]!;
    if (character === '\r') {
      if (content[index + 1] === '\n') {
        lines.push({ body, ending: '\r\n' });
        index += 1;
      } else {
        lines.push({ body, ending: '\r' });
      }
      body = '';
      continue;
    }
    if (character === '\n') {
      lines.push({ body, ending: '\n' });
      body = '';
      continue;
    }
    body += character;
  }
  if (body.length > 0) lines.push({ body, ending: '' });
  return lines;
}

function hunkMismatch(path: string, context?: string): ApplyPatchContentOutcome {
  return {
    ok: false,
    error: {
      code: 'hunk_mismatch',
      path,
      message: `ApplyPatch hunk did not match in ${path}${context ? ` (context ${JSON.stringify(context)})` : ''}`,
    },
  };
}
