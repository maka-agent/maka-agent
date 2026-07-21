export type ArtifactKind = 'file' | 'diff' | 'html' | 'image' | 'pdf';

export type ArtifactSource =
  | 'tool_result'
  | 'tool_result_archive'
  | 'synthesis_cache_block'
  | 'history_compact_block'
  | 'history_compact_source'
  | 'provider_request_capture'
  | 'user_upload'
  | 'export'
  | 'snapshot'
  | 'fixture';

export type ArtifactStatus = 'live' | 'deleted';

export interface ArtifactRecord {
  id: string;
  sessionId: string;
  turnId: string;
  createdAt: number;
  name: string;
  kind: ArtifactKind;
  /**
   * Artifact-root-relative path. Never absolute and never exposed as a
   * filesystem path to renderer code.
   */
  relativePath: string;
  sizeBytes: number;
  mimeType?: string;
  source?: ArtifactSource;
  summary?: string;
  status: ArtifactStatus;
}

export type ArtifactChangedReason = 'created' | 'deleted' | 'purged';

export interface ArtifactChangedEvent {
  reason: ArtifactChangedReason;
  artifactId: string;
  sessionId: string;
  ts: number;
}

export type ArtifactReadFailureReason =
  | 'not_found'
  | 'too_large'
  | 'read_failed'
  | 'not_allowed'
  | 'deleted';

export type ArtifactBinaryReadFailureReason = ArtifactReadFailureReason | 'unsupported_mime';

export type ArtifactTextReadResult =
  | { ok: true; text: string }
  | { ok: false; reason: ArtifactReadFailureReason };

export type ArtifactBinaryReadResult =
  | { ok: true; base64: string; mimeType: string }
  | { ok: false; reason: ArtifactBinaryReadFailureReason };

export type ArtifactSaveFailureReason =
  | 'canceled'
  | 'not_found'
  | 'not_allowed'
  | 'deleted'
  | 'write_failed';

export type ArtifactSaveResult =
  | { ok: true; saved: string }
  | { ok: false; reason: ArtifactSaveFailureReason };
