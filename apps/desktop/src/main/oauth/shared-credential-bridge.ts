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

export type SharedOAuthCredentialStore = Pick<CredentialStore, 'getSecret' | 'setSecret' | 'deleteSecret'>;

/** @deprecated Transitional alias while services migrate to the store-authority API. */
export type SharedOAuthCredentialSaveStore = Pick<CredentialStore, 'setSecret'>;
/** @deprecated Transitional alias while services migrate to the store-authority API. */
export type SharedOAuthCredentialDeleteStore = Pick<CredentialStore, 'deleteSecret'>;

export type SharedOAuthTokensReadResult =
  | { status: 'ok'; tokens: OAuthSubscriptionTokens }
  | { status: 'missing' }
  /** Entry existed but was not a valid token payload; it has been deleted
   *  so the next login does not observe a stuck-corrupt state. */
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
 * exists but does not parse as a token payload is deleted (best-effort)
 * and reported as `corrupt`.
 */
export async function loadSharedOAuthTokens(
  store: SharedOAuthCredentialStore,
  slug: string,
): Promise<SharedOAuthTokensReadResult> {
  const raw = await store.getSecret(slug, 'oauth_token');
  if (raw === null) return { status: 'missing' };
  const tokens = parseOAuthSubscriptionTokens(raw);
  if (!tokens) {
    await store.deleteSecret(slug, 'oauth_token').catch(() => {});
    return { status: 'corrupt' };
  }
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
  /** The store already held a token for the slug (it is at least as
   *  fresh — every legacy write dual-wrote the store, and pure-Node
   *  refreshes write only the store); file removed as a stale duplicate. */
  | 'superseded'
  /** Decryption unavailable or denied; file left intact for a later
   *  start (never destroy a possibly recoverable secret). */
  | 'left-encrypted'
  /** Decrypted fine but the payload is not a token; file removed. */
  | 'removed-corrupt'
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
 * store, once per file. Idempotent: a missing file is a no-op, and
 * every terminal outcome except `left-encrypted`/`failed` removes the
 * file so no decryptable copy survives (tombstone, matching
 * `migrateLegacyCredentialFile`). Never throws — desktop startup treats
 * migration as best-effort; returns a report per file that existed.
 */
export async function importLegacyOAuthTokenFiles(input: {
  credentialStore: Pick<CredentialStore, 'getSecret' | 'setSecret'>;
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
      if (await input.credentialStore.getSecret(slug, 'oauth_token') !== null) {
        await fs.unlink(filePath);
        report('superseded');
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
        // start, so keep the file. Only a successful decrypt that
        // yields garbage proves the file is dead.
        report('left-encrypted', error);
        continue;
      }
      const tokens = parseOAuthSubscriptionTokens(decoded);
      if (!tokens) {
        await fs.unlink(filePath);
        report('removed-corrupt');
        continue;
      }
      await input.credentialStore.setSecret(slug, 'oauth_token', serializeOAuthSubscriptionTokens(tokens));
      await fs.unlink(filePath);
      report('imported');
    } catch (error) {
      report('failed', error);
    }
  }
  return reports;
}

// =============================================================
// Transitional best-effort export helpers — deleted once every
// service persists through the authoritative API above.
// =============================================================

export interface TrySaveSharedOAuthTokenInput {
  credentialStore?: SharedOAuthCredentialSaveStore;
  slug: string;
  value: string;
}

export interface TryDeleteSharedOAuthTokenInput {
  credentialStore?: SharedOAuthCredentialDeleteStore;
  slug: string;
}

export async function trySaveSharedOAuthToken(input: TrySaveSharedOAuthTokenInput): Promise<boolean> {
  try {
    await input.credentialStore?.setSecret(input.slug, 'oauth_token', input.value);
    return Boolean(input.credentialStore);
  } catch {
    return false;
  }
}

export async function tryDeleteSharedOAuthToken(input: TryDeleteSharedOAuthTokenInput): Promise<boolean> {
  if (!input.credentialStore) return true;
  try {
    await input.credentialStore.deleteSecret(input.slug, 'oauth_token');
    return true;
  } catch {
    return false;
  }
}
