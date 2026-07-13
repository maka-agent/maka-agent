import type { ToolOutputStream, ToolResultContent } from '@maka/core/events';
import {
  ptyCompactTerminalLine,
  ptyTuiTerminalRows,
  ptyTuiTerminalView,
  readWriteStdinInputPreview,
  type PtyShellOutput,
  type ShellRunOperation,
} from '@maka/core';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { ansi } from './tui-ansi.js';
import { colorDiff, diffLineKind } from './tui-diff.js';
import {
  collapseToSingleLine,
  fitLine,
  formatUnknownInline,
  limitText,
  renderIndented,
} from './pi-transcript-format.js';
import type {
  MakaPiToolEntry,
  MakaPiToolOutputDelta,
} from './pi-transcript.js';

export function renderToolBlock(entry: MakaPiToolEntry, width: number, expanded: boolean): string[] {
  return expanded ? renderExpandedToolBlock(entry, width) : renderCompactToolBlock(entry, width);
}

function toolStatusText(entry: MakaPiToolEntry): string {
  const status = entry.status === 'running'
    ? ansi.yellow('running')
    : entry.status === 'detached'
      ? ansi.dim('detached')
      : entry.status === 'unavailable'
        ? ansi.dim('source unavailable')
      : entry.status === 'done'
        ? ansi.green('done')
        : ansi.red(entry.status);
  const duration = entry.durationMs === undefined
    ? ''
    : entry.toolName === 'Bash' && entry.result?.kind === 'shell_run'
      ? ansi.dim(` ${Math.floor(entry.durationMs / 1_000)}s`)
      : ansi.dim(` ${entry.durationMs}ms`);
  return `${status}${duration}`;
}

/**
 * Compact tool card: at most two lines. Line 1 carries the tool name, an
 * inline dim input summary, and status; line 2 is a one-line result summary
 * with a dim `(Ctrl+O)` hint when expanding would reveal more.
 */
function renderCompactToolBlock(entry: MakaPiToolEntry, width: number): string[] {
  // collapseToSingleLine guards both slots: fitLine truncates width, not \n,
  // so any multi-line summary text would silently break the two-line card.
  const inputSummary = collapseToSingleLine(toolInputSummary(entry));
  const header = `${ansi.yellow('Tool')} ${entry.title ?? entry.toolName}`
    + `${inputSummary ? ` ${ansi.dim(inputSummary)}` : ''} ${toolStatusText(entry)}`;
  const lines = [fitLine(header, width)];
  const summary = compactToolSummary(entry, width);
  if (summary) {
    const hint = summary.expandable ? ansi.dim(' (Ctrl+O)') : '';
    lines.push(fitLine(`  ${collapseToSingleLine(summary.text)}${hint}`, width));
  }
  if (entry.toolName === 'Bash' && entry.status === 'running' && entry.result?.kind === 'shell_run') {
    lines.push(fitLine(ansi.dim('  Ask Maka to stop this task'), width));
  }
  return lines;
}

function renderExpandedToolBlock(entry: MakaPiToolEntry, width: number): string[] {
  const lines = [
    fitLine(`${ansi.yellow('Tool')} ${entry.title ?? entry.toolName} ${toolStatusText(entry)}`, width),
  ];
  const inputSummary = toolInputSummary(entry);
  if (inputSummary) lines.push(...renderIndented(inputSummary, width, 2).map(ansi.dim));
  if (entry.progress.droppedChars > 0) {
    lines.push(...renderIndented(
      ansi.dim(`⋯ ${entry.progress.droppedChars} earlier progress chars truncated ⋯`),
      width,
      2,
    ));
  }
  if (entry.progress.length > 0) {
    lines.push(...renderCappedResultText(entry.progress.values().join(''), width, ansi.dim));
  }
  if (entry.outputDeltas.droppedChars > 0) {
    lines.push(...renderIndented(
      ansi.dim(`⋯ ${entry.outputDeltas.droppedChars} earlier live-output chars truncated ⋯`),
      width,
      2,
    ));
  }
  lines.push(...renderToolStreams(entry.outputDeltas.values(), width));
  if (entry.result || entry.output) {
    lines.push(...renderToolResult(entry, width));
  }
  if (entry.toolName === 'Bash' && entry.status === 'running' && entry.result?.kind === 'shell_run') {
    lines.push(...renderIndented(ansi.dim('Ask Maka to stop this task'), width, 2));
  }
  return lines.map((line) => fitLine(line, width));
}

interface CompactToolSummary {
  text: string;
  /** True when expanding would reveal more than this one-line summary. */
  expandable: boolean;
}

function compactToolSummary(entry: MakaPiToolEntry, width: number): CompactToolSummary | undefined {
  const hasLiveOutput = entry.outputDeltas.length > 0 || entry.progress.length > 0;
  const result = entry.result;
  if (result?.kind === 'shell_run') {
    if (entry.toolName === 'WriteStdin') {
      return {
        text: formatPtyControlOperation(result.operation, entry.input),
        expandable: result.operation?.kind === 'pty_control' && result.operation.failed,
      };
    }
    const latest = result.output?.mode === 'pty'
      ? ptyCompactTerminalLine(result.output)
      : result.output?.mode === 'pipes'
        ? result.output.latestStream
          ? lastNonEmptyLine(result.output[result.output.latestStream])
          : lastNonEmptyLine([result.output.stdout, result.output.stderr].filter(Boolean).join('\n'))
        : '';
    if (latest) return { text: latest, expandable: true };
    return {
      text: entry.status === 'detached'
        ? ansi.dim('(owned by source session)')
        : entry.status === 'unavailable'
          ? ansi.dim('(source session unavailable)')
        : result.status === 'running'
          ? ansi.dim('(waiting for output)')
          : ansi.dim('(no output)'),
      expandable: true,
    };
  }
  if (entry.status === 'running' && hasLiveOutput) {
    const live = latestLiveOutputLine(entry);
    if (live) return { text: live, expandable: true };
  }

  if (result?.kind === 'terminal') return compactTerminalSummary(result, hasLiveOutput);
  if (result?.kind === 'file_diff') return compactDiffSummary(result);
  if (result?.kind === 'file_write') {
    return { text: `wrote ${result.bytes} bytes ${result.path}`, expandable: hasLiveOutput };
  }

  if (entry.toolName === 'Grep') {
    const count = jsonArrayCount(entry, 'matches');
    if (count !== undefined) {
      return {
        text: `${count} match${count === 1 ? '' : 'es'}`,
        expandable: count > 0 || hasLiveOutput,
      };
    }
  }

  if (entry.toolName === 'Glob') {
    const count = jsonArrayCount(entry, 'files');
    if (count !== undefined) {
      return {
        text: `${count} file${count === 1 ? '' : 's'}`,
        expandable: count > 0 || hasLiveOutput,
      };
    }
  }

  const text = plainResultText(entry);
  if (!text) return undefined;
  // Only a successful filesystem Read that carries real file content gets the
  // line/byte summary — the same guard the expanded card uses. A runtime
  // resource, errored, or archived Read falls through to the generic first-line
  // summary so its status shows instead of a fabricated count.
  if (entry.toolName === 'Read'
    && entry.status !== 'error'
    && isFilesystemReadPath(entry)
    && isReadBodyResult(result)) {
    const lineCount = readBodyLineCount(text);
    return {
      text: `${lineCount} line${lineCount === 1 ? '' : 's'}, ${byteLength(text)} bytes`,
      expandable: true,
    };
  }
  const firstLine = text.split('\n', 1)[0] ?? '';
  return {
    text: firstLine,
    expandable: text.includes('\n') || hasLiveOutput || firstLine.length + 2 > width,
  };
}

function compactTerminalSummary(
  content: Extract<ToolResultContent, { kind: 'terminal' }>,
  hasLiveOutput: boolean,
): CompactToolSummary {
  const hasOutput = content.output.mode === 'pty'
    ? Boolean(ptyCompactTerminalLine(content.output))
    : Boolean(content.output.stdout || content.output.stderr);
  if (content.status !== 'completed') {
    const detail = content.output.mode === 'pipes'
      ? lastNonEmptyLine(content.output.stderr)
      : ptyCompactTerminalLine(content.output);
    const status = ansi.red(content.exitCode === undefined ? content.status : `exit ${content.exitCode}`);
    return {
      text: detail ? `${status} ${detail}` : status,
      expandable: hasOutput || hasLiveOutput,
    };
  }
  if (content.output.mode === 'pty') {
    const latest = ptyCompactTerminalLine(content.output);
    return latest
      ? { text: latest, expandable: true }
      : { text: ansi.dim('(no output)'), expandable: hasLiveOutput };
  }
  const combined = [content.output.stdout, content.output.stderr].filter(Boolean).join('\n').replace(/\n+$/, '');
  if (!combined) return { text: ansi.dim('(no output)'), expandable: hasLiveOutput };
  const totalLines = combined.split('\n').length;
  const prefix = totalLines > 1 ? ansi.dim(`(${totalLines} lines) `) : '';
  return {
    text: `${prefix}${lastNonEmptyLine(combined)}`,
    expandable: totalLines > 1 || hasLiveOutput,
  };
}

function compactDiffSummary(
  content: Extract<ToolResultContent, { kind: 'file_diff' }>,
): CompactToolSummary {
  let adds = 0;
  let dels = 0;
  for (const line of content.diff.split('\n')) {
    const kind = diffLineKind(line);
    if (kind === 'add') adds += 1;
    else if (kind === 'del') dels += 1;
  }
  const path = content.paths[0];
  return {
    text: `${ansi.green(`+${adds}`)} ${ansi.red(`-${dels}`)}${path ? ` ${path}` : ''}`,
    expandable: true,
  };
}

/**
 * Row count for list-shaped json results (Grep `matches`, Glob `files`).
 * Returns a count only when the keyed field is genuinely an array; an
 * error-shaped result (e.g. `{ error: "..." }`) returns undefined so the
 * caller falls back to a generic first-line summary rather than reporting a
 * fabricated "N matches" / "N files" from an unrelated line count.
 */
function jsonArrayCount(entry: MakaPiToolEntry, key: string): number | undefined {
  const result = entry.result;
  if (result?.kind === 'json' && result.value !== null && typeof result.value === 'object') {
    const rows = (result.value as Record<string, unknown>)[key];
    if (Array.isArray(rows)) return rows.length;
  }
  return undefined;
}

/** Latest non-empty output line from live deltas (redaction-aware), else progress. */
function latestLiveOutputLine(entry: MakaPiToolEntry): string {
  const groups = groupOutputDeltas(entry.outputDeltas.values());
  if (groups.length > 0) {
    const fromDeltas = lastNonEmptyLine(groups.map((group) => group.text).join('\n'));
    if (fromDeltas) return fromDeltas;
  }
  return lastNonEmptyLine(entry.progress.values().join(''));
}

function lastNonEmptyLine(text: string): string {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line && line.trim()) return line;
  }
  return '';
}

function renderToolText(text: string, width: number): string[] {
  return renderIndented(limitText(text, 12_000), width, 2);
}

// Expanding a tool card should reveal enough to orient, not replay a whole
// file or command dump into the transcript. Long output collapses to its first
// and last few lines with a hidden-count marker; diffs are the deliberate
// exception (rendered in full) because the whole change is the point.
const EXPANDED_TOOL_HEAD_LINES = 3;
const EXPANDED_TOOL_TAIL_LINES = 3;

/**
 * Render tool output for the expanded card, keeping at most the first
 * `EXPANDED_TOOL_HEAD_LINES` and last `EXPANDED_TOOL_TAIL_LINES` source lines
 * with a dim marker in between. `style` colors the content lines (e.g. dim for
 * stderr); the marker is always dim.
 */
function renderCappedResultText(
  text: string,
  width: number,
  style: (line: string) => string = (line) => line,
): string[] {
  // Command output almost always ends in a newline; splitting raw would count
  // that trailing empty string as a line, capping 7 real lines as if they were
  // 8 and spending a tail slot on a blank. Drop trailing newlines before both
  // the cap decision and the slice so the head/tail counts are real lines.
  const trimmed = text.replace(/\n+$/, '');
  const sourceLines = trimmed.split('\n');
  if (sourceLines.length <= EXPANDED_TOOL_HEAD_LINES + EXPANDED_TOOL_TAIL_LINES + 1) {
    return renderToolText(trimmed, width).map(style);
  }
  const hidden = sourceLines.length - EXPANDED_TOOL_HEAD_LINES - EXPANDED_TOOL_TAIL_LINES;
  const head = sourceLines.slice(0, EXPANDED_TOOL_HEAD_LINES).join('\n');
  const tail = sourceLines.slice(sourceLines.length - EXPANDED_TOOL_TAIL_LINES).join('\n');
  return [
    ...renderToolText(head, width).map(style),
    ...renderIndented(ansi.dim(`⋯ ${hidden} lines hidden ⋯`), width, 2),
    ...renderToolText(tail, width).map(style),
  ];
}

/**
 * Line count for a Read body, dropping only the single conventional EOF newline
 * so `foo\n` counts as one line while a real trailing blank line is preserved
 * (`a\n\n` is two lines, `\n` is one). Shared by the compact and expanded
 * summaries so the same card can never flip its line count when toggled.
 */
function readBodyLineCount(text: string): number {
  if (text === '') return 0;
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  return body.split('\n').length;
}

function renderReadSummary(entry: MakaPiToolEntry, width: number): string[] {
  const text = plainResultText(entry);
  // Byte count keeps the full content, since that is the file's real size on
  // disk; the line count drops the trailing newline (see readBodyLineCount).
  const lineCount = readBodyLineCount(text);
  const summary = `Read ${lineCount} line${lineCount === 1 ? '' : 's'}, ${byteLength(text)} bytes`;
  return renderIndented(ansi.dim(summary), width, 2);
}

function readInputPath(entry: MakaPiToolEntry): string | undefined {
  const input = entry.input;
  const path = input !== null && typeof input === 'object'
    ? (input as { path?: unknown }).path
    : undefined;
  return typeof path === 'string' && path.length > 0 ? path : undefined;
}

function readInputRef(entry: MakaPiToolEntry): string | undefined {
  const input = entry.input;
  const ref = input !== null && typeof input === 'object'
    ? (input as { ref?: unknown }).ref
    : undefined;
  return typeof ref === 'string' && ref.length > 0 ? ref : undefined;
}

/** A Read using the filesystem branch. */
function isFilesystemReadPath(entry: MakaPiToolEntry): boolean {
  return readInputPath(entry) !== undefined;
}

/** A Read using the runtime-resource branch (background-task output, etc.). */
function isRuntimeResourceRead(entry: MakaPiToolEntry): boolean {
  return readInputRef(entry)?.startsWith('maka://runtime/') ?? false;
}

/**
 * True only for the result shapes a filesystem Read uses to carry actual file
 * content. An `archived_tool_result` placeholder (or any other kind) is not a
 * read body, so it renders its own status instead of a fabricated line count.
 */
function isReadBodyResult(result: ToolResultContent | undefined): boolean {
  if (result?.kind === 'text') return true;
  // A json Read body is the `{ content: string }` shape the file loader
  // returns; any other json (e.g. an `{ error }` payload) is a status object,
  // not file content, and should render its real shape rather than a
  // fabricated line/byte count.
  if (result?.kind === 'json') {
    const value = result.value;
    return value !== null
      && typeof value === 'object'
      && typeof (value as { content?: unknown }).content === 'string';
  }
  return false;
}

/**
 * Render live `tool_output_delta` chunks. Chunks are de-duped and ordered by
 * `seq` (so a late or repeated seq cannot corrupt the display), consecutive
 * same-stream chunks are grouped under a single dim `[stream]` label, and any
 * redacted chunk shows a `[redacted]` marker instead of its raw content.
 */
function renderToolStreams(deltas: readonly MakaPiToolOutputDelta[], width: number): string[] {
  const lines: string[] = [];
  for (const group of groupOutputDeltas(deltas)) {
    lines.push(fitLine(ansi.dim(`[${group.stream}]`), width));
    lines.push(...renderCappedResultText(group.text, width, ansi.dim));
  }
  return lines;
}

function groupOutputDeltas(
  deltas: readonly MakaPiToolOutputDelta[],
): Array<{ stream: ToolOutputStream; text: string }> {
  const bySeq = new Map<number, MakaPiToolOutputDelta>();
  for (const delta of deltas) {
    if (!bySeq.has(delta.seq)) bySeq.set(delta.seq, delta);
  }
  const ordered = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  const groups: Array<{ stream: ToolOutputStream; text: string }> = [];
  for (const delta of ordered) {
    const chunk = delta.redacted ? '[redacted]' : delta.chunk;
    const last = groups[groups.length - 1];
    if (last && last.stream === delta.stream) {
      last.text += chunk;
    } else {
      groups.push({ stream: delta.stream, text: chunk });
    }
  }
  return groups;
}

function renderToolResult(entry: MakaPiToolEntry, width: number): string[] {
  const result = entry.result;
  // A `maka://runtime/...` resource Read surfaces live state (background-task
  // metadata + stdout/stderr) that only lives in the transcript. Its body opens
  // with several metadata/separator lines, so a head/tail cap would hide the very
  // output the user expanded to see — render it in full.
  if (entry.toolName === 'Read' && isRuntimeResourceRead(entry)) {
    return renderToolText(plainResultText(entry), width);
  }
  // A successful filesystem Read that returned real file content pulled it into
  // the model's context; the transcript only needs to note that it happened, so
  // skip the content and keep a summary. Everything else falls through to render
  // its content: a failed Read (its error), and — critically — an
  // `archived_tool_result` placeholder, so its not_loaded/missing status stays
  // visible instead of being mistaken for a one-line file.
  if (entry.toolName === 'Read'
    && entry.status !== 'error'
    && isFilesystemReadPath(entry)
    && isReadBodyResult(result)) {
    return renderReadSummary(entry, width);
  }
  if (result?.kind === 'terminal') return renderTerminalResult(result, width);
  // A background `shell_run` carries process metadata (ref, status, exit) the
  // head/tail cap must never hide — otherwise a failed or timed-out background
  // command looks the same as a successful one. Render the status in full and
  // cap only the stdout/stderr stream bodies.
  if (result?.kind === 'shell_run') {
    if (entry.toolName === 'WriteStdin') {
      return renderIndented(formatPtyControlOperation(result.operation, entry.input), width, 2);
    }
    return renderShellRunResult(entry, result, width);
  }
  // Diffs are the deliberate exception to the head/tail cap: the whole change
  // is what the user is expanding to see.
  if (result?.kind === 'file_diff') return renderDiffResult(result.diff, width);
  if (result?.kind === 'file_write') {
    return renderIndented(`Wrote ${result.bytes} bytes to ${result.path}`, width, 2);
  }
  // A generic `text` dump — a Bash body or raw tool text — is what the head/tail
  // cap targets: the model already holds the full body, so the transcript only
  // needs enough to orient. An undefined result with a formatted `output` string
  // is treated the same way. `json` is deliberately excluded: a Read json is
  // summarized above, a Grep/Glob json is a structured list the user expands to
  // scan in full, and any other json collapses to a single inline line where the
  // cap would be a no-op anyway.
  if (result === undefined || result.kind === 'text') {
    return renderCappedResultText(plainResultText(entry), width);
  }
  // Everything else — json lists (Grep/Glob), agent reports, web-search results,
  // subagent / workflow summaries, office-doc output — is content the user
  // expands to read in full, so render it without the cap, like a diff.
  return renderToolText(plainResultText(entry), width);
}

/** Best-effort extraction of the human-readable body from a tool result. */
function plainResultText(entry: MakaPiToolEntry): string {
  const result = entry.result;
  if (result?.kind === 'text') return result.text;
  if (result?.kind === 'json') {
    const value = result.value;
    if (value !== null && typeof value === 'object') {
      const content = (value as { content?: unknown }).content;
      if (typeof content === 'string') return content;
      const record = value as { matches?: unknown; files?: unknown };
      const rows = record.matches ?? record.files;
      if (Array.isArray(rows)) return rows.map((row) => String(row)).join('\n');
    }
    // Single line: this text can land on the compact summary line, and a
    // pretty-printed JSON body would break the two-line card contract.
    return formatUnknownInline(value);
  }
  return entry.output ?? '';
}

function renderTerminalResult(
  content: Extract<ToolResultContent, { kind: 'terminal' }>,
  width: number,
): string[] {
  const lines: string[] = [];
  if (content.status !== 'completed') {
    const status = content.exitCode === undefined ? content.status : `exit ${content.exitCode}`;
    lines.push(...renderIndented(ansi.red(status), width, 2));
    if (content.failureMessage) lines.push(...renderIndented(ansi.red(content.failureMessage), width, 2));
  }
  if (content.output.mode === 'pty') {
    lines.push(...renderPtyTerminalRows(content.output, width));
  } else {
    if (content.output.stdout) lines.push(...renderCappedResultText(content.output.stdout, width));
    if (content.output.stderr) {
      lines.push(...renderIndented(ansi.dim('[stderr]'), width, 2));
      lines.push(...renderCappedResultText(content.output.stderr, width, ansi.dim));
    }
  }
  return lines;
}

function renderPtyTerminalRows(output: PtyShellOutput, width: number): string[] {
  const view = ptyTuiTerminalView(output);
  const lines = view.rows.map((row) => {
    const available = Math.max(0, width - 2);
    const body = visibleWidth(row) > available ? truncateToWidth(row, available, '…') : row;
    return `  ${body}`;
  });
  if (output.truncated || view.rowsOmitted) {
    lines.push(...renderIndented(ansi.dim('terminal output truncated'), width, 2));
  }
  if (output.redacted) lines.push(...renderIndented(ansi.dim('terminal output redacted'), width, 2));
  return lines;
}

function renderPipeShellOutput(
  output: Extract<NonNullable<Extract<ToolResultContent, { kind: 'shell_run' }>['output']>, { mode: 'pipes' }>,
  width: number,
): string[] {
  const lines: string[] = [];
  if (output.stdout) lines.push(...renderCappedResultText(output.stdout, width));
  if (output.stderr) {
    lines.push(...renderIndented(ansi.dim('[stderr]'), width, 2));
    lines.push(...renderCappedResultText(output.stderr, width, ansi.dim));
  }
  return lines;
}

/**
 * Render a `shell_run` (background-process) result. The status line — status,
 * exit code, failure message, and the run `ref` — is always shown in full so a
 * head/tail cap can never hide whether the command failed or timed out; only
 * the stdout/stderr stream bodies are capped.
 */
function renderShellRunResult(
  entry: MakaPiToolEntry,
  content: Extract<ToolResultContent, { kind: 'shell_run' }>,
  width: number,
): string[] {
  const lines: string[] = [];
  // The command/cwd live on the result. The Bash input summary shows only the
  // command's first line (`command.split('\n')[0]`), so skip the result-side
  // `$ cmd` only when the input already shows the whole command — a single-line
  // command. A multiline command, or a ref-only StopBackgroundTask input,
  // renders the full command here so none of it is lost. The cwd is in neither
  // input summary, so show it once here.
  const input = entry.input;
  const command = input !== null && typeof input === 'object'
    ? (input as { command?: unknown }).command
    : undefined;
  const inputShowsFullCommand = typeof command === 'string'
    && command.trim() !== ''
    && !command.includes('\n');
  if (!inputShowsFullCommand) {
    lines.push(...renderIndented(ansi.dim(`$ ${content.cmd}`), width, 2));
  }
  lines.push(...renderIndented(ansi.dim(`cwd: ${content.cwd}`), width, 2));
  const settled = content.status !== 'running' && content.status !== 'completed';
  const parts: string[] = [content.status];
  if (content.exitCode !== undefined) parts.push(`exit ${content.exitCode}`);
  if (content.failureMessage) parts.push(content.failureMessage);
  const head = parts.join(' · ');
  // Keep the colored status and the dim ref as separate ansi spans; nesting one
  // inside the other would let the inner reset terminate the outer color early.
  const statusLine = `${settled ? ansi.red(head) : ansi.dim(head)} ${ansi.dim(`(${content.ref})`)}`;
  lines.push(...renderIndented(statusLine, width, 2));
  if (content.output?.mode === 'pty') {
    const hasTerminalView = ptyTuiTerminalRows(content.output).length > 0;
    lines.push(...renderPtyTerminalRows(content.output, width));
    if (!hasTerminalView && (content.status === 'failed' || content.status === 'orphaned')) {
      lines.push(...renderIndented(ansi.dim('No terminal view available'), width, 2));
    }
  } else if (content.output?.mode === 'pipes') {
    lines.push(...renderPipeShellOutput(content.output, width));
  }
  return lines;
}

function renderDiffResult(diff: string, width: number): string[] {
  return renderIndented(colorDiff(limitText(diff, 12_000)), width, 2);
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function formatPtyControlOperation(operation: ShellRunOperation | undefined, args: unknown): string {
  if (operation?.kind !== 'pty_control') return 'Background terminal interaction failed';
  const parts: string[] = [];
  if (operation.input) {
    const preview = readWriteStdinInputPreview(args);
    const action = operation.input.applied ? 'Sent' : 'Did not send';
    if (preview) {
      parts.push(preview.truncated
        ? `${action}: ${preview.text}… · ${operation.input.bytes} bytes total`
        : `${action}: ${preview.text}`);
    } else {
      parts.push(`${action} ${operation.input.bytes} bytes`);
    }
  }
  if (operation.resize) {
    const size = `${operation.resize.cols}x${operation.resize.rows}`;
    if (!operation.resize.applied) parts.push(`Did not resize to ${size}`);
    else if (operation.resize.changed) parts.push(`Resized to ${size}`);
    else if (!operation.input) parts.push(`Size already ${size}`);
  }
  if (operation.failed) parts.push('Background terminal interaction failed');
  return parts.join(' · ') || 'Background terminal interaction completed';
}

function toolInputSummary(entry: MakaPiToolEntry): string {
  const input = entry.input;
  const obj = input !== null && typeof input === 'object' ? (input as Record<string, unknown>) : undefined;
  switch (entry.toolName) {
    case 'Bash': {
      const command = obj?.command;
      if (typeof command === 'string' && command.trim()) {
        return `$ ${command.split('\n')[0]}`;
      }
      break;
    }
    case 'Read': {
      const path = obj?.path;
      if (typeof path === 'string' && path.trim()) {
        const parts = [path];
        if (typeof obj?.offset === 'number') parts.push(`offset ${obj.offset}`);
        if (typeof obj?.limit === 'number') parts.push(`limit ${obj.limit}`);
        return parts.join(' ');
      }
      break;
    }
    case 'WriteStdin': {
      const parts: string[] = [];
      const input = readWriteStdinInputPreview(obj);
      if (input) parts.push(input.truncated ? `${input.text}… · ${input.bytes} bytes` : input.text);
      if (obj?.size && typeof obj.size === 'object') {
        const size = obj.size as { cols?: unknown; rows?: unknown };
        if (typeof size.cols === 'number' && typeof size.rows === 'number') {
          parts.push(`${size.cols}x${size.rows}`);
        }
      }
      if (parts.length > 0) return parts.join(' · ');
      if (typeof obj?.ref === 'string') return obj.ref;
      break;
    }
    case 'Write':
    case 'Edit': {
      const path = obj?.path;
      if (typeof path === 'string' && path.trim()) return path;
      break;
    }
    case 'Grep': {
      const pattern = obj?.pattern;
      if (typeof pattern === 'string' && pattern.trim()) {
        const parts = [pattern];
        if (typeof obj?.path === 'string' && obj.path.trim()) parts.push(`in ${obj.path}`);
        if (typeof obj?.glob === 'string' && obj.glob.trim()) parts.push(`glob ${obj.glob}`);
        return parts.join(' ');
      }
      break;
    }
    case 'Glob': {
      const pattern = obj?.pattern;
      if (typeof pattern === 'string' && pattern.trim()) {
        const cwd = obj?.cwd;
        return typeof cwd === 'string' && cwd.trim() ? `${pattern} in ${cwd}` : pattern;
      }
      break;
    }
  }
  if (input === undefined) return '';
  // Single line: this summary is inlined into the compact header, and a
  // pretty-printed JSON body would break the two-line card contract.
  return `input: ${limitText(formatUnknownInline(input), 600)}`;
}
