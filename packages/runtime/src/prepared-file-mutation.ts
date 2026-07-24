import type { PreparedFileMutationFact } from './tool-recovery-facts.js';

export type CurrentFileCheckpointState =
  | {
      kind: 'missing';
      recoverableBeforeBackupSha256?: string;
      recoverableBeforeBackupMode?: number;
    }
  | { kind: 'file'; sha256: string; mode?: number };

export type PreparedFileMutationDisposition =
  | { disposition: 'finalize'; reasonCode: 'prepared_after_matches' }
  | { disposition: 'redo'; reasonCode: 'prepared_before_matches' }
  | {
      disposition: 'park';
      reasonCode: 'prepared_file_drifted' | 'prepared_file_mode_drifted';
    };

export function decidePreparedFileMutation(
  fact: PreparedFileMutationFact,
  current: CurrentFileCheckpointState,
): PreparedFileMutationDisposition {
  if (current.kind === 'file' && current.sha256 === fact.expectedAfter.sha256) {
    if (current.mode !== undefined && current.mode !== fact.expectedAfter.mode) {
      return { disposition: 'park', reasonCode: 'prepared_file_mode_drifted' };
    }
    return { disposition: 'finalize', reasonCode: 'prepared_after_matches' };
  }
  if (
    current.kind === 'missing' &&
    fact.before.kind === 'file' &&
    current.recoverableBeforeBackupSha256 === fact.before.sha256 &&
    (current.recoverableBeforeBackupMode === undefined ||
      current.recoverableBeforeBackupMode === fact.before.mode)
  ) {
    return { disposition: 'redo', reasonCode: 'prepared_before_matches' };
  }
  if (
    (current.kind === 'missing' && fact.before.kind === 'missing') ||
    (current.kind === 'file' &&
      fact.before.kind === 'file' &&
      current.sha256 === fact.before.sha256 &&
      (current.mode === undefined || current.mode === fact.before.mode))
  ) {
    return { disposition: 'redo', reasonCode: 'prepared_before_matches' };
  }
  if (
    current.kind === 'file' &&
    fact.before.kind === 'file' &&
    current.sha256 === fact.before.sha256 &&
    current.mode !== undefined
  ) {
    return { disposition: 'park', reasonCode: 'prepared_file_mode_drifted' };
  }
  return { disposition: 'park', reasonCode: 'prepared_file_drifted' };
}
