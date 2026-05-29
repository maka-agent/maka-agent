export const MAX_IMPORTED_TEXT_FILE_BYTES = 200_000;
export const MAX_IMPORTED_TEXT_FILE_CHARS = 20_000;
export const MAX_IMPORTED_TEXT_FILE_COUNT = 5;
export const MAX_IMPORTED_TEXT_FILES_CHARS = 40_000;
export const MAX_IMPORTED_TEXT_FILE_SAMPLE_BYTES = 4096;
export const MAX_IMPORTED_FOLDER_ENTRIES = 200;
export const MAX_IMPORTED_FOLDER_COUNT = 3;
export const MAX_IMPORTED_FOLDERS_ENTRIES = 300;
export const MAX_IMPORTED_FOLDER_DEPTH = 4;

export type TextFileImportPreflightFailureReason =
  | 'missing'
  | 'too-large'
  | 'too-many-files'
  | 'unsupported-type';

export type TextFileImportPreflightResult =
  | { ok: true }
  | { ok: false; reason: TextFileImportPreflightFailureReason };

export interface DroppedTextFilePreflightInput {
  name?: string;
  size: number;
  type?: string;
  sampleBytes?: ArrayLike<number>;
}

export function preflightDroppedTextFilesForPromptImport(files: readonly DroppedTextFilePreflightInput[]): TextFileImportPreflightResult {
  if (files.length === 0) return { ok: false, reason: 'missing' };
  if (files.length > MAX_IMPORTED_TEXT_FILE_COUNT) return { ok: false, reason: 'too-many-files' };

  for (const file of files) {
    const size = Number.isFinite(file.size) ? Math.max(0, Math.floor(file.size)) : 0;
    if (size > MAX_IMPORTED_TEXT_FILE_BYTES) return { ok: false, reason: 'too-large' };
    if (!isDroppedTextFileImportCompatible(file)) return { ok: false, reason: 'unsupported-type' };
  }

  return { ok: true };
}

export function isDroppedTextFileImportCompatible(file: DroppedTextFilePreflightInput): boolean {
  const mime = normalizeMime(file.type);
  const suffix = fileSuffix(file.name);
  const basename = fileBasename(file.name);

  if (isTextMime(mime)) return true;
  if (isKnownBinaryMime(mime)) return false;
  if (TEXT_FILE_SUFFIXES.has(suffix) || TEXT_FILE_BASENAMES.has(basename)) return true;
  if (BINARY_FILE_SUFFIXES.has(suffix)) return false;

  if (file.sampleBytes && file.sampleBytes.length > 0) {
    return looksTextLike(file.sampleBytes);
  }

  // Keep extensionless / unknown files importable from explicit picker paths;
  // the main process still performs full binary sniffing after reading.
  return true;
}

function normalizeMime(value: string | undefined): string {
  return (value ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

function isTextMime(mime: string): boolean {
  if (!mime) return false;
  if (mime.startsWith('text/')) return true;
  if (TEXT_MIME_TYPES.has(mime)) return true;
  return mime.endsWith('+json') || mime.endsWith('+xml');
}

function isKnownBinaryMime(mime: string): boolean {
  if (!mime || mime === 'application/octet-stream') return false;
  if (mime.startsWith('image/') || mime.startsWith('audio/') || mime.startsWith('video/')) return true;
  return BINARY_MIME_TYPES.has(mime);
}

function fileBasename(name: string | undefined): string {
  return (name ?? '').split(/[\\/]/).filter(Boolean).pop()?.trim().toLowerCase() ?? '';
}

function fileSuffix(name: string | undefined): string {
  const basename = fileBasename(name);
  const dotIndex = basename.lastIndexOf('.');
  if (dotIndex <= 0 || dotIndex === basename.length - 1) return '';
  return basename.slice(dotIndex + 1);
}

function looksTextLike(bytes: ArrayLike<number>): boolean {
  const sampleLength = Math.min(bytes.length, MAX_IMPORTED_TEXT_FILE_SAMPLE_BYTES);
  if (sampleLength === 0) return true;
  let suspicious = 0;
  for (let index = 0; index < sampleLength; index += 1) {
    const byte = bytes[index] ?? 0;
    if (byte === 0) return false;
    if (byte < 9 || (byte > 13 && byte < 32)) suspicious += 1;
  }
  return suspicious / sampleLength <= 0.3;
}

const TEXT_MIME_TYPES = new Set([
  'application/json',
  'application/ld+json',
  'application/toml',
  'application/x-toml',
  'application/x-yaml',
  'application/xml',
  'application/yaml',
]);

const BINARY_MIME_TYPES = new Set([
  'application/pdf',
  'application/zip',
  'application/x-7z-compressed',
  'application/x-gzip',
  'application/gzip',
  'application/x-rar-compressed',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);

const TEXT_FILE_SUFFIXES = new Set([
  'bash',
  'c',
  'cc',
  'cjs',
  'conf',
  'cpp',
  'cs',
  'css',
  'csv',
  'env',
  'fish',
  'go',
  'gql',
  'graphql',
  'h',
  'hpp',
  'htm',
  'html',
  'ini',
  'java',
  'js',
  'json',
  'jsonl',
  'jsx',
  'kt',
  'kts',
  'less',
  'log',
  'mjs',
  'md',
  'mdx',
  'php',
  'ps1',
  'py',
  'rb',
  'rs',
  'sass',
  'scss',
  'sh',
  'sql',
  'svelte',
  'toml',
  'ts',
  'tsv',
  'tsx',
  'txt',
  'vue',
  'xml',
  'yaml',
  'yml',
  'zsh',
]);

const TEXT_FILE_BASENAMES = new Set([
  '.env',
  '.gitignore',
  '.npmrc',
  'dockerfile',
  'makefile',
  'readme',
]);

const BINARY_FILE_SUFFIXES = new Set([
  '7z',
  'avi',
  'bmp',
  'doc',
  'docx',
  'gif',
  'gz',
  'heic',
  'ico',
  'jpeg',
  'jpg',
  'mov',
  'mp3',
  'mp4',
  'pages',
  'pdf',
  'png',
  'ppt',
  'pptx',
  'rar',
  'tar',
  'webm',
  'webp',
  'xls',
  'xlsx',
  'zip',
]);
