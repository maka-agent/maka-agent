import { assertAllowedKeys, requireExactRecord, requireRecord, requireString } from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineOperation } from './operation-spec.js';

export const SKILL_CATALOG_PAGE_MAX_ITEMS = 128;
export const SKILL_CATALOG_PAGE_MAX_BYTES = 48 * 1024;
export const SKILL_CATALOG_PREVIEW_CONTENT_MAX_BYTES = 24 * 1024;

export const SKILL_CATALOG_PREVIEW_RESULT_MAX_BYTES = 62 * 1024;
const SKILL_ID_MAX_LENGTH = 81;
const NAME_MAX_LENGTH = 256;
const DESCRIPTION_MAX_LENGTH = 4 * 1024;
const CATEGORY_MAX_LENGTH = 128;
const ARRAY_MAX_ITEMS = 64;
const ARRAY_ITEM_MAX_LENGTH = 256;
const CURSOR_MAX_LENGTH = 512;

const QUERY_ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'internal_failure',
  'invalid_request',
] as const;
const COMMAND_ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'internal_failure',
  'invalid_request',
  'persistence_failed',
  'commit_outcome_unknown',
] as const;

export type SkillCatalogRevision = `sha256:${string}`;
export type SkillContentSha256 = SkillCatalogRevision;
export type SkillCatalogView = 'installed' | 'sources' | 'diagnostics';
export type SkillSourceType = 'workspace' | 'bundled' | 'managed' | 'unknown';
export type SkillRuntimeStatus = 'enabled' | 'disabled' | 'state_error';
export type SkillCatalogValidationStatus = 'ok' | 'missing_lock' | 'modified' | 'metadata_error';
export type SkillCatalogManagedUpdateStatus =
  | 'not_managed'
  | 'source_missing'
  | 'up_to_date'
  | 'update_available'
  | 'local_modified'
  | 'metadata_error';

export interface SkillCatalogEntry {
  readonly kind: 'skill';
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly declaredTools: readonly string[];
  readonly requiredTools: readonly string[];
  readonly requiredCapabilities: readonly string[];
  readonly enabled: boolean;
  readonly runtimeStatus: SkillRuntimeStatus;
  readonly contentSha256: SkillContentSha256;
  readonly sourceType: SkillSourceType;
  readonly userModified: boolean;
  readonly validationStatus: SkillCatalogValidationStatus;
  readonly managedUpdateStatus?: SkillCatalogManagedUpdateStatus;
}

export interface SkillCatalogSourceEntry {
  readonly kind: 'source';
  readonly sourceType: 'bundled' | 'managed';
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly category: string;
  readonly contentSha256: SkillContentSha256;
  readonly installed: boolean;
}

export interface SkillCatalogDiagnostic {
  readonly kind: 'diagnostic';
  readonly scope: 'installed' | 'source';
  readonly id: string;
  readonly codes: readonly string[];
}

export type SkillCatalogItem = SkillCatalogEntry | SkillCatalogSourceEntry | SkillCatalogDiagnostic;

export type SkillCatalogQueryInput =
  | { readonly kind: 'start'; readonly view: SkillCatalogView }
  | {
      readonly kind: 'continue';
      readonly view: SkillCatalogView;
      readonly revision: SkillCatalogRevision;
      readonly cursor: string;
    };

export type SkillCatalogQueryResult =
  | {
      readonly kind: 'page';
      readonly view: SkillCatalogView;
      readonly revision: SkillCatalogRevision;
      readonly items: readonly SkillCatalogItem[];
      readonly nextCursor: string | null;
    }
  | {
      readonly kind: 'revision_changed';
      readonly expectedRevision: SkillCatalogRevision;
      readonly actualRevision: SkillCatalogRevision;
    };

export interface SkillCatalogRefreshInput {
  readonly expectedRevision: SkillCatalogRevision;
}

export type SkillCatalogRefreshResult =
  | { readonly kind: 'committed' | 'unchanged'; readonly revision: SkillCatalogRevision }
  | SkillCatalogRevisionConflict;

export type SkillCatalogMutation =
  | { readonly kind: 'create_starter' }
  | {
      readonly kind: 'install';
      readonly sourceType: 'bundled' | 'managed';
      readonly sourceId: string;
      readonly expectedSourceSha256: SkillContentSha256;
    }
  | {
      readonly kind: 'update_managed';
      readonly skillId: string;
      readonly expectedCurrentSha256: SkillContentSha256;
      readonly expectedSourceSha256: SkillContentSha256;
      readonly force: boolean;
    }
  | { readonly kind: 'delete'; readonly skillId: string }
  | { readonly kind: 'set_enabled'; readonly skillId: string; readonly enabled: boolean };

export interface SkillCatalogMutateInput {
  readonly expectedRevision: SkillCatalogRevision;
  readonly mutation: SkillCatalogMutation;
}

export type SkillCatalogMutationRejectedReason =
  | 'not_found'
  | 'already_exists'
  | 'not_managed'
  | 'source_missing'
  | 'source_changed'
  | 'source_invalid'
  | 'local_modified'
  | 'state_error';

export type SkillCatalogMutateResult =
  | {
      readonly kind: 'committed' | 'unchanged';
      readonly revision: SkillCatalogRevision;
      readonly entry: SkillCatalogEntry | null;
    }
  | SkillCatalogRevisionConflict
  | { readonly kind: 'rejected'; readonly reason: SkillCatalogMutationRejectedReason };

export interface SkillCatalogPreviewUpdateInput {
  readonly skillId: string;
  readonly expectedRevision: SkillCatalogRevision;
}

export type SkillCatalogPreviewRejectedReason =
  | 'not_found'
  | 'not_managed'
  | 'source_missing'
  | 'preview_too_large';

export type SkillCatalogPreviewUpdateResult =
  | {
      readonly kind: 'preview';
      readonly revision: SkillCatalogRevision;
      readonly currentContent: string;
      readonly sourceContent: string;
      readonly currentContentSha256: SkillContentSha256;
      readonly sourceContentSha256: SkillContentSha256;
    }
  | SkillCatalogRevisionConflict
  | { readonly kind: 'rejected'; readonly reason: SkillCatalogPreviewRejectedReason };

export interface SkillCatalogRevisionConflict {
  readonly kind: 'revision_conflict';
  readonly expectedRevision: SkillCatalogRevision;
  readonly actualRevision: SkillCatalogRevision;
}

export const SKILL_CATALOG_OPERATION_SPECS = {
  'skill.catalog.query': defineOperation<
    SkillCatalogQueryInput,
    SkillCatalogQueryResult,
    (typeof QUERY_ERRORS)[number]
  >({
    mode: 'query',
    retry: 'safe',
    admission: 'ready',
    errors: QUERY_ERRORS,
    decodeInput: decodeQueryInput,
    decodeOutput: decodeQueryResult,
  }),
  'skill.catalog.refresh': defineOperation<
    SkillCatalogRefreshInput,
    SkillCatalogRefreshResult,
    (typeof COMMAND_ERRORS)[number]
  >({
    mode: 'command',
    retry: 'none',
    admission: 'ready',
    errors: COMMAND_ERRORS,
    decodeInput: decodeRefreshInput,
    decodeOutput: decodeRefreshResult,
  }),
  'skill.catalog.mutate': defineOperation<
    SkillCatalogMutateInput,
    SkillCatalogMutateResult,
    (typeof COMMAND_ERRORS)[number]
  >({
    mode: 'command',
    retry: 'none',
    admission: 'ready',
    errors: COMMAND_ERRORS,
    decodeInput: decodeMutateInput,
    decodeOutput: decodeMutateResult,
  }),
  'skill.catalog.preview-update': defineOperation<
    SkillCatalogPreviewUpdateInput,
    SkillCatalogPreviewUpdateResult,
    (typeof QUERY_ERRORS)[number]
  >({
    mode: 'query',
    retry: 'safe',
    admission: 'ready',
    errors: QUERY_ERRORS,
    decodeInput: decodePreviewInput,
    decodeOutput: decodePreviewResult,
  }),
} as const;

function decodeQueryInput(value: unknown): SkillCatalogQueryInput {
  const record = requireRecord(value, 'skill catalog query input');
  if (record.kind === 'start') {
    const start = requireExactRecord(record, 'skill catalog start query', ['kind', 'view']);
    return { kind: 'start', view: view(start.view) };
  }
  if (record.kind === 'continue') {
    const continuation = requireExactRecord(record, 'skill catalog continuation query', [
      'kind',
      'view',
      'revision',
      'cursor',
    ]);
    return {
      kind: 'continue',
      view: view(continuation.view),
      revision: catalogRevision(continuation.revision, 'skill catalog revision'),
      cursor: requireString(continuation.cursor, 'skill catalog cursor', CURSOR_MAX_LENGTH),
    };
  }
  throw invalidProtocolFrame('Invalid skill catalog query kind');
}

function decodeQueryResult(value: unknown): SkillCatalogQueryResult {
  const record = requireRecord(value, 'skill catalog query result');
  if (record.kind === 'revision_changed') {
    const changed = requireExactRecord(record, 'skill catalog revision changed result', [
      'kind',
      'expectedRevision',
      'actualRevision',
    ]);
    return {
      kind: 'revision_changed',
      expectedRevision: catalogRevision(changed.expectedRevision, 'expected revision'),
      actualRevision: catalogRevision(changed.actualRevision, 'actual revision'),
    };
  }
  const page = requireExactRecord(record, 'skill catalog page result', [
    'kind',
    'view',
    'revision',
    'items',
    'nextCursor',
  ]);
  if (page.kind !== 'page' || !Array.isArray(page.items)) {
    throw invalidProtocolFrame('Invalid skill catalog page result');
  }
  const pageView = view(page.view);
  if (page.items.length > SKILL_CATALOG_PAGE_MAX_ITEMS) {
    throw invalidProtocolFrame('Skill catalog page exceeds item limit');
  }
  const decoded: SkillCatalogQueryResult = {
    kind: 'page',
    view: pageView,
    revision: catalogRevision(page.revision, 'skill catalog revision'),
    items: page.items.map((item) => decodePageItem(item, pageView)),
    nextCursor:
      page.nextCursor === null
        ? null
        : requireString(page.nextCursor, 'skill catalog next cursor', CURSOR_MAX_LENGTH),
  };
  if (jsonByteLength(decoded) > SKILL_CATALOG_PAGE_MAX_BYTES) {
    throw invalidProtocolFrame('Skill catalog page exceeds byte limit');
  }
  return decoded;
}

function decodePageItem(value: unknown, expectedView: SkillCatalogView): SkillCatalogItem {
  const record = requireRecord(value, 'skill catalog page item');
  if (expectedView === 'installed' && record.kind === 'skill') return decodeSkillEntry(record);
  if (expectedView === 'sources' && record.kind === 'source') return decodeSourceEntry(record);
  if (expectedView === 'diagnostics' && record.kind === 'diagnostic') {
    return decodeDiagnostic(record);
  }
  throw invalidProtocolFrame('Skill catalog item does not match page view');
}

function decodeSkillEntry(value: unknown): SkillCatalogEntry {
  const record = requireRecord(value, 'skill catalog entry');
  const allowed = [
    'kind',
    'id',
    'name',
    'description',
    'declaredTools',
    'requiredTools',
    'requiredCapabilities',
    'enabled',
    'runtimeStatus',
    'contentSha256',
    'sourceType',
    'userModified',
    'validationStatus',
    'managedUpdateStatus',
  ] as const;
  assertAllowedKeys(record, 'skill catalog entry', allowed);
  if (allowed.slice(0, -1).some((key) => !Object.hasOwn(record, key))) {
    throw invalidProtocolFrame('Invalid skill catalog entry fields');
  }
  if (record.kind !== 'skill') throw invalidProtocolFrame('Invalid skill catalog entry kind');
  const entry: SkillCatalogEntry = {
    kind: 'skill',
    id: skillId(record.id, 'skill id'),
    name: requireString(record.name, 'skill name', NAME_MAX_LENGTH),
    description: requireString(record.description, 'skill description', DESCRIPTION_MAX_LENGTH),
    declaredTools: boundedStringArray(record.declaredTools, 'declared tools'),
    requiredTools: boundedStringArray(record.requiredTools, 'required tools'),
    requiredCapabilities: boundedStringArray(record.requiredCapabilities, 'required capabilities'),
    enabled: boolean(record.enabled, 'skill enabled'),
    runtimeStatus: runtimeStatus(record.runtimeStatus),
    contentSha256: contentSha256(record.contentSha256, 'skill content sha256'),
    sourceType: installedSourceType(record.sourceType),
    userModified: boolean(record.userModified, 'skill user modified'),
    validationStatus: validationStatus(record.validationStatus),
  };
  if (Object.hasOwn(record, 'managedUpdateStatus')) {
    return { ...entry, managedUpdateStatus: managedUpdateStatus(record.managedUpdateStatus) };
  }
  return entry;
}

function decodeSourceEntry(value: unknown): SkillCatalogSourceEntry {
  const record = requireExactRecord(value, 'skill catalog source entry', [
    'kind',
    'sourceType',
    'id',
    'name',
    'description',
    'category',
    'contentSha256',
    'installed',
  ]);
  if (record.kind !== 'source') throw invalidProtocolFrame('Invalid skill catalog source kind');
  return {
    kind: 'source',
    sourceType: mutableSourceType(record.sourceType),
    id: skillId(record.id, 'skill source id'),
    name: requireString(record.name, 'skill source name', NAME_MAX_LENGTH),
    description: requireString(
      record.description,
      'skill source description',
      DESCRIPTION_MAX_LENGTH,
    ),
    category: requireString(record.category, 'skill source category', CATEGORY_MAX_LENGTH),
    contentSha256: contentSha256(record.contentSha256, 'skill source content sha256'),
    installed: boolean(record.installed, 'skill source installed'),
  };
}

function decodeDiagnostic(value: unknown): SkillCatalogDiagnostic {
  const record = requireExactRecord(value, 'skill catalog diagnostic', [
    'kind',
    'scope',
    'id',
    'codes',
  ]);
  if (record.kind !== 'diagnostic') throw invalidProtocolFrame('Invalid skill diagnostic kind');
  return {
    kind: 'diagnostic',
    scope: diagnosticScope(record.scope),
    id: skillId(record.id, 'skill diagnostic id'),
    codes: boundedStringArray(record.codes, 'skill diagnostic codes'),
  };
}

function decodeRefreshInput(value: unknown): SkillCatalogRefreshInput {
  const record = requireExactRecord(value, 'skill catalog refresh input', ['expectedRevision']);
  return {
    expectedRevision: catalogRevision(record.expectedRevision, 'expected revision'),
  };
}

function decodeRefreshResult(value: unknown): SkillCatalogRefreshResult {
  const record = requireRecord(value, 'skill catalog refresh result');
  if (record.kind === 'revision_conflict') return decodeRevisionConflict(record);
  const result = requireExactRecord(record, 'skill catalog refresh result', ['kind', 'revision']);
  if (result.kind !== 'committed' && result.kind !== 'unchanged') {
    throw invalidProtocolFrame('Invalid skill catalog refresh result kind');
  }
  return {
    kind: result.kind,
    revision: catalogRevision(result.revision, 'skill catalog revision'),
  };
}

function decodeMutateInput(value: unknown): SkillCatalogMutateInput {
  const record = requireExactRecord(value, 'skill catalog mutate input', [
    'expectedRevision',
    'mutation',
  ]);
  return {
    expectedRevision: catalogRevision(record.expectedRevision, 'expected revision'),
    mutation: decodeMutation(record.mutation),
  };
}

function decodeMutation(value: unknown): SkillCatalogMutation {
  const record = requireRecord(value, 'skill catalog mutation');
  if (record.kind === 'create_starter') {
    requireExactRecord(record, 'create starter mutation', ['kind']);
    return { kind: 'create_starter' };
  }
  if (record.kind === 'install') {
    const mutation = requireExactRecord(record, 'install skill mutation', [
      'kind',
      'sourceType',
      'sourceId',
      'expectedSourceSha256',
    ]);
    return {
      kind: 'install',
      sourceType: mutableSourceType(mutation.sourceType),
      sourceId: skillId(mutation.sourceId, 'skill source id'),
      expectedSourceSha256: contentSha256(mutation.expectedSourceSha256, 'expected source sha256'),
    };
  }
  if (record.kind === 'update_managed') {
    const mutation = requireExactRecord(record, 'update managed skill mutation', [
      'kind',
      'skillId',
      'expectedCurrentSha256',
      'expectedSourceSha256',
      'force',
    ]);
    return {
      kind: 'update_managed',
      skillId: skillId(mutation.skillId, 'skill id'),
      expectedCurrentSha256: contentSha256(
        mutation.expectedCurrentSha256,
        'expected current sha256',
      ),
      expectedSourceSha256: contentSha256(mutation.expectedSourceSha256, 'expected source sha256'),
      force: boolean(mutation.force, 'force'),
    };
  }
  if (record.kind === 'delete') {
    const mutation = requireExactRecord(record, 'delete skill mutation', ['kind', 'skillId']);
    return { kind: 'delete', skillId: skillId(mutation.skillId, 'skill id') };
  }
  if (record.kind === 'set_enabled') {
    const mutation = requireExactRecord(record, 'set skill enabled mutation', [
      'kind',
      'skillId',
      'enabled',
    ]);
    return {
      kind: 'set_enabled',
      skillId: skillId(mutation.skillId, 'skill id'),
      enabled: boolean(mutation.enabled, 'skill enabled'),
    };
  }
  throw invalidProtocolFrame('Invalid skill catalog mutation kind');
}

function decodeMutateResult(value: unknown): SkillCatalogMutateResult {
  const record = requireRecord(value, 'skill catalog mutate result');
  if (record.kind === 'revision_conflict') return decodeRevisionConflict(record);
  if (record.kind === 'rejected') {
    const rejected = requireExactRecord(record, 'skill catalog mutation rejected result', [
      'kind',
      'reason',
    ]);
    return { kind: 'rejected', reason: mutationRejectedReason(rejected.reason) };
  }
  const result = requireExactRecord(record, 'skill catalog mutation result', [
    'kind',
    'revision',
    'entry',
  ]);
  if (result.kind !== 'committed' && result.kind !== 'unchanged') {
    throw invalidProtocolFrame('Invalid skill catalog mutation result kind');
  }
  return {
    kind: result.kind,
    revision: catalogRevision(result.revision, 'skill catalog revision'),
    entry: result.entry === null ? null : decodeSkillEntry(result.entry),
  };
}

function decodePreviewInput(value: unknown): SkillCatalogPreviewUpdateInput {
  const record = requireExactRecord(value, 'skill catalog preview input', [
    'skillId',
    'expectedRevision',
  ]);
  return {
    skillId: skillId(record.skillId, 'skill id'),
    expectedRevision: catalogRevision(record.expectedRevision, 'expected revision'),
  };
}

function decodePreviewResult(value: unknown): SkillCatalogPreviewUpdateResult {
  const record = requireRecord(value, 'skill catalog preview result');
  if (record.kind === 'revision_conflict') return decodeRevisionConflict(record);
  if (record.kind === 'rejected') {
    const rejected = requireExactRecord(record, 'skill catalog preview rejected result', [
      'kind',
      'reason',
    ]);
    return { kind: 'rejected', reason: previewRejectedReason(rejected.reason) };
  }
  const preview = requireExactRecord(record, 'skill catalog preview result', [
    'kind',
    'revision',
    'currentContent',
    'sourceContent',
    'currentContentSha256',
    'sourceContentSha256',
  ]);
  if (preview.kind !== 'preview') throw invalidProtocolFrame('Invalid skill catalog preview kind');
  const decoded: SkillCatalogPreviewUpdateResult = {
    kind: 'preview',
    revision: catalogRevision(preview.revision, 'skill catalog revision'),
    currentContent: previewContent(preview.currentContent, 'current skill content'),
    sourceContent: previewContent(preview.sourceContent, 'source skill content'),
    currentContentSha256: contentSha256(preview.currentContentSha256, 'current content sha256'),
    sourceContentSha256: contentSha256(preview.sourceContentSha256, 'source content sha256'),
  };
  if (jsonByteLength(decoded) > SKILL_CATALOG_PREVIEW_RESULT_MAX_BYTES) {
    throw invalidProtocolFrame('Skill catalog preview exceeds byte limit');
  }
  return decoded;
}

function decodeRevisionConflict(value: unknown): SkillCatalogRevisionConflict {
  const record = requireExactRecord(value, 'skill catalog revision conflict', [
    'kind',
    'expectedRevision',
    'actualRevision',
  ]);
  if (record.kind !== 'revision_conflict') {
    throw invalidProtocolFrame('Invalid skill catalog revision conflict');
  }
  return {
    kind: 'revision_conflict',
    expectedRevision: catalogRevision(record.expectedRevision, 'expected revision'),
    actualRevision: catalogRevision(record.actualRevision, 'actual revision'),
  };
}

function skillId(value: unknown, label: string): string {
  const id = requireString(value, label, SKILL_ID_MAX_LENGTH);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(id)) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return id;
}

function catalogRevision(value: unknown, label: string): SkillCatalogRevision {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return value as SkillCatalogRevision;
}

function contentSha256(value: unknown, label: string): SkillContentSha256 {
  return catalogRevision(value, label);
}

function previewContent(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value, 'utf8') > SKILL_CATALOG_PREVIEW_CONTENT_MAX_BYTES
  ) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return value;
}

function boundedStringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length > ARRAY_MAX_ITEMS) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return value.map((item) => requireString(item, label, ARRAY_ITEM_MAX_LENGTH));
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw invalidProtocolFrame(`Invalid ${label}`);
  return value;
}

function view(value: unknown): SkillCatalogView {
  if (value === 'installed' || value === 'sources' || value === 'diagnostics') return value;
  throw invalidProtocolFrame('Invalid skill catalog view');
}

function mutableSourceType(value: unknown): 'bundled' | 'managed' {
  if (value === 'bundled' || value === 'managed') return value;
  throw invalidProtocolFrame('Invalid skill source type');
}

function installedSourceType(value: unknown): SkillSourceType {
  if (value === 'workspace' || value === 'bundled' || value === 'managed' || value === 'unknown') {
    return value;
  }
  throw invalidProtocolFrame('Invalid installed skill source type');
}

function runtimeStatus(value: unknown): SkillRuntimeStatus {
  if (value === 'enabled' || value === 'disabled' || value === 'state_error') return value;
  throw invalidProtocolFrame('Invalid skill runtime status');
}

function validationStatus(value: unknown): SkillCatalogValidationStatus {
  if (
    value === 'ok' ||
    value === 'missing_lock' ||
    value === 'modified' ||
    value === 'metadata_error'
  ) {
    return value;
  }
  throw invalidProtocolFrame('Invalid skill validation status');
}

function managedUpdateStatus(value: unknown): SkillCatalogManagedUpdateStatus {
  if (
    value === 'not_managed' ||
    value === 'source_missing' ||
    value === 'up_to_date' ||
    value === 'update_available' ||
    value === 'local_modified' ||
    value === 'metadata_error'
  ) {
    return value;
  }
  throw invalidProtocolFrame('Invalid managed skill update status');
}

function diagnosticScope(value: unknown): SkillCatalogDiagnostic['scope'] {
  if (value === 'installed' || value === 'source') return value;
  throw invalidProtocolFrame('Invalid skill diagnostic scope');
}

function mutationRejectedReason(value: unknown): SkillCatalogMutationRejectedReason {
  if (
    value === 'not_found' ||
    value === 'already_exists' ||
    value === 'not_managed' ||
    value === 'source_missing' ||
    value === 'source_changed' ||
    value === 'source_invalid' ||
    value === 'local_modified' ||
    value === 'state_error'
  ) {
    return value;
  }
  throw invalidProtocolFrame('Invalid skill catalog mutation rejection reason');
}

function previewRejectedReason(value: unknown): SkillCatalogPreviewRejectedReason {
  if (
    value === 'not_found' ||
    value === 'not_managed' ||
    value === 'source_missing' ||
    value === 'preview_too_large'
  ) {
    return value;
  }
  throw invalidProtocolFrame('Invalid skill catalog preview rejection reason');
}

function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}
