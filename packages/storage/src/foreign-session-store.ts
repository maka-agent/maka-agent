/**
 * Read-only scanner + digest reader over foreign agent session stores
 * (#1057): Claude Code (~/.claude/projects) and Codex (~/.codex).
 *
 * Boundary rules, in order of importance:
 *
 *   1. READ-ONLY. This store never writes, renames, locks, or truncates
 *      anything. It deliberately does NOT take the root-authority
 *      capability — that contract exists for Maka's own workspace; foreign
 *      stores belong to other tools and must stay byte-identical.
 *   2. SCOPED. All reads resolve under the configured home directory's
 *      known subtrees (`.claude/projects`, `.codex`). Paths obtained from
 *      foreign metadata (Codex `rollout_path`) are realpath-checked to
 *      still live inside the source root — a hostile row cannot point the
 *      reader at ~/.ssh.
 *   3. BOUNDED. Byte caps from @maka/core/foreign-session apply to every
 *      read (head window for metadata, head+tail window for titles, hard
 *      cap for digests); scan results cap at 50 sessions / 30 days.
 *   4. UNTRUSTED. All extracted text passes the core sanitize/redact gate;
 *      malformed lines and unreadable files are skipped, never fatal.
 *
 * Codex is read SQLite-first (node:sqlite, readOnly; column availability
 * introspected via PRAGMA so version drift degrades gracefully) with a
 * rollout-file directory walk as fallback.
 */

import { open, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import {
  FOREIGN_SESSION_DIGEST_MAX_READ_BYTES,
  FOREIGN_SESSION_HEAD_BYTES,
  FOREIGN_SESSION_SCAN_MAX_AGE_MS,
  FOREIGN_SESSION_SCAN_MAX_SESSIONS,
  FOREIGN_SESSION_TITLE_WINDOW_BYTES,
  claudeAssistantText,
  claudeToolFilePaths,
  claudeUserMessageText,
  codexRolloutMessage,
  codexRolloutSessionMeta,
  collectClaudeMeta,
  collectClaudeTitle,
  createDigestAccumulator,
  finishDigest,
  normalizeCodexThreadRow,
  parseForeignJsonLine,
  pickClaudeTitle,
  pushDigestFile,
  pushDigestMessage,
  sanitizeForeignTitle,
  type ClaudeTitleCandidates,
  type ClaudeTranscriptMeta,
  type CodexThreadRow,
  type ForeignSessionDigest,
  type ForeignSessionSource,
  type ForeignSessionSummary,
} from '@maka/core/foreign-session';

export interface ForeignSessionScanOptions {
  /** Only sessions whose recorded cwd equals this path (after realpath-free
   * string normalization). Empty/undefined lists across all cwds. */
  cwd?: string;
}

export interface ForeignSessionStore {
  /** Which sources are enabled AND present on this machine. */
  availableSources(): Promise<ForeignSessionSource[]>;
  listSessions(options?: ForeignSessionScanOptions): Promise<ForeignSessionSummary[]>;
  readDigest(summary: ForeignSessionSummary): Promise<ForeignSessionDigest>;
}

export interface ForeignSessionStoreOptions {
  /** Overridable for tests. Defaults to os.homedir(). */
  homeDir?: string;
  /** Env for per-source enable flags. Defaults to process.env. */
  env?: Record<string, string | undefined>;
}

/** Default on; set to '0' to disable (cloak-flag convention). */
export function isClaudeCodeImportEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.MAKA_IMPORT_CLAUDE_CODE !== '0';
}

export function isCodexImportEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.MAKA_IMPORT_CODEX !== '0';
}

export function createForeignSessionStore(options: ForeignSessionStoreOptions = {}): ForeignSessionStore {
  return new FileForeignSessionStore(options.homeDir ?? homedir(), options.env ?? process.env);
}

class FileForeignSessionStore implements ForeignSessionStore {
  constructor(
    private readonly homeDir: string,
    private readonly env: Record<string, string | undefined>,
  ) {}

  private get claudeRoot(): string {
    return join(this.homeDir, '.claude', 'projects');
  }

  private get codexRoot(): string {
    return join(this.homeDir, '.codex');
  }

  async availableSources(): Promise<ForeignSessionSource[]> {
    const sources: ForeignSessionSource[] = [];
    if (isClaudeCodeImportEnabled(this.env) && (await isDirectory(this.claudeRoot))) {
      sources.push('claude-code');
    }
    if (isCodexImportEnabled(this.env) && (await isDirectory(this.codexRoot))) {
      sources.push('codex');
    }
    return sources;
  }

  async listSessions(options: ForeignSessionScanOptions = {}): Promise<ForeignSessionSummary[]> {
    const sources = await this.availableSources();
    const now = Date.now();
    const results: ForeignSessionSummary[] = [];
    if (sources.includes('claude-code')) {
      results.push(...(await this.listClaudeSessions(options, now)));
    }
    if (sources.includes('codex')) {
      results.push(...(await this.listCodexSessions(options, now)));
    }
    results.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
    return results.slice(0, FOREIGN_SESSION_SCAN_MAX_SESSIONS);
  }

  /* ------------------------------ Claude ------------------------------ */

  private async listClaudeSessions(
    options: ForeignSessionScanOptions,
    now: number,
  ): Promise<ForeignSessionSummary[]> {
    const projectDirs = await listSubdirectories(this.claudeRoot);
    const candidates: { path: string; mtimeMs: number }[] = [];
    for (const dir of projectDirs) {
      for (const entry of await listFilesWithSuffix(dir, '.jsonl')) {
        candidates.push(entry);
      }
    }
    // Newest transcripts first so the per-source cap keeps the useful ones
    // and old files never get opened at all.
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

    const results: ForeignSessionSummary[] = [];
    for (const candidate of candidates) {
      if (results.length >= FOREIGN_SESSION_SCAN_MAX_SESSIONS) break;
      if (now - candidate.mtimeMs > FOREIGN_SESSION_SCAN_MAX_AGE_MS) break;
      const summary = await this.scanClaudeTranscript(candidate.path, candidate.mtimeMs, options.cwd);
      if (summary) results.push(summary);
    }
    return results;
  }

  private async scanClaudeTranscript(
    path: string,
    mtimeMs: number,
    cwdFilter: string | undefined,
  ): Promise<ForeignSessionSummary | undefined> {
    const head = await readWindow(path, 'head', FOREIGN_SESSION_HEAD_BYTES);
    if (head === undefined) return undefined;
    const meta: ClaudeTranscriptMeta = {};
    for (const line of head.split('\n')) {
      const record = parseForeignJsonLine(line);
      if (record) collectClaudeMeta(record, meta);
      if (meta.cwd !== undefined && meta.isSidechain !== undefined) break;
    }
    if (meta.isSidechain === true) return undefined;
    if (meta.cwd === undefined) return undefined;
    if (cwdFilter !== undefined && normalizePath(meta.cwd) !== normalizePath(cwdFilter)) return undefined;

    const titles: ClaudeTitleCandidates = {};
    const titleHead = await readWindow(path, 'head', FOREIGN_SESSION_TITLE_WINDOW_BYTES);
    const titleTail = await readWindow(path, 'tail', FOREIGN_SESSION_TITLE_WINDOW_BYTES);
    for (const window of [titleTail, titleHead]) {
      if (window === undefined) continue;
      for (const line of window.split('\n')) {
        const record = parseForeignJsonLine(line);
        if (record) {
          collectClaudeTitle(record, titles);
          collectClaudeMeta(record, meta);
        }
      }
    }
    const id = basename(path, '.jsonl');
    return {
      source: 'claude-code',
      id,
      title: pickClaudeTitle(titles) || id,
      cwd: meta.cwd,
      updatedAtMs: meta.timestampMs ?? mtimeMs,
      gitBranch: meta.gitBranch,
      transcriptPath: path,
    };
  }

  /* ------------------------------ Codex ------------------------------- */

  private async listCodexSessions(
    options: ForeignSessionScanOptions,
    now: number,
  ): Promise<ForeignSessionSummary[]> {
    const fromDb = await this.listCodexSessionsFromSqlite(options, now);
    if (fromDb !== undefined) return fromDb;
    return this.listCodexSessionsFromRollouts(options, now);
  }

  /**
   * undefined = SQLite unusable (no DB file, node:sqlite unavailable, or
   * schema too old) → caller falls back to the rollout walk. An empty array
   * is a real "no sessions" answer.
   */
  private async listCodexSessionsFromSqlite(
    options: ForeignSessionScanOptions,
    now: number,
  ): Promise<ForeignSessionSummary[] | undefined> {
    const dbPath = await newestCodexStateDb(this.codexRoot);
    if (dbPath === undefined) return undefined;
    let rows: CodexThreadRow[];
    try {
      const sqlite = await import('node:sqlite');
      const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
      try {
        const columns = new Set(
          (db.prepare('PRAGMA table_info(threads)').all() as { name?: unknown }[])
            .map((c) => (typeof c.name === 'string' ? c.name : ''))
            .filter((n) => n.length > 0),
        );
        if (!columns.has('id') || !columns.has('rollout_path')) return undefined;
        const wanted = [
          'id',
          'rollout_path',
          'cwd',
          'title',
          'first_user_message',
          'updated_at_ms',
          'updated_at',
          'git_branch',
          'archived',
          'source',
        ].filter((c) => columns.has(c));
        // Column names come from the fixed `wanted` allowlist above, never
        // from the database — safe to interpolate.
        const order = columns.has('updated_at_ms') ? 'updated_at_ms' : 'updated_at';
        rows = db
          .prepare(`SELECT ${wanted.join(', ')} FROM threads ORDER BY ${order} DESC LIMIT ${FOREIGN_SESSION_SCAN_MAX_SESSIONS * 2}`)
          .all() as CodexThreadRow[];
      } finally {
        db.close();
      }
    } catch {
      return undefined;
    }

    const results: ForeignSessionSummary[] = [];
    for (const row of rows) {
      if (results.length >= FOREIGN_SESSION_SCAN_MAX_SESSIONS) break;
      const normalized = normalizeCodexThreadRow(row);
      if (!normalized) continue;
      if (now - normalized.updatedAtMs > FOREIGN_SESSION_SCAN_MAX_AGE_MS) continue;
      if (options.cwd !== undefined && normalizePath(normalized.cwd) !== normalizePath(options.cwd)) continue;
      const transcriptPath = await this.resolveCodexRolloutPath(normalized.rolloutPath);
      if (transcriptPath === undefined) continue;
      results.push({
        source: normalized.source,
        id: normalized.id,
        title: normalized.title,
        cwd: normalized.cwd,
        updatedAtMs: normalized.updatedAtMs,
        gitBranch: normalized.gitBranch,
        transcriptPath,
      });
    }
    return results;
  }

  private async listCodexSessionsFromRollouts(
    options: ForeignSessionScanOptions,
    now: number,
  ): Promise<ForeignSessionSummary[]> {
    const sessionsRoot = join(this.codexRoot, 'sessions');
    const files = await walkRolloutFiles(sessionsRoot, now);
    const results: ForeignSessionSummary[] = [];
    for (const file of files) {
      if (results.length >= FOREIGN_SESSION_SCAN_MAX_SESSIONS) break;
      const head = await readWindow(file.path, 'head', FOREIGN_SESSION_HEAD_BYTES);
      if (head === undefined) continue;
      let meta: ReturnType<typeof codexRolloutSessionMeta>;
      let firstUserText: string | undefined;
      for (const line of head.split('\n')) {
        const record = parseForeignJsonLine(line);
        if (!record) continue;
        meta ??= codexRolloutSessionMeta(record);
        if (firstUserText === undefined) {
          const message = codexRolloutMessage(record);
          if (message?.role === 'user') firstUserText = message.text;
        }
        if (meta && firstUserText !== undefined) break;
      }
      if (!meta?.id || meta.cwd === undefined) continue;
      if (options.cwd !== undefined && normalizePath(meta.cwd) !== normalizePath(options.cwd)) continue;
      results.push({
        source: 'codex',
        id: meta.id,
        // session_meta has no title; the first user message in the head
        // window is the best available label (Grok Build does the same).
        title: sanitizeForeignTitle(firstUserText) || meta.id,
        cwd: meta.cwd,
        updatedAtMs: meta.timestampMs ?? file.mtimeMs,
        gitBranch: meta.gitBranch,
        transcriptPath: file.path,
      });
    }
    return results;
  }

  /** Realpath-confine a rollout path from the (untrusted) DB to ~/.codex. */
  private async resolveCodexRolloutPath(rolloutPath: string): Promise<string | undefined> {
    try {
      const real = await realpath(resolve(rolloutPath));
      const root = await realpath(this.codexRoot);
      if (real !== root && !real.startsWith(root + sep)) return undefined;
      return (await stat(real)).isFile() ? real : undefined;
    } catch {
      return undefined;
    }
  }

  /* ------------------------------ Digest ------------------------------ */

  async readDigest(summary: ForeignSessionSummary): Promise<ForeignSessionDigest> {
    // The transcript path was produced by our own scan, but re-confine it
    // anyway: digests can be requested long after the scan, and the file
    // may have been swapped for a symlink in between.
    const root = summary.source === 'claude-code' ? this.claudeRoot : this.codexRoot;
    const real = await realpath(resolve(summary.transcriptPath));
    const realRoot = await realpath(root);
    if (real !== realRoot && !real.startsWith(realRoot + sep)) {
      throw new Error('Foreign transcript escaped its source root');
    }

    const acc = createDigestAccumulator();
    const size = (await stat(real)).size;
    let text: string;
    if (size > FOREIGN_SESSION_DIGEST_MAX_READ_BYTES) {
      // Oversized transcript: keep the freshest window (the tail carries the
      // stopping point, which the handoff cares about most) and say so.
      text = (await readWindow(real, 'tail', FOREIGN_SESSION_DIGEST_MAX_READ_BYTES)) ?? '';
      acc.warnings.push(
        `transcript is ${size} bytes; only the trailing ${FOREIGN_SESSION_DIGEST_MAX_READ_BYTES} bytes were read`,
      );
    } else {
      text = await readFile(real, 'utf8');
    }

    let dropped = 0;
    for (const line of text.split('\n')) {
      if (line.trim().length === 0) continue;
      const record = parseForeignJsonLine(line);
      if (!record) {
        dropped += 1;
        continue;
      }
      if (summary.source === 'claude-code') {
        if (record.type === 'user' && record.isSidechain !== true) {
          const text = claudeUserMessageText(record);
          if (text !== undefined) pushDigestMessage(acc, 'user', text);
        } else if (record.type === 'assistant') {
          const text = claudeAssistantText(record);
          if (text !== undefined) pushDigestMessage(acc, 'assistant', text);
          for (const path of claudeToolFilePaths(record)) pushDigestFile(acc, path);
        }
      } else {
        const message = codexRolloutMessage(record);
        if (message) pushDigestMessage(acc, message.role, message.text);
      }
    }
    if (dropped > 0) acc.warnings.push(`${dropped} malformed transcript lines were skipped`);

    return finishDigest(acc, {
      source: summary.source,
      id: summary.id,
      title: summary.title,
      cwd: summary.cwd,
      gitBranch: summary.gitBranch,
      updatedAtMs: summary.updatedAtMs,
    });
  }
}

/* ------------------------------ fs helpers ------------------------------ */

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function listSubdirectories(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => join(root, e.name));
  } catch {
    return [];
  }
}

async function listFilesWithSuffix(dir: string, suffix: string): Promise<{ path: string; mtimeMs: number }[]> {
  const out: { path: string; mtimeMs: number }[] = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(suffix)) continue;
      const path = join(dir, entry.name);
      try {
        out.push({ path, mtimeMs: (await stat(path)).mtimeMs });
      } catch {
        // Deleted mid-scan; skip.
      }
    }
  } catch {
    // Unreadable project dir; skip.
  }
  return out;
}

/** Codex sessions/YYYY/MM/DD/rollout-*.jsonl walk, newest days first. */
async function walkRolloutFiles(root: string, now: number): Promise<{ path: string; mtimeMs: number }[]> {
  const out: { path: string; mtimeMs: number }[] = [];
  const years = (await listSubdirectories(root)).sort().reverse();
  for (const year of years) {
    const months = (await listSubdirectories(year)).sort().reverse();
    for (const month of months) {
      const days = (await listSubdirectories(month)).sort().reverse();
      for (const day of days) {
        for (const file of await listFilesWithSuffix(day, '.jsonl')) {
          if (!basename(file.path).startsWith('rollout-')) continue;
          if (now - file.mtimeMs > FOREIGN_SESSION_SCAN_MAX_AGE_MS) continue;
          out.push(file);
        }
        // Enough candidates for the cap even after per-file drops.
        if (out.length >= FOREIGN_SESSION_SCAN_MAX_SESSIONS * 2) {
          out.sort((a, b) => b.mtimeMs - a.mtimeMs);
          return out;
        }
      }
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

/** Newest ~/.codex/state_N.sqlite, or undefined when none exist. */
async function newestCodexStateDb(codexRoot: string): Promise<string | undefined> {
  try {
    const entries = await readdir(codexRoot);
    const dbs = entries
      .filter((name) => /^state_\d+\.sqlite$/.test(name))
      .sort((a, b) => Number(b.match(/\d+/)?.[0] ?? 0) - Number(a.match(/\d+/)?.[0] ?? 0));
    return dbs.length > 0 ? join(codexRoot, dbs[0]!) : undefined;
  } catch {
    return undefined;
  }
}

/** Bounded read of a file's head or tail window; undefined on any error. */
async function readWindow(path: string, where: 'head' | 'tail', bytes: number): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(path, 'r');
    const size = (await handle.stat()).size;
    const length = Math.min(bytes, size);
    const position = where === 'head' ? 0 : size - length;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, position);
    return buffer.toString('utf8');
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}

function normalizePath(path: string): string {
  const resolved = resolve(path);
  return resolved.endsWith(sep) && resolved !== sep ? resolved.slice(0, -1) : resolved;
}
