import { execFile } from 'node:child_process';
import { basename, extname, join, relative } from 'node:path';
import { readFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { buildOfficeCliEnv } from './officecli-env.js';
import { redactSecrets } from '@maka/core/redaction';
import {
  MAX_IMPORTED_FOLDER_COUNT,
  MAX_IMPORTED_FOLDER_DEPTH,
  MAX_IMPORTED_FOLDER_ENTRIES,
  MAX_IMPORTED_FOLDERS_ENTRIES,
  MAX_IMPORTED_TEXT_FILE_BYTES,
  MAX_IMPORTED_TEXT_FILE_CHARS,
  MAX_IMPORTED_TEXT_FILE_COUNT,
  MAX_IMPORTED_TEXT_FILE_SAMPLE_BYTES,
  MAX_IMPORTED_TEXT_FILES_CHARS,
  preflightDroppedTextFilesForPromptImport,
} from '@maka/core';

export {
  MAX_IMPORTED_FOLDER_COUNT,
  MAX_IMPORTED_FOLDER_DEPTH,
  MAX_IMPORTED_FOLDER_ENTRIES,
  MAX_IMPORTED_FOLDERS_ENTRIES,
  MAX_IMPORTED_TEXT_FILE_BYTES,
  MAX_IMPORTED_TEXT_FILE_CHARS,
  MAX_IMPORTED_TEXT_FILE_COUNT,
  MAX_IMPORTED_TEXT_FILE_SAMPLE_BYTES,
  MAX_IMPORTED_TEXT_FILES_CHARS,
} from '@maka/core';

const FOLDER_OUTLINE_SKIP_NAMES = new Set([
  '.git',
  '.next',
  '.turbo',
  '.vite',
  'dist',
  'build',
  'coverage',
  'node_modules',
]);
const OFFICE_IMPORT_EXTENSIONS = new Set(['.docx', '.xlsx', '.pptx']);
const MAX_IMPORTED_OFFICE_FILE_BYTES = 50 * 1024 * 1024;
const OFFICE_IMPORT_TIMEOUT_MS = 15_000;
const OFFICE_IMPORT_MAX_BUFFER = 512 * 1024;

export type TextFileImportFailureReason =
  | 'missing'
  | 'too-large'
  | 'binary'
  | 'too-many-files'
  | 'unsupported-type'
  | 'read-failed'
  | 'officecli_missing'
  | 'officecli_timeout'
  | 'officecli_failed';

export type TextFileImportResult =
  | {
      ok: true;
      name: string;
      bytes: number;
      files: number;
      truncated: boolean;
      prompt: string;
    }
  | {
      ok: false;
      reason: TextFileImportFailureReason;
    };

export interface DroppedTextFilePayload {
  name: string;
  size: number;
  type?: string;
  text: string;
}

type TextFileImportRunner = typeof execFile;

interface TextFileImportOptions {
  runner?: TextFileImportRunner;
  timeoutMs?: number;
}

export type FolderOutlineImportFailureReason =
  | 'missing'
  | 'read-failed'
  | 'too-many-folders'
  | 'empty';

export type FolderOutlineImportResult =
  | {
      ok: true;
      name: string;
      folders: number;
      entries: number;
      truncated: boolean;
      prompt: string;
    }
  | {
      ok: false;
      reason: FolderOutlineImportFailureReason;
    };

export async function readTextFileForPromptImport(filePath: string, options: TextFileImportOptions = {}): Promise<TextFileImportResult> {
  const loaded = await loadTextFileForPromptImport(filePath, options);
  if (!loaded.ok) return loaded;
  const prompt = loaded.kind === 'office'
    ? formatImportedOfficeDocumentPrompt({ name: loaded.name, text: loaded.text, truncated: loaded.truncated, source: 'file-picker' })
    : formatImportedTextFilePrompt({ name: loaded.name, text: loaded.text, truncated: loaded.truncated, source: 'file-picker' });
  return {
    ok: true,
    name: loaded.name,
    bytes: loaded.bytes,
    files: 1,
    truncated: loaded.truncated,
    prompt,
  };
}

export async function readTextFilesForPromptImport(filePaths: string[], options: TextFileImportOptions = {}): Promise<TextFileImportResult> {
  const selected = filePaths.filter(Boolean);
  if (selected.length === 0) return { ok: false, reason: 'missing' };
  if (selected.length === 1) return readTextFileForPromptImport(selected[0], options);
  if (selected.length > MAX_IMPORTED_TEXT_FILE_COUNT) return { ok: false, reason: 'too-many-files' };

  const loadedFiles = [];
  for (const filePath of selected) {
    const loaded = await loadTextFileForPromptImport(filePath, options);
    if (!loaded.ok) return loaded;
    loadedFiles.push(loaded);
  }

  let remaining = MAX_IMPORTED_TEXT_FILES_CHARS;
  let truncated = false;
  const fragments: string[] = [];
  for (const file of loadedFiles) {
    const chars = Array.from(file.text);
    const text = chars.length > remaining ? chars.slice(0, Math.max(0, remaining)).join('') : file.text;
    remaining -= Array.from(text).length;
    truncated = truncated || file.truncated || chars.length > Array.from(text).length || remaining <= 0;
    const blockInput = {
      name: file.name,
      text,
      truncated: file.truncated || chars.length > Array.from(text).length,
      source: 'file-picker',
    } satisfies Parameters<typeof formatImportedTextFileBlock>[0];
    fragments.push(file.kind === 'office' ? formatImportedOfficeDocumentBlock(blockInput) : formatImportedTextFileBlock(blockInput));
    if (remaining <= 0) break;
  }

  const totalBytes = loadedFiles.reduce((sum, file) => sum + file.bytes, 0);
  return {
    ok: true,
    name: loadedFiles.every((file) => file.kind === 'text') ? `${loadedFiles.length} 个文本文件` : `${loadedFiles.length} 个本地文件`,
    bytes: totalBytes,
    files: loadedFiles.length,
    truncated,
    prompt: loadedFiles.every((file) => file.kind === 'text') ? formatImportedTextFilesPrompt({
      count: loadedFiles.length,
      fragments: fragments.join('\n\n'),
      truncated,
    }) : formatImportedLocalFilesPrompt({
      count: loadedFiles.length,
      fragments: fragments.join('\n\n'),
      truncated,
    }),
  };
}

export function readDroppedTextFilesForPromptImport(payloads: DroppedTextFilePayload[]): TextFileImportResult {
  const selected = payloads.filter((file) => file && typeof file.name === 'string');
  if (selected.length === 0) return { ok: false, reason: 'missing' };
  const preflight = preflightDroppedTextFilesForPromptImport(selected.map((file) => ({
    name: file.name,
    size: file.size,
    type: file.type,
    sampleBytes: Buffer.from(typeof file.text === 'string' ? file.text : '', 'utf8').subarray(0, MAX_IMPORTED_TEXT_FILE_SAMPLE_BYTES),
  })));
  if (!preflight.ok) return preflight;

  const loadedFiles = [];
  for (const payload of selected) {
    const loaded = loadDroppedTextFileForPromptImport(payload);
    if (!loaded.ok) return loaded;
    loadedFiles.push(loaded);
  }

  if (loadedFiles.length === 1) {
    const [file] = loadedFiles;
    return {
      ok: true,
      name: file.name,
      bytes: file.bytes,
      files: 1,
      truncated: file.truncated,
      prompt: formatImportedTextFilePrompt({ name: file.name, text: file.text, truncated: file.truncated, source: 'drop-or-paste' }),
    };
  }

  let remaining = MAX_IMPORTED_TEXT_FILES_CHARS;
  let truncated = false;
  const fragments: string[] = [];
  for (const file of loadedFiles) {
    const chars = Array.from(file.text);
    const text = chars.length > remaining ? chars.slice(0, Math.max(0, remaining)).join('') : file.text;
    remaining -= Array.from(text).length;
    const fileTruncated = file.truncated || chars.length > Array.from(text).length;
    truncated = truncated || fileTruncated || remaining <= 0;
    fragments.push(formatImportedTextFileBlock({ name: file.name, text, truncated: fileTruncated, source: 'drop-or-paste' }));
    if (remaining <= 0) break;
  }

  return {
    ok: true,
    name: `${loadedFiles.length} 个文本文件`,
    bytes: loadedFiles.reduce((sum, file) => sum + file.bytes, 0),
    files: loadedFiles.length,
    truncated,
    prompt: formatImportedTextFilesPrompt({
      count: loadedFiles.length,
      fragments: fragments.join('\n\n'),
      truncated,
    }),
  };
}

async function loadTextFileForPromptImport(filePath: string, options: TextFileImportOptions = {}): Promise<
  | {
      ok: true;
      kind: 'text' | 'office';
      name: string;
      bytes: number;
      text: string;
      truncated: boolean;
    }
  | {
      ok: false;
      reason: TextFileImportFailureReason;
    }
> {
  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch {
    return { ok: false, reason: 'missing' };
  }
  if (!fileStat.isFile()) return { ok: false, reason: 'missing' };
  if (isOfficeDocumentPath(filePath)) {
    return loadOfficeDocumentForPromptImport(filePath, fileStat.size, options);
  }
  if (fileStat.size > MAX_IMPORTED_TEXT_FILE_BYTES) return { ok: false, reason: 'too-large' };
  const preflight = preflightDroppedTextFilesForPromptImport([{ name: filePath, size: fileStat.size }]);
  if (!preflight.ok) return preflight;

  let raw: Buffer;
  try {
    raw = await readFile(filePath);
  } catch {
    return { ok: false, reason: 'read-failed' };
  }
  if (looksBinary(raw)) return { ok: false, reason: 'binary' };

  const cleaned = raw.toString('utf8').replace(/\u0000/g, '').trim();
  if (!cleaned) return { ok: false, reason: 'binary' };

  const chars = Array.from(cleaned);
  const truncated = chars.length > MAX_IMPORTED_TEXT_FILE_CHARS;
  const text = truncated ? chars.slice(0, MAX_IMPORTED_TEXT_FILE_CHARS).join('') : cleaned;
  const name = basename(filePath);
  return {
    ok: true,
    kind: 'text',
    name,
    bytes: fileStat.size,
    text,
    truncated,
  };
}

async function loadOfficeDocumentForPromptImport(
  filePath: string,
  bytes: number,
  options: TextFileImportOptions,
): Promise<
  | {
      ok: true;
      kind: 'office';
      name: string;
      bytes: number;
      text: string;
      truncated: boolean;
    }
  | {
      ok: false;
      reason: TextFileImportFailureReason;
    }
> {
  if (bytes > MAX_IMPORTED_OFFICE_FILE_BYTES) return { ok: false, reason: 'too-large' };
  const runner = options.runner ?? execFile;
  const timeoutMs = options.timeoutMs ?? OFFICE_IMPORT_TIMEOUT_MS;
  try {
    const rawText = await runOfficeCliTextImport(runner, filePath, timeoutMs);
    const cleaned = sanitizeImportedOfficeText(rawText, filePath);
    if (!cleaned) return { ok: false, reason: 'officecli_failed' };
    const chars = Array.from(cleaned);
    const truncated = chars.length > MAX_IMPORTED_TEXT_FILE_CHARS;
    const text = truncated ? chars.slice(0, MAX_IMPORTED_TEXT_FILE_CHARS).join('') : cleaned;
    return {
      ok: true,
      kind: 'office',
      name: basename(filePath),
      bytes,
      text,
      truncated,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { ok: false, reason: 'officecli_missing' };
    if (code === 'ETIMEDOUT' || (error as { killed?: boolean }).killed) return { ok: false, reason: 'officecli_timeout' };
    return { ok: false, reason: 'officecli_failed' };
  }
}

function runOfficeCliTextImport(runner: TextFileImportRunner, filePath: string, timeoutMs: number): Promise<string> {
  return new Promise((resolveText, reject) => {
    const child = runner(
      'officecli',
      ['view', filePath, 'text'],
      {
        timeout: timeoutMs,
        maxBuffer: OFFICE_IMPORT_MAX_BUFFER,
        env: buildOfficeCliEnv(),
      },
      (error, stdout, stderr) => {
        if (error) {
          Object.assign(error, { stdout, stderr });
          reject(error);
          return;
        }
        resolveText(String(stdout ?? ''));
      },
    );
    child.on('error', reject);
  });
}

function sanitizeImportedOfficeText(text: string, filePath: string): string {
  return redactSecrets(text.replaceAll(filePath, '<selected-office-file>')).trim();
}

function isOfficeDocumentPath(filePath: string): boolean {
  return OFFICE_IMPORT_EXTENSIONS.has(extname(filePath).toLowerCase());
}

function loadDroppedTextFileForPromptImport(input: DroppedTextFilePayload):
  | {
      ok: true;
      kind: 'text';
      name: string;
      bytes: number;
      text: string;
      truncated: boolean;
    }
  | {
      ok: false;
      reason: TextFileImportFailureReason;
    } {
  const bytes = Number.isFinite(input.size) ? Math.max(0, Math.floor(input.size)) : 0;
  if (bytes > MAX_IMPORTED_TEXT_FILE_BYTES) return { ok: false, reason: 'too-large' };
  const rawText = typeof input.text === 'string' ? input.text : '';
  const raw = Buffer.from(rawText, 'utf8');
  if (looksBinary(raw)) return { ok: false, reason: 'binary' };

  const cleaned = rawText.replace(/\u0000/g, '').trim();
  if (!cleaned) return { ok: false, reason: 'binary' };

  const chars = Array.from(cleaned);
  const truncated = chars.length > MAX_IMPORTED_TEXT_FILE_CHARS;
  const text = truncated ? chars.slice(0, MAX_IMPORTED_TEXT_FILE_CHARS).join('') : cleaned;
  const name = sanitizeDroppedFileName(input.name);
  return {
    ok: true,
    kind: 'text',
    name,
    bytes,
    text,
    truncated,
  };
}

function sanitizeDroppedFileName(name: string): string {
  const leaf = basename(name).split(/[\\/]/).filter(Boolean).pop() ?? '';
  const cleaned = leaf.replace(/[\u0000-\u001f]/g, '').trim();
  return cleaned || 'dropped.txt';
}

export function formatImportedTextFilePrompt(input: {
  name: string;
  text: string;
  truncated: boolean;
  source?: PromptContextSource;
}): string {
  return [
    `请结合下面导入的本地文本文件 "${input.name}" 回答。`,
    input.truncated ? '文件内容过长，下面只包含前一部分。' : '',
    '',
    formatImportedTextFileBlock(input),
  ].filter(Boolean).join('\n');
}

export function formatImportedTextFilesPrompt(input: { count: number; fragments: string; truncated: boolean }): string {
  return [
    `请结合下面导入的 ${input.count} 个本地文本文件回答。`,
    input.truncated ? '文件内容过长，下面只包含前一部分。' : '',
    '',
    input.fragments,
  ].filter(Boolean).join('\n');
}

export function formatImportedOfficeDocumentPrompt(input: {
  name: string;
  text: string;
  truncated: boolean;
  source?: PromptContextSource;
}): string {
  return [
    `请结合下面从 Office 文档 "${input.name}" 导出的文本回答。`,
    input.truncated ? '文档内容较长，下面只包含前一部分。' : '',
    '',
    formatImportedOfficeDocumentBlock(input),
  ].filter(Boolean).join('\n');
}

export function formatImportedLocalFilesPrompt(input: { count: number; fragments: string; truncated: boolean }): string {
  return [
    `请结合下面导入的 ${input.count} 个本地文件内容回答。`,
    input.truncated ? '文件内容较长，下面只包含前一部分。' : '',
    '',
    input.fragments,
  ].filter(Boolean).join('\n');
}

type PromptContextSource = 'file-picker' | 'drop-or-paste' | 'folder-picker';

function formatImportedTextFileBlock(input: {
  name: string;
  text: string;
  truncated: boolean;
  source?: PromptContextSource;
}): string {
  return [
    `<local-text-file name="${escapeXmlAttr(input.name)}"${formatPromptContextAttrs({
      source: input.source,
      fingerprint: fingerprintPromptContext(input.text),
      truncated: input.truncated,
    })}>`,
    escapeXmlText(input.text),
    '</local-text-file>',
  ].join('\n');
}

function formatImportedOfficeDocumentBlock(input: {
  name: string;
  text: string;
  truncated: boolean;
  source?: PromptContextSource;
}): string {
  return [
    `<local-office-document name="${escapeXmlAttr(input.name)}"${formatPromptContextAttrs({
      source: input.source,
      fingerprint: fingerprintPromptContext(input.text),
      truncated: input.truncated,
    })}>`,
    escapeXmlText(input.text),
    '</local-office-document>',
  ].join('\n');
}

export async function readFolderOutlineForPromptImport(folderPath: string): Promise<FolderOutlineImportResult> {
  const loaded = await loadFolderOutlineForPromptImport(folderPath, MAX_IMPORTED_FOLDER_ENTRIES);
  if (!loaded.ok) return loaded;
  return {
    ok: true,
    name: loaded.name,
    folders: 1,
    entries: loaded.entries,
    truncated: loaded.truncated,
    prompt: formatImportedFolderOutlinePrompt({
      name: loaded.name,
      outline: loaded.outline,
      truncated: loaded.truncated,
      source: 'folder-picker',
    }),
  };
}

export async function readFolderOutlinesForPromptImport(folderPaths: string[]): Promise<FolderOutlineImportResult> {
  const selected = folderPaths.filter(Boolean);
  if (selected.length === 0) return { ok: false, reason: 'missing' };
  if (selected.length === 1) return readFolderOutlineForPromptImport(selected[0]);
  if (selected.length > MAX_IMPORTED_FOLDER_COUNT) return { ok: false, reason: 'too-many-folders' };

  let remainingEntries = MAX_IMPORTED_FOLDERS_ENTRIES;
  let truncated = false;
  let totalEntries = 0;
  const blocks: string[] = [];
  for (const folderPath of selected) {
    const loaded = await loadFolderOutlineForPromptImport(folderPath, remainingEntries);
    if (!loaded.ok) return loaded;
    totalEntries += loaded.entries;
    remainingEntries -= loaded.entries;
    truncated = truncated || loaded.truncated || remainingEntries <= 0;
    blocks.push(formatImportedFolderOutlineBlock({
      name: loaded.name,
      outline: loaded.outline,
      truncated: loaded.truncated || remainingEntries <= 0,
      source: 'folder-picker',
    }));
    if (remainingEntries <= 0) break;
  }

  return {
    ok: true,
    name: `${selected.length} 个文件夹`,
    folders: selected.length,
    entries: totalEntries,
    truncated,
    prompt: formatImportedFolderOutlinesPrompt({
      count: selected.length,
      outlines: blocks.join('\n\n'),
      truncated,
    }),
  };
}

async function loadFolderOutlineForPromptImport(
  folderPath: string,
  maxEntries: number,
): Promise<
  | {
      ok: true;
      name: string;
      entries: number;
      outline: string;
      truncated: boolean;
    }
  | {
      ok: false;
      reason: FolderOutlineImportFailureReason;
    }
> {
  let rootStat;
  try {
    rootStat = await stat(folderPath);
  } catch {
    return { ok: false, reason: 'missing' };
  }
  if (!rootStat.isDirectory()) return { ok: false, reason: 'missing' };

  const lines: string[] = [];
  let truncated = false;

  try {
    await scanFolderOutline({
      root: folderPath,
      dir: folderPath,
      depth: 0,
      lines,
      maxEntries,
      markTruncated: () => { truncated = true; },
    });
  } catch {
    return { ok: false, reason: 'read-failed' };
  }

  if (lines.length === 0) return { ok: false, reason: 'empty' };
  const name = basename(folderPath) || 'folder';
  return {
    ok: true,
    name,
    entries: lines.length,
    outline: lines.join('\n'),
    truncated,
  };
}

export function formatImportedFolderOutlinePrompt(input: {
  name: string;
  outline: string;
  truncated: boolean;
  source?: PromptContextSource;
}): string {
  return [
    `请结合下面导入的本地文件夹目录 "${input.name}" 回答。`,
    input.truncated ? '目录较大，下面只包含前一部分。' : '',
    '',
    formatImportedFolderOutlineBlock(input),
  ].filter(Boolean).join('\n');
}

export function formatImportedFolderOutlinesPrompt(input: { count: number; outlines: string; truncated: boolean }): string {
  return [
    `请结合下面导入的 ${input.count} 个本地文件夹目录回答。`,
    input.truncated ? '目录较大，下面只包含前一部分。' : '',
    '',
    input.outlines,
  ].filter(Boolean).join('\n');
}

function formatImportedFolderOutlineBlock(input: {
  name: string;
  outline: string;
  truncated: boolean;
  source?: PromptContextSource;
}): string {
  return [
    `<local-folder-outline name="${escapeXmlAttr(input.name)}"${formatPromptContextAttrs({
      source: input.source,
      fingerprint: fingerprintPromptContext(input.outline),
      truncated: input.truncated,
    })}>`,
    escapeXmlText(input.outline),
    '</local-folder-outline>',
  ].join('\n');
}

async function scanFolderOutline(input: {
  root: string;
  dir: string;
  depth: number;
  lines: string[];
  maxEntries: number;
  markTruncated: () => void;
}): Promise<void> {
  if (input.lines.length >= input.maxEntries || input.depth >= MAX_IMPORTED_FOLDER_DEPTH) {
    input.markTruncated();
    return;
  }

  const entries = await readdir(input.dir, { withFileTypes: true });
  entries.sort((a, b) => {
    const aDir = a.isDirectory() ? 0 : 1;
    const bDir = b.isDirectory() ? 0 : 1;
    if (aDir !== bDir) return aDir - bDir;
    return a.name.localeCompare(b.name);
  });

  for (const entry of entries) {
    if (input.lines.length >= input.maxEntries) {
      input.markTruncated();
      return;
    }
    if (entry.name.startsWith('.') || FOLDER_OUTLINE_SKIP_NAMES.has(entry.name)) continue;

    const absolute = join(input.dir, entry.name);
    const rel = relative(input.root, absolute).split(/[\\/]/).join('/');
    if (!rel || rel.startsWith('..')) continue;

    if (entry.isDirectory()) {
      input.lines.push(`${'  '.repeat(input.depth)}- ${rel}/`);
      await scanFolderOutline({
        root: input.root,
        dir: absolute,
        depth: input.depth + 1,
        lines: input.lines,
        maxEntries: input.maxEntries,
        markTruncated: input.markTruncated,
      });
    } else if (entry.isFile()) {
      input.lines.push(`${'  '.repeat(input.depth)}- ${rel}`);
    }
  }
}

function looksBinary(buffer: Buffer): boolean {
  if (buffer.length === 0) return true;
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
    if (byte < 7 || (byte > 13 && byte < 32)) suspicious += 1;
  }
  return suspicious / sample.length > 0.02;
}

function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatPromptContextAttrs(input: {
  source?: PromptContextSource;
  fingerprint: string;
  truncated: boolean;
}): string {
  return [
    input.source ? ` source="${input.source}"` : '',
    ` fingerprint="${input.fingerprint}"`,
    input.truncated ? ' truncated="true"' : '',
  ].join('');
}

function fingerprintPromptContext(value: string): string {
  const digest = createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16);
  return `sha256:${digest}`;
}
