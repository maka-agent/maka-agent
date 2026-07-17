import {
  CombinedAutocompleteProvider,
  Editor,
  Key,
  SelectList,
  decodeKittyPrintable,
  isKeyRepeat,
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
import type { UserQuestionOption } from '@maka/core';
import { PERMISSION_MODES, type PermissionMode } from '@maka/core/permission';
import type { ThinkingLevel } from '@maka/core/model-thinking';
import type { InvocableSkillEntry } from '@maka/runtime';
import type { ModelChoice } from './connection-target.js';
import { skillInvocationPrefixAt } from './skill-token.js';
import { ansi, editorTheme, stripAnsi } from './tui-ansi.js';

export class MakaAutocompleteProvider implements AutocompleteProvider {
  private readonly fileProvider: CombinedAutocompleteProvider;
  private readonly slashCommands: readonly MakaSlashCommandMetadata[];
  private readonly listSkills?: () => Promise<readonly InvocableSkillEntry[]>;

  // The kind of suggestions last returned by getSuggestions: 'skill' when the
  // active list was mid-message `/skill:` completions, null otherwise. The
  // Editor runs getSuggestions before applyCompletion and snapshot-guards the
  // request, so this reliably disambiguates a mid-message skill selection (no
  // `/` in prefix) from a file selection sharing the same prefix.
  private lastSlashKind: 'skill' | null = null;

  constructor(
    basePath: string,
    slashCommands: readonly MakaSlashCommandMetadata[],
    listSkills?: () => Promise<readonly InvocableSkillEntry[]>,
  ) {
    this.fileProvider = new CombinedAutocompleteProvider([], basePath);
    this.slashCommands = slashCommands;
    this.listSkills = listSkills;
  }

  async getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ): Promise<AutocompleteSuggestions | null> {
    this.lastSlashKind = null;
    // `/skill:<query>` takes precedence everywhere - including at line start,
    // where it would otherwise parse as a (non-matching) slash command — and
    // it suppresses file completion: the token charset looks path-like.
    const skillPrefix = skillInvocationPrefixAt(lines, cursorLine, cursorCol);
    if (skillPrefix !== null && this.listSkills && !options.force) {
      // Skill completion is first-line only, matching pi-tui's isSlashMenuAllowed.
      if (cursorLine !== 0) return null;
      const query = skillPrefix.query.toLowerCase();
      const skills = await this.listSkills();
      if (options.signal.aborted) return null;
      const items = skills
        .filter((skill) =>
          skill.id.toLowerCase().startsWith(query)
          || skill.name.toLowerCase().includes(query))
        .map((skill) => ({
          value: skill.id,
          label: `/skill:${skill.id}`,
          description: skill.description ? `${skill.name} · ${skill.description}` : skill.name,
        }));
      if (items.length > 0) {
        // Line-start keeps `/skill:query` so pi-tui auto-submits on select (the
        // existing "select to invoke" UX). Mid-message drops the `/skill:` head
        // (just the query) so selection inserts and returns instead of
        // submitting - pi-tui submits only when `autocompletePrefix` starts with `/`.
        this.lastSlashKind = 'skill';
        const currentLine = lines[cursorLine] || '';
        const textBeforeCursor = currentLine.slice(0, cursorCol);
        const atLineStart = textBeforeCursor.slice(0, textBeforeCursor.length - skillPrefix.prefix.length).trim() === '';
        return { items, prefix: atLineStart ? skillPrefix.prefix : skillPrefix.query };
      }
      return null;
    }
    if (skillPrefix !== null && !options.force) {
      // Inside a token but no skill surface: never fall through to path completion.
      return null;
    }
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
    // A bare mid-message `/`-token (not `/skill:`, handled above): offer
    // `/skill:xxx` completions so typing `/` surfaces skills immediately. Plain
    // commands are not offered here - they only execute at line start.
    const midSlash = midMessageSlashToken(lines, cursorLine, cursorCol);
    if (midSlash !== null && this.listSkills && !options.force) {
      // Keep the raw query as the replacement prefix; toLowerCase can change
      // UTF-16 length (e.g. "İ" -> "i̇", len 1 -> 2), and applyCompletion slices
      // by prefix.length, so a lowercased prefix would over-delete the original.
      const rawQuery = midSlash.slice(1);
      const query = rawQuery.toLowerCase();
      const skills = await this.listSkills();
      if (options.signal.aborted) return null;
      const items = skills
        .filter((skill) =>
          skill.id.toLowerCase().startsWith(query)
          || skill.name.toLowerCase().includes(query))
        .map((skill) => ({
          value: `skill:${skill.id}`,
          label: `/skill:${skill.id}`,
          description: skill.description ? `${skill.name} · ${skill.description}` : skill.name,
        }));
      if (items.length > 0) {
        // Prefix is the raw text after `/` (no leading `/`) so pi-tui's
        // select-confirm guard does not auto-submit. applyCompletion reuses the
        // mid-message skill path: beforePrefix ends with `/`, item.value is
        // `skill:<id>`, so `${beforePrefix}${item.value} ` yields `/skill:<id> `.
        this.lastSlashKind = 'skill';
        return { items, prefix: rawQuery };
      }
      // No skill matched. Do NOT fall through to the file provider: a mid-message
      // `/`-token's file completion would carry a `/`-prefixed prefix, and pi-tui's
      // select-confirm guard auto-submits when `prefix.startsWith("/")` - so
      // selecting it would send the unfinished message. Mid-message `/`-path
      // completion was not available before this PR either (pi-tui excludes `/`
      // from triggerCharacters), so returning null restores the prior behavior.
      return null;
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
    if (prefix.startsWith('/skill:')) {
      const nextLines = [...lines];
      nextLines[cursorLine] = `${beforePrefix}/skill:${item.value} ${currentLine.slice(cursorCol)}`;
      return {
        lines: nextLines,
        cursorLine,
        cursorCol: beforePrefix.length + item.value.length + 8,
      };
    }
    if (prefix.startsWith('/') && beforePrefix.trim() === '') {
      const nextLines = [...lines];
      nextLines[cursorLine] = `${beforePrefix}/${item.value} ${currentLine.slice(cursorCol)}`;
      return {
        lines: nextLines,
        cursorLine,
        cursorCol: beforePrefix.length + item.value.length + 2,
      };
    }
    if (this.lastSlashKind === 'skill') {
      // Mid-message skill: prefix is just the query (no `/skill:`); the
      // `/skill:` head sits at the end of beforePrefix. Insert
      // `/skill:<value> ` and leave the cursor after the space; pi-tui will not
      // auto-submit because the prefix did not start with `/`.
      const nextLines = [...lines];
      nextLines[cursorLine] = `${beforePrefix}${item.value} ${currentLine.slice(cursorCol)}`;
      return {
        lines: nextLines,
        cursorLine,
        cursorCol: beforePrefix.length + item.value.length + 1,
      };
    }
    return this.fileProvider.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
  }

  shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
    if (skillInvocationPrefixAt(lines, cursorLine, cursorCol) !== null) return false;
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

// A `/`-token that begins mid-message (after whitespace) on the first line,
// excluding the `/skill:` form (handled by skillInvocationPrefixAt above) and
// line-start (handled by slashCommandPrefix). Used to offer `/skill:xxx`
// completions from a bare `/` so typing `/` surfaces skills immediately.
function midMessageSlashToken(lines: string[], cursorLine: number, cursorCol: number): string | null {
  if (cursorLine !== 0) return null;
  const currentLine = lines[cursorLine] || '';
  const textBeforeCursor = currentLine.slice(0, cursorCol);
  const match = /(?:\s)(\/\S*)$/.exec(textBeforeCursor);
  if (!match) return null;
  const token = match[1];
  return token.startsWith('/skill:') ? null : token;
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

const USER_QUESTION_ROW_PREFIX_WIDTH = 2;

/**
 * A single question's overlay: the preset options and a free-text "Other" row on
 * one screen. The free-text row is the list's last line — an inline {@link Editor}
 * that activates when the highlight lands on it. ↑↓ move the highlight through the
 * options and the input row as one ring; typing a printable character while on an
 * option jumps to the input row and starts the answer there (gemini-cli's
 * type-to-jump). Enter selects the highlighted option, or submits non-empty input
 * text; Esc leaves the whole question unanswered. Replaces the old two-step design
 * that swapped the option list out for a separate text overlay.
 */
export class UserQuestionOverlay implements Component {
  private readonly editor: Editor;
  // Highlight index over [0, options.length]. `options.length` is the input row.
  private activeIndex = 0;

  constructor(
    tui: TUI,
    private readonly input: {
      title: string;
      rightLabel: string;
      hint: string;
      placeholder: string;
      options: readonly UserQuestionOption[];
      onSelectOption(index: number): void;
      onSubmitText(value: string): void;
      onSkip(): void;
    },
  ) {
    // paddingX 0 so the inline row aligns under the `  `/`→ ` option prefix
    // instead of the editor's own gutter.
    this.editor = new Editor(tui, editorTheme(), { paddingX: 0 });
    // Submit through the Editor's own submitValue() path: it expands paste
    // markers (a large paste is stored as a `[paste #N …]` placeholder until
    // then) and trims, so the answer is the real pasted/typed text. An empty
    // submission is a no-op so Enter on the blank row can't send a blank answer.
    this.editor.onSubmit = (value) => {
      if (value) this.input.onSubmitText(value);
    };
  }

  private get inputRowIndex(): number {
    return this.input.options.length;
  }

  private get onInputRow(): boolean {
    return this.activeIndex === this.inputRowIndex;
  }

  invalidate(): void {
    this.editor.invalidate();
  }

  handleInput(data: string): void {
    // Esc always abandons the whole question (advance unanswered), even with
    // text typed — one Esc level, matching the pre-inline behavior.
    if (matchesKey(data, Key.escape)) {
      this.input.onSkip();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.activeIndex = this.activeIndex === 0 ? this.inputRowIndex : this.activeIndex - 1;
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.activeIndex = this.activeIndex === this.inputRowIndex ? 0 : this.activeIndex + 1;
      return;
    }
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
      // A held-key repeat must not double-advance onto the next question.
      if (isKeyRepeat(data)) return;
      if (!this.onInputRow) {
        this.input.onSelectOption(this.activeIndex);
        return;
      }
      // Fall through: on the input row even Enter goes to the Editor, whose own
      // key classification decides newline (LF/Ctrl-J, Shift+Enter, `\`+Enter)
      // vs submit — submitValue() then feeds the wired onSubmit above.
    }
    if (this.onInputRow) {
      this.editor.handleInput(data);
      return;
    }
    // Type-to-jump: a printable key (or an IME/legacy multi-byte sequence) while
    // an option is highlighted moves to the input row and starts the answer with
    // that key. Mirror the editor's own printable test — a Kitty CSI-u printable,
    // or a legacy sequence whose first byte is a non-control character — so
    // navigation/control keys (arrows, Enter, Esc, Ctrl/Alt combos) never trigger
    // the jump. The raw sequence is handed to the editor so its IME and paste
    // handling stay intact.
    const printable = decodeKittyPrintable(data) ?? (data.charCodeAt(0) >= 32 ? data : undefined);
    if (printable !== undefined) {
      this.activeIndex = this.inputRowIndex;
      this.editor.handleInput(data);
    }
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const lines: string[] = [
      padLine(`${this.input.title} ${ansi.accent(this.input.rightLabel)}`, safeWidth),
      padLine(ansi.dim(this.input.hint), safeWidth),
      padLine('', safeWidth),
    ];
    this.input.options.forEach((option, index) => {
      lines.push(this.renderOptionRow(option, index === this.activeIndex, safeWidth));
    });
    lines.push(...this.renderInputRow(safeWidth));
    lines.push(padLine(ansi.accent('-'.repeat(safeWidth)), safeWidth));
    return lines;
  }

  private renderOptionRow(option: UserQuestionOption, active: boolean, width: number): string {
    const prefix = active ? '→ ' : '  ';
    const body = option.description
      ? `${option.label}  ${active ? option.description : ansi.dim(option.description)}`
      : option.label;
    return formatPickerItemLine(`${prefix}${body}`, width);
  }

  private renderInputRow(width: number): string[] {
    const prefix = this.onInputRow ? '→ ' : '  ';
    const contentWidth = Math.max(1, width - USER_QUESTION_ROW_PREFIX_WIDTH);
    // Focused only while the input row is highlighted: that both shows the block
    // cursor and emits the hardware-cursor marker (#1064) so IME candidate windows
    // anchor to the edited text instead of the terminal bottom.
    this.editor.focused = this.onInputRow;
    if (!this.onInputRow && this.editor.getText().length === 0) {
      return [padLine(`${prefix}${ansi.dim(this.input.placeholder)}`, width)];
    }
    // Drop the editor's own top/bottom border rows; keep just its content lines
    // so the answer reads as one row of the list.
    const editorLines = this.editor.render(contentWidth).slice(1, -1);
    if (editorLines.length === 0) {
      return [padLine(`${prefix}${ansi.dim(this.input.placeholder)}`, width)];
    }
    return editorLines.map((line, index) => (
      padLine(`${index === 0 ? prefix : '  '}${line}`, width)
    ));
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

/**
 * `/skill` picker items (issue #1148). The value is the skill id (that's what
 * the inserted `/skill:<id>` token resolves by); the description carries the
 * id too, since CJK display names alone don't tell the user what to type.
 */
export function skillPickerItems(skills: readonly InvocableSkillEntry[]): SelectItem[] {
  return skills.map((skill) => ({
    value: skill.id,
    label: skill.name,
    description: skill.description ? `${skill.id} · ${skill.description}` : skill.id,
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
