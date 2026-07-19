import type { Component, Editor } from '@earendil-works/pi-tui';
import { stripAnsi } from './tui-ansi.js';

// The pi-tui Editor renders its autocomplete menu at the tail of its render
// output, i.e. below the input box. The Maka TUI pins the input at the bottom
// of the screen, so those suggestions must appear *above* the editor instead.
//
// Editor exposes no way to render the menu on its own (only isShowingAutocomplete()),
// so this module post-processes the lines Editor.render() returns: it locates the
// editor's chrome borders and moves the trailing suggestion block above them.
//
// Fragile by necessity: isEditorChromeLine pattern-matches the editor's border
// lines (all-dash) and scroll hint ("--- UP/DOWN N more ---"). If pi-tui changes
// those shapes, this split silently misfires (suggestions vanish or land wrong)
// with no compile error. Re-verify these patterns whenever pi-tui is upgraded.

export interface MakaAutocompleteArrangementInput {
  lines: string[];
  autocompleteShowing: boolean;
  autocompleteSlotRows: number;
}

export interface MakaAutocompleteArrangementResult {
  lines: string[];
  autocompleteSlotRows: number;
}

export function arrangeAutocompleteAboveEditor(
  input: MakaAutocompleteArrangementInput,
): MakaAutocompleteArrangementResult {
  if (!input.autocompleteShowing) {
    return { lines: input.lines, autocompleteSlotRows: 0 };
  }
  const sections = splitTrailingAutocomplete(input.lines);
  if (sections.autocompleteLines.length === 0) {
    return { lines: sections.editorLines, autocompleteSlotRows: 0 };
  }
  const autocompleteSlotRows = Math.max(
    input.autocompleteSlotRows,
    sections.autocompleteLines.length,
  );
  return {
    lines: [
      ...Array.from({ length: autocompleteSlotRows - sections.autocompleteLines.length }, () => ''),
      ...sections.autocompleteLines,
      ...sections.editorLines,
    ],
    autocompleteSlotRows,
  };
}

export class MakaAutocompleteAboveEditorComponent implements Component {
  private autocompleteSlotRows = 0;

  constructor(private readonly editor: Editor) {}

  get focused(): boolean {
    return this.editor.focused;
  }

  set focused(value: boolean) {
    this.editor.focused = value;
  }

  invalidate(): void {
    this.editor.invalidate();
  }

  handleInput(data: string): void {
    this.editor.handleInput(data);
  }

  render(width: number): string[] {
    const lines = this.editor.render(width);
    const result = arrangeAutocompleteAboveEditor({
      lines,
      autocompleteShowing: this.editor.isShowingAutocomplete(),
      autocompleteSlotRows: this.autocompleteSlotRows,
    });
    this.autocompleteSlotRows = result.autocompleteSlotRows;
    return result.lines;
  }
}

interface MakaAutocompleteSections {
  autocompleteLines: string[];
  editorLines: string[];
}

function splitTrailingAutocomplete(lines: string[]): MakaAutocompleteSections {
  const bottomBorderIndex = findLastIndex(lines, isEditorChromeLine);
  if (bottomBorderIndex < 1 || bottomBorderIndex === lines.length - 1) {
    return { autocompleteLines: [], editorLines: lines };
  }
  const topBorderIndex = findLastIndex(lines.slice(0, bottomBorderIndex), isEditorChromeLine);
  if (topBorderIndex < 0) return { autocompleteLines: [], editorLines: lines };

  return {
    autocompleteLines: lines.slice(bottomBorderIndex + 1),
    editorLines: lines.slice(0, bottomBorderIndex + 1),
  };
}

function isEditorChromeLine(line: string): boolean {
  const text = stripAnsi(line);
  return /^─+$/.test(text) || /^─── [↑↓] \d+ more ─*$/.test(text);
}

function findLastIndex<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index]!)) return index;
  }
  return -1;
}
