import type { AttachmentRef } from './events.js';

/** Per-send cap on attachment count, shared by renderer preflight and main resolve. */
export const MAX_ATTACHMENT_COUNT = 8;

/** Per-file byte cap, shared by renderer preflight, preload encode, and main resolve. */
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;


const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  doc: 'application/msword',
  xls: 'application/vnd.ms-excel',
  ppt: 'application/vnd.ms-powerpoint',
};

/**
 * Best-effort MIME from a file name, used when the picker gives no MIME
 * (Electron's openDialog only returns paths). Falls back to
 * `application/octet-stream` so downstream validation always sees a MIME.
 */
export function guessMimeFromName(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  if (dot < 0 || dot === fileName.length - 1) return 'application/octet-stream';
  const ext = fileName.slice(dot + 1).toLowerCase();
  return MIME_BY_EXTENSION[ext] ?? 'application/octet-stream';
}

/**
 * Route a MIME type to an {@link AttachmentRef} kind. The runtime
 * consumption split is image vs. everything-else (images become provider
 * image parts; other kinds are read on demand by the model via Read /
 * OfficeDocument), so this only needs to single out the kinds that change
 * consumption or display. Unknown / unmapped MIME falls back to `other`.
 *
 * `fileName` is consulted for kinds whose MIME is unreliable across OSes
 * (Office documents arrive as `application/octet-stream` or a long
 * `vnd.openxmlformats` string depending on the source); MIME still wins
 * when it is present and specific.
 */
export function attachmentKindFromMimeType(mimeType: string, fileName?: string): AttachmentRef['kind'] {
  const mime = mimeType.toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime === 'application/pdf') return 'pdf';
  if (fileName) {
    const lowerName = fileName.toLowerCase();
    if (
      lowerName.endsWith('.docx') ||
      lowerName.endsWith('.doc') ||
      lowerName.endsWith('.xlsx') ||
      lowerName.endsWith('.xls') ||
      lowerName.endsWith('.pptx') ||
      lowerName.endsWith('.ppt')
    ) {
      return 'doc';
    }
  }
  return 'other';
}
