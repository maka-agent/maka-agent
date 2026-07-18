/**
 * Foreign session contracts and defensive parsing (#1057).
 *
 * A "foreign session" is a conversation persisted on this machine by another
 * coding agent (Claude Code, Codex). Maka can list them and, on request,
 * distill one into a handoff digest so the user continues work in a fresh
 * Maka session without re-explaining context.
 *
 * Everything in a foreign store is UNTRUSTED input: transcripts may carry
 * prompt injection, foreign system prompts, secrets, control characters, or
 * bidi spoofs. This module is the single gate all foreign text passes
 * through before it may reach a Maka surface or an LLM prompt:
 *
 *   - `sanitizeForeignText` — NFC, C0/C1/bidi controls → space, zero-width
 *     removal, whitespace collapse, code-point cap (the session-name.ts
 *     pipeline, parameterized for longer payloads).
 *   - digest building redacts secrets (`redactSecrets`) and never includes
 *     tool outputs, system prompts, or thinking blocks — only user-authored
 *     messages, assistant text, and file paths, each capped.
 *   - a digest is DATA for the handoff prompt, never instructions: the
 *     consumer must wrap it in an untrusted-data envelope.
 *
 * IO lives in @maka/storage (foreign-session-store.ts); this module is pure.
 */

import { redactSecrets } from './redaction.js';

export const FOREIGN_SESSION_SOURCES = ['claude-code', 'codex'] as const;
export type ForeignSessionSource = typeof FOREIGN_SESSION_SOURCES[number];

/** Scanner result caps (per issue #1057: max 50 sessions, 30-day window). */
export const FOREIGN_SESSION_SCAN_MAX_SESSIONS = 50;
export const FOREIGN_SESSION_SCAN_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Bytes read from a transcript head to extract cwd/meta. */
export const FOREIGN_SESSION_HEAD_BYTES = 4096;
/** Bytes read from head+tail for title candidates. */
export const FOREIGN_SESSION_TITLE_WINDOW_BYTES = 64 * 1024;
/** Hard cap on bytes read from one transcript when building a digest. */
export const FOREIGN_SESSION_DIGEST_MAX_READ_BYTES = 2 * 1024 * 1024;

export const FOREIGN_SESSION_TITLE_MAX_CODE_POINTS = 120;
export const FOREIGN_SESSION_MESSAGE_MAX_CODE_POINTS = 2000;
export const FOREIGN_SESSION_DIGEST_MAX_MESSAGES = 20;
export const FOREIGN_SESSION_DIGEST_MAX_FILES = 40;
export const FOREIGN_SESSION_PATH_MAX_CODE_POINTS = 260;

export interface ForeignSessionSummary {
  source: ForeignSessionSource;
  /** Source-native id (Claude uuid / Codex thread id). Opaque to Maka. */
  id: string;
  /** Sanitized display title (never empty — falls back to the id). */
  title: string;
  /** Working directory the foreign session ran in ('' when unknown). */
  cwd: string;
  /** Last-activity wall clock, ms epoch. */
  updatedAtMs: number;
  gitBranch?: string;
  /** Absolute transcript path (Claude .jsonl / Codex rollout .jsonl). */
  transcriptPath: string;
}

/**
 * Sanitized, capped distillation of one foreign transcript. This is the ONLY
 * shape foreign conversation content may take beyond the storage layer.
 * Deliberately absent: tool outputs, system prompts, thinking blocks,
 * assistant tool calls — per the #1057 safety contract those never cross
 * into Maka context. Old tool output is stale evidence anyway; the handoff
 * instructs verification against the working tree instead.
 */
export interface ForeignSessionDigest {
  source: ForeignSessionSource;
  id: string;
  title: string;
  cwd: string;
  gitBranch?: string;
  updatedAtMs: number;
  /** Chronological user-authored messages (sanitized, redacted, capped). */
  userMessages: string[];
  /** Chronological assistant text snippets (sanitized, redacted, capped). */
  assistantTexts: string[];
  /** Workspace-relative or absolute file paths referenced by tool calls. */
  filesTouched: string[];
  /** Records dropped by parsing/caps — surfaced as reader uncertainty. */
  warnings: string[];
}

/**
 * session-name.ts pipeline generalized for foreign payloads: same character
 * classes, parameterized cap, and empty-in → empty-out (callers decide the
 * fallback; foreign text has no "reject" path because we never block a scan
 * on one bad string).
 */
export function sanitizeForeignText(input: unknown, maxCodePoints: number): string {
  if (typeof input !== 'string') return '';
  const cleaned = input
    .normalize('NFC')
    .replace(/[\u0000-\u001F\u007F\u0080-\u009F]/g, ' ')
    .replace(/[\u202A-\u202E\u2066-\u2069]/g, ' ')
    .replace(/[\u200B\u200C\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const points = Array.from(cleaned);
  if (points.length <= maxCodePoints) return cleaned;
  return points.slice(0, maxCodePoints).join('') + '…';
}

/** Sanitize + redact in one step for digest payloads. */
export function sanitizeForeignMessage(input: unknown): string {
  return redactSecrets(sanitizeForeignText(input, FOREIGN_SESSION_MESSAGE_MAX_CODE_POINTS));
}

export function sanitizeForeignTitle(input: unknown): string {
  return redactSecrets(sanitizeForeignText(input, FOREIGN_SESSION_TITLE_MAX_CODE_POINTS));
}

/* ------------------------------------------------------------------ *
 * Claude Code transcript records
 *
 * ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl — one JSON object per
 * line, discriminated by `type`. The scanner cares about:
 *   - `user`      : cwd / gitBranch / isSidechain / timestamp / message
 *   - `assistant` : message (text blocks) / timestamp
 *   - `ai-title`  : aiTitle        (title candidate, near tail)
 *   - `last-prompt`: lastPrompt    (title candidate, near tail)
 *   - `summary`   : summary        (title candidate)
 * Unknown types are skipped, never fatal.
 * ------------------------------------------------------------------ */

export interface ClaudeTranscriptMeta {
  cwd?: string;
  gitBranch?: string;
  isSidechain?: boolean;
  timestampMs?: number;
}

/** Title candidates in descending priority order. */
export interface ClaudeTitleCandidates {
  customTitle?: string;
  aiTitle?: string;
  summary?: string;
  lastPrompt?: string;
  firstUserMessage?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseTimestampMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms;
  }
  return undefined;
}

/** Parse one JSONL line; undefined for anything malformed. */
export function parseForeignJsonLine(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) return undefined;
  try {
    return asRecord(JSON.parse(trimmed));
  } catch {
    return undefined;
  }
}

/** Extract scan metadata from a parsed Claude record, merging into `meta`. */
export function collectClaudeMeta(record: Record<string, unknown>, meta: ClaudeTranscriptMeta): void {
  if (typeof record.cwd === 'string' && meta.cwd === undefined) meta.cwd = record.cwd;
  if (typeof record.gitBranch === 'string' && record.gitBranch.length > 0 && meta.gitBranch === undefined) {
    meta.gitBranch = record.gitBranch;
  }
  if (typeof record.isSidechain === 'boolean' && meta.isSidechain === undefined) {
    meta.isSidechain = record.isSidechain;
  }
  const ts = parseTimestampMs(record.timestamp);
  if (ts !== undefined && (meta.timestampMs === undefined || ts > meta.timestampMs)) {
    meta.timestampMs = ts;
  }
}

/** Extract title candidates from a parsed Claude record, merging into `titles`. */
export function collectClaudeTitle(record: Record<string, unknown>, titles: ClaudeTitleCandidates): void {
  if (typeof record.customTitle === 'string' && titles.customTitle === undefined) {
    titles.customTitle = record.customTitle;
  }
  if (typeof record.aiTitle === 'string' && titles.aiTitle === undefined) titles.aiTitle = record.aiTitle;
  if (typeof record.summary === 'string' && titles.summary === undefined) titles.summary = record.summary;
  if (typeof record.lastPrompt === 'string' && titles.lastPrompt === undefined) {
    titles.lastPrompt = record.lastPrompt;
  }
  if (record.type === 'user' && titles.firstUserMessage === undefined) {
    const text = claudeUserMessageText(record);
    if (text !== undefined) titles.firstUserMessage = text;
  }
}

export function pickClaudeTitle(titles: ClaudeTitleCandidates): string {
  return (
    sanitizeForeignTitle(
      titles.customTitle ?? titles.aiTitle ?? titles.summary ?? titles.lastPrompt ?? titles.firstUserMessage,
    ) || ''
  );
}

/**
 * User-authored text from a Claude `user` record. Message content is either
 * a plain string or an array of content blocks; only `text` blocks count —
 * tool_result blocks are foreign tool output and are deliberately dropped.
 */
export function claudeUserMessageText(record: Record<string, unknown>): string | undefined {
  const message = asRecord(record.message);
  if (!message) return undefined;
  const content = message.content;
  if (typeof content === 'string') return content.length > 0 ? content : undefined;
  if (!Array.isArray(content)) return undefined;
  const texts: string[] = [];
  for (const block of content) {
    const rec = asRecord(block);
    if (rec && rec.type === 'text' && typeof rec.text === 'string') texts.push(rec.text);
  }
  const joined = texts.join('\n').trim();
  return joined.length > 0 ? joined : undefined;
}

/** Assistant text blocks from a Claude `assistant` record (no tool calls). */
export function claudeAssistantText(record: Record<string, unknown>): string | undefined {
  return claudeUserMessageText(record);
}

/** File paths referenced by tool_use blocks in a Claude assistant record. */
export function claudeToolFilePaths(record: Record<string, unknown>): string[] {
  const message = asRecord(record.message);
  const content = message?.content;
  if (!Array.isArray(content)) return [];
  const paths: string[] = [];
  for (const block of content) {
    const rec = asRecord(block);
    if (!rec || rec.type !== 'tool_use') continue;
    const input = asRecord(rec.input);
    if (!input) continue;
    for (const key of ['file_path', 'path', 'notebook_path']) {
      const value = input[key];
      if (typeof value === 'string' && value.length > 0) {
        paths.push(sanitizeForeignText(value, FOREIGN_SESSION_PATH_MAX_CODE_POINTS));
      }
    }
  }
  return paths;
}

/* ------------------------------------------------------------------ *
 * Codex stores
 *
 * SQLite `threads` table (preferred) — column availability varies across
 * Codex versions, so the reader introspects and adapts. Rollout JSONL
 * (~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl) is the
 * fallback; lines are `{ type, timestamp, payload }` envelopes where
 * `session_meta` carries id/cwd and `response_item` carries conversation
 * content.
 * ------------------------------------------------------------------ */

/** Codex thread sources eligible for import (per issue #1057). */
export const CODEX_SUPPORTED_THREAD_SOURCES = ['cli', 'vscode', 'atlas', 'chatgpt'] as const;

export interface CodexThreadRow {
  id?: unknown;
  rollout_path?: unknown;
  cwd?: unknown;
  title?: unknown;
  first_user_message?: unknown;
  updated_at_ms?: unknown;
  updated_at?: unknown;
  git_branch?: unknown;
  archived?: unknown;
  source?: unknown;
}

/** Normalize a Codex threads row; undefined when it cannot be listed. */
export function normalizeCodexThreadRow(
  row: CodexThreadRow,
): (Omit<ForeignSessionSummary, 'transcriptPath'> & { rolloutPath: string }) | undefined {
  if (typeof row.id !== 'string' || row.id.length === 0) return undefined;
  if (typeof row.rollout_path !== 'string' || row.rollout_path.length === 0) return undefined;
  if (row.archived === 1 || row.archived === true) return undefined;
  if (
    typeof row.source === 'string' &&
    !(CODEX_SUPPORTED_THREAD_SOURCES as readonly string[]).includes(row.source)
  ) {
    return undefined;
  }
  const updatedAtMs =
    typeof row.updated_at_ms === 'number' && Number.isFinite(row.updated_at_ms)
      ? row.updated_at_ms
      : typeof row.updated_at === 'number' && Number.isFinite(row.updated_at)
        ? row.updated_at * 1000
        : parseTimestampMs(row.updated_at) ?? 0;
  const title = sanitizeForeignTitle(row.title) || sanitizeForeignTitle(row.first_user_message) || row.id;
  return {
    source: 'codex',
    id: row.id,
    title,
    cwd: typeof row.cwd === 'string' ? row.cwd : '',
    updatedAtMs,
    gitBranch: typeof row.git_branch === 'string' && row.git_branch.length > 0 ? row.git_branch : undefined,
    rolloutPath: row.rollout_path,
  };
}

/** session_meta payload from a Codex rollout envelope line. */
export function codexRolloutSessionMeta(
  record: Record<string, unknown>,
): { id?: string; cwd?: string; gitBranch?: string; timestampMs?: number } | undefined {
  if (record.type !== 'session_meta') return undefined;
  const payload = asRecord(record.payload);
  if (!payload) return undefined;
  const git = asRecord(payload.git);
  return {
    id: typeof payload.id === 'string' ? payload.id : undefined,
    cwd: typeof payload.cwd === 'string' ? payload.cwd : undefined,
    gitBranch: typeof git?.branch === 'string' ? git.branch : undefined,
    timestampMs: parseTimestampMs(record.timestamp),
  };
}

/**
 * User/assistant text from a Codex rollout envelope. `response_item`
 * payloads follow the OpenAI Responses shape: `{ type: 'message', role,
 * content: [{ type: 'input_text'|'output_text', text }] }`. Everything
 * else (function calls, reasoning, tool outputs) is dropped by design.
 */
export function codexRolloutMessage(
  record: Record<string, unknown>,
): { role: 'user' | 'assistant'; text: string } | undefined {
  if (record.type !== 'response_item') return undefined;
  const payload = asRecord(record.payload);
  if (!payload || payload.type !== 'message') return undefined;
  const role = payload.role;
  if (role !== 'user' && role !== 'assistant') return undefined;
  if (!Array.isArray(payload.content)) return undefined;
  const texts: string[] = [];
  for (const block of payload.content) {
    const rec = asRecord(block);
    if (rec && (rec.type === 'input_text' || rec.type === 'output_text') && typeof rec.text === 'string') {
      texts.push(rec.text);
    }
  }
  const joined = texts.join('\n').trim();
  if (joined.length === 0) return undefined;
  return { role, text: joined };
}

/* ------------------------------------------------------------------ *
 * Digest assembly
 * ------------------------------------------------------------------ */

export interface DigestAccumulator {
  userMessages: string[];
  assistantTexts: string[];
  filesTouched: Set<string>;
  warnings: string[];
}

export function createDigestAccumulator(): DigestAccumulator {
  return { userMessages: [], assistantTexts: [], filesTouched: new Set(), warnings: [] };
}

export function pushDigestMessage(acc: DigestAccumulator, role: 'user' | 'assistant', raw: string): void {
  const list = role === 'user' ? acc.userMessages : acc.assistantTexts;
  if (list.length >= FOREIGN_SESSION_DIGEST_MAX_MESSAGES) return;
  const text = sanitizeForeignMessage(raw);
  if (text.length > 0) list.push(text);
}

export function pushDigestFile(acc: DigestAccumulator, path: string): void {
  if (acc.filesTouched.size >= FOREIGN_SESSION_DIGEST_MAX_FILES) return;
  if (path.length > 0) acc.filesTouched.add(path);
}

export function finishDigest(
  acc: DigestAccumulator,
  base: Pick<ForeignSessionDigest, 'source' | 'id' | 'title' | 'cwd' | 'gitBranch' | 'updatedAtMs'>,
): ForeignSessionDigest {
  return {
    ...base,
    userMessages: acc.userMessages,
    assistantTexts: acc.assistantTexts,
    filesTouched: [...acc.filesTouched],
    warnings: acc.warnings,
  };
}

/**
 * Render a digest as an explicitly-untrusted data block for the handoff
 * prompt. The envelope wording mirrors the memory/turn-tail discipline:
 * contents are reference data, never instructions. Foreign-authored text
 * additionally has literal envelope tags stripped so a transcript cannot
 * close the block early (cf. renderSafeTaskLedgerText).
 */
export function renderForeignSessionDigestForPrompt(digest: ForeignSessionDigest): string {
  const strip = (text: string): string => text.replace(/<\/?foreign-session-digest[^\n>]*>/gi, '');
  const lines: string[] = [
    '<foreign-session-digest>',
    `source=${digest.source}`,
    `title=${JSON.stringify(strip(digest.title))}`,
    `cwd=${JSON.stringify(digest.cwd)}`,
    ...(digest.gitBranch ? [`git_branch=${JSON.stringify(strip(digest.gitBranch))}`] : []),
    `updated_at=${new Date(digest.updatedAtMs).toISOString()}`,
    '',
    '## User messages (chronological)',
    ...digest.userMessages.map((m, i) => `${i + 1}. ${JSON.stringify(strip(m))}`),
    '',
    '## Assistant replies (text only, tool activity omitted)',
    ...digest.assistantTexts.map((m, i) => `${i + 1}. ${JSON.stringify(strip(m))}`),
    '',
    '## Files referenced by tool calls',
    ...digest.filesTouched.map((f) => `- ${strip(f)}`),
    ...(digest.warnings.length > 0
      ? ['', '## Reader warnings', ...digest.warnings.map((w) => `- ${strip(w)}`)]
      : []),
    '</foreign-session-digest>',
  ];
  return lines.join('\n');
}
