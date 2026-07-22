import type { PreparedFileMutationFact } from './tool-recovery-facts.js';

export type CurrentFileCheckpointState =
  | { kind: 'missing' }
  | { kind: 'file'; sha256: string };

export type PreparedFileMutationDisposition =
  | { disposition: 'finalize'; reasonCode: 'prepared_after_matches' }
  | { disposition: 'redo'; reasonCode: 'prepared_before_matches' }
  | { disposition: 'park'; reasonCode: 'prepared_file_drifted' };

export function decidePreparedFileMutation(
  fact: PreparedFileMutationFact,
  current: CurrentFileCheckpointState,
): PreparedFileMutationDisposition {
  if (current.kind === 'file' && current.sha256 === fact.expectedAfter.sha256) {
    return { disposition: 'finalize', reasonCode: 'prepared_after_matches' };
  }
  if (
    (current.kind === 'missing' && fact.before.kind === 'missing') ||
    (current.kind === 'file' &&
      fact.before.kind === 'file' &&
      current.sha256 === fact.before.sha256)
  ) {
    return { disposition: 'redo', reasonCode: 'prepared_before_matches' };
  }
  return { disposition: 'park', reasonCode: 'prepared_file_drifted' };
}
