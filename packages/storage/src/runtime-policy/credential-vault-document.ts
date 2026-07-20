import { randomUUID } from 'node:crypto';
import {
  type CredentialLocator,
  type CredentialMutationResult,
  type CredentialStatus,
  type CredentialVaultSnapshot,
  type CredentialVersionBasis,
  type DeleteCredentialInput,
  type SetCredentialInput,
} from '@maka/core/runtime-policy';
import { WEB_SEARCH_PROVIDERS } from '@maka/core';
import {
  deepFreeze,
  entityId,
  integer,
  nextRevision,
  positiveRevision,
  record,
  revision,
  string,
  unique,
} from './codec.js';
import { codecError, type CodecSource } from './errors.js';
import {
  readBoundedJsonDocument,
  VAULT_DOCUMENT_MAX_BYTES,
  writeJsonDocument,
} from './document-io.js';
import type { RuntimePolicyCredentialMaterial } from './operations.js';

const FILE = 'credential-vault.json';
const SCHEMA_VERSION = 1 as const;
const MAX_SECRET_LENGTH = 64 * 1024;
const MAX_VAULT_ENTRIES = 2_048;

export interface CredentialVaultEntry extends CredentialVersionBasis {
  readonly secret: string;
  readonly updatedAt: number;
}

export interface CredentialVaultDocument {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly revision: number;
  readonly entries: readonly CredentialVaultEntry[];
}

export class CredentialVaultDocumentOwner {
  async read(root: string): Promise<CredentialVaultDocument> {
    const value = await readBoundedJsonDocument(root, FILE, VAULT_DOCUMENT_MAX_BYTES);
    if (value === undefined) return { schemaVersion: SCHEMA_VERSION, revision: 0, entries: [] };
    const raw = record(value, FILE, 'invalid_document', ['schemaVersion', 'revision', 'entries']);
    if (raw.schemaVersion !== SCHEMA_VERSION) {
      throw codecError('invalid_document', `${FILE} has an unsupported schema version`);
    }
    if (!Array.isArray(raw.entries) || raw.entries.length > MAX_VAULT_ENTRIES) {
      throw codecError('invalid_document', `${FILE}.entries must be a bounded array`);
    }
    const entries = raw.entries.map((item, index) =>
      parseEntry(item, `${FILE}.entries[${index}]`, 'invalid_document'),
    );
    unique(
      entries.map((entry) => locatorKey(entry.locator)),
      `${FILE} locators`,
      'invalid_document',
    );
    unique(
      entries.map((entry) => entry.credentialId),
      `${FILE} credential ids`,
      'invalid_document',
    );
    return {
      schemaVersion: SCHEMA_VERSION,
      revision: revision(raw.revision, `${FILE}.revision`, 'invalid_document'),
      entries,
    };
  }

  async set(root: string, rawInput: SetCredentialInput): Promise<CredentialMutationResult> {
    const input = parseSetInput(rawInput);
    const current = await this.read(root);
    const index = findCredentialIndex(current, input.locator);
    const previous = index < 0 ? undefined : current.entries[index];
    if (!matchesExpectation(previous, input.expected)) {
      return credentialStale(
        input.expected ? { locator: input.locator, ...input.expected } : null,
        previous ? credentialBasis(previous) : null,
      );
    }
    if (index < 0 && current.entries.length >= MAX_VAULT_ENTRIES) {
      throw codecError('invalid_credential_input', 'Credential vault entry limit has been reached');
    }
    const entry: CredentialVaultEntry = previous
      ? {
          ...previous,
          revision: nextRevision(previous.revision),
          secret: input.secret,
          updatedAt: Date.now(),
        }
      : {
          locator: input.locator,
          credentialId: randomUUID(),
          revision: 1,
          secret: input.secret,
          updatedAt: Date.now(),
        };
    const entries = [...current.entries];
    if (index < 0) entries.push(entry);
    else entries[index] = entry;
    const next = {
      schemaVersion: SCHEMA_VERSION,
      revision: nextRevision(current.revision),
      entries,
    };
    await this.write(root, next);
    return committed(next);
  }

  async delete(root: string, rawInput: DeleteCredentialInput): Promise<CredentialMutationResult> {
    const input = parseDeleteInput(rawInput);
    const current = await this.read(root);
    const index = findCredentialIndex(current, input.expected.locator);
    const previous = index < 0 ? undefined : current.entries[index];
    if (!sameCredentialBasis(previous, input.expected)) {
      return credentialStale(input.expected, previous ? credentialBasis(previous) : null);
    }
    const next = {
      schemaVersion: SCHEMA_VERSION,
      revision: nextRevision(current.revision),
      entries: current.entries.filter((_entry, candidate) => candidate !== index),
    };
    await this.write(root, next);
    return committed(next);
  }

  async deleteConnectionCredentials(
    root: string,
    current: CredentialVaultDocument,
    connectionId: string,
  ): Promise<CredentialVaultSnapshot> {
    const entries = current.entries.filter(
      (entry) =>
        entry.locator.scope !== 'connection' || entry.locator.connectionId !== connectionId,
    );
    if (entries.length === current.entries.length) return vaultSnapshot(current);
    const next = {
      schemaVersion: SCHEMA_VERSION,
      revision: nextRevision(current.revision),
      entries,
    };
    await this.write(root, next);
    return vaultSnapshot(next);
  }

  async writeRefresh(
    root: string,
    current: CredentialVaultDocument,
    expected: CredentialVersionBasis,
    rawSecret: unknown,
  ): Promise<CredentialVaultSnapshot> {
    const secret = parseSecret(rawSecret, 'credential refresh secret');
    const index = findCredentialIndex(current, expected.locator);
    const previous = current.entries[index];
    if (!sameCredentialBasis(previous, expected)) {
      throw codecError('invalid_document', 'Coordinator admitted a stale credential refresh');
    }
    const entries = [...current.entries];
    entries[index] = {
      ...previous,
      revision: nextRevision(previous.revision),
      secret,
      updatedAt: Date.now(),
    };
    const next = {
      schemaVersion: SCHEMA_VERSION,
      revision: nextRevision(current.revision),
      entries,
    };
    await this.write(root, next);
    return vaultSnapshot(next);
  }

  private async write(root: string, document: CredentialVaultDocument): Promise<void> {
    await writeJsonDocument(root, FILE, document, VAULT_DOCUMENT_MAX_BYTES);
  }
}

export function vaultSnapshot(document: CredentialVaultDocument): CredentialVaultSnapshot {
  return deepFreeze({
    revision: document.revision,
    entries: document.entries.map((entry) => credentialStatusFromEntry(entry)),
  });
}

export function credentialStatus(
  document: CredentialVaultDocument,
  locator: CredentialLocator,
): CredentialStatus {
  const entry = findCredential(document, locator);
  return deepFreeze(
    entry
      ? credentialStatusFromEntry(entry)
      : {
          locator: structuredClone(locator),
          configured: false,
          credentialId: null,
          revision: null,
          updatedAt: null,
        },
  );
}

export function credentialMaterial(entry: CredentialVaultEntry): RuntimePolicyCredentialMaterial {
  return deepFreeze({ ...credentialBasis(entry), secret: entry.secret });
}

export function credentialBasis(entry: CredentialVaultEntry): CredentialVersionBasis {
  return {
    locator: structuredClone(entry.locator),
    credentialId: entry.credentialId,
    revision: entry.revision,
  };
}

export function findCredential(
  document: CredentialVaultDocument,
  locator: CredentialLocator,
): CredentialVaultEntry | undefined {
  return document.entries.find((entry) => sameLocator(entry.locator, locator));
}

export function sameCredentialBasis(
  actual: CredentialVaultEntry | undefined,
  expected: CredentialVersionBasis,
): boolean {
  return (
    actual !== undefined &&
    sameLocator(actual.locator, expected.locator) &&
    actual.credentialId === expected.credentialId &&
    actual.revision === expected.revision
  );
}

export function sameCredentialStatus(
  actual: CredentialStatus,
  expected: CredentialStatus,
): boolean {
  return (
    sameLocator(actual.locator, expected.locator) &&
    actual.configured === expected.configured &&
    actual.credentialId === expected.credentialId &&
    actual.revision === expected.revision
  );
}

export function parseCredentialLocator(
  value: unknown,
  context: string,
  source: CodecSource = 'invalid_credential_input',
): CredentialLocator {
  const base = record(
    value,
    context,
    source,
    ['scope', 'connectionId', 'provider', 'kind'],
    ['scope', 'kind'],
  );
  if (base.scope === 'connection') {
    const item = record(value, context, source, ['scope', 'connectionId', 'kind']);
    if (item.kind !== 'api_key' && item.kind !== 'oauth_token') {
      throw codecError(source, `${context}.kind is invalid`);
    }
    return {
      scope: 'connection',
      connectionId: entityId(item.connectionId, `${context}.connectionId`, source),
      kind: item.kind,
    };
  }
  if (base.scope === 'web_search') {
    const item = record(value, context, source, ['scope', 'provider', 'kind']);
    if (
      item.kind !== 'api_key' ||
      !(WEB_SEARCH_PROVIDERS as readonly unknown[]).includes(item.provider)
    ) {
      throw codecError(source, `${context} is not a valid web search credential locator`);
    }
    return {
      scope: 'web_search',
      provider: item.provider as Extract<CredentialLocator, { scope: 'web_search' }>['provider'],
      kind: 'api_key',
    };
  }
  if (base.scope === 'network_proxy') {
    const item = record(value, context, source, ['scope', 'kind']);
    if (item.kind !== 'password') throw codecError(source, `${context}.kind is invalid`);
    return { scope: 'network_proxy', kind: 'password' };
  }
  throw codecError(source, `${context}.scope is invalid`);
}

export function parseSecret(value: unknown, context: string): string {
  const parsed = string(value, context, MAX_SECRET_LENGTH, 'invalid_credential_input');
  if (parsed.length === 0)
    throw codecError('invalid_credential_input', `${context} must not be empty`);
  return parsed;
}

export function parseCredentialBasis(
  value: unknown,
  context: string,
  source: CodecSource = 'invalid_credential_input',
): CredentialVersionBasis {
  const item = record(value, context, source, ['locator', 'credentialId', 'revision']);
  return {
    locator: parseCredentialLocator(item.locator, `${context}.locator`, source),
    credentialId: entityId(item.credentialId, `${context}.credentialId`, source),
    revision: positiveRevision(item.revision, `${context}.revision`, source),
  };
}

function parseSetInput(value: unknown): SetCredentialInput {
  const input = record(value, 'set credential input', 'invalid_credential_input', [
    'locator',
    'expected',
    'secret',
  ]);
  const locator = parseCredentialLocator(input.locator, 'set credential locator');
  let expected: SetCredentialInput['expected'];
  if (input.expected === null) {
    expected = null;
  } else {
    const item = record(
      input.expected,
      'set credential expected basis',
      'invalid_credential_input',
      ['credentialId', 'revision'],
    );
    expected = {
      credentialId: entityId(
        item.credentialId,
        'set credential expected credentialId',
        'invalid_credential_input',
      ),
      revision: positiveRevision(
        item.revision,
        'set credential expected revision',
        'invalid_credential_input',
      ),
    };
  }
  return { locator, expected, secret: parseSecret(input.secret, 'set credential secret') };
}

function parseDeleteInput(value: unknown): DeleteCredentialInput {
  const input = record(value, 'delete credential input', 'invalid_credential_input', ['expected']);
  return { expected: parseCredentialBasis(input.expected, 'delete credential expected basis') };
}

function parseEntry(value: unknown, context: string, source: CodecSource): CredentialVaultEntry {
  const item = record(value, context, source, [
    'locator',
    'credentialId',
    'revision',
    'secret',
    'updatedAt',
  ]);
  const secret = string(item.secret, `${context}.secret`, MAX_SECRET_LENGTH, source);
  if (secret.length === 0) throw codecError(source, `${context}.secret must not be empty`);
  return {
    locator: parseCredentialLocator(item.locator, `${context}.locator`, source),
    credentialId: entityId(item.credentialId, `${context}.credentialId`, source),
    revision: positiveRevision(item.revision, `${context}.revision`, source),
    secret,
    updatedAt: integer(item.updatedAt, `${context}.updatedAt`, 0, Number.MAX_SAFE_INTEGER, source),
  };
}

function credentialStatusFromEntry(entry: CredentialVaultEntry): CredentialStatus {
  return {
    locator: structuredClone(entry.locator),
    configured: true,
    credentialId: entry.credentialId,
    revision: entry.revision,
    updatedAt: entry.updatedAt,
  };
}

function findCredentialIndex(
  document: CredentialVaultDocument,
  locator: CredentialLocator,
): number {
  return document.entries.findIndex((entry) => sameLocator(entry.locator, locator));
}

function sameLocator(left: CredentialLocator, right: CredentialLocator): boolean {
  if (left.scope !== right.scope || left.kind !== right.kind) return false;
  if (left.scope === 'connection' && right.scope === 'connection') {
    return left.connectionId === right.connectionId;
  }
  if (left.scope === 'web_search' && right.scope === 'web_search') {
    return left.provider === right.provider;
  }
  return left.scope === 'network_proxy' && right.scope === 'network_proxy';
}

function locatorKey(locator: CredentialLocator): string {
  switch (locator.scope) {
    case 'connection':
      return `connection:${locator.connectionId}:${locator.kind}`;
    case 'web_search':
      return `web_search:${locator.provider}:api_key`;
    case 'network_proxy':
      return 'network_proxy:password';
  }
}

function matchesExpectation(
  actual: CredentialVaultEntry | undefined,
  expected: SetCredentialInput['expected'],
): boolean {
  if (expected === null) return actual === undefined;
  return (
    actual !== undefined &&
    actual.credentialId === expected.credentialId &&
    actual.revision === expected.revision
  );
}

function credentialStale(
  expected: CredentialVersionBasis | null,
  actual: CredentialVersionBasis | null,
): CredentialMutationResult {
  return deepFreeze({ kind: 'credential_stale', expected, actual });
}

function committed(document: CredentialVaultDocument): CredentialMutationResult {
  return deepFreeze({ kind: 'committed', snapshot: vaultSnapshot(document) });
}
