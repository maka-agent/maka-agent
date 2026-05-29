import { resolve, isAbsolute } from 'node:path';
import type { AttachmentRef, StorageRef } from '@maka/core';

export const ATTACHMENT_APPROVAL_TTL_MS = 30 * 60 * 1000;
export const MAX_APPROVED_ATTACHMENT_PATHS = 1000;
const MAX_RENDERER_ATTACHMENTS = 8;
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

const ATTACHMENT_KINDS = new Set<AttachmentRef['kind']>(['image', 'pdf', 'doc', 'code', 'other']);

export type AttachmentValidationFailureReason =
  | 'invalid_attachment'
  | 'too_many_attachments'
  | 'unapproved_external_path';

export interface AttachmentApprovalRegistry {
  approvePaths(senderId: number, paths: readonly string[] | string | null | undefined): void;
  isApproved(senderId: number, path: string): boolean;
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
  const approvals = new Map<string, number>();

  function key(senderId: number, path: string): string {
    return `${senderId}:${path}`;
  }

  function prune(current = now()): void {
    for (const [approvalKey, approvedAt] of approvals) {
      if (current - approvedAt > ttlMs) approvals.delete(approvalKey);
    }
    while (approvals.size > maxEntries) {
      const oldest = approvals.keys().next().value;
      if (!oldest) break;
      approvals.delete(oldest);
    }
  }

  return {
    approvePaths(senderId, paths) {
      const current = now();
      prune(current);
      const list = Array.isArray(paths) ? paths : paths ? [paths] : [];
      for (const path of list) {
        const normalized = normalizeExternalAttachmentPath(path);
        if (!normalized) continue;
        const approvalKey = key(senderId, normalized);
        approvals.delete(approvalKey);
        approvals.set(approvalKey, current);
      }
      prune(current);
    },
    isApproved(senderId, path) {
      const normalized = normalizeExternalAttachmentPath(path);
      if (!normalized) return false;
      prune(now());
      return approvals.has(key(senderId, normalized));
    },
    clearSender(senderId) {
      const prefix = `${senderId}:`;
      for (const approvalKey of approvals.keys()) {
        if (approvalKey.startsWith(prefix)) approvals.delete(approvalKey);
      }
    },
    prune,
    size() {
      prune(now());
      return approvals.size;
    },
  };
}

export function validateRendererAttachments(
  attachments: unknown,
  input: {
    senderId: number;
    approvals: AttachmentApprovalRegistry;
  },
): { ok: true; attachments?: AttachmentRef[] } | { ok: false; reason: AttachmentValidationFailureReason } {
  if (attachments === undefined) return { ok: true };
  if (!Array.isArray(attachments)) return { ok: false, reason: 'invalid_attachment' };
  if (attachments.length > MAX_RENDERER_ATTACHMENTS) return { ok: false, reason: 'too_many_attachments' };

  const out: AttachmentRef[] = [];
  for (const item of attachments) {
    const attachment = normalizeAttachmentRef(item, input);
    if (!attachment.ok) return attachment;
    out.push(attachment.attachment);
  }
  return { ok: true, attachments: out.length > 0 ? out : undefined };
}

function normalizeAttachmentRef(
  value: unknown,
  input: {
    senderId: number;
    approvals: AttachmentApprovalRegistry;
  },
): { ok: true; attachment: AttachmentRef } | { ok: false; reason: AttachmentValidationFailureReason } {
  if (!value || typeof value !== 'object') return { ok: false, reason: 'invalid_attachment' };
  const record = value as Record<string, unknown>;
  if (!ATTACHMENT_KINDS.has(record.kind as AttachmentRef['kind'])) return { ok: false, reason: 'invalid_attachment' };
  const name = normalizeBoundedText(record.name, 160);
  const mimeType = normalizeBoundedText(record.mimeType, 128);
  const bytes = normalizeAttachmentBytes(record.bytes);
  const ref = normalizeStorageRef(record.ref, input);
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
  input: {
    senderId: number;
    approvals: AttachmentApprovalRegistry;
  },
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
  if (record.kind === 'external_file') {
    const absolutePath = normalizeExternalAttachmentPath(record.absolutePath);
    if (!absolutePath) return { ok: false, reason: 'invalid_attachment' };
    if (!input.approvals.isApproved(input.senderId, absolutePath)) {
      return { ok: false, reason: 'unapproved_external_path' };
    }
    return { ok: true, ref: { kind: 'external_file', absolutePath } };
  }
  return { ok: false, reason: 'invalid_attachment' };
}

export function normalizeExternalAttachmentPath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes('\0')) return null;
  return resolve(trimmed);
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
