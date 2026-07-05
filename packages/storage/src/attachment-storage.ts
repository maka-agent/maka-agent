import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveArtifactPath, type ArtifactStore } from './artifact-store.js';
import type { ArtifactKind, StorageRef } from '@maka/core';

export interface IngestAttachmentInput {
  sessionId: string;
  turnId: string;
  name: string;
  mimeType: string;
  bytes: Uint8Array;
}

/** Map an attachment MIME type to the artifact kind used for storage. */
export function attachmentArtifactKindFromMime(mimeType: string): ArtifactKind {
  const lower = mimeType.toLowerCase();
  if (lower.startsWith('image/')) return 'image';
  if (lower === 'application/pdf') return 'pdf';
  return 'file';
}

/**
 * Persist attachment bytes into the session's ArtifactStore as a `user_upload`
 * artifact and return a `session_file` StorageRef that points at the stored
 * copy. External/temporary files are copied here so later reads see a stable
 * snapshot (not a path that can be swapped or deleted).
 */
export async function ingestAttachment(
  store: ArtifactStore,
  input: IngestAttachmentInput,
): Promise<StorageRef> {
  const record = await store.create({
    sessionId: input.sessionId,
    turnId: input.turnId,
    name: input.name,
    kind: attachmentArtifactKindFromMime(input.mimeType),
    content: input.bytes,
    mimeType: input.mimeType,
    source: 'user_upload',
  });
  return {
    kind: 'session_file',
    sessionId: input.sessionId,
    relativePath: record.relativePath,
  };
}

export type AttachmentReadFailureReason =
  | 'unsupported_ref_kind'
  | 'not_found'
  | 'not_allowed'
  | 'read_failed';

export type AttachmentReadResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: AttachmentReadFailureReason };

/**
 * Read attachment bytes back from a StorageRef. Only `session_file` refs are
 * supported — they resolve under the workspace artifact root via the same
 * path-safety check as ArtifactStore. `external_file` and `workspace_file`
 * are intentionally rejected here; callers that need workspace files use the
 * Read tool, and external files must be ingested (copied) before reading.
 */
export async function readAttachmentBytes(
  ref: StorageRef,
  workspaceRoot: string,
): Promise<AttachmentReadResult> {
  if (ref.kind !== 'session_file') return { ok: false, reason: 'unsupported_ref_kind' };
  const artifactRoot = join(workspaceRoot, 'artifacts');
  const resolved = await resolveArtifactPath({ artifactRoot, relativePath: ref.relativePath });
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  try {
    const buffer = await readFile(resolved.path);
    return { ok: true, bytes: new Uint8Array(buffer) };
  } catch {
    return { ok: false, reason: 'read_failed' };
  }
}
