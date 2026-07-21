import {
  requireCount,
  requireEntityId,
  requireExactRecord,
  requireRecord,
  requireUtf8BoundedString,
} from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineOperation } from './operation-spec.js';

export const AUTOMATION_NAME_MAX_BYTES = 256;
export const AUTOMATION_PROMPT_MAX_BYTES = 16 * 1024;
export const AUTOMATION_CRON_EXPRESSION_MAX_BYTES = 256;
export const AUTOMATION_FIRE_FAILURE_MAX_BYTES = 2 * 1024;
export const AUTOMATION_CWD_MAX_BYTES = 4 * 1024;
export const AUTOMATION_MODEL_MAX_BYTES = 512;
export const AUTOMATION_CURSOR_MAX_BYTES = 512;
export const AUTOMATION_PAGE_MAX_ITEMS = 16;
export const AUTOMATION_PAGE_MAX_BYTES = 48 * 1024;
export const AUTOMATION_SCHEDULE_SECONDS_MAX = 366 * 24 * 60 * 60;
export const AUTOMATION_MAX_FIRES = 1_000_000;

const QUERY_ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'invalid_request',
  'not_found',
  'persistence_failed',
  'internal_failure',
] as const;

const MUTATE_ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'invalid_request',
  'not_found',
  'operation_conflict',
  'persistence_failed',
  'commit_outcome_unknown',
  'internal_failure',
] as const;

export type AutomationRevision = number;
export type AutomationCatalogRevision = number;

export type AutomationSchedule =
  | { readonly type: 'cron'; readonly expression: string }
  | { readonly type: 'interval'; readonly seconds: number }
  | { readonly type: 'once'; readonly delaySeconds: number };

export type AutomationThinkingLevel =
  | 'off'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max';

export type AutomationExecutionTarget =
  | {
      readonly kind: 'existing_session';
      readonly sessionId: string;
    }
  | {
      readonly kind: 'fresh_session';
      readonly sourceSessionId: string;
      readonly cwd: string;
      readonly backend: 'ai-sdk' | 'fake' | 'pi-agent';
      readonly llmConnectionSlug: string;
      readonly model: string;
      readonly thinkingLevel: AutomationThinkingLevel | null;
      readonly permissionMode: 'explore';
    };

export interface AutomationDefinitionInput {
  readonly kind: 'heartbeat' | 'cron';
  readonly name: string;
  readonly prompt: string;
  readonly executionTarget: AutomationExecutionTarget;
  readonly schedule: AutomationSchedule;
  readonly maxFires: number | null;
  readonly expiresAt: number | null;
}

export interface AutomationCurrentFireSummary {
  readonly fireId: string;
  readonly status: 'admitted' | 'running';
  readonly admittedAt: number;
  readonly runId: string | null;
}

export interface AutomationLastFireSummary {
  readonly fireId: string;
  readonly status: 'succeeded' | 'failed' | 'outcome_unknown';
  readonly admittedAt: number;
  readonly completedAt: number;
  readonly runId: string | null;
  readonly failure: string | null;
}

export interface AutomationProjection extends AutomationDefinitionInput {
  readonly automationId: string;
  readonly revision: AutomationRevision;
  readonly enabled: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly nextFireAt: number | null;
  readonly currentFire: AutomationCurrentFireSummary | null;
  readonly lastFire: AutomationLastFireSummary | null;
}

export type AutomationQueryInput =
  | { readonly kind: 'get'; readonly automationId: string }
  | {
      readonly kind: 'list';
      readonly limit: number;
      readonly revision: AutomationCatalogRevision | null;
      readonly cursor: string | null;
    };

export type AutomationQueryResult =
  | {
      readonly kind: 'item';
      readonly catalogRevision: AutomationCatalogRevision;
      readonly automation: AutomationProjection;
    }
  | {
      readonly kind: 'page';
      readonly revision: AutomationCatalogRevision;
      readonly items: readonly AutomationProjection[];
      readonly nextCursor: string | null;
    }
  | {
      readonly kind: 'revision_changed';
      readonly expected: AutomationCatalogRevision;
      readonly actual: AutomationCatalogRevision;
    };

export type AutomationMutation =
  | {
      /** Semantic identity: an identical replay may return unchanged; different content conflicts. */
      readonly kind: 'create';
      readonly automationId: string;
      readonly definition: AutomationDefinitionInput;
    }
  | {
      /** CAS replacement of the definition. Already admitted fires retain their frozen inputs. */
      readonly kind: 'update';
      readonly automationId: string;
      readonly expectedRevision: AutomationRevision;
      readonly definition: AutomationDefinitionInput;
    }
  | {
      /** CAS gate for future fire admission; it does not cancel an admitted fire. */
      readonly kind: 'set_enabled';
      readonly automationId: string;
      readonly expectedRevision: AutomationRevision;
      readonly enabled: boolean;
    }
  | {
      /** CAS delete affects future fires and conflicts while a non-terminal fire exists. */
      readonly kind: 'delete';
      readonly automationId: string;
      readonly expectedRevision: AutomationRevision;
    };

export interface AutomationMutateInput {
  readonly mutation: AutomationMutation;
}

export type AutomationMutateResult =
  | {
      readonly kind: 'committed' | 'unchanged';
      readonly catalogRevision: AutomationCatalogRevision;
      readonly automation: AutomationProjection;
    }
  | {
      readonly kind: 'deleted';
      readonly catalogRevision: AutomationCatalogRevision;
      readonly automationId: string;
    };

export const AUTOMATION_OPERATION_SPECS = {
  'automation.query': defineOperation<
    AutomationQueryInput,
    AutomationQueryResult,
    (typeof QUERY_ERRORS)[number]
  >({
    mode: 'query',
    retry: 'safe',
    admission: 'ready',
    errors: QUERY_ERRORS,
    decodeInput: decodeAutomationQueryInput,
    decodeOutput: decodeAutomationQueryResult,
  }),
  'automation.mutate': defineOperation<
    AutomationMutateInput,
    AutomationMutateResult,
    (typeof MUTATE_ERRORS)[number]
  >({
    mode: 'command',
    retry: 'semantic',
    admission: 'ready',
    errors: MUTATE_ERRORS,
    decodeInput: decodeAutomationMutateInput,
    decodeOutput: decodeAutomationMutateResult,
  }),
} as const;

export function decodeAutomationQueryInput(value: unknown): AutomationQueryInput {
  const record = requireRecord(value, 'automation query input');
  if (record.kind === 'get') {
    const input = requireExactRecord(record, 'automation get input', ['kind', 'automationId']);
    return { kind: 'get', automationId: automationId(input.automationId) };
  }
  if (record.kind !== 'list') throw invalidProtocolFrame('Invalid automation query kind');
  const input = requireExactRecord(record, 'automation list input', [
    'kind',
    'limit',
    'revision',
    'cursor',
  ]);
  const revision = nullableCatalogRevision(input.revision, 'automation list revision');
  const cursor = input.cursor === null ? null : automationCursor(input.cursor);
  if ((revision === null) !== (cursor === null)) {
    throw invalidProtocolFrame('Automation list revision and cursor must both be null or present');
  }
  return { kind: 'list', limit: pageLimit(input.limit), revision, cursor };
}

export function decodeAutomationQueryResult(value: unknown): AutomationQueryResult {
  return decodeQueryResult(value);
}

export function encodeAutomationQueryResult(value: unknown): AutomationQueryResult {
  return decodeQueryResult(value);
}

export function decodeAutomationMutateInput(value: unknown): AutomationMutateInput {
  const input = requireExactRecord(value, 'automation mutate input', ['mutation']);
  return { mutation: decodeMutation(input.mutation) };
}

export function decodeAutomationMutateResult(value: unknown): AutomationMutateResult {
  return decodeMutateResult(value);
}

export function encodeAutomationMutateResult(value: unknown): AutomationMutateResult {
  return decodeMutateResult(value);
}

function decodeQueryResult(value: unknown): AutomationQueryResult {
  const record = requireRecord(value, 'automation query result');
  if (record.kind === 'item') {
    const result = requireExactRecord(record, 'automation item result', [
      'kind',
      'catalogRevision',
      'automation',
    ]);
    return {
      kind: 'item',
      catalogRevision: catalogRevision(result.catalogRevision, 'automation catalog revision'),
      automation: decodeProjection(result.automation),
    };
  }
  if (record.kind === 'revision_changed') {
    const result = requireExactRecord(record, 'automation revision changed result', [
      'kind',
      'expected',
      'actual',
    ]);
    return {
      kind: 'revision_changed',
      expected: catalogRevision(result.expected, 'expected automation catalog revision'),
      actual: catalogRevision(result.actual, 'actual automation catalog revision'),
    };
  }
  if (record.kind !== 'page') throw invalidProtocolFrame('Invalid automation query result kind');
  const page = requireExactRecord(record, 'automation page result', [
    'kind',
    'revision',
    'items',
    'nextCursor',
  ]);
  if (!Array.isArray(page.items) || page.items.length > AUTOMATION_PAGE_MAX_ITEMS) {
    throw invalidProtocolFrame('Automation page exceeds item limit');
  }
  const decoded: AutomationQueryResult = {
    kind: 'page',
    revision: catalogRevision(page.revision, 'automation catalog revision'),
    items: page.items.map(decodeProjection),
    nextCursor: page.nextCursor === null ? null : automationCursor(page.nextCursor),
  };
  if (jsonByteLength(decoded) > AUTOMATION_PAGE_MAX_BYTES) {
    throw invalidProtocolFrame('Automation page exceeds byte limit');
  }
  return decoded;
}

function decodeMutation(value: unknown): AutomationMutation {
  const record = requireRecord(value, 'automation mutation');
  if (record.kind === 'create') {
    const mutation = requireExactRecord(record, 'automation create mutation', [
      'kind',
      'automationId',
      'definition',
    ]);
    return {
      kind: 'create',
      automationId: automationId(mutation.automationId),
      definition: decodeDefinition(mutation.definition),
    };
  }
  if (record.kind === 'update') {
    const mutation = requireExactRecord(record, 'automation update mutation', [
      'kind',
      'automationId',
      'expectedRevision',
      'definition',
    ]);
    return {
      kind: 'update',
      automationId: automationId(mutation.automationId),
      expectedRevision: entityRevision(mutation.expectedRevision, 'expected automation revision'),
      definition: decodeDefinition(mutation.definition),
    };
  }
  if (record.kind === 'set_enabled') {
    const mutation = requireExactRecord(record, 'automation set enabled mutation', [
      'kind',
      'automationId',
      'expectedRevision',
      'enabled',
    ]);
    return {
      kind: 'set_enabled',
      automationId: automationId(mutation.automationId),
      expectedRevision: entityRevision(mutation.expectedRevision, 'expected automation revision'),
      enabled: boolean(mutation.enabled, 'automation enabled'),
    };
  }
  if (record.kind === 'delete') {
    const mutation = requireExactRecord(record, 'automation delete mutation', [
      'kind',
      'automationId',
      'expectedRevision',
    ]);
    return {
      kind: 'delete',
      automationId: automationId(mutation.automationId),
      expectedRevision: entityRevision(mutation.expectedRevision, 'expected automation revision'),
    };
  }
  throw invalidProtocolFrame('Invalid automation mutation kind');
}

function decodeMutateResult(value: unknown): AutomationMutateResult {
  const record = requireRecord(value, 'automation mutate result');
  if (record.kind === 'deleted') {
    const result = requireExactRecord(record, 'automation deleted result', [
      'kind',
      'catalogRevision',
      'automationId',
    ]);
    return {
      kind: 'deleted',
      catalogRevision: catalogRevision(result.catalogRevision, 'automation catalog revision'),
      automationId: automationId(result.automationId),
    };
  }
  if (record.kind !== 'committed' && record.kind !== 'unchanged') {
    throw invalidProtocolFrame('Invalid automation mutate result kind');
  }
  const result = requireExactRecord(record, 'automation mutate result', [
    'kind',
    'catalogRevision',
    'automation',
  ]);
  return {
    kind: record.kind,
    catalogRevision: catalogRevision(result.catalogRevision, 'automation catalog revision'),
    automation: decodeProjection(result.automation),
  };
}

function decodeDefinition(value: unknown): AutomationDefinitionInput {
  const definition = requireExactRecord(value, 'automation definition', [
    'kind',
    'name',
    'prompt',
    'executionTarget',
    'schedule',
    'maxFires',
    'expiresAt',
  ]);
  const kind = automationKind(definition.kind);
  const executionTarget = decodeExecutionTarget(definition.executionTarget);
  if (
    (kind === 'heartbeat' && executionTarget.kind !== 'existing_session') ||
    (kind === 'cron' && executionTarget.kind !== 'fresh_session')
  ) {
    throw invalidProtocolFrame('Automation kind does not match execution target');
  }
  return {
    kind,
    name: requireUtf8BoundedString(definition.name, 'automation name', AUTOMATION_NAME_MAX_BYTES),
    prompt: requireUtf8BoundedString(
      definition.prompt,
      'automation prompt',
      AUTOMATION_PROMPT_MAX_BYTES,
    ),
    executionTarget,
    schedule: decodeSchedule(definition.schedule),
    maxFires:
      definition.maxFires === null
        ? null
        : boundedPositiveInteger(definition.maxFires, 'automation maxFires', AUTOMATION_MAX_FIRES),
    expiresAt:
      definition.expiresAt === null
        ? null
        : timestamp(definition.expiresAt, 'automation expiresAt'),
  };
}

function decodeProjection(value: unknown): AutomationProjection {
  const projection = requireExactRecord(value, 'automation projection', [
    'automationId',
    'revision',
    'kind',
    'name',
    'prompt',
    'executionTarget',
    'schedule',
    'maxFires',
    'expiresAt',
    'enabled',
    'createdAt',
    'updatedAt',
    'nextFireAt',
    'currentFire',
    'lastFire',
  ]);
  const definition = decodeDefinition({
    kind: projection.kind,
    name: projection.name,
    prompt: projection.prompt,
    executionTarget: projection.executionTarget,
    schedule: projection.schedule,
    maxFires: projection.maxFires,
    expiresAt: projection.expiresAt,
  });
  const currentFire =
    projection.currentFire === null ? null : decodeCurrentFire(projection.currentFire);
  const lastFire = projection.lastFire === null ? null : decodeLastFire(projection.lastFire);
  return {
    automationId: automationId(projection.automationId),
    revision: entityRevision(projection.revision, 'automation revision'),
    ...definition,
    enabled: boolean(projection.enabled, 'automation enabled'),
    createdAt: timestamp(projection.createdAt, 'automation createdAt'),
    updatedAt: timestamp(projection.updatedAt, 'automation updatedAt'),
    nextFireAt:
      projection.nextFireAt === null
        ? null
        : timestamp(projection.nextFireAt, 'automation nextFireAt'),
    currentFire,
    lastFire,
  };
}

function decodeSchedule(value: unknown): AutomationSchedule {
  const record = requireRecord(value, 'automation schedule');
  if (record.type === 'cron') {
    const schedule = requireExactRecord(record, 'automation cron schedule', ['type', 'expression']);
    return {
      type: 'cron',
      expression: requireUtf8BoundedString(
        schedule.expression,
        'automation cron expression',
        AUTOMATION_CRON_EXPRESSION_MAX_BYTES,
      ),
    };
  }
  if (record.type === 'interval') {
    const schedule = requireExactRecord(record, 'automation interval schedule', ['type', 'seconds']);
    return {
      type: 'interval',
      seconds: boundedPositiveInteger(
        schedule.seconds,
        'automation interval seconds',
        AUTOMATION_SCHEDULE_SECONDS_MAX,
      ),
    };
  }
  if (record.type === 'once') {
    const schedule = requireExactRecord(record, 'automation once schedule', [
      'type',
      'delaySeconds',
    ]);
    return {
      type: 'once',
      delaySeconds: boundedPositiveInteger(
        schedule.delaySeconds,
        'automation delay seconds',
        AUTOMATION_SCHEDULE_SECONDS_MAX,
      ),
    };
  }
  throw invalidProtocolFrame('Invalid automation schedule type');
}

function decodeExecutionTarget(value: unknown): AutomationExecutionTarget {
  const record = requireRecord(value, 'automation execution target');
  if (record.kind === 'existing_session') {
    const target = requireExactRecord(record, 'automation existing session target', [
      'kind',
      'sessionId',
    ]);
    return {
      kind: 'existing_session',
      sessionId: requireEntityId(target.sessionId, 'automation target sessionId'),
    };
  }
  if (record.kind !== 'fresh_session') {
    throw invalidProtocolFrame('Invalid automation execution target kind');
  }
  const target = requireExactRecord(record, 'automation fresh session target', [
    'kind',
    'sourceSessionId',
    'cwd',
    'backend',
    'llmConnectionSlug',
    'model',
    'thinkingLevel',
    'permissionMode',
  ]);
  if (target.permissionMode !== 'explore') {
    throw invalidProtocolFrame('Automation fresh session permissionMode must be explore');
  }
  return {
    kind: 'fresh_session',
    sourceSessionId: requireEntityId(target.sourceSessionId, 'automation source sessionId'),
    cwd: requireUtf8BoundedString(target.cwd, 'automation cwd', AUTOMATION_CWD_MAX_BYTES),
    backend: automationBackend(target.backend),
    llmConnectionSlug: requireEntityId(
      target.llmConnectionSlug,
      'automation LLM connection slug',
    ),
    model: requireUtf8BoundedString(target.model, 'automation model', AUTOMATION_MODEL_MAX_BYTES),
    thinkingLevel:
      target.thinkingLevel === null ? null : thinkingLevel(target.thinkingLevel),
    permissionMode: 'explore',
  };
}

function decodeCurrentFire(value: unknown): AutomationCurrentFireSummary {
  const fire = requireExactRecord(value, 'automation current fire', [
    'fireId',
    'status',
    'admittedAt',
    'runId',
  ]);
  if (fire.status !== 'admitted' && fire.status !== 'running') {
    throw invalidProtocolFrame('Invalid automation current fire status');
  }
  return {
    fireId: requireEntityId(fire.fireId, 'automation fireId'),
    status: fire.status,
    admittedAt: timestamp(fire.admittedAt, 'automation fire admittedAt'),
    runId: fire.runId === null ? null : requireEntityId(fire.runId, 'automation fire runId'),
  };
}

function decodeLastFire(value: unknown): AutomationLastFireSummary {
  const fire = requireExactRecord(value, 'automation last fire', [
    'fireId',
    'status',
    'admittedAt',
    'completedAt',
    'runId',
    'failure',
  ]);
  if (
    fire.status !== 'succeeded' &&
    fire.status !== 'failed' &&
    fire.status !== 'outcome_unknown'
  ) {
    throw invalidProtocolFrame('Invalid automation last fire status');
  }
  const failure =
    fire.failure === null
      ? null
      : requireUtf8BoundedString(
          fire.failure,
          'automation fire failure',
          AUTOMATION_FIRE_FAILURE_MAX_BYTES,
        );
  if ((fire.status === 'failed') !== (failure !== null)) {
    throw invalidProtocolFrame('Automation fire failure must match failed status');
  }
  return {
    fireId: requireEntityId(fire.fireId, 'automation fireId'),
    status: fire.status,
    admittedAt: timestamp(fire.admittedAt, 'automation fire admittedAt'),
    completedAt: timestamp(fire.completedAt, 'automation fire completedAt'),
    runId: fire.runId === null ? null : requireEntityId(fire.runId, 'automation fire runId'),
    failure,
  };
}

function automationKind(value: unknown): AutomationDefinitionInput['kind'] {
  if (value === 'heartbeat' || value === 'cron') return value;
  throw invalidProtocolFrame('Invalid automation kind');
}

function automationBackend(
  value: unknown,
): Extract<AutomationExecutionTarget, { kind: 'fresh_session' }>['backend'] {
  if (value === 'ai-sdk' || value === 'fake' || value === 'pi-agent') return value;
  throw invalidProtocolFrame('Invalid automation backend');
}

function thinkingLevel(value: unknown): AutomationThinkingLevel {
  if (
    value === 'off' ||
    value === 'minimal' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh' ||
    value === 'max'
  ) {
    return value;
  }
  throw invalidProtocolFrame('Invalid automation thinking level');
}

function automationId(value: unknown): string {
  return requireEntityId(value, 'automationId');
}

function automationCursor(value: unknown): string {
  return requireUtf8BoundedString(value, 'automation cursor', AUTOMATION_CURSOR_MAX_BYTES);
}

function pageLimit(value: unknown): number {
  return boundedPositiveInteger(value, 'automation page limit', AUTOMATION_PAGE_MAX_ITEMS);
}

function entityRevision(value: unknown, label: string): AutomationRevision {
  return boundedPositiveInteger(value, label, Number.MAX_SAFE_INTEGER);
}

function catalogRevision(value: unknown, label: string): AutomationCatalogRevision {
  return requireCount(value, label);
}

function nullableCatalogRevision(value: unknown, label: string): AutomationCatalogRevision | null {
  return value === null ? null : catalogRevision(value, label);
}

function timestamp(value: unknown, label: string): number {
  return requireCount(value, label);
}

function boundedPositiveInteger(value: unknown, label: string, maximum: number): number {
  const count = requireCount(value, label);
  if (count === 0 || count > maximum) throw invalidProtocolFrame(`Invalid ${label}`);
  return count;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw invalidProtocolFrame(`Invalid ${label}`);
  return value;
}

function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}
