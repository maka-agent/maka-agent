/**
 * Quiet-panel presentation for built-in Read / Grep / Glob / Edit / Write
 * tools that still persist as generic JSON. Pure helpers — no React.
 */
import { redactSecrets } from '../redact.js';
import type { ToolActivityItem } from '../materialize.js';
import { extractToolCommand } from './tool-command.js';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const raw = record?.[key];
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

function numberField(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const raw = record?.[key];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
}

/**
 * First-line invocation for the quiet panel: path / pattern / command text,
 * never a pretty-printed args object.
 */
export function formatToolInvocationLine(item: Pick<ToolActivityItem, 'toolName' | 'args' | 'activityKind'>): string | undefined {
  const args = asRecord(item.args);
  if (!args) return undefined;

  const command = extractToolCommand(item.args);
  if (command) return redactSecrets(command);

  const path = stringField(args, 'path');
  const pattern = stringField(args, 'pattern');
  const name = item.toolName;

  if (name === 'Read' || name === 'Write' || name === 'Edit') {
    if (!path) return undefined;
    const offset = numberField(args, 'offset');
    const limit = numberField(args, 'limit');
    const range =
      offset !== undefined || limit !== undefined
        ? ` · L${offset ?? 0}${limit !== undefined ? `+${limit}` : ''}`
        : '';
    return redactSecrets(`${path}${range}`);
  }

  if (name === 'Grep') {
    if (!pattern) return undefined;
    const scope = path ? ` in ${path}` : '';
    const glob = stringField(args, 'glob');
    const globSuffix = glob ? ` (${glob})` : '';
    return redactSecrets(`${pattern}${scope}${globSuffix}`);
  }

  if (name === 'Glob') {
    if (!pattern) return undefined;
    const cwd = stringField(args, 'cwd');
    return redactSecrets(cwd ? `${pattern} in ${cwd}` : pattern);
  }

  // Unknown tools: prefer a single primary string field over JSON dump.
  if (path) return redactSecrets(path);
  if (pattern) return redactSecrets(pattern);
  return undefined;
}

export interface BuiltinJsonPreview {
  /** Preferred first line when the result already embeds the subject (e.g. write path). */
  headline?: string;
  body: string;
}

/**
 * Turn built-in tool JSON results into plain text for the quiet panel.
 * Returns undefined when the shape is not a known builtin result — caller
 * falls back to generic JSON preview.
 */
export function formatBuiltinJsonResult(
  toolName: string,
  value: unknown,
): BuiltinJsonPreview | undefined {
  const record = asRecord(value);
  if (!record) return undefined;

  if (toolName === 'Read') {
    const content = stringField(record, 'content');
    if (content === undefined) return undefined;
    return { body: redactSecrets(content) };
  }

  if (toolName === 'Grep') {
    const matches = record.matches;
    if (!Array.isArray(matches)) return undefined;
    const lines = matches
      .filter((line): line is string => typeof line === 'string')
      .map((line) => redactSecrets(line));
    return {
      body: lines.length > 0 ? lines.join('\n') : '（无匹配）',
    };
  }

  if (toolName === 'Glob') {
    const files = record.files;
    if (!Array.isArray(files)) return undefined;
    const lines = files
      .filter((line): line is string => typeof line === 'string')
      .map((line) => redactSecrets(line));
    return {
      body: lines.length > 0 ? lines.join('\n') : '（无匹配文件）',
    };
  }

  if (toolName === 'Write') {
    const path = stringField(record, 'path');
    const bytes = numberField(record, 'bytes');
    if (!path) return undefined;
    const size = bytes !== undefined ? ` · ${bytes} B` : '';
    return {
      headline: redactSecrets(path),
      body: `已写入${size}`,
    };
  }

  if (toolName === 'Edit') {
    const path = stringField(record, 'path');
    const replacements = numberField(record, 'replacements');
    const startLine = numberField(record, 'startLine');
    const endLine = numberField(record, 'endLine');
    if (!path) return undefined;
    const range =
      startLine !== undefined && endLine !== undefined
        ? ` · L${startLine}–${endLine}`
        : '';
    const count = replacements !== undefined ? ` · ${replacements} 处` : '';
    return {
      headline: redactSecrets(path),
      body: `已替换${count}${range}`,
    };
  }

  return undefined;
}
