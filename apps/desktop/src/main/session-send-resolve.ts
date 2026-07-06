import { randomUUID } from 'node:crypto';
import type { AttachmentRef, SessionHeader } from '@maka/core';
import type { ArtifactStore } from '@maka/storage';
import { ingestAttachments, resolveIngestItems } from './attachment-ingest.js';
import type { AttachmentApprovalRegistry } from './attachment-approval.js';

export interface SendCommandWithItems {
  type: 'send';
  turnId?: string;
  text: string;
  attachmentItems?: unknown;
}

/**
 * Run the send readiness check, then resolve + ingest attachment items, in
 * that order. Readiness failure throws before any token is consumed or
 * artifact created, so the caller can retry with the same approvalId.
 */
export async function resolveSessionSend(input: {
  sessionId: string;
  senderId: number;
  command: SendCommandWithItems;
  ensureCanSend: (sessionId: string) => Promise<void>;
  readHeader: (sessionId: string) => Promise<SessionHeader | null>;
  approvals: AttachmentApprovalRegistry;
  stat: (path: string) => Promise<{ size: number }>;
  artifactStore: ArtifactStore;
  resizeImage: (bytes: Uint8Array) => Promise<Uint8Array>;
}): Promise<{ turnId: string; attachments: AttachmentRef[] }> {
  await input.ensureCanSend(input.sessionId);
  let attachments: AttachmentRef[] = [];
  if (input.command.attachmentItems) {
    const header = await input.readHeader(input.sessionId);
    if (!header) throw new Error('无法读取会话工作目录。');
    const files = await resolveIngestItems({
      senderId: input.senderId,
      items: input.command.attachmentItems,
      approvals: input.approvals,
      stat: input.stat,
    });
    attachments = await ingestAttachments({
      files,
      cwd: header.cwd,
      sessionId: input.sessionId,
      artifactStore: input.artifactStore,
      resizeImage: input.resizeImage,
    });
  }
  return { turnId: input.command.turnId || randomUUID(), attachments };
}