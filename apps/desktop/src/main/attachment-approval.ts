import { randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import type { AttachmentRef, StorageRef } from '@maka/core';

export const ATTACHMENT_APPROVAL_TTL_MS = 30 * 60 * 1000;
export const MAX_APPROVED_ATTACHMENT_PATHS = 1000;
export const MAX_RENDERER_ATTACHMENTS = 8;
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

const ATTACHMENT_KINDS = new Set<AttachmentRef['kind']>(['image', 'pdf', 'doc', 'code', 'other']);

export type AttachmentValidationFailureReason = 'invalid_attachment' | 'too_many_attachments';

/**
 * Token handed to the renderer in place of a local path. The path never leaves
 * the main process; only this opaque id does.
 */
export interface IssuedAttachmentApproval {
  approvalId: string;
  name: string;
  mimeType?: string;
  size: number;
}

/**
 * Path + metadata redeemed from a one-shot token, for main-internal use only.
 */
export interface ApprovedAttachmentPath {
  path: string;
  name: string;
  mimeType?: string;
  size: number;
}

interface ApprovalEntry extends ApprovedAttachmentPath {
  senderId: number;
  issuedAt: number;
}

export interface AttachmentApprovalRegistry {
  /**
   * Stamp each user-chosen path with a one-shot opaque token. The path stays
   * in main; the renderer only ever sees the token + display metadata.
   */
  issueApprovals(
    senderId: number,
    files: readonly { path: string; name: string; mimeType?: string; size: number }[],
  ): IssuedAttachmentApproval[];
  /**
   * Redeem a token for its bound path. Returns null if the token is unknown,
   * belongs to another sender, or has expired. Redemption is one-shot: a
   * second call with the same id returns null.
   */
  consumeApproval(senderId: number, approvalId: string): ApprovedAttachmentPath | null;
  clearSender(senderId: number): void;
  prune(now?: number): void;
  size(): number;
}

export function createAttachmentApprovalRegistry(input: {
  now?: () => number;
  ttlMs?: number;
  maxEntries?: number;
} = {}): AttachmentApprovalRegistry {
  const now = input.now ?? Date.now;
  const ttlMs = input.ttlMs ?? ATTACHMENT_APPROVAL_TTL_MS;
  const maxEntries = input.maxEntries ?? MAX_APPROVED_ATTACHMENT_PATHS;
  const approvals = new Map<string, ApprovalEntry>();

  function prune(current = now()): void {
    for (const [id, entry] of approvals) {
      if (current - entry.issuedAt > ttlMs) approvals.delete(id);
    }
    while (approvals.size > maxEntries) {
      const oldest = approvals.keys().next().value;
      if (!oldest) break;
      approvals.delete(oldest);
    }
  }

  return {
    issueApprovals(senderId, files) {
      const current = now();
      prune(current);
      return files.map((file) => {
        const id = randomUUID();
        approvals.set(id, {
          senderId,
          path: resolve(file.path),
          name: file.name,
          ...(file.mimeType ? { mimeType: file.mimeType } : {}),
          size: file.size,
          issuedAt: current,
        });
        return {
          approvalId: id,
          name: file.name,
          ...(file.mimeType ? { mimeType: file.mimeType } : {}),
          size: file.size,
        };
      });
    },
    consumeApproval(senderId, approvalId) {
      prune(now());
      const entry = approvals.get(approvalId);
      if (!entry || entry.senderId !== senderId) return null;
      approvals.delete(approvalId);
      return {
        path: entry.path,
        name: entry.name,
        ...(entry.mimeType ? { mimeType: entry.mimeType } : {}),
        size: entry.size,
      };
    },
    clearSender(senderId) {
      for (const [id, entry] of approvals) {
        if (entry.senderId === senderId) approvals.delete(id);
      }
    },
    prune,
    size() {
      prune(now());
      return approvals.size;
    },
  };
}

/**
 * Validate AttachmentRef arrays the renderer hands to `sessions:send`. Only
 * session_file / workspace_file refs survive: an absolute path must never
 * round-trip through the renderer, so external_file refs are rejected. Count
 * and per-attachment byte caps are enforced here as a defense-in-depth backstop
 * (primary enforcement is at ingest, before any file is read).
 */
export function validateRendererAttachments(
  attachments: unknown,
): { ok: true; attachments?: AttachmentRef[] } | { ok: false; reason: AttachmentValidationFailureReason } {
  if (attachments === undefined) return { ok: true };
  if (!Array.isArray(attachments)) return { ok: false, reason: 'invalid_attachment' };
  if (attachments.length > MAX_RENDERER_ATTACHMENTS) return { ok: false, reason: 'too_many_attachments' };

  const out: AttachmentRef[] = [];
  for (const item of attachments) {
    const attachment = normalizeAttachmentRef(item);
    if (!attachment.ok) return attachment;
    out.push(attachment.attachment);
  }
  return { ok: true, attachments: out.length > 0 ? out : undefined };
}

function normalizeAttachmentRef(
  value: unknown,
): { ok: true; attachment: AttachmentRef } | { ok: false; reason: AttachmentValidationFailureReason } {
  if (!value || typeof value !== 'object') return { ok: false, reason: 'invalid_attachment' };
  const record = value as Record<string, unknown>;
  if (!ATTACHMENT_KINDS.has(record.kind as AttachmentRef['kind'])) return { ok: false, reason: 'invalid_attachment' };
  const name = normalizeBoundedText(record.name, 160);
  const mimeType = normalizeBoundedText(record.mimeType, 128);
  const bytes = normalizeAttachmentBytes(record.bytes);
  const ref = normalizeStorageRef(record.ref);
  if (!name || !mimeType || bytes === null || !ref.ok) {
    return { ok: false, reason: ref.ok ? 'invalid_attachment' : ref.reason };
  }
  return {
    ok: true,
    attachment: {
      kind: record.kind as AttachmentRef['kind'],
      name,
      mimeType,
      bytes,
      ref: ref.ref,
    },
  };
}

function normalizeStorageRef(
  value: unknown,
): { ok: true; ref: StorageRef } | { ok: false; reason: AttachmentValidationFailureReason } {
  if (!value || typeof value !== 'object') return { ok: false, reason: 'invalid_attachment' };
  const record = value as Record<string, unknown>;
  if (record.kind === 'session_file' || record.kind === 'workspace_file') {
    const relativePath = typeof record.relativePath === 'string' ? record.relativePath : '';
    if (!isSafeRelativeAttachmentPath(relativePath)) return { ok: false, reason: 'invalid_attachment' };
    if (record.kind === 'session_file') {
      const sessionId = normalizeBoundedText(record.sessionId, 128);
      if (!sessionId) return { ok: false, reason: 'invalid_attachment' };
      return { ok: true, ref: { kind: 'session_file', sessionId, relativePath } };
    }
    return { ok: true, ref: { kind: 'workspace_file', relativePath } };
  }
  // external_file (renderer-supplied absolute path) is rejected here: paths
  // must never round-trip via the renderer. main-issued approvalId tokens are
  // the only way a path enters, and ingestion converts it to a session_file.
  return { ok: false, reason: 'invalid_attachment' };
}

function isSafeRelativeAttachmentPath(value: string): boolean {
  if (!value || isAbsolute(value)) return false;
  if (value.includes('\0')) return false;
  if (value.includes('//') || value.includes('\\\\')) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) return false;
  const parts = value.split(/[\\/]+/);
  return parts.every((part) => part !== '' && part !== '.' && part !== '..');
}

function normalizeBoundedText(value: unknown, limit: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > limit || trimmed.includes('\0')) return null;
  return trimmed;
}

function normalizeAttachmentBytes(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < 0 || value > MAX_ATTACHMENT_BYTES) return null;
  return Math.floor(value);
}
