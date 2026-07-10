/**
 * Quiet-panel formatting for tool args + generic JSON results.
 *
 * Built-in tools (Read/Grep/…) still persist as `kind: 'json'`. The quiet panel
 * must never dump pretty-printed JSON with escaped newlines — always plain
 * headline + body text, for every tool name.
 */
import { redactSecrets } from '../redact.js';
import type { ToolActivityItem } from '../materialize.js';
import { extractToolCommand } from './tool-command.js';

const BODY_KEYS = [
  'content',
  'text',
  'message',
  'output',
  'stdout',
  'stderr',
  'diff',
  'summary',
  'body',
  'result',
] as const;

const LIST_KEYS = [
  'matches',
  'files',
  'results',
  'items',
  'lines',
  'rows',
  'loaded',
  'tools',
  'paths',
] as const;

const HEADLINE_KEYS = [
  'path',
  'file',
  'cmd',
  'command',
  'pattern',
  'query',
  'url',
  'name',
  'title',
  'id',
  'ref',
] as const;

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

function formatRangeSuffix(args: Record<string, unknown>): string {
  const offset = numberField(args, 'offset');
  const limit = numberField(args, 'limit');
  if (offset === undefined && limit === undefined) return '';
  return ` · L${offset ?? 0}${limit !== undefined ? `+${limit}` : ''}`;
}

/**
 * First-line invocation for the quiet panel from tool args — never a
 * pretty-printed args object.
 */
export function formatToolInvocationLine(
  item: Pick<ToolActivityItem, 'toolName' | 'args' | 'activityKind'>,
): string | undefined {
  const args = asRecord(item.args);
  if (!args) {
    if (typeof item.args === 'string' && item.args.trim()) return redactSecrets(item.args);
    return undefined;
  }

  const command = extractToolCommand(item.args);
  if (command) return redactSecrets(command);

  const path = stringField(args, 'path') ?? stringField(args, 'file');
  const pattern = stringField(args, 'pattern');
  const query = stringField(args, 'query');
  const name = item.toolName;

  if (name === 'Grep' || (pattern && (name === 'Glob' || path))) {
    if (pattern) {
      const scope = path ? ` in ${path}` : '';
      const glob = stringField(args, 'glob');
      const cwd = stringField(args, 'cwd');
      const where = scope || (cwd ? ` in ${cwd}` : '');
      const globSuffix = glob ? ` (${glob})` : '';
      return redactSecrets(`${pattern}${where}${globSuffix}`);
    }
  }

  if (path) {
    return redactSecrets(`${path}${formatRangeSuffix(args)}`);
  }

  if (pattern) {
    const cwd = stringField(args, 'cwd');
    return redactSecrets(cwd ? `${pattern} in ${cwd}` : pattern);
  }

  if (query) return redactSecrets(query);

  for (const key of HEADLINE_KEYS) {
    const value = stringField(args, key);
    if (value) return redactSecrets(value);
  }

  // Last resort: short key:value lines (still not JSON braces).
  const lines = formatAsKeyValueLines(args);
  return lines.length > 0 ? lines : undefined;
}

export interface QuietPreview {
  headline?: string;
  body: string;
}

/**
 * Format any tool JSON/result payload for the quiet panel.
 * Always returns a body — never `undefined` for object values so callers
 * cannot fall back to `JSON.stringify`.
 */
export function formatQuietJsonValue(value: unknown): QuietPreview {
  if (value === null || value === undefined) {
    return { body: '（空）' };
  }
  if (typeof value === 'string') {
    return { body: redactSecrets(value) || '（空）' };
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return { body: String(value) };
  }
  if (Array.isArray(value)) {
    return { body: formatArrayAsBody(value) };
  }

  const record = asRecord(value);
  if (!record) {
    return { body: redactSecrets(String(value)) };
  }

  // Known list payloads (Grep/Glob/load_tools/…).
  for (const key of LIST_KEYS) {
    if (!Array.isArray(record[key])) continue;
    const body = formatArrayAsBody(record[key] as unknown[]);
    const headline = pickHeadline(record, new Set<string>([key]));
    return headline ? { headline, body } : { body };
  }

  // Dominant text payload (Read content, messages, …).
  for (const key of BODY_KEYS) {
    if (typeof record[key] !== 'string') continue;
    const body = redactSecrets(record[key] as string);
    // Prefer path/title from sibling fields as headline; do not restate the body key.
    const headline = pickHeadline(record, new Set<string>([key]));
    return headline ? { headline, body } : { body };
  }

  // Write / Edit style { ok, path, bytes, … }.
  const path = stringField(record, 'path');
  if (path && (record.ok === true || numberField(record, 'bytes') !== undefined || numberField(record, 'replacements') !== undefined)) {
    const bytes = numberField(record, 'bytes');
    const replacements = numberField(record, 'replacements');
    const startLine = numberField(record, 'startLine');
    const endLine = numberField(record, 'endLine');
    const parts: string[] = [];
    if (record.ok === true) parts.push('已完成');
    if (record.ok === false) parts.push('未完成');
    if (bytes !== undefined) parts.push(`${bytes} B`);
    if (replacements !== undefined) parts.push(`${replacements} 处`);
    if (startLine !== undefined && endLine !== undefined) parts.push(`L${startLine}–${endLine}`);
    return {
      headline: redactSecrets(path),
      body: parts.length > 0 ? parts.join(' · ') : '已写入',
    };
  }

  return { body: formatAsKeyValueLines(record) || '（空）' };
}

/** @deprecated Use formatQuietJsonValue — kept name for call-site clarity with toolName. */
export function formatBuiltinJsonResult(_toolName: string, value: unknown): QuietPreview {
  return formatQuietJsonValue(value);
}

function pickHeadline(
  record: Record<string, unknown>,
  skip: ReadonlySet<string>,
): string | undefined {
  for (const key of HEADLINE_KEYS) {
    if (skip.has(key)) continue;
    const value = stringField(record, key);
    if (value) return redactSecrets(value);
  }
  return undefined;
}

function formatArrayAsBody(values: unknown[]): string {
  if (values.length === 0) return '（空）';
  if (values.every((item) => typeof item === 'string')) {
    return redactSecrets((values as string[]).join('\n'));
  }
  return values
    .map((item) => {
      if (typeof item === 'string') return redactSecrets(item);
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        return formatAsKeyValueLines(item as Record<string, unknown>);
      }
      return redactSecrets(String(item));
    })
    .filter((line) => line.length > 0)
    .join('\n');
}

/**
 * Plain `key: value` lines — never JSON braces or escaped `\n` sequences.
 * Keys and whole lines pass through `redactSecrets` so dynamic property names
 * carrying credentials (e.g. `api_key=sk-…`) cannot bypass value-only redaction.
 */
export function formatAsKeyValueLines(record: Record<string, unknown>, depth = 0): string {
  if (depth > 3) return redactSecrets(String(record));
  const indent = '  '.repeat(depth);
  const lines: string[] = [];
  const push = (line: string) => {
    lines.push(redactSecrets(line));
  };
  for (const [key, raw] of Object.entries(record)) {
    if (raw === undefined) continue;
    const safeKey = redactSecrets(key);
    if (raw === null) {
      push(`${indent}${safeKey}: null`);
      continue;
    }
    if (typeof raw === 'string') {
      // Multi-line strings get a block, not a quoted escape soup.
      if (raw.includes('\n')) {
        push(`${indent}${safeKey}:`);
        for (const line of redactSecrets(raw).split('\n')) {
          push(`${indent}  ${line}`);
        }
      } else {
        push(`${indent}${safeKey}: ${redactSecrets(raw)}`);
      }
      continue;
    }
    if (typeof raw === 'number' || typeof raw === 'boolean') {
      push(`${indent}${safeKey}: ${raw}`);
      continue;
    }
    if (Array.isArray(raw)) {
      if (raw.length === 0) {
        push(`${indent}${safeKey}: （空）`);
      } else if (raw.every((item) => typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean')) {
        push(`${indent}${safeKey}:`);
        for (const item of raw) {
          push(`${indent}  - ${typeof item === 'string' ? redactSecrets(item) : String(item)}`);
        }
      } else {
        push(`${indent}${safeKey}:`);
        for (const line of formatArrayAsBody(raw).split('\n')) {
          push(`${indent}  ${line}`);
        }
      }
      continue;
    }
    if (typeof raw === 'object') {
      push(`${indent}${safeKey}:`);
      const nested = formatAsKeyValueLines(raw as Record<string, unknown>, depth + 1);
      if (nested) {
        for (const line of nested.split('\n')) push(line);
      }
      continue;
    }
    push(`${indent}${safeKey}: ${redactSecrets(String(raw))}`);
  }
  return lines.join('\n');
}
