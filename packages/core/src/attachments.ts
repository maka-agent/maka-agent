import type { AttachmentRef } from './events.js';

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
