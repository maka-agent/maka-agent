export * from './session-store.js';
export * from './agent-run-store.js';
export * from './shell-run-store.js';
export * from './connection-store.js';
// Narrow public surface: only the typed store + the one-time migration. The
// file lock and atomic writer stay internal so callers can't bypass the
// CredentialStore contract and drive the low-level lock directly.
export {
  CREDENTIAL_SCHEMA_VERSION,
  createFileCredentialStore,
  migrateLegacyCredentialFile,
} from './credential-store.js';
export type {
  CredentialCasResult,
  CredentialKind,
  CredentialStore,
  LegacyCredentialDecryptor,
} from './credential-store.js';
export * from './settings-store.js';
export * from './telemetry-repo.js';
export * from './artifact-store.js';
export * from './artifact-attachments.js';
export * from './plan-reminder-store.js';
export * from './task-ledger-store.js';
export * from './foreign-session-store.js';
export * from './agent-mailbox-store.js';
export * from './config-transfer.js';
export * from './automation-store.js';
export * from './mcp-config-store.js';
