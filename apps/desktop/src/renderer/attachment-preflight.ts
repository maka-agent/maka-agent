export const MAX_PREFLIGHT_FILE_BYTES = 50 * 1024 * 1024;

type PreflightItem = {
  source: { type: 'approval' } | { type: 'file'; file: { size: number } };
};

/**
 * Reject oversized File blobs before a new-chat session is created, so an
 * encode-time size failure does not leave an empty session behind. This is a
 * renderer-side UX guard; main-side resolveIngestItems is still the
 * authoritative size cap.
 */
export function preflightAttachmentItems(items: readonly PreflightItem[]): void {
  for (const item of items) {
    if (item.source.type === 'file' && item.source.file.size > MAX_PREFLIGHT_FILE_BYTES) {
      throw new Error('附件大小超过 50MB');
    }
  }
}