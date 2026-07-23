export const SESSION_TRANSCRIPT_RECORD_TYPE = 'session_transcript';
export const SESSION_TRANSCRIPT_SCHEMA_VERSION = 1;

export interface SessionTranscriptMarker {
  type: typeof SESSION_TRANSCRIPT_RECORD_TYPE;
  sessionId: string;
  schemaVersion: typeof SESSION_TRANSCRIPT_SCHEMA_VERSION;
}

export function createSessionTranscriptMarker(sessionId: string): SessionTranscriptMarker {
  return {
    type: SESSION_TRANSCRIPT_RECORD_TYPE,
    sessionId,
    schemaVersion: SESSION_TRANSCRIPT_SCHEMA_VERSION,
  };
}

export function isSessionTranscriptMarker(value: unknown): value is SessionTranscriptMarker {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.type === SESSION_TRANSCRIPT_RECORD_TYPE;
}

export function decodeSessionTranscriptMarker(
  value: unknown,
  expectedSessionId: string,
): SessionTranscriptMarker {
  if (!isSessionTranscriptMarker(value)) {
    throw new Error(`Session ${expectedSessionId}: missing transcript marker`);
  }
  if (
    value.sessionId !== expectedSessionId ||
    value.schemaVersion !== SESSION_TRANSCRIPT_SCHEMA_VERSION
  ) {
    throw new Error(`Session ${expectedSessionId}: invalid transcript marker`);
  }
  return value;
}
