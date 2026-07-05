import { readFile } from 'node:fs/promises';
import { basename, relative, sep } from 'node:path';
import { attachmentKindFromMimeType, guessMimeFromName } from '@maka/core';
import type { ArtifactKind, ArtifactSource, AttachmentRef } from '@maka/core';
import type { ArtifactStore } from '@maka/storage';

export type AttachmentIngestFile =
  | { path: string; mimeType?: string; size: number }
  | { name: string; mimeType?: string; size: number; content: Uint8Array };

/**
 * Resolve a selected/dropped file into an {@link AttachmentRef} the runtime
 * can consume:
 *  - image (anywhere): resize → ArtifactStore snapshot → session_file ref.
 *    Images must become provider image parts, so they are always snapshotted
 *    (an external image path could vanish or be swapped before the turn runs).
 *  - non-image inside the workspace: workspace_file ref, no copy. The model
 *    reads it on demand via the Read tool, which is already cwd-bound.
 *  - non-image outside the workspace: ArtifactStore snapshot → session_file
 *    ref. Snapshots the bytes at attach time so a symlink swap (TOCTOU) or a
 *    deleted temp file cannot change what the model later reads.
 *
 * `resizeImage` is injected because it depends on Electron's nativeImage;
 * tests pass a fake. `turnId` is not known at attach time, so the snapshot is
 * filed under the sessionId.
 */
export async function ingestAttachments(input: {
  files: AttachmentIngestFile[];
  cwd: string;
  sessionId: string;
  artifactStore: ArtifactStore;
  resizeImage?: (bytes: Uint8Array) => Promise<Uint8Array>;
  now?: () => number;
}): Promise<AttachmentRef[]> {
  const refs: AttachmentRef[] = [];
  for (const file of input.files) {
    const name = attachmentFileName(file);
    const mimeType = file.mimeType && file.mimeType.length > 0 ? file.mimeType : guessMimeFromName(name);
    const kind = attachmentKindFromMimeType(mimeType, name);

    if (kind !== 'image' && isPathAttachment(file) && isInsideCwd(input.cwd, file.path)) {
      refs.push({
        kind,
        name,
        mimeType,
        bytes: file.size,
        ref: { kind: 'workspace_file', relativePath: relative(input.cwd, file.path) },
      });
      continue;
    }

    let bytes: Uint8Array = isPathAttachment(file) ? await readFile(file.path) : file.content;
    if (kind === 'image' && input.resizeImage) {
      bytes = await input.resizeImage(bytes);
    }
    const artifactKind: ArtifactKind = kind === 'image' ? 'image' : kind === 'pdf' ? 'pdf' : 'file';
    const source: ArtifactSource = 'user_upload';
    const record = await input.artifactStore.create({
      sessionId: input.sessionId,
      turnId: input.sessionId,
      name,
      kind: artifactKind,
      content: bytes,
      mimeType,
      source,
      ...(input.now ? { now: input.now() } : {}),
    });
    refs.push({
      kind,
      name,
      mimeType,
      bytes: bytes.byteLength,
      ref: { kind: 'session_file', sessionId: input.sessionId, relativePath: record.id },
    });
  }
  return refs;
}

function isPathAttachment(file: AttachmentIngestFile): file is Extract<AttachmentIngestFile, { path: string }> {
  return 'path' in file;
}

function attachmentFileName(file: AttachmentIngestFile): string {
  if (isPathAttachment(file)) return basename(file.path);
  const normalized = file.name.replace(/\\/g, '/');
  const name = basename(normalized).trim();
  return name || 'attachment';
}

function isInsideCwd(cwd: string, target: string): boolean {
  if (target === cwd) return true;
  const rel = relative(cwd, target);
  return rel !== '' && !rel.startsWith('..') && rel !== '..' && !rel.includes(`..${sep}`) && !rel.startsWith(sep);
}
