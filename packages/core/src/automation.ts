import { isThinkingLevel, type ThinkingLevel } from './model-thinking.js';
import type { BackendKind } from './session.js';

export const AUTOMATION_STATUSES = ['enabled', 'disabled', 'exhausted'] as const;
export const AUTOMATION_FIRE_OUTCOME_KINDS = [
  'succeeded',
  'failed',
  'outcome_unknown',
] as const;

export type AutomationStatus = (typeof AUTOMATION_STATUSES)[number];
export type AutomationSchedule =
  | { readonly kind: 'once'; readonly delayMs: number }
  | { readonly kind: 'interval'; readonly intervalMs: number }
  | { readonly kind: 'cron'; readonly expression: string };
export interface AutomationFreshSessionTemplate {
  readonly cwd: string;
  readonly backend: BackendKind;
  readonly llmConnectionSlug: string;
  readonly model: string;
  readonly thinkingLevel?: ThinkingLevel;
  readonly permissionMode: 'explore';
}

export type AutomationTarget =
  | { readonly kind: 'heartbeat'; readonly sessionId: string }
  | {
      readonly kind: 'cron';
      readonly creatorSessionId: string;
      readonly freshSession: AutomationFreshSessionTemplate;
    };

export interface AutomationDefinitionConfig {
  readonly name: string;
  readonly prompt: string;
  readonly target: AutomationTarget;
  readonly schedule: AutomationSchedule;
  readonly maxFireCount: number | null;
  readonly expiresAt: number | null;
}

export interface AutomationDefinition extends AutomationDefinitionConfig {
  readonly automationId: string;
  readonly status: AutomationStatus;
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly nextFireAt: number | null;
  readonly fireCount: number;
}

export interface CreateAutomationDefinitionRequest extends AutomationDefinitionConfig {
  readonly automationId: string;
  readonly createdAt: number;
  readonly nextFireAt: number;
  readonly enabled: boolean;
}

export interface UpdateAutomationDefinitionRequest extends AutomationDefinitionConfig {
  readonly automationId: string;
  readonly expectedRevision: number;
  readonly updatedAt: number;
  readonly nextFireAt: number | null;
}

export interface SetAutomationEnabledRequest {
  readonly automationId: string;
  readonly expectedRevision: number;
  readonly enabled: boolean;
  readonly updatedAt: number;
  readonly nextFireAt: number | null;
}

export interface DeleteAutomationDefinitionRequest {
  readonly automationId: string;
  readonly expectedRevision: number;
  readonly deletedAt: number;
}

export interface AutomationFireAdmission {
  readonly fireId: string;
  readonly automationId: string;
  readonly scheduledFor: number;
  readonly admittedAt: number;
  readonly targetSessionId: string;
  readonly turnId: string;
  readonly runId: string;
  readonly userMessageId: string;
  readonly definitionRevision: number;
}

export interface AdmitAutomationFireRequest {
  readonly admission: Omit<AutomationFireAdmission, 'definitionRevision'>;
  readonly expectedAutomationRevision: number;
  readonly nextFireAt: number | null;
}

export type AutomationFireTerminalOutcome =
  | { readonly kind: 'succeeded'; readonly settledAt: number }
  | {
      readonly kind: 'failed';
      readonly settledAt: number;
      readonly errorCode: string;
      readonly message: string;
    }
  | {
      readonly kind: 'outcome_unknown';
      readonly settledAt: number;
      readonly phase: 'before_run_start' | 'after_run_start';
    };

export interface AutomationFire {
  readonly admission: AutomationFireAdmission;
  readonly definitionAfterAdmission: AutomationDefinition;
  readonly outcome?: AutomationFireTerminalOutcome;
}

export interface SettleAutomationFireRequest {
  readonly fireId: string;
  readonly outcome: AutomationFireTerminalOutcome;
}

export class AutomationDomainDecodeError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = 'AutomationDomainDecodeError';
  }
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const CRON_TOKEN_PATTERN = /^[A-Za-z0-9*?,/\-]+$/;
const encoder = new TextEncoder();

export function decodeAutomationDefinition(value: unknown): AutomationDefinition {
  const item = record(value, 'Automation definition');
  fields(item, [
    'automationId',
    'name',
    'prompt',
    'target',
    'schedule',
    'status',
    'revision',
    'createdAt',
    'updatedAt',
    'nextFireAt',
    'fireCount',
    'maxFireCount',
    'expiresAt',
  ]);
  const definition = {
    automationId: id(item.automationId, 'automationId'),
    ...config(item),
    status: enumeration(item.status, AUTOMATION_STATUSES, 'automation status'),
    revision: positiveInteger(item.revision, 'automation revision'),
    createdAt: timestamp(item.createdAt, 'createdAt'),
    updatedAt: timestamp(item.updatedAt, 'updatedAt'),
    nextFireAt: nullableTimestamp(item.nextFireAt, 'nextFireAt'),
    fireCount: integer(item.fireCount, 'fireCount', 0),
  } satisfies AutomationDefinition;
  if (definition.updatedAt < definition.createdAt) invalid('updatedAt precedes createdAt');
  if (definition.maxFireCount !== null && definition.fireCount > definition.maxFireCount) {
    invalid('fireCount exceeds maxFireCount');
  }
  if (definition.status === 'enabled' && definition.nextFireAt === null) {
    invalid('enabled automation requires nextFireAt');
  }
  if (definition.status !== 'enabled' && definition.nextFireAt !== null) {
    invalid('only enabled automation may have nextFireAt');
  }
  return deepFreeze(definition);
}

export function decodeCreateAutomationDefinitionRequest(
  value: unknown,
): CreateAutomationDefinitionRequest {
  const item = record(value, 'Create automation request');
  fields(item, [
    'automationId',
    'name',
    'prompt',
    'target',
    'schedule',
    'maxFireCount',
    'expiresAt',
    'createdAt',
    'nextFireAt',
    'enabled',
  ]);
  const request = {
    automationId: id(item.automationId, 'automationId'),
    ...config(item),
    createdAt: timestamp(item.createdAt, 'createdAt'),
    nextFireAt: timestamp(item.nextFireAt, 'nextFireAt'),
    enabled: boolean(item.enabled, 'enabled'),
  } satisfies CreateAutomationDefinitionRequest;
  validateInitialDueTime(request.createdAt, request.nextFireAt);
  return deepFreeze(request);
}

export function decodeUpdateAutomationDefinitionRequest(
  value: unknown,
): UpdateAutomationDefinitionRequest {
  const item = record(value, 'Update automation request');
  fields(item, [
    'automationId',
    'expectedRevision',
    'name',
    'prompt',
    'target',
    'schedule',
    'maxFireCount',
    'expiresAt',
    'updatedAt',
    'nextFireAt',
  ]);
  return deepFreeze({
    automationId: id(item.automationId, 'automationId'),
    expectedRevision: positiveInteger(item.expectedRevision, 'expectedRevision'),
    ...config(item),
    updatedAt: timestamp(item.updatedAt, 'updatedAt'),
    nextFireAt: nullableTimestamp(item.nextFireAt, 'nextFireAt'),
  } satisfies UpdateAutomationDefinitionRequest);
}

export function decodeSetAutomationEnabledRequest(value: unknown): SetAutomationEnabledRequest {
  const item = record(value, 'Set automation enabled request');
  fields(item, [
    'automationId',
    'expectedRevision',
    'enabled',
    'updatedAt',
    'nextFireAt',
  ]);
  const enabled = boolean(item.enabled, 'enabled');
  const nextFireAt = nullableTimestamp(item.nextFireAt, 'nextFireAt');
  if (enabled !== (nextFireAt !== null)) invalid('enabled and nextFireAt disagree');
  return Object.freeze({
    automationId: id(item.automationId, 'automationId'),
    expectedRevision: positiveInteger(item.expectedRevision, 'expectedRevision'),
    enabled,
    updatedAt: timestamp(item.updatedAt, 'updatedAt'),
    nextFireAt,
  });
}

export function decodeDeleteAutomationDefinitionRequest(
  value: unknown,
): DeleteAutomationDefinitionRequest {
  const item = record(value, 'Delete automation request');
  fields(item, ['automationId', 'expectedRevision', 'deletedAt']);
  return Object.freeze({
    automationId: id(item.automationId, 'automationId'),
    expectedRevision: positiveInteger(item.expectedRevision, 'expectedRevision'),
    deletedAt: timestamp(item.deletedAt, 'deletedAt'),
  });
}

export function decodeAutomationFireAdmission(value: unknown): AutomationFireAdmission {
  const item = record(value, 'Automation fire admission');
  fields(item, [
    'fireId',
    'automationId',
    'scheduledFor',
    'admittedAt',
    'targetSessionId',
    'turnId',
    'runId',
    'userMessageId',
    'definitionRevision',
  ]);
  return Object.freeze({
    fireId: id(item.fireId, 'fireId'),
    automationId: id(item.automationId, 'automationId'),
    scheduledFor: timestamp(item.scheduledFor, 'scheduledFor'),
    admittedAt: timestamp(item.admittedAt, 'admittedAt'),
    targetSessionId: id(item.targetSessionId, 'targetSessionId'),
    turnId: id(item.turnId, 'turnId'),
    runId: id(item.runId, 'runId'),
    userMessageId: id(item.userMessageId, 'userMessageId'),
    definitionRevision: positiveInteger(item.definitionRevision, 'definitionRevision'),
  });
}

export function decodeAdmitAutomationFireRequest(value: unknown): AdmitAutomationFireRequest {
  const item = record(value, 'Admit automation fire request');
  fields(item, ['admission', 'expectedAutomationRevision', 'nextFireAt']);
  const admission = record(item.admission, 'Proposed automation fire admission');
  fields(admission, [
    'fireId',
    'automationId',
    'scheduledFor',
    'admittedAt',
    'targetSessionId',
    'turnId',
    'runId',
    'userMessageId',
  ]);
  return deepFreeze({
    admission: {
      fireId: id(admission.fireId, 'fireId'),
      automationId: id(admission.automationId, 'automationId'),
      scheduledFor: timestamp(admission.scheduledFor, 'scheduledFor'),
      admittedAt: timestamp(admission.admittedAt, 'admittedAt'),
      targetSessionId: id(admission.targetSessionId, 'targetSessionId'),
      turnId: id(admission.turnId, 'turnId'),
      runId: id(admission.runId, 'runId'),
      userMessageId: id(admission.userMessageId, 'userMessageId'),
    },
    expectedAutomationRevision: positiveInteger(
      item.expectedAutomationRevision,
      'expectedAutomationRevision',
    ),
    nextFireAt: nullableTimestamp(item.nextFireAt, 'nextFireAt'),
  });
}

export function decodeAutomationFireTerminalOutcome(
  value: unknown,
): AutomationFireTerminalOutcome {
  const item = record(value, 'Automation fire terminal outcome');
  if (item.kind === 'succeeded') {
    fields(item, ['kind', 'settledAt']);
    return Object.freeze({ kind: 'succeeded', settledAt: timestamp(item.settledAt, 'settledAt') });
  }
  if (item.kind === 'failed') {
    fields(item, ['kind', 'settledAt', 'errorCode', 'message']);
    return Object.freeze({
      kind: 'failed',
      settledAt: timestamp(item.settledAt, 'settledAt'),
      errorCode: text(item.errorCode, 'errorCode', 128, false),
      message: text(item.message, 'message', 4096, false),
    });
  }
  if (item.kind === 'outcome_unknown') {
    fields(item, ['kind', 'settledAt', 'phase']);
    return Object.freeze({
      kind: 'outcome_unknown',
      settledAt: timestamp(item.settledAt, 'settledAt'),
      phase: enumeration(
        item.phase,
        ['before_run_start', 'after_run_start'] as const,
        'outcome unknown phase',
      ),
    });
  }
  return invalid('unknown Automation fire outcome kind');
}

export function decodeAutomationFire(value: unknown): AutomationFire {
  const item = record(value, 'Automation fire');
  fields(
    item,
    ['admission', 'definitionAfterAdmission'],
    ['outcome'],
  );
  const fire: AutomationFire = {
    admission: decodeAutomationFireAdmission(item.admission),
    definitionAfterAdmission: decodeAutomationDefinition(item.definitionAfterAdmission),
    ...(item.outcome === undefined
      ? {}
      : { outcome: decodeAutomationFireTerminalOutcome(item.outcome) }),
  };
  if (fire.outcome && fire.outcome.settledAt < fire.admission.admittedAt) {
    invalid('fire settledAt precedes admittedAt');
  }
  if (
    fire.definitionAfterAdmission.automationId !== fire.admission.automationId ||
    fire.definitionAfterAdmission.revision !== fire.admission.definitionRevision + 1
  ) {
    invalid('fire definition snapshot does not follow the admission revision');
  }
  return deepFreeze(fire);
}

export function decodeSettleAutomationFireRequest(value: unknown): SettleAutomationFireRequest {
  const item = record(value, 'Settle automation fire request');
  fields(item, ['fireId', 'outcome']);
  return deepFreeze({
    fireId: id(item.fireId, 'fireId'),
    outcome: decodeAutomationFireTerminalOutcome(item.outcome),
  });
}

function config(item: Record<string, unknown>): AutomationDefinitionConfig {
  const parsed = {
    name: text(item.name, 'name', 256, false),
    prompt: text(item.prompt, 'prompt', 32 * 1024, false),
    target: decodeTarget(item.target),
    schedule: decodeSchedule(item.schedule),
    maxFireCount: nullablePositiveInteger(item.maxFireCount, 'maxFireCount'),
    expiresAt: nullableTimestamp(item.expiresAt, 'expiresAt'),
  };
  return parsed;
}

function decodeTarget(value: unknown): AutomationTarget {
  const item = record(value, 'Automation target');
  if (item.kind === 'heartbeat') {
    fields(item, ['kind', 'sessionId']);
    return Object.freeze({ kind: 'heartbeat', sessionId: id(item.sessionId, 'sessionId') });
  }
  if (item.kind === 'cron') {
    fields(item, ['kind', 'creatorSessionId', 'freshSession']);
    const template = record(item.freshSession, 'Automation fresh-session template');
    fields(
      template,
      ['cwd', 'backend', 'llmConnectionSlug', 'model', 'permissionMode'],
      ['thinkingLevel'],
    );
    if (template.permissionMode !== 'explore') {
      invalid("Automation fresh-session permissionMode must be 'explore'");
    }
    const backend = enumeration(
      template.backend,
      ['ai-sdk', 'fake', 'pi-agent'] as const,
      'backend',
    );
    const thinkingLevel =
      template.thinkingLevel === undefined
        ? undefined
        : isThinkingLevel(template.thinkingLevel)
          ? template.thinkingLevel
          : invalid('thinkingLevel is invalid');
    return deepFreeze({
      kind: 'cron',
      creatorSessionId: id(item.creatorSessionId, 'creatorSessionId'),
      freshSession: {
        cwd: text(template.cwd, 'cwd', 4096, false),
        backend,
        llmConnectionSlug: text(template.llmConnectionSlug, 'llmConnectionSlug', 256, false),
        model: text(template.model, 'model', 512, false),
        ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
        permissionMode: 'explore',
      },
    });
  }
  return invalid('unknown Automation target kind');
}

function decodeSchedule(value: unknown): AutomationSchedule {
  const item = record(value, 'Automation schedule');
  if (item.kind === 'once') {
    fields(item, ['kind', 'delayMs']);
    return Object.freeze({
      kind: 'once',
      delayMs: integer(item.delayMs, 'schedule.delayMs', 1000),
    });
  }
  if (item.kind === 'interval') {
    fields(item, ['kind', 'intervalMs']);
    return Object.freeze({
      kind: 'interval',
      intervalMs: integer(item.intervalMs, 'schedule.intervalMs', 1000),
    });
  }
  if (item.kind === 'cron') {
    fields(item, ['kind', 'expression']);
    const expression = text(item.expression, 'schedule.expression', 256, false);
    const tokens = expression.split(' ');
    if (tokens.length !== 5 || tokens.some((token) => !CRON_TOKEN_PATTERN.test(token))) {
      invalid('cron expression must use canonical five-field syntax');
    }
    return Object.freeze({ kind: 'cron', expression });
  }
  return invalid('unknown Automation schedule kind');
}

function validateInitialDueTime(createdAt: number, next: number) {
  if (next < createdAt) invalid('nextFireAt precedes createdAt');
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return invalid(`${context} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return invalid(`${context} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function fields(
  item: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
) {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(item)) if (!allowed.has(key)) invalid(`unknown field '${key}'`);
  for (const key of required) if (!Object.hasOwn(item, key)) invalid(`missing field '${key}'`);
}

function id(value: unknown, context: string): string {
  const parsed = text(value, context, 128, false);
  if (!ID_PATTERN.test(parsed)) invalid(`${context} has invalid characters`);
  return parsed;
}

function text(value: unknown, context: string, maxBytes: number, allowEmpty: boolean): string {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && value.length === 0) ||
    value.normalize('NFC') !== value ||
    encoder.encode(value).byteLength > maxBytes ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  ) {
    return invalid(`${context} is not canonical bounded text`);
  }
  return value;
}

function integer(value: unknown, context: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    return invalid(`${context} must be a safe integer >= ${minimum}`);
  }
  return value as number;
}
function positiveInteger(value: unknown, context: string) {
  return integer(value, context, 1);
}
function timestamp(value: unknown, context: string) {
  return integer(value, context, 0);
}
function nullableTimestamp(value: unknown, context: string): number | null {
  return value === null ? null : timestamp(value, context);
}
function nullablePositiveInteger(value: unknown, context: string): number | null {
  return value === null ? null : positiveInteger(value, context);
}
function boolean(value: unknown, context: string): boolean {
  if (typeof value !== 'boolean') return invalid(`${context} must be a boolean`);
  return value;
}
function enumeration<T extends string>(
  value: unknown,
  values: readonly T[],
  context: string,
): T {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    return invalid(`${context} is invalid`);
  }
  return value as T;
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
function invalid(message: string): never {
  throw new AutomationDomainDecodeError(message);
}
