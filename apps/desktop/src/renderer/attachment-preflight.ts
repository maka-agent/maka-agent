import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_COUNT } from '@maka/core';

type PreflightItem = {
  size: number;
  source: { type: 'approval'; approvalId: string } | { type: 'file'; file: { size: number } };
};

/**
 * Reject count/size/duplicate-token violations before a new-chat session is
 * created, so an encode/resolve-time failure does not leave an empty session
 * behind. This is a renderer-side UX guard mirroring main-side
 * resolveIngestItems pre-validation; main remains the authoritative cap.
 *
 * File blobs are sized by the browser File object; approval-token attachments
 * are sized by the pending size stamped at pick time (main re-stats).
 */
export function preflightAttachmentItems(items: readonly PreflightItem[]): void {
  if (items.length > MAX_ATTACHMENT_COUNT) throw new Error('附件数量超过 8 个');
  const seen = new Set<string>();
  for (const item of items) {
    const bytes = item.source.type === 'file' ? item.source.file.size : item.size;
    if (bytes > MAX_ATTACHMENT_BYTES) throw new Error('附件大小超过 50MB');
    if (item.source.type === 'approval') {
      if (seen.has(item.source.approvalId)) throw new Error('附件来源重复，请勿重复添加同一文件。');
      seen.add(item.source.approvalId);
    }
  }
}