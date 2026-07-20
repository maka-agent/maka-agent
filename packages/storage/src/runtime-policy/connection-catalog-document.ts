import { randomUUID } from 'node:crypto';
import {
  type ConnectionCatalogEntry,
  type ConnectionCatalogEntryDraft,
  type ConnectionCatalogEntryUpdate,
  type ConnectionCatalogMutationResult,
  type ConnectionCatalogSnapshot,
  type ConnectionModel,
  type ConnectionModelDiscoveryResult,
  type ConnectionTarget,
  type ConnectionTestSummary,
  type ConnectionVersionBasis,
  type CreateCatalogConnectionInput,
  type RemoveCatalogConnectionInput,
  type SetDefaultConnectionTargetInput,
  type UpdateCatalogConnectionInput,
} from '@maka/core/runtime-policy';
import { PROVIDER_DEFAULTS, validateSlug, type ProviderType } from '@maka/core/llm-connections';
import {
  boolean,
  deepFreeze,
  entityId,
  integer,
  nextRevision,
  nonEmptyString,
  optionalString,
  positiveRevision,
  record,
  revision,
  string,
  stringArray,
  unique,
} from './codec.js';
import { codecError, type CodecSource } from './errors.js';
import {
  CATALOG_DOCUMENT_MAX_BYTES,
  readBoundedJsonDocument,
  writeJsonDocument,
} from './document-io.js';

const FILE = 'connection-catalog.json';
const SCHEMA_VERSION = 1 as const;
const MAX_CONNECTIONS = 1_024;
const PROVIDER_TYPES = new Set<string>(Object.keys(PROVIDER_DEFAULTS));

export interface ConnectionCatalogDocument {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly revision: number;
  readonly defaultTarget: ConnectionTarget | null;
  readonly connections: readonly ConnectionCatalogEntry[];
}

export class ConnectionCatalogDocumentOwner {
  async read(root: string): Promise<ConnectionCatalogDocument> {
    const value = await readBoundedJsonDocument(root, FILE, CATALOG_DOCUMENT_MAX_BYTES);
    if (value === undefined) {
      return { schemaVersion: SCHEMA_VERSION, revision: 0, defaultTarget: null, connections: [] };
    }
    const raw = record(value, FILE, 'invalid_document', [
      'schemaVersion',
      'revision',
      'defaultTarget',
      'connections',
    ]);
    if (raw.schemaVersion !== SCHEMA_VERSION) {
      throw codecError('invalid_document', `${FILE} has an unsupported schema version`);
    }
    if (!Array.isArray(raw.connections) || raw.connections.length > MAX_CONNECTIONS) {
      throw codecError('invalid_document', `${FILE}.connections must be a bounded array`);
    }
    const connections = raw.connections.map((item, index) =>
      parseEntry(item, `${FILE}.connections[${index}]`, 'invalid_document'),
    );
    unique(
      connections.map((item) => item.slug),
      `${FILE} connection slugs`,
      'invalid_document',
    );
    unique(
      connections.map((item) => item.connectionId),
      `${FILE} connection ids`,
      'invalid_document',
    );
    const defaultTarget =
      raw.defaultTarget === null
        ? null
        : parseTarget(raw.defaultTarget, `${FILE}.defaultTarget`, 'invalid_document');
    if (defaultTarget && !isValidTarget(defaultTarget, connections)) {
      throw codecError('invalid_document', `${FILE} contains an invalid default target`);
    }
    return {
      schemaVersion: SCHEMA_VERSION,
      revision: revision(raw.revision, `${FILE}.revision`, 'invalid_document'),
      defaultTarget,
      connections,
    };
  }

  async create(
    root: string,
    rawInput: CreateCatalogConnectionInput,
  ): Promise<ConnectionCatalogMutationResult> {
    const input = parseCreateInput(rawInput);
    const current = await this.read(root);
    if (current.revision !== input.expectedCatalogRevision) {
      return revisionConflict(input.expectedCatalogRevision, current.revision);
    }
    if (current.connections.some((item) => item.slug === input.connection.slug)) {
      return deepFreeze({ kind: 'connection_exists', slug: input.connection.slug });
    }
    if (current.connections.length >= MAX_CONNECTIONS) {
      throw codecError(
        'invalid_connection_input',
        `Connection catalog cannot exceed ${MAX_CONNECTIONS} entries`,
      );
    }
    const next: ConnectionCatalogDocument = {
      ...current,
      revision: nextRevision(current.revision),
      connections: [
        ...current.connections,
        {
          ...input.connection,
          connectionId: randomUUID(),
          revision: 1,
          models: [],
        },
      ],
    };
    await this.write(root, next);
    return committed(next);
  }

  async update(
    root: string,
    rawInput: UpdateCatalogConnectionInput,
  ): Promise<ConnectionCatalogMutationResult> {
    const input = parseUpdateInput(rawInput);
    const current = await this.read(root);
    const index = findConnectionIndex(current, input.expected);
    const previous = index < 0 ? undefined : current.connections[index];
    if (!previous || previous.revision !== input.expected.revision) {
      return connectionStale(input.expected, previous ? connectionBasis(previous) : null);
    }
    const changes = canonicalizeUpdate(input.changes, previous.providerType);
    const endpointChanged = previous.baseUrl !== changes.baseUrl;
    const connections = [...current.connections];
    connections[index] = {
      connectionId: previous.connectionId,
      revision: nextRevision(previous.revision),
      slug: previous.slug,
      name: changes.name,
      providerType: previous.providerType,
      ...(changes.baseUrl === undefined ? {} : { baseUrl: changes.baseUrl }),
      enabled: changes.enabled,
      enabledModelIds: changes.enabledModelIds,
      models: endpointChanged ? [] : previous.models,
      ...(endpointChanged || previous.modelSource === undefined
        ? {}
        : { modelSource: previous.modelSource }),
      ...(endpointChanged || previous.modelsFetchedAt === undefined
        ? {}
        : { modelsFetchedAt: previous.modelsFetchedAt }),
      ...(endpointChanged || previous.lastTest === undefined
        ? {}
        : { lastTest: previous.lastTest }),
    };
    if (current.defaultTarget && !isValidTarget(current.defaultTarget, connections)) {
      return deepFreeze({ kind: 'invalid_default_target', target: current.defaultTarget });
    }
    const next = { ...current, revision: nextRevision(current.revision), connections };
    await this.write(root, next);
    return committed(next);
  }

  async remove(
    root: string,
    rawInput: RemoveCatalogConnectionInput,
  ): Promise<ConnectionCatalogMutationResult> {
    const input = parseRemoveInput(rawInput);
    const current = await this.read(root);
    const index = findConnectionIndex(current, input.expected);
    const previous = index < 0 ? undefined : current.connections[index];
    if (!previous || previous.revision !== input.expected.revision) {
      return connectionStale(input.expected, previous ? connectionBasis(previous) : null);
    }
    const next: ConnectionCatalogDocument = {
      ...current,
      revision: nextRevision(current.revision),
      defaultTarget:
        current.defaultTarget && sameConnectionIdentity(current.defaultTarget, previous)
          ? null
          : current.defaultTarget,
      connections: current.connections.filter((_item, candidate) => candidate !== index),
    };
    await this.write(root, next);
    return committed(next);
  }

  async setDefaultTarget(
    root: string,
    rawInput: SetDefaultConnectionTargetInput,
  ): Promise<ConnectionCatalogMutationResult> {
    const input = parseSetDefaultInput(rawInput);
    const current = await this.read(root);
    if (current.revision !== input.expectedCatalogRevision) {
      return revisionConflict(input.expectedCatalogRevision, current.revision);
    }
    if (input.target && !isValidTarget(input.target, current.connections)) {
      return deepFreeze({ kind: 'invalid_default_target', target: input.target });
    }
    const next = {
      ...current,
      revision: nextRevision(current.revision),
      defaultTarget: input.target,
    };
    await this.write(root, next);
    return committed(next);
  }

  async writeModelFetchResult(
    root: string,
    current: ConnectionCatalogDocument,
    expected: ConnectionVersionBasis,
    rawResult: ConnectionModelDiscoveryResult,
  ): Promise<ConnectionCatalogSnapshot> {
    const result = parseModelFetchResult(rawResult);
    const index = findConnectionIndex(current, expected);
    const previous = current.connections[index];
    if (!previous || previous.revision !== expected.revision) {
      throw codecError('invalid_document', 'Coordinator admitted a stale model fetch result');
    }
    const patched: ConnectionCatalogEntry = {
      ...previous,
      revision: nextRevision(previous.revision),
      models: result.models,
      modelSource: result.source,
      modelsFetchedAt: result.fetchedAt,
    };
    return this.writePatchedResult(root, current, index, patched);
  }

  async writeConnectionTestResult(
    root: string,
    current: ConnectionCatalogDocument,
    expected: ConnectionVersionBasis,
    rawResult: ConnectionTestSummary,
  ): Promise<ConnectionCatalogSnapshot> {
    const result = parseConnectionTestResult(rawResult);
    const index = findConnectionIndex(current, expected);
    const previous = current.connections[index];
    if (!previous || previous.revision !== expected.revision) {
      throw codecError('invalid_document', 'Coordinator admitted a stale connection test result');
    }
    const patched: ConnectionCatalogEntry = {
      ...previous,
      revision: nextRevision(previous.revision),
      lastTest: result,
    };
    return this.writePatchedResult(root, current, index, patched);
  }

  private async writePatchedResult(
    root: string,
    current: ConnectionCatalogDocument,
    index: number,
    patched: ConnectionCatalogEntry,
  ): Promise<ConnectionCatalogSnapshot> {
    const connections = [...current.connections];
    connections[index] = patched;
    const next = { ...current, revision: nextRevision(current.revision), connections };
    await this.write(root, next);
    return catalogSnapshot(next);
  }

  private async write(root: string, document: ConnectionCatalogDocument): Promise<void> {
    await writeJsonDocument(root, FILE, document, CATALOG_DOCUMENT_MAX_BYTES);
  }
}

export function catalogSnapshot(document: ConnectionCatalogDocument): ConnectionCatalogSnapshot {
  return deepFreeze({
    revision: document.revision,
    defaultTarget: structuredClone(document.defaultTarget),
    connections: structuredClone(document.connections),
  });
}

export function connectionBasis(connection: ConnectionCatalogEntry): ConnectionVersionBasis {
  return {
    connectionId: connection.connectionId,
    revision: connection.revision,
  };
}

export function findConnection(
  document: ConnectionCatalogDocument,
  identity: Pick<ConnectionVersionBasis, 'connectionId'>,
): ConnectionCatalogEntry | undefined {
  return document.connections.find((item) => sameConnectionIdentity(item, identity));
}

export function sameConnectionBasis(
  actual: ConnectionCatalogEntry | undefined,
  expected: ConnectionVersionBasis,
): boolean {
  return (
    actual !== undefined &&
    sameConnectionIdentity(actual, expected) &&
    actual.revision === expected.revision
  );
}

function findConnectionIndex(
  document: ConnectionCatalogDocument,
  identity: Pick<ConnectionVersionBasis, 'connectionId'>,
): number {
  return document.connections.findIndex((item) => sameConnectionIdentity(item, identity));
}

function sameConnectionIdentity(
  left: Pick<ConnectionVersionBasis, 'connectionId'>,
  right: Pick<ConnectionVersionBasis, 'connectionId'>,
): boolean {
  return left.connectionId === right.connectionId;
}

function isValidTarget(
  target: ConnectionTarget,
  connections: readonly ConnectionCatalogEntry[],
): boolean {
  const connection = connections.find((item) => sameConnectionIdentity(item, target));
  return Boolean(connection?.enabled && connection.enabledModelIds.includes(target.modelId));
}

function parseCreateInput(value: unknown): CreateCatalogConnectionInput {
  const input = record(value, 'create connection input', 'invalid_connection_input', [
    'expectedCatalogRevision',
    'connection',
  ]);
  return {
    expectedCatalogRevision: revision(
      input.expectedCatalogRevision,
      'create connection expected catalog revision',
      'invalid_connection_input',
    ),
    connection: parseDraft(input.connection, 'create connection', 'invalid_connection_input'),
  };
}

function parseUpdateInput(value: unknown): UpdateCatalogConnectionInput {
  const input = record(value, 'update connection input', 'invalid_connection_input', [
    'expected',
    'changes',
  ]);
  return {
    expected: parseConnectionBasis(
      input.expected,
      'update connection expected basis',
      'invalid_connection_input',
    ),
    changes: parseUpdate(input.changes, 'update connection changes', 'invalid_connection_input'),
  };
}

function parseRemoveInput(value: unknown): RemoveCatalogConnectionInput {
  const input = record(value, 'remove connection input', 'invalid_connection_input', ['expected']);
  return {
    expected: parseConnectionBasis(
      input.expected,
      'remove connection expected basis',
      'invalid_connection_input',
    ),
  };
}

function parseSetDefaultInput(value: unknown): SetDefaultConnectionTargetInput {
  const input = record(value, 'set default target input', 'invalid_connection_input', [
    'expectedCatalogRevision',
    'target',
  ]);
  return {
    expectedCatalogRevision: revision(
      input.expectedCatalogRevision,
      'set default target expected catalog revision',
      'invalid_connection_input',
    ),
    target:
      input.target === null
        ? null
        : parseTarget(input.target, 'default target', 'invalid_connection_input'),
  };
}

export function parseConnectionIdentity(
  value: unknown,
  context: string,
  source: CodecSource,
): Pick<ConnectionVersionBasis, 'connectionId'> {
  const item = record(value, context, source, ['connectionId']);
  return {
    connectionId: entityId(item.connectionId, `${context}.connectionId`, source),
  };
}

export function parseConnectionBasis(
  value: unknown,
  context: string,
  source: CodecSource,
): ConnectionVersionBasis {
  const item = record(value, context, source, ['connectionId', 'revision']);
  return {
    connectionId: entityId(item.connectionId, `${context}.connectionId`, source),
    revision: positiveRevision(item.revision, `${context}.revision`, source),
  };
}

function parseDraft(
  value: unknown,
  context: string,
  source: CodecSource,
): ConnectionCatalogEntryDraft {
  const item = record(
    value,
    context,
    source,
    ['slug', 'name', 'providerType', 'baseUrl', 'enabled', 'enabledModelIds'],
    ['slug', 'name', 'providerType', 'enabled', 'enabledModelIds'],
  );
  return configurationFromRecord(item, context, source);
}

function configurationFromRecord(
  item: Record<string, unknown>,
  context: string,
  source: CodecSource,
): ConnectionCatalogEntryDraft {
  const slug = parseSlug(item.slug, `${context}.slug`, source);
  const providerType = parseProviderType(item.providerType, `${context}.providerType`, source);
  const baseUrl = parseBaseUrlOverride(item.baseUrl, providerType, `${context}.baseUrl`, source);
  return {
    slug,
    name: string(item.name, `${context}.name`, 256, source),
    providerType,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    enabled: boolean(item.enabled, `${context}.enabled`, source),
    enabledModelIds: stringArray(item.enabledModelIds, `${context}.enabledModelIds`, 512, source),
  };
}

function parseUpdate(
  value: unknown,
  context: string,
  source: CodecSource,
): ConnectionCatalogEntryUpdate {
  const item = record(
    value,
    context,
    source,
    ['name', 'baseUrl', 'enabled', 'enabledModelIds'],
    ['name', 'enabled', 'enabledModelIds'],
  );
  return {
    name: string(item.name, `${context}.name`, 256, source),
    ...(item.baseUrl === undefined
      ? {}
      : { baseUrl: optionalString(item.baseUrl, `${context}.baseUrl`, 2_048, source) }),
    enabled: boolean(item.enabled, `${context}.enabled`, source),
    enabledModelIds: stringArray(item.enabledModelIds, `${context}.enabledModelIds`, 512, source),
  };
}

function canonicalizeUpdate(
  update: ConnectionCatalogEntryUpdate,
  providerType: ProviderType,
): ConnectionCatalogEntryUpdate {
  const baseUrl = parseBaseUrlOverride(
    update.baseUrl,
    providerType,
    'update connection changes.baseUrl',
    'invalid_connection_input',
  );
  return {
    name: update.name,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    enabled: update.enabled,
    enabledModelIds: update.enabledModelIds,
  };
}

function parseEntry(value: unknown, context: string, source: CodecSource): ConnectionCatalogEntry {
  const item = record(
    value,
    context,
    source,
    [
      'connectionId',
      'revision',
      'slug',
      'name',
      'providerType',
      'baseUrl',
      'enabled',
      'enabledModelIds',
      'models',
      'modelSource',
      'modelsFetchedAt',
      'lastTest',
    ],
    [
      'connectionId',
      'revision',
      'slug',
      'name',
      'providerType',
      'enabled',
      'enabledModelIds',
      'models',
    ],
  );
  const draft = configurationFromRecord(item, context, source);
  if (!Array.isArray(item.models) || item.models.length > 2_048) {
    throw codecError(source, `${context}.models must be a bounded array`);
  }
  const models = item.models.map((model, index) =>
    parseModel(model, `${context}.models[${index}]`, source),
  );
  unique(
    models.map((model) => model.id),
    `${context}.models ids`,
    source,
  );
  if (
    item.modelSource !== undefined &&
    item.modelSource !== 'fetched' &&
    item.modelSource !== 'fallback'
  ) {
    throw codecError(source, `${context}.modelSource is invalid`);
  }
  if ((item.modelSource === undefined) !== (item.modelsFetchedAt === undefined)) {
    throw codecError(source, `${context} must carry modelSource and modelsFetchedAt together`);
  }
  if (source === 'invalid_document' && item.modelSource === undefined && models.length > 0) {
    throw codecError(source, `${context}.models must be empty before model discovery`);
  }
  return {
    ...draft,
    connectionId: entityId(item.connectionId, `${context}.connectionId`, source),
    revision: positiveRevision(item.revision, `${context}.revision`, source),
    models,
    ...(item.modelSource === undefined ? {} : { modelSource: item.modelSource }),
    ...(item.modelsFetchedAt === undefined
      ? {}
      : {
          modelsFetchedAt: integer(
            item.modelsFetchedAt,
            `${context}.modelsFetchedAt`,
            0,
            Number.MAX_SAFE_INTEGER,
            source,
          ),
        }),
    ...(item.lastTest === undefined
      ? {}
      : { lastTest: parseLastTest(item.lastTest, `${context}.lastTest`, source) }),
  };
}

function parseProviderType(value: unknown, context: string, source: CodecSource): ProviderType {
  if (typeof value !== 'string' || !PROVIDER_TYPES.has(value)) {
    throw codecError(source, `${context} is not a registered provider`);
  }
  return value as ProviderType;
}

function parseBaseUrlOverride(
  value: unknown,
  providerType: ProviderType,
  context: string,
  source: CodecSource,
): string | undefined {
  const raw = optionalString(value, context, 2_048, source);
  const trimmed = raw?.trim();
  if (!trimmed) {
    if (source === 'invalid_document' && raw !== undefined) {
      throw codecError(
        source,
        `${context} must be omitted when no endpoint override is configured`,
      );
    }
    return undefined;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw codecError(source, `${context} must be a valid URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw codecError(source, `${context} must use http or https`);
  }
  if (parsed.username || parsed.password) {
    throw codecError(source, `${context} must not contain username or password`);
  }
  if (trimmed.includes('?')) {
    throw codecError(source, `${context} must not contain a query`);
  }
  if (trimmed.includes('#')) {
    throw codecError(source, `${context} must not contain a fragment`);
  }

  const canonical = parsed.toString();
  const providerDefault = canonicalProviderBaseUrl(providerType);
  const override = canonical === providerDefault ? undefined : canonical;
  if (override !== undefined && PROVIDER_DEFAULTS[providerType].authKind === 'oauth_token') {
    throw codecError(source, `${context} cannot override an OAuth provider endpoint`);
  }
  if (source === 'invalid_document' && raw !== override) {
    throw codecError(source, `${context} must contain only a canonical endpoint override`);
  }
  return override;
}

function canonicalProviderBaseUrl(providerType: ProviderType): string | undefined {
  const baseUrl = PROVIDER_DEFAULTS[providerType].baseUrl.trim();
  if (!baseUrl) return undefined;
  try {
    return new URL(baseUrl).toString();
  } catch {
    return undefined;
  }
}

function parseSlug(value: unknown, context: string, source: CodecSource): string {
  if (typeof value !== 'string') throw codecError(source, `${context} must be a string`);
  const error = validateSlug(value);
  if (error) throw codecError(source, `${context}: ${error}`);
  return value;
}

function parseTarget(value: unknown, context: string, source: CodecSource): ConnectionTarget {
  const item = record(value, context, source, ['connectionId', 'modelId']);
  return {
    connectionId: entityId(item.connectionId, `${context}.connectionId`, source),
    modelId: nonEmptyString(item.modelId, `${context}.modelId`, 512, source),
  };
}

function parseModel(value: unknown, context: string, source: CodecSource): ConnectionModel {
  const item = record(
    value,
    context,
    source,
    ['id', 'displayName', 'apiProtocol', 'contextWindow', 'maxOutputTokens', 'capabilities'],
    ['id'],
  );
  if (
    item.apiProtocol !== undefined &&
    item.apiProtocol !== 'openai-chat' &&
    item.apiProtocol !== 'openai-responses' &&
    item.apiProtocol !== 'anthropic-messages'
  ) {
    throw codecError(source, `${context}.apiProtocol is invalid`);
  }
  let capabilities: ConnectionModel['capabilities'];
  if (item.capabilities !== undefined) {
    const raw = record(
      item.capabilities,
      `${context}.capabilities`,
      source,
      ['chat', 'vision', 'reasoning', 'functionCalling', 'imageGeneration'],
      [],
    );
    capabilities = {};
    for (const key of Object.keys(raw)) {
      (capabilities as Record<string, boolean>)[key] = boolean(
        raw[key],
        `${context}.capabilities.${key}`,
        source,
      );
    }
  }
  return {
    id: nonEmptyString(item.id, `${context}.id`, 512, source),
    ...(item.displayName === undefined
      ? {}
      : { displayName: string(item.displayName, `${context}.displayName`, 512, source) }),
    ...(item.apiProtocol === undefined ? {} : { apiProtocol: item.apiProtocol }),
    ...(item.contextWindow === undefined
      ? {}
      : {
          contextWindow: integer(
            item.contextWindow,
            `${context}.contextWindow`,
            1,
            Number.MAX_SAFE_INTEGER,
            source,
          ),
        }),
    ...(item.maxOutputTokens === undefined
      ? {}
      : {
          maxOutputTokens: integer(
            item.maxOutputTokens,
            `${context}.maxOutputTokens`,
            1,
            Number.MAX_SAFE_INTEGER,
            source,
          ),
        }),
    ...(capabilities === undefined ? {} : { capabilities }),
  };
}

function parseLastTest(
  value: unknown,
  context: string,
  source: CodecSource,
): ConnectionTestSummary {
  const item = record(
    value,
    context,
    source,
    ['status', 'checkedAt', 'errorClass'],
    ['status', 'checkedAt'],
  );
  if (item.status !== 'verified' && item.status !== 'needs_reauth' && item.status !== 'error') {
    throw codecError(source, `${context}.status is invalid`);
  }
  if (
    item.errorClass !== undefined &&
    item.errorClass !== 'auth' &&
    item.errorClass !== 'timeout' &&
    item.errorClass !== 'provider_unavailable' &&
    item.errorClass !== 'network' &&
    item.errorClass !== 'unknown'
  ) {
    throw codecError(source, `${context}.errorClass is invalid`);
  }
  return {
    status: item.status,
    checkedAt: nonEmptyString(item.checkedAt, `${context}.checkedAt`, 128, source),
    ...(item.errorClass === undefined ? {} : { errorClass: item.errorClass }),
  };
}

export function parseModelFetchResult(value: unknown): ConnectionModelDiscoveryResult {
  const item = record(value, 'model fetch result', 'invalid_connection_input', [
    'models',
    'source',
    'fetchedAt',
  ]);
  if (!Array.isArray(item.models) || item.models.length > 2_048) {
    throw codecError(
      'invalid_connection_input',
      'model fetch result models must be a bounded array',
    );
  }
  const models = item.models.map((model, index) =>
    parseModel(model, `model fetch result models[${index}]`, 'invalid_connection_input'),
  );
  unique(
    models.map((model) => model.id),
    'model fetch result model ids',
    'invalid_connection_input',
  );
  if (item.source !== 'fetched' && item.source !== 'fallback') {
    throw codecError('invalid_connection_input', 'model fetch result source is invalid');
  }
  return {
    models,
    source: item.source,
    fetchedAt: integer(
      item.fetchedAt,
      'model fetch result fetchedAt',
      0,
      Number.MAX_SAFE_INTEGER,
      'invalid_connection_input',
    ),
  };
}

export function parseConnectionTestResult(value: unknown): ConnectionTestSummary {
  return parseLastTest(value, 'connection test result', 'invalid_connection_input');
}

function revisionConflict(expectedRevision: number, actualRevision: number) {
  return deepFreeze({ kind: 'revision_conflict' as const, expectedRevision, actualRevision });
}

function connectionStale(expected: ConnectionVersionBasis, actual: ConnectionVersionBasis | null) {
  return deepFreeze({ kind: 'connection_stale' as const, expected, actual });
}

function committed(document: ConnectionCatalogDocument): ConnectionCatalogMutationResult {
  return deepFreeze({ kind: 'committed', snapshot: catalogSnapshot(document) });
}
