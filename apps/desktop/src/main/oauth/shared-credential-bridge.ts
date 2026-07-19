/**
 * OAuth token persistence for the desktop subscription services.
 *
 * The pure-Node `CredentialStore` (workspace `credentials.json`) is the
 * single authority for runtime-usable OAuth tokens (#1125): desktop,
 * TUI, and headless all read and write the same store, so a desktop
 * login is immediately usable from pure-Node surfaces and vice versa.
 * Electron `safeStorage` no longer stores tokens; it only decrypts
 * legacy per-service token files once via
 * `importLegacyOAuthTokenFiles`, after which those files are removed.
 *
 * Read/write failures are the caller's to surface (`storage_failed`),
 * so unlike the historical best-effort export, these helpers do not
 * swallow store errors.
 */

import { promises as fs } from 'node:fs';
import {
  parseOAuthSubscriptionTokens,
  serializeOAuthSubscriptionTokens,
  type OAuthSubscriptionTokens,
} from '@maka/runtime';
import type { CredentialStore } from '@maka/storage';

export type SharedOAuthCredentialStore = Pick<
  CredentialStore,
  'getSecret' | 'setSecret' | 'deleteSecret' | 'compareAndSetSecret'
>;

export type SharedOAuthTokensReadResult =
  | { status: 'ok'; tokens: OAuthSubscriptionTokens }
  | { status: 'missing' }
  /** Entry exists but is not a valid token payload. The entry is kept
   *  as-is: reads never destroy a secret (it may be readable by a
   *  newer schema or repairable by hand), and a fresh login simply
   *  overwrites it — there is no stuck state a delete would unstick. */
  | { status: 'corrupt' };

/** Persist tokens as the authoritative copy. Throws on store failure. */
export async function saveSharedOAuthTokens(
  store: Pick<CredentialStore, 'setSecret'>,
  slug: string,
  tokens: OAuthSubscriptionTokens,
): Promise<void> {
  await store.setSecret(slug, 'oauth_token', serializeOAuthSubscriptionTokens(tokens));
}

/**
 * Load the authoritative tokens. Store read errors (corrupt file,
 * schema mismatch, stale lock) propagate to the caller; an entry that
 * exists but does not parse as a token payload is reported as
 * `corrupt` and left untouched.
 */
export async function loadSharedOAuthTokens(
  store: SharedOAuthCredentialStore,
  slug: string,
): Promise<SharedOAuthTokensReadResult> {
  const raw = await store.getSecret(slug, 'oauth_token');
  if (raw === null) return { status: 'missing' };
  const tokens = parseOAuthSubscriptionTokens(raw);
  if (!tokens) return { status: 'corrupt' };
  return { status: 'ok', tokens };
}

/** Delete the authoritative tokens. Throws on store failure. */
export async function deleteSharedOAuthTokens(
  store: Pick<CredentialStore, 'deleteSecret'>,
  slug: string,
): Promise<void> {
  await store.deleteSecret(slug, 'oauth_token');
}

// =============================================================
// One-shot import of legacy safeStorage-encrypted token files.
// =============================================================

/**
 * Shape-compatible with Electron's `safeStorage` so main.ts can pass it
 * straight through; injected so this module never imports `electron`
 * and the import stays testable in pure Node.
 */
export interface LegacySafeStorageDecryptor {
  isEncryptionAvailable(): boolean;
  decryptString(encrypted: Buffer): string;
}

export interface LegacyOAuthTokenFile {
  slug: string;
  filePath: string;
}

export type LegacyOAuthTokenImportOutcome =
  /** Decrypted and written to the store; file removed. */
  | 'imported'
  /** The store already held a PARSEABLE token for the slug (it is at
   *  least as fresh — every legacy write dual-wrote the store, and
   *  pure-Node refreshes write only the store); file removed as a
   *  stale duplicate. An unparseable store entry does not supersede:
   *  a valid legacy token must win over stored garbage. */
  | 'superseded'
  /** Decryption unavailable or denied; file left intact for a later
   *  start (never destroy a possibly recoverable secret). */
  | 'left-encrypted'
  /** Decrypted fine but the payload is not a token this build can
   *  parse; file kept — only an explicit logout destroys it. */
  | 'left-unparseable'
  /** Unexpected I/O or store error; file left intact. */
  | 'failed';

export interface LegacyOAuthTokenImportReport {
  slug: string;
  filePath: string;
  outcome: LegacyOAuthTokenImportOutcome;
  error?: unknown;
}

/**
 * Import legacy safeStorage-encrypted token files into the shared
 * store, once per file. Idempotent: a missing file is a no-op. The
 * The file is removed after a successful import, when superseded by a
 * parseable store token, or when a concurrent logout wins the serialized
 * check. Every other outcome keeps the file for a later start (or manual
 * recovery), because the import must never destroy the last copy without
 * an authoritative replacement or deletion. Never throws — desktop startup
 * treats migration as best-effort; returns a report per file that existed.
 * The startup owner completes this one-shot phase before exposing interactive
 * OAuth mutations; CAS protects it from independent shared-store writers.
 */
export async function importLegacyOAuthTokenFiles(input: {
  credentialStore: Pick<CredentialStore, 'getSecret' | 'setSecret' | 'compareAndSetSecret'>;
  decryptor: LegacySafeStorageDecryptor;
  files: LegacyOAuthTokenFile[];
}): Promise<LegacyOAuthTokenImportReport[]> {
  const reports: LegacyOAuthTokenImportReport[] = [];
  for (const { slug, filePath } of input.files) {
    const report = (outcome: LegacyOAuthTokenImportOutcome, error?: unknown): void => {
      reports.push({ slug, filePath, outcome, ...(error === undefined ? {} : { error }) });
    };
    let encrypted: Buffer;
    try {
      encrypted = await fs.readFile(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') report('failed', error);
      continue;
    }
    try {
      let existing = await input.credentialStore.getSecret(slug, 'oauth_token');
      if (existing !== null && parseOAuthSubscriptionTokens(existing)) {
        if (!input.credentialStore.compareAndSetSecret) {
          await fs.unlink(filePath);
          report('superseded');
          continue;
        }
        // A same-value CAS turns the pre-lock "already imported" snapshot into
        // a serialized decision before the legacy file may be removed.
        const checked = await input.credentialStore.compareAndSetSecret(
          slug,
          'oauth_token',
          existing,
          existing,
        );
        if (checked.committed || (checked.current !== null && parseOAuthSubscriptionTokens(checked.current))) {
          await fs.unlink(filePath);
          report('superseded');
          continue;
        }
        if (checked.current === null) {
          // Logout removes the legacy file before deleting the shared token.
          // Once that deletion wins the serialized check, the buffered legacy
          // value must not become a new basis and resurrect the credential.
          await fs.rm(filePath, { force: true });
          report('superseded');
          continue;
        }
        report('failed', new Error('OAuth credential changed during legacy import.'));
        continue;
      }
      if (!input.decryptor.isEncryptionAvailable()) {
        report('left-encrypted');
        continue;
      }
      let decoded: string;
      try {
        decoded = input.decryptor.decryptString(encrypted);
      } catch (error) {
        // Keychain denied / rolled: possibly recoverable on a later
        // start, so keep the file.
        report('left-encrypted', error);
        continue;
      }
      const tokens = parseOAuthSubscriptionTokens(decoded);
      if (!tokens) {
        report('left-unparseable');
        continue;
      }
      const serialized = serializeOAuthSubscriptionTokens(tokens);
      if (input.credentialStore.compareAndSetSecret) {
        const committed = await input.credentialStore.compareAndSetSecret(
          slug,
          'oauth_token',
          existing,
          serialized,
        );
        if (!committed.committed) {
          if (committed.current !== null && parseOAuthSubscriptionTokens(committed.current)) {
            await fs.unlink(filePath);
            report('superseded');
          } else {
            report('failed', new Error('OAuth credential changed during legacy import.'));
          }
          continue;
        }
      } else {
        await input.credentialStore.setSecret(slug, 'oauth_token', serialized);
      }
      await fs.unlink(filePath);
      report('imported');
    } catch (error) {
      report('failed', error);
    }
  }
  return reports;
}
