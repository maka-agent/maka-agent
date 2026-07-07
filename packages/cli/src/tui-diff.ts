import { ansi } from './tui-ansi.js';

export type DiffLineKind = 'add' | 'del' | 'hunk' | 'meta' | 'ctx';

/**
 * Classify a single unified-diff line. Copied from the renderer-side
 * `diffLineKind` in `@maka/ui` (tool-result-preview.tsx) so the CLI stays
 * free of React/DOM imports. `+++`/`---` file headers count as metadata,
 * `@@` hunk headers get their own kind, and bare `+`/`-` are add/del.
 */
export function diffLineKind(line: string): DiffLineKind {
  if (line.startsWith('+++') || line.startsWith('---')) return 'meta';
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return 'ctx';
}

/** Tint a diff line by kind: add→green, del→red, hunk→accent, meta→dim, ctx→plain. */
export function colorDiffLine(line: string): string {
  switch (diffLineKind(line)) {
    case 'add':
      return ansi.green(line);
    case 'del':
      return ansi.red(line);
    case 'hunk':
      return ansi.accent(line);
    case 'meta':
      return ansi.dim(line);
    case 'ctx':
      return line;
  }
}

/** Color a whole diff body, preserving line breaks. */
export function colorDiff(diff: string): string {
  return diff.split('\n').map(colorDiffLine).join('\n');
}
