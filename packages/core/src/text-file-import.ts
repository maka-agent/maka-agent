export const MAX_IMPORTED_TEXT_FILE_BYTES = 200_000;
export const MAX_IMPORTED_TEXT_FILE_CHARS = 20_000;
export const MAX_IMPORTED_TEXT_FILE_COUNT = 5;
export const MAX_IMPORTED_TEXT_FILES_CHARS = 40_000;
export const MAX_IMPORTED_FOLDER_ENTRIES = 200;
export const MAX_IMPORTED_FOLDER_COUNT = 3;
export const MAX_IMPORTED_FOLDERS_ENTRIES = 300;
export const MAX_IMPORTED_FOLDER_DEPTH = 4;

export type TextFileImportPreflightFailureReason =
  | 'missing'
  | 'too-large'
  | 'too-many-files';

export type TextFileImportPreflightResult =
  | { ok: true }
  | { ok: false; reason: TextFileImportPreflightFailureReason };

export interface DroppedTextFilePreflightInput {
  size: number;
}

export function preflightDroppedTextFilesForPromptImport(files: readonly DroppedTextFilePreflightInput[]): TextFileImportPreflightResult {
  if (files.length === 0) return { ok: false, reason: 'missing' };
  if (files.length > MAX_IMPORTED_TEXT_FILE_COUNT) return { ok: false, reason: 'too-many-files' };

  for (const file of files) {
    const size = Number.isFinite(file.size) ? Math.max(0, Math.floor(file.size)) : 0;
    if (size > MAX_IMPORTED_TEXT_FILE_BYTES) return { ok: false, reason: 'too-large' };
  }

  return { ok: true };
}
