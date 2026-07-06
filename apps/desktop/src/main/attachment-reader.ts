import type { ArtifactStore } from '@maka/storage';
import type { AttachmentByteReader } from '@maka/runtime';

const DEFAULT_ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024;

/**
 * Build the {@link AttachmentByteReader} injected into AiSdkBackend at
 * construction time. Only `session_file` refs (ArtifactStore snapshots)
 * are readable here:
 *  - workspace_file refs are read by the model via the Read tool (cwd-bound);
 *  - external_file refs are copied into ArtifactStore at attach time, so by
 *    the time the backend consumes them they are session_file refs.
 *
 * The session-id check stops one session from reading another session's
 * attachment snapshots, and the byte cap matches the attachment-approval
 * limit so a replaced/large snapshot cannot blow past the budget.
 */
export function createAttachmentByteReader(input: {
  artifactStore: ArtifactStore;
  sessionId: string;
  maxBytes?: number;
}): AttachmentByteReader {
  const maxBytes = input.maxBytes ?? DEFAULT_ATTACHMENT_MAX_BYTES;
  return async (ref) => {
    if (ref.kind !== 'session_file') return { ok: false, reason: 'unsupported_ref_kind' };
    if (ref.sessionId !== input.sessionId) return { ok: false, reason: 'session_mismatch' };
    const result = await input.artifactStore.readBinary(ref.relativePath, { maxBytes });
    if (!result.ok) return { ok: false, reason: result.reason };
    return { ok: true, bytes: Buffer.from(result.base64, 'base64') };
  };
}
