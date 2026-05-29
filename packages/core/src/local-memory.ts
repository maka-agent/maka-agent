/**
 * Transparent local MEMORY.md contract.
 *
 * V0.1 describes one user-visible Markdown file. It does not implement
 * hidden durable memory, extraction, embeddings, recall, or agent tools.
 */

export interface LocalMemorySettings {
  readonly enabled: boolean;
  readonly agentReadEnabled: boolean;
}

export type LocalMemoryOrigin = 'manual' | 'extracted' | 'imported' | 'unknown';
export type LocalMemoryEntryStatus = 'active' | 'archived';

export interface LocalMemoryEntryPreview {
  readonly id: string;
  readonly origin: LocalMemoryOrigin;
  readonly status: LocalMemoryEntryStatus;
  readonly title: string;
  readonly content: string;
  readonly createdAt?: number;
  readonly updatedAt?: number;
  readonly tags: readonly string[];
  readonly decayTtlMs?: number;
}

export interface LocalMemoryParseResult {
  readonly entries: ReadonlyArray<LocalMemoryEntryPreview>;
  readonly activeEntries: ReadonlyArray<LocalMemoryEntryPreview>;
  readonly archivedEntries: ReadonlyArray<LocalMemoryEntryPreview>;
  readonly safeMode: boolean;
  readonly reason?: 'empty' | 'oversize';
}

interface LocalMemoryRawEntry extends LocalMemoryEntryPreview {
  readonly promptContent: string;
}

interface LocalMemoryRawParseResult {
  readonly entries: ReadonlyArray<LocalMemoryRawEntry>;
  readonly activeEntries: ReadonlyArray<LocalMemoryRawEntry>;
  readonly archivedEntries: ReadonlyArray<LocalMemoryRawEntry>;
  readonly safeMode: boolean;
  readonly reason?: 'empty' | 'oversize';
}

export interface LocalMemoryState {
  readonly path: string;
  readonly enabled: boolean;
  readonly agentReadEnabled: boolean;
  readonly status: 'ok' | 'disabled' | 'safe_mode' | 'incognito_blocked' | 'error';
  readonly content: string;
  readonly entryCount: number;
  readonly activeEntryCount: number;
  readonly archivedEntryCount: number;
  readonly entries: ReadonlyArray<LocalMemoryEntryPreview>;
  readonly activeEntries: ReadonlyArray<LocalMemoryEntryPreview>;
  readonly archivedEntries: ReadonlyArray<LocalMemoryEntryPreview>;
  readonly latestEntry?: LocalMemoryEntryPreview;
  readonly reason?: string;
}

export interface AppendManualLocalMemoryEntryInput {
  readonly title: string;
  readonly content: string;
  readonly tags?: readonly string[];
  readonly now?: number;
}

export type AppendManualLocalMemoryEntryResult =
  | { readonly ok: true; readonly draft: string }
  | { readonly ok: false; readonly reason: 'empty_title' | 'empty_content' | 'oversize' };

export interface SetLocalMemoryEntryStatusInput {
  readonly id: string;
  readonly status: LocalMemoryEntryStatus;
  readonly now?: number;
}

export type SetLocalMemoryEntryStatusResult =
  | { readonly ok: true; readonly draft: string }
  | { readonly ok: false; readonly reason: 'invalid_id' | 'not_found' | 'oversize' };

export const LOCAL_MEMORY_MAX_BYTES = 128 * 1024;
export const LOCAL_MEMORY_PROMPT_MAX_CHARS = 12_000;

export function defaultLocalMemorySettings(): LocalMemorySettings {
  return { enabled: true, agentReadEnabled: false };
}

export function normalizeLocalMemorySettings(input: unknown): LocalMemorySettings {
  if (!input || typeof input !== 'object') return defaultLocalMemorySettings();
  const value = input as Partial<LocalMemorySettings>;
  return {
    enabled: value.enabled !== false,
    agentReadEnabled: value.agentReadEnabled === true,
  };
}

export function defaultLocalMemoryMarkdown(now = Date.now()): string {
  return [
    '# Maka Memory',
    '',
    '## 示例：我的偏好',
    `<!-- maka-memory: id=manual-${now} origin=manual createdAt=${now} -->`,
    '这里写你希望 Maka 记住的长期偏好。默认不会注入给 agent；需要在设置里单独开启“agent 可读取本地记忆”。',
    '',
  ].join('\n');
}

export function parseLocalMemoryMarkdown(input: string): LocalMemoryParseResult {
  const parsed = parseLocalMemoryMarkdownRaw(input);
  if (parsed.safeMode || parsed.reason) return parsed;
  return toPreviewParseResult(parsed);
}

export function buildLocalMemoryPromptBody(input: string): string | undefined {
  const parsed = parseLocalMemoryMarkdownRaw(input);
  if (parsed.safeMode || parsed.activeEntries.length === 0) return undefined;

  const blocks = parsed.activeEntries.map((entry) => {
    const lines = [`## ${entry.title}`];
    if (entry.tags.length > 0) lines.push(`Tags: ${entry.tags.join(', ')}`);
    lines.push(entry.promptContent);
    return lines.join('\n');
  });
  const body = blocks.join('\n\n').trim();
  if (body.length === 0) return undefined;
  if (body.length <= LOCAL_MEMORY_PROMPT_MAX_CHARS) return body;
  return `${body.slice(0, LOCAL_MEMORY_PROMPT_MAX_CHARS).trimEnd()}\n\n[本地记忆已按长度截断]`;
}

export function appendManualLocalMemoryEntryDraft(
  currentDraft: string,
  input: AppendManualLocalMemoryEntryInput,
): AppendManualLocalMemoryEntryResult {
  const title = normalizeManualEntryTitle(input.title);
  if (!title) return { ok: false, reason: 'empty_title' };

  const content = input.content.trim();
  if (!content) return { ok: false, reason: 'empty_content' };

  const now = Number.isFinite(input.now) && input.now !== undefined ? Math.max(0, Math.floor(input.now)) : Date.now();
  const tags = normalizeManualEntryTags(input.tags ?? []);
  const meta = [
    `id=manual-${now}`,
    'origin=manual',
    `createdAt=${now}`,
    'status=active',
    ...(tags.length > 0 ? [`tags=${tags.join(',')}`] : []),
  ].join(' ');
  const entry = [
    `## ${title}`,
    `<!-- maka-memory: ${meta} -->`,
    content,
  ].join('\n');
  const draft = currentDraft.trim().length > 0 ? `${currentDraft.trimEnd()}\n\n${entry}\n` : `${entry}\n`;
  if (new TextEncoder().encode(draft).byteLength > LOCAL_MEMORY_MAX_BYTES) {
    return { ok: false, reason: 'oversize' };
  }
  return { ok: true, draft };
}

export function setLocalMemoryEntryStatusDraft(
  currentDraft: string,
  input: SetLocalMemoryEntryStatusInput,
): SetLocalMemoryEntryStatusResult {
  const id = input.id.trim();
  if (!id || (input.status !== 'active' && input.status !== 'archived')) {
    return { ok: false, reason: 'invalid_id' };
  }

  const section = findLocalMemoryEntrySection(currentDraft, id);
  if (!section) return { ok: false, reason: 'not_found' };

  const now = Number.isFinite(input.now) && input.now !== undefined ? Math.max(0, Math.floor(input.now)) : Date.now();
  const lines = currentDraft.split(/\r?\n/);
  const meta = {
    ...(section.meta ?? {}),
    id: section.id,
    status: input.status,
    updatedAt: String(now),
  };
  const metaLine = `<!-- maka-memory: ${serializeMetaComment(meta)} -->`;

  if (section.metaLineIndex !== undefined) {
    lines[section.metaLineIndex] = metaLine;
  } else {
    lines.splice(section.headingLineIndex + 1, 0, metaLine);
  }

  const draft = lines.join('\n');
  if (new TextEncoder().encode(draft).byteLength > LOCAL_MEMORY_MAX_BYTES) {
    return { ok: false, reason: 'oversize' };
  }
  return { ok: true, draft };
}

function parseLocalMemoryMarkdownRaw(input: string): LocalMemoryRawParseResult {
  const size = new TextEncoder().encode(input).byteLength;
  if (size > LOCAL_MEMORY_MAX_BYTES) {
    return { entries: [], activeEntries: [], archivedEntries: [], safeMode: true, reason: 'oversize' };
  }
  if (input.trim().length === 0) {
    return { entries: [], activeEntries: [], archivedEntries: [], safeMode: false, reason: 'empty' };
  }

  const entries: LocalMemoryRawEntry[] = [];
  const lines = input.split(/\r?\n/);
  let current: { title: string; body: string[]; meta?: Record<string, string> } | null = null;

  const flush = () => {
    if (!current) return;
    const content = current.body.join('\n').trim();
    if (content.length > 0) {
      const id = current.meta?.id ?? slugId(current.title);
      const origin = normalizeOrigin(current.meta?.origin);
      const status = current.meta?.status === 'archived' ? 'archived' : 'active';
      const createdAt = parseFiniteNumber(current.meta?.createdAt);
      const updatedAt = parseFiniteNumber(current.meta?.updatedAt);
      const decayTtlMs = parseFiniteNumber(current.meta?.decayTtlMs);
      entries.push({
        id,
        origin,
        status,
        title: current.title,
        content: content.slice(0, 500),
        promptContent: content,
        ...(Number.isFinite(createdAt) ? { createdAt } : {}),
        ...(Number.isFinite(updatedAt) ? { updatedAt } : {}),
        tags: parseTags(current.meta?.tags),
        ...(Number.isFinite(decayTtlMs) ? { decayTtlMs } : {}),
      });
    }
    current = null;
  };

  for (const line of lines) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      flush();
      current = { title: heading[1] ?? '未命名记忆', body: [] };
      continue;
    }
    if (!current) continue;
    const meta = parseMetaComment(line);
    if (meta) {
      current.meta = meta;
      continue;
    }
    current.body.push(line);
  }
  flush();
  const archivedEntries = entries.filter((entry) => entry.status === 'archived');
  const activeEntries = entries.filter((entry) => entry.status === 'active');
  return { entries, activeEntries, archivedEntries, safeMode: false };
}

function toPreviewParseResult(parsed: LocalMemoryRawParseResult): LocalMemoryParseResult {
  const entries = parsed.entries.map(stripPromptContent);
  return {
    ...parsed,
    entries,
    activeEntries: entries.filter((entry) => entry.status === 'active'),
    archivedEntries: entries.filter((entry) => entry.status === 'archived'),
  };
}

function stripPromptContent(entry: LocalMemoryRawEntry): LocalMemoryEntryPreview {
  const { promptContent: _promptContent, ...preview } = entry;
  return preview;
}

function parseMetaComment(line: string): Record<string, string> | null {
  const match = /^<!--\s*maka-memory:\s*(.*?)\s*-->$/.exec(line.trim());
  if (!match) return null;
  const meta: Record<string, string> = {};
  for (const part of (match[1] ?? '').split(/\s+/)) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx);
    const value = part.slice(idx + 1);
    if (/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(key) && value.length <= 128) {
      meta[key] = value;
    }
  }
  return meta;
}

function findLocalMemoryEntrySection(
  input: string,
  entryId: string,
): { id: string; headingLineIndex: number; metaLineIndex?: number; meta?: Record<string, string> } | null {
  const lines = input.split(/\r?\n/);
  let current: { title: string; headingLineIndex: number; metaLineIndex?: number; meta?: Record<string, string> } | null = null;

  const matchCurrent = () => {
    if (!current) return null;
    const id = current.meta?.id ?? slugId(current.title);
    return id === entryId ? { id, ...current } : null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      const matched = matchCurrent();
      if (matched) return matched;
      current = { title: heading[1] ?? '未命名记忆', headingLineIndex: index };
      continue;
    }
    if (!current || current.meta) continue;
    const meta = parseMetaComment(line);
    if (meta) {
      current.meta = meta;
      current.metaLineIndex = index;
    }
  }
  return matchCurrent();
}

function serializeMetaComment(meta: Record<string, string>): string {
  const orderedKeys = ['id', 'origin', 'createdAt', 'updatedAt', 'status', 'tags', 'decayTtlMs'];
  const seen = new Set<string>();
  const parts: string[] = [];

  const push = (key: string) => {
    if (seen.has(key)) return;
    const value = meta[key];
    if (value === undefined) return;
    const safeValue = value.replace(/[\s<>]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 128);
    if (!safeValue) return;
    seen.add(key);
    parts.push(`${key}=${safeValue}`);
  };

  for (const key of orderedKeys) push(key);
  for (const key of Object.keys(meta).sort()) {
    if (/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(key)) push(key);
  }
  return parts.join(' ');
}

function normalizeManualEntryTitle(input: string): string {
  return input
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function normalizeManualEntryTags(input: readonly string[]): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const raw of input) {
    const tag = raw
      .replace(/[\s,]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .trim()
      .slice(0, 24);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
    if (tags.length >= 8) break;
  }
  return tags;
}

function normalizeOrigin(input: string | undefined): LocalMemoryOrigin {
  switch (input) {
    case 'manual':
    case 'extracted':
    case 'imported':
      return input;
    default:
      return 'unknown';
  }
}

function parseFiniteNumber(input: string | undefined): number | undefined {
  if (!input) return undefined;
  const value = Number(input);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function parseTags(input: string | undefined): string[] {
  if (!input) return [];
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const raw of input.split(',')) {
    const tag = raw.trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
    if (tags.length >= 8) break;
  }
  return tags;
}

function slugId(title: string): string {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug.length > 0 ? slug : 'memory-entry';
}
