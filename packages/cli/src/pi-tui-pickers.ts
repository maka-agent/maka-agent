import {
  CombinedAutocompleteProvider,
  Editor,
  Key,
  SelectList,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type AutocompleteItem,
  type AutocompleteProvider,
  type AutocompleteSuggestions,
  type Component,
  type SelectItem,
  type TUI,
} from '@earendil-works/pi-tui';
import { PERMISSION_MODES, type PermissionMode } from '@maka/core/permission';
import type { ThinkingLevel } from '@maka/core/model-thinking';
import type { ModelChoice } from './connection-target.js';
import { ansi, editorTheme, stripAnsi } from './tui-ansi.js';

export class MakaAutocompleteProvider implements AutocompleteProvider {
  private readonly fileProvider: CombinedAutocompleteProvider;
  private readonly slashCommands: readonly MakaSlashCommandMetadata[];

  constructor(basePath: string, slashCommands: readonly MakaSlashCommandMetadata[]) {
    this.fileProvider = new CombinedAutocompleteProvider([], basePath);
    this.slashCommands = slashCommands;
  }

  async getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ): Promise<AutocompleteSuggestions | null> {
    const slashPrefix = slashCommandPrefix(lines, cursorLine, cursorCol);
    if (slashPrefix !== null && !options.force) {
      const query = slashPrefix.slice(1).toLowerCase();
      const items = this.slashCommands
        .filter((command) => command.name.startsWith(query))
        .map((command) => ({
          value: command.name,
          label: `/${command.name}`,
          description: command.description,
        }));
      return items.length > 0 ? { items, prefix: slashPrefix } : null;
    }
    return this.fileProvider.getSuggestions(lines, cursorLine, cursorCol, options);
  }

  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number } {
    const currentLine = lines[cursorLine] || '';
    const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
    if (prefix.startsWith('/') && beforePrefix.trim() === '') {
      const nextLines = [...lines];
      nextLines[cursorLine] = `${beforePrefix}/${item.value} ${currentLine.slice(cursorCol)}`;
      return {
        lines: nextLines,
        cursorLine,
        cursorCol: beforePrefix.length + item.value.length + 2,
      };
    }
    return this.fileProvider.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
  }

  shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
    return this.fileProvider.shouldTriggerFileCompletion(lines, cursorLine, cursorCol);
  }
}

export interface MakaSlashCommandMetadata {
  name: string;
  description: string;
}

export interface MakaSlashCommand extends MakaSlashCommandMetadata {
  run(parts: string[]): void;
}

function slashCommandPrefix(lines: string[], cursorLine: number, cursorCol: number): string | null {
  const currentLine = lines[cursorLine] || '';
  const textBeforeCursor = currentLine.slice(0, cursorCol);
  return textBeforeCursor.startsWith('/') && !textBeforeCursor.includes(' ') ? textBeforeCursor : null;
}

export class PickerOverlay implements Component {
  constructor(
    private readonly list: SelectList,
    private readonly input: {
      title: string;
      rightLabel: string;
      hint?: string;
      onInput?: (data: string) => boolean;
    },
  ) {}

  invalidate(): void {
    this.list.invalidate();
  }

  handleInput(data: string): void {
    if (this.input.onInput?.(data)) return;
    this.list.handleInput(data);
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    return [
      padLine(`${this.input.title} ${ansi.accent(this.input.rightLabel)}`, safeWidth),
      padLine(ansi.dim(this.input.hint ?? 'enter select / esc close'), safeWidth),
      padLine('', safeWidth),
      ...this.list.render(safeWidth).map((line) => formatPickerItemLine(line, safeWidth)),
      padLine(ansi.accent('-'.repeat(safeWidth)), safeWidth),
    ];
  }
}

export class UserQuestionTextOverlay implements Component {
  private readonly editor: Editor;

  constructor(
    tui: TUI,
    private readonly input: {
      title: string;
      rightLabel: string;
      onSubmit(value: string): void;
      onSkip(): void;
    },
  ) {
    this.editor = new Editor(tui, editorTheme(), { paddingX: 1 });
    this.editor.onSubmit = (value) => {
      const answer = value.trim();
      if (answer) this.input.onSubmit(answer);
    };
  }

  invalidate(): void {
    this.editor.invalidate();
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.input.onSkip();
      return;
    }
    this.editor.handleInput(data);
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    return [
      padLine(`${this.input.title} ${ansi.accent(this.input.rightLabel)}`, safeWidth),
      padLine(ansi.dim('Type another answer · Enter submit · Esc unanswered · Ctrl+C stop'), safeWidth),
      ...this.editor.render(safeWidth).map((line) => padLine(line, safeWidth)),
      padLine(ansi.accent('-'.repeat(safeWidth)), safeWidth),
    ];
  }
}

export function modelPickerItems(currentModel: string, models: readonly string[] | undefined): SelectItem[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const candidate of [currentModel, ...(models ?? [])]) {
    const id = candidate.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids.map((id) => ({
    value: id,
    label: id,
    ...(id === currentModel ? { description: 'current' } : {}),
  }));
}

/**
 * `/model` items across every ready connection. The value is the choice's index
 * (models can repeat across connections, so no id is unique on its own); the
 * caller maps it back to the {@link ModelChoice}. The description carries the
 * owning connection so identical model ids on different providers are readable.
 */
export function modelChoicePickerItems(
  choices: readonly ModelChoice[],
  current: { model: string; connectionSlug: string },
): SelectItem[] {
  return choices.map((choice, index) => {
    const isCurrent = choice.model === current.model && choice.connectionSlug === current.connectionSlug;
    const tags = [choice.connectionName || choice.connectionSlug];
    if (isCurrent) tags.push('current');
    else if (choice.isDefaultConnection) tags.push('default');
    return { value: String(index), label: choice.model, description: tags.join(' · ') };
  });
}

export function permissionModePickerItems(currentMode: PermissionMode): SelectItem[] {
  return PERMISSION_MODES.map((mode) => ({
    value: mode,
    label: mode,
    ...(mode === currentMode ? { description: 'current' } : {}),
  }));
}

const THINKING_LEVEL_LABELS: Record<ThinkingLevel, string> = {
  off: '关',
  minimal: '最小',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '超高',
  max: '最高',
};

export function thinkingLevelPickerItems(
  levels: readonly ThinkingLevel[],
  current: ThinkingLevel | undefined,
): SelectItem[] {
  return [
    { value: 'default', label: '默认', ...(current === undefined ? { description: 'current' } : {}) },
    ...levels.map((level) => ({
      value: level,
      label: THINKING_LEVEL_LABELS[level],
      ...(level === current ? { description: 'current' } : {}),
    })),
  ];
}

function formatPickerItemLine(line: string, width: number): string {
  const padded = padLine(line, width);
  return stripAnsi(line).startsWith('→ ') ? ansi.reverse(padded) : padded;
}

function padLine(text: string, width: number): string {
  const safeWidth = Math.max(1, width);
  const trimmed = visibleWidth(text) > safeWidth ? truncateToWidth(text, safeWidth, '') : text;
  return `${trimmed}${' '.repeat(Math.max(0, safeWidth - visibleWidth(trimmed)))}`;
}
