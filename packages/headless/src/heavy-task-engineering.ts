import type { MakaTool, MakaToolContext } from '@maka/runtime';
import { z } from 'zod';
import { validateHeavyTaskPublicSelfCheck } from './heavy-task-self-check.js';
import type {
  HeavyTaskEngineeringCompleteness,
  HeavyTaskEngineeringLinks,
  HeavyTaskEngineeringRecord,
  HeavyTaskEngineeringRecordKind,
  HeavyTaskSourceGuardResult,
  TaskEvent,
  TaskRunArtifact,
} from './task-contracts.js';
import type { TaskRunProjection, TaskRunStore } from './task-run-store.js';

export const HEAVY_TASK_ENGINEERING_SCHEMA_VERSION = 1;
export const HEAVY_TASK_ENGINEERING_TOOL_NAMES = ['engineering_record', 'check_record'] as const;
export const DEFAULT_PROMPT_ENGINEERING_LIMIT = 8;
export const DEFAULT_EXPORT_ENGINEERING_LIMIT = 25;

const MAX_TEXT_CHARS = 2_000;
const MAX_SHORT_TEXT_CHARS = 500;
const MAX_COMMAND_CHARS = 1_000;
const MAX_ITEMS = 50;
const ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

const stableIdSchema = z.string().trim().min(1).max(120).regex(ID_PATTERN);
const textSchema = z.string().trim().min(1).max(MAX_TEXT_CHARS);
const shortTextSchema = z.string().trim().min(1).max(MAX_SHORT_TEXT_CHARS);
const idArraySchema = z.array(stableIdSchema).max(MAX_ITEMS).optional();
const fileArraySchema = z.array(shortTextSchema).max(MAX_ITEMS).optional();
const completenessSchema = z.enum(['complete', 'incomplete']).optional();
const recordStatusSchema = z.enum(['proposed', 'running', 'passed', 'failed', 'repaired', 'superseded', 'abandoned']);

const linksSchema = z.object({
  todoIds: idArraySchema,
  evidenceIds: idArraySchema,
  toolCallIds: idArraySchema,
  checkIds: idArraySchema,
  artifactIds: idArraySchema,
  changedFiles: fileArraySchema,
  patchIds: idArraySchema,
  hypothesisIds: idArraySchema,
  repairIds: idArraySchema,
}).strict().optional();

type EngineeringInputLinks = Partial<HeavyTaskEngineeringLinks>;
type RefinableRecordInput = {
  completeness?: string;
  incompleteReason?: string;
  links?: EngineeringInputLinks;
  kind?: string;
  hypothesis?: { rationaleEvidenceIds?: string[] };
  repair?: { failedCheckIds?: string[] };
  patch?: { changedFiles?: string[]; mutationEvidenceIds?: string[] };
};

const baseRecordSchema = z.object({
  title: textSchema,
  summary: textSchema,
  status: recordStatusSchema,
  completeness: completenessSchema,
  incompleteReason: textSchema.optional(),
  links: linksSchema,
}).strict();

export const engineeringRecordSubmitSchema = baseRecordSchema.extend({
  kind: z.enum(['hypothesis', 'repair', 'patch']),
  hypothesis: z.object({
    expectedSignal: textSchema,
    rationaleEvidenceIds: z.array(stableIdSchema).max(MAX_ITEMS).optional(),
  }).strict().optional(),
  repair: z.object({
    failedCheckIds: z.array(stableIdSchema).max(MAX_ITEMS).optional(),
    hypothesisId: stableIdSchema.optional(),
    repairStrategy: textSchema,
    outcome: z.enum(['not_checked', 'check_passed', 'check_failed', 'inconclusive']),
  }).strict().optional(),
  patch: z.object({
    changedFiles: z.array(shortTextSchema).max(MAX_ITEMS).optional(),
    changeSummary: textSchema,
    mutationEvidenceIds: z.array(stableIdSchema).max(MAX_ITEMS).optional(),
  }).strict().optional(),
}).superRefine((value, ctx) => {
  refineCommonRecord(value, ctx);
  if (value.kind === 'hypothesis' && !value.hypothesis) {
    issue(ctx, ['hypothesis'], 'hypothesis payload is required');
  }
  if (value.kind === 'repair' && !value.repair) {
    issue(ctx, ['repair'], 'repair payload is required');
  }
  if (value.kind === 'patch' && !value.patch) {
    issue(ctx, ['patch'], 'patch payload is required');
  }
});

export const checkRecordSubmitSchema = baseRecordSchema.extend({
  command: z.string().trim().min(1).max(MAX_COMMAND_CHARS).optional(),
  expectedSignal: textSchema,
  observedSignal: textSchema,
  result: z.enum(['pass', 'fail', 'inconclusive']),
}).superRefine(refineCommonRecord);

export type EngineeringRecordSubmitInput = z.infer<typeof engineeringRecordSubmitSchema>;
export type CheckRecordSubmitInput = z.infer<typeof checkRecordSubmitSchema>;

export interface HeavyTaskEngineeringRecorder {
  recordEngineering(
    input: EngineeringRecordSubmitInput,
    ctx: MakaToolContext,
  ): Promise<HeavyTaskEngineeringRecordResult>;
  recordCheck(
    input: CheckRecordSubmitInput,
    ctx: MakaToolContext,
  ): Promise<HeavyTaskEngineeringRecordResult & { checkId: string }>;
}

export type HeavyTaskEngineeringRecordResult =
  | {
      accepted: true;
      record: HeavyTaskEngineeringRecord;
      missingLinks: string[];
      complete: boolean;
    }
  | {
      accepted: false;
      guard: HeavyTaskSourceGuardResult & { status: 'rejected' };
    };

export function createHeavyTaskEngineeringRecorder(input: {
  taskRunId: string;
  attemptId?: string;
  store: TaskRunStore;
  now: () => number;
  newId: () => string;
}): HeavyTaskEngineeringRecorder {
  return {
    async recordEngineering(rawArgs, ctx) {
      const args = engineeringRecordSubmitSchema.parse(rawArgs);
      const ts = input.now();
      const guard = validateEngineeringStrings(args, ts);
      if (!guard.ok) return { accepted: false, guard: guard.guard };
      const record = buildEngineeringRecord({ args, ctx, ts, taskRunId: input.taskRunId, attemptId: input.attemptId, newId: input.newId });
      await rejectDuplicateRecordRefs(record, input.store, input.taskRunId);
      const projected = resolveHeavyTaskEngineeringRecordLinks(record, await input.store.project(input.taskRunId));
      await appendRecord(input.store, input.taskRunId, projected, ts, input.newId);
      return recordResult(projected);
    },
    async recordCheck(rawArgs, ctx) {
      const args = checkRecordSubmitSchema.parse(rawArgs);
      const ts = input.now();
      const guard = validateEngineeringStrings({ kind: 'targeted_check', ...args }, ts);
      if (!guard.ok) return { accepted: false, guard: guard.guard, checkId: '' };
      const record = buildCheckRecord({ args, ctx, ts, taskRunId: input.taskRunId, attemptId: input.attemptId, newId: input.newId });
      await rejectDuplicateRecordRefs(record, input.store, input.taskRunId);
      const projected = resolveHeavyTaskEngineeringRecordLinks(record, await input.store.project(input.taskRunId));
      await appendRecord(input.store, input.taskRunId, projected, ts, input.newId);
      return { ...recordResult(projected), checkId: projected.targetedCheck!.checkId };
    },
  };
}

export function buildHeavyTaskEngineeringTools(recorder: HeavyTaskEngineeringRecorder): MakaTool[] {
  return [
    {
      name: 'engineering_record',
      description: 'Record a structured heavy-task hypothesis, repair, or patch summary linked to todos, checks, files, artifacts, and compact evidence ids.',
      parameters: engineeringRecordSubmitSchema,
      permissionRequired: false,
      impl: async (args, ctx) => recorder.recordEngineering(engineeringRecordSubmitSchema.parse(args), ctx),
    },
    {
      name: 'check_record',
      description: 'Record a structured targeted check linked to todo ids, tool call ids, and compact evidence envelope ids.',
      parameters: checkRecordSubmitSchema,
      permissionRequired: false,
      impl: async (args, ctx) => recorder.recordCheck(checkRecordSubmitSchema.parse(args), ctx),
    },
  ];
}

export function resolveHeavyTaskEngineeringRecordLinks(
  record: HeavyTaskEngineeringRecord,
  projection: Pick<TaskRunProjection, 'latestHeavyTaskTodos' | 'heavyTaskEvidence' | 'artifacts' | 'heavyTaskEngineeringRecords'>,
): HeavyTaskEngineeringRecord {
  const todoIds = new Set(projection.latestHeavyTaskTodos?.items.map((item) => item.id) ?? []);
  const evidenceIds = new Set(projection.heavyTaskEvidence.map((item) => item.evidenceId));
  const artifactIds = new Set(projection.artifacts.map((item) => item.artifactId));
  const checkIds = new Set<string>();
  for (const check of projection.heavyTaskEvidence.flatMap((item) => [item.check?.checkId, item.check?.linkedSelfCheckId, ...(item.links?.checkIds ?? [])])) {
    if (check) checkIds.add(check);
  }
  for (const item of projection.heavyTaskEngineeringRecords) {
    if (item.targetedCheck?.checkId) checkIds.add(item.targetedCheck.checkId);
  }
  if (record.targetedCheck?.checkId) {
    checkIds.add(record.targetedCheck.checkId);
  }

  const missingTodoIds = missing(record.links.todoIds, todoIds);
  const missingEvidenceIds = missing(record.links.evidenceIds, evidenceIds);
  const missingArtifactIds = missing(record.links.artifactIds, artifactIds);
  const missingCheckIds = missing(record.links.checkIds, checkIds);
  const projectionState = { missingTodoIds, missingEvidenceIds, missingArtifactIds, missingCheckIds };
  const missingRequired = missingRequiredLinksForRecord(record);
  const hasMissing = missingTodoIds.length
    + missingEvidenceIds.length
    + missingArtifactIds.length
    + missingCheckIds.length
    + missingRequired.length > 0;
  if (!hasMissing) return { ...record, projection: projectionState };
  return {
    ...record,
    completeness: 'incomplete',
    incompleteReason: record.incompleteReason ?? (
      missingRequired.length > 0
        ? `Required links are missing for a complete ${record.kind} record: ${missingRequired.join(', ')}.`
        : 'Referenced todo, evidence, artifact, or check links were not found during task-run replay.'
    ),
    projection: projectionState,
  };
}

export function isPublicHeavyTaskEngineeringRecord(record: HeavyTaskEngineeringRecord, now = record.ts): boolean {
  return validateEngineeringStrings(record, now).ok;
}

export function renderHeavyTaskEngineeringForPrompt(projection: {
  heavyTaskEngineeringRecords?: HeavyTaskEngineeringRecord[];
}): string | undefined {
  const records = projection.heavyTaskEngineeringRecords ?? [];
  if (records.length === 0) return undefined;
  const recent = records.slice(-DEFAULT_PROMPT_ENGINEERING_LIMIT);
  const lines = ['Heavy-task structured engineering loop records from prior task-run events:'];
  for (const record of recent) {
    const missing = missingSummary(record);
    lines.push(`- ${record.recordId} ${record.kind} status=${record.status} completeness=${record.completeness}${missing}`);
    lines.push(`  - todos=${joinOrNone(record.links.todoIds)} checks=${joinOrNone(record.links.checkIds)} evidence=${joinOrNone(record.links.evidenceIds)}`);
    if (record.links.changedFiles.length > 0) lines.push(`  - changedFiles=${record.links.changedFiles.slice(0, 6).map((file) => oneLine(file, 80)).join(', ')}`);
    lines.push(`  - ${oneLine(record.title, 120)}: ${oneLine(record.summary, 180)}`);
  }
  if (records.length > recent.length) {
    lines.push(`- ${records.length - recent.length} older engineering record(s) omitted`);
  }
  lines.push('Continue linking engineering_record/check_record submissions to current todo ids, check ids, compact evidence ids, tool call ids, and changed files/artifacts.');
  return lines.join('\n');
}

export function compactHeavyTaskEngineeringState(records: readonly HeavyTaskEngineeringRecord[]): {
  latest: HeavyTaskEngineeringRecord;
  recent: HeavyTaskEngineeringRecord[];
  historyCount: number;
  incompleteCount: number;
} | undefined {
  if (records.length === 0) return undefined;
  return {
    latest: records[records.length - 1],
    recent: records.slice(-DEFAULT_EXPORT_ENGINEERING_LIMIT),
    historyCount: records.length,
    incompleteCount: records.filter((record) => record.completeness === 'incomplete').length,
  };
}

function buildEngineeringRecord(input: {
  args: EngineeringRecordSubmitInput;
  ctx: MakaToolContext;
  ts: number;
  taskRunId: string;
  attemptId?: string;
  newId: () => string;
}): HeavyTaskEngineeringRecord {
  const id = input.newId();
  const links = normalizeLinks(input.args.links);
  const completeness = completenessFor(input.args);
  const base = baseRecord(input, id, input.args.kind, completeness, links, 'engineering_record');
  if (input.args.kind === 'hypothesis') {
    const hypothesis = input.args.hypothesis!;
    const rationaleEvidenceIds = unique(hypothesis.rationaleEvidenceIds ?? []);
    return {
      ...base,
      links: { ...links, evidenceIds: unique([...links.evidenceIds, ...rationaleEvidenceIds]) },
      hypothesis: { expectedSignal: hypothesis.expectedSignal, rationaleEvidenceIds },
    };
  }
  if (input.args.kind === 'repair') {
    const repair = input.args.repair!;
    const failedCheckIds = unique(repair.failedCheckIds ?? input.args.links?.checkIds ?? []);
    return {
      ...base,
      links: { ...links, checkIds: unique([...links.checkIds, ...failedCheckIds]), hypothesisIds: unique([...links.hypothesisIds, repair.hypothesisId].filter(isString)) },
      repair: {
        failedCheckIds,
        ...(repair.hypothesisId ? { hypothesisId: repair.hypothesisId } : {}),
        repairStrategy: repair.repairStrategy,
        outcome: repair.outcome,
      },
    };
  }
  const patch = input.args.patch!;
  const patchId = input.newId();
  const changedFiles = unique(patch.changedFiles ?? links.changedFiles);
  const mutationEvidenceIds = unique(patch.mutationEvidenceIds ?? []);
  return {
    ...base,
    links: {
      ...links,
      evidenceIds: unique([...links.evidenceIds, ...mutationEvidenceIds]),
      changedFiles,
      patchIds: unique([...links.patchIds, patchId]),
    },
    patch: {
      patchId,
      changedFiles,
      changeSummary: patch.changeSummary,
      mutationEvidenceIds,
    },
  };
}

function buildCheckRecord(input: {
  args: CheckRecordSubmitInput;
  ctx: MakaToolContext;
  ts: number;
  taskRunId: string;
  attemptId?: string;
  newId: () => string;
}): HeavyTaskEngineeringRecord {
  const checkId = input.newId();
  const links = normalizeLinks(input.args.links);
  const toolCallIds = unique([...links.toolCallIds, input.ctx.toolCallId]);
  return {
    ...baseRecord(input, input.newId(), 'targeted_check', completenessFor(input.args), {
      ...links,
      toolCallIds,
      checkIds: unique([...links.checkIds, checkId]),
    }, 'check_record'),
    targetedCheck: {
      checkId,
      ...(input.args.command ? { command: input.args.command } : {}),
      expectedSignal: input.args.expectedSignal,
      observedSignal: input.args.observedSignal,
      result: input.args.result,
    },
  };
}

function baseRecord(
  input: { args: EngineeringRecordSubmitInput | CheckRecordSubmitInput; ctx: MakaToolContext; ts: number; taskRunId: string; attemptId?: string },
  recordId: string,
  kind: HeavyTaskEngineeringRecordKind,
  completeness: HeavyTaskEngineeringCompleteness,
  links: HeavyTaskEngineeringLinks,
  toolName: 'engineering_record' | 'check_record',
): Omit<HeavyTaskEngineeringRecord, 'hypothesis' | 'targetedCheck' | 'repair' | 'patch'> {
  return {
    schemaVersion: HEAVY_TASK_ENGINEERING_SCHEMA_VERSION,
    recordId,
    taskRunId: input.taskRunId,
    ...(input.attemptId ? { attemptId: input.attemptId } : {}),
    ts: input.ts,
    kind,
    title: input.args.title,
    summary: input.args.summary,
    status: input.args.status,
    completeness,
    ...(input.args.incompleteReason ? { incompleteReason: input.args.incompleteReason } : {}),
    source: {
      kind: 'model_tool',
      toolCallId: input.ctx.toolCallId,
      ...(input.ctx.sessionId ? { sessionId: input.ctx.sessionId } : {}),
      ...(input.ctx.turnId ? { turnId: input.ctx.turnId } : {}),
      toolName,
    },
    links,
  };
}

function completenessFor(input: EngineeringRecordSubmitInput | CheckRecordSubmitInput): HeavyTaskEngineeringCompleteness {
  return input.completeness ?? 'complete';
}

function normalizeLinks(input: EngineeringInputLinks | undefined): HeavyTaskEngineeringLinks {
  return {
    todoIds: unique(input?.todoIds ?? []),
    evidenceIds: unique(input?.evidenceIds ?? []),
    toolCallIds: unique(input?.toolCallIds ?? []),
    checkIds: unique(input?.checkIds ?? []),
    artifactIds: unique(input?.artifactIds ?? []),
    changedFiles: unique(input?.changedFiles ?? []),
    patchIds: unique(input?.patchIds ?? []),
    hypothesisIds: unique(input?.hypothesisIds ?? []),
    repairIds: unique(input?.repairIds ?? []),
  };
}

function refineCommonRecord(value: RefinableRecordInput, ctx: z.RefinementCtx): void {
  const completeness = value.completeness ?? 'complete';
  if (completeness === 'incomplete' && !value.incompleteReason) {
    issue(ctx, ['incompleteReason'], 'incomplete records require incompleteReason');
  }
  if (completeness === 'complete') {
    const missing = requiredMissing(value);
    for (const item of missing) issue(ctx, [item], `complete ${value.kind ?? 'targeted_check'} record requires ${item}`);
  }
  for (const [name, values] of Object.entries(value.links ?? {})) {
    if (Array.isArray(values) && values.length !== new Set(values).size) {
      issue(ctx, ['links', name], `duplicate ids in ${name}`);
    }
  }
}

function requiredMissing(value: RefinableRecordInput): string[] {
  const links = normalizeLinks(value.links);
  if (value.kind === 'hypothesis') {
    return [
      links.todoIds.length === 0 ? 'todoIds' : '',
      (value.hypothesis?.rationaleEvidenceIds?.length ?? 0) === 0 ? 'rationaleEvidenceIds' : '',
    ].filter(Boolean);
  }
  if (value.kind === 'repair') {
    return [
      links.todoIds.length === 0 ? 'todoIds' : '',
      (value.repair?.failedCheckIds?.length ?? links.checkIds.length) === 0 ? 'failedCheckIds' : '',
      links.changedFiles.length === 0 && links.artifactIds.length === 0 ? 'changedFiles or artifactIds' : '',
    ].filter(Boolean);
  }
  if (value.kind === 'patch') {
    return [
      links.todoIds.length === 0 ? 'todoIds' : '',
      (value.patch?.changedFiles?.length ?? links.changedFiles.length) === 0 && links.artifactIds.length === 0 ? 'changedFiles or artifactIds' : '',
      (value.patch?.mutationEvidenceIds?.length ?? 0) === 0 ? 'mutationEvidenceIds' : '',
    ].filter(Boolean);
  }
  return [
    links.todoIds.length === 0 ? 'todoIds' : '',
    links.toolCallIds.length === 0 ? 'toolCallIds' : '',
    links.evidenceIds.length === 0 ? 'evidenceIds' : '',
  ].filter(Boolean);
}

function missingRequiredLinksForRecord(record: HeavyTaskEngineeringRecord): string[] {
  if (record.completeness === 'incomplete') return [];
  if (record.kind === 'hypothesis') {
    return [
      record.links.todoIds.length === 0 ? 'todoIds' : '',
      !record.hypothesis ? 'hypothesis' : '',
      ((record.hypothesis?.rationaleEvidenceIds.length ?? 0) + record.links.evidenceIds.length) === 0 ? 'rationaleEvidenceIds' : '',
    ].filter(Boolean);
  }
  if (record.kind === 'targeted_check') {
    return [
      record.links.todoIds.length === 0 ? 'todoIds' : '',
      record.links.toolCallIds.length === 0 ? 'toolCallIds' : '',
      record.links.evidenceIds.length === 0 ? 'evidenceIds' : '',
      !record.targetedCheck?.checkId ? 'checkId' : '',
    ].filter(Boolean);
  }
  if (record.kind === 'repair') {
    return [
      record.links.todoIds.length === 0 ? 'todoIds' : '',
      !record.repair ? 'repair' : '',
      ((record.repair?.failedCheckIds.length ?? 0) + record.links.checkIds.length) === 0 ? 'failedCheckIds' : '',
      record.links.changedFiles.length === 0 && record.links.artifactIds.length === 0 ? 'changedFiles or artifactIds' : '',
    ].filter(Boolean);
  }
  return [
    record.links.todoIds.length === 0 ? 'todoIds' : '',
    !record.patch?.patchId ? 'patchId' : '',
    record.links.changedFiles.length === 0 && record.links.artifactIds.length === 0 ? 'changedFiles or artifactIds' : '',
    ((record.patch?.mutationEvidenceIds.length ?? 0) + record.links.evidenceIds.length) === 0 ? 'mutationEvidenceIds' : '',
  ].filter(Boolean);
}

function validateEngineeringStrings(value: unknown, now: number): { ok: true } | { ok: false; guard: HeavyTaskSourceGuardResult & { status: 'rejected' } } {
  const categories = new Set<string>();
  for (const text of stringsFrom(value)) {
    const validation = validateHeavyTaskPublicSelfCheck({ publicReason: text.slice(0, MAX_TEXT_CHARS) }, now);
    if (!validation.ok) validation.guard.categories.forEach((category) => categories.add(category));
  }
  if (categories.size === 0) return { ok: true };
  return {
    ok: false,
    guard: {
      status: 'rejected',
      checkedAt: now,
      categories: [...categories].sort(),
      publicReason: 'Rejected because submitted engineering record referenced private, hidden, or evaluator-only material.',
    },
  };
}

function stringsFrom(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringsFrom);
  if (!value || typeof value !== 'object') return [];
  const out: string[] = [];
  for (const [key, item] of Object.entries(value)) {
    if (['title', 'summary', 'incompleteReason', 'expectedSignal', 'observedSignal', 'command', 'changeSummary', 'repairStrategy', 'changedFiles'].includes(key)) {
      out.push(...stringsFrom(item));
    } else if (typeof item === 'object') {
      out.push(...stringsFrom(item));
    }
  }
  return out.filter((item) => item.trim().length > 0);
}

async function rejectDuplicateRecordRefs(record: HeavyTaskEngineeringRecord, store: TaskRunStore, taskRunId: string): Promise<void> {
  const projection = await store.project(taskRunId);
  const recordIds = new Set(projection.heavyTaskEngineeringRecords.map((item) => item.recordId));
  const checkIds = new Set(projection.heavyTaskEngineeringRecords.map((item) => item.targetedCheck?.checkId).filter(isString));
  const patchIds = new Set(projection.heavyTaskEngineeringRecords.map((item) => item.patch?.patchId).filter(isString));
  if (recordIds.has(record.recordId)) throw new Error(`duplicate engineering record id: ${record.recordId}`);
  if (record.targetedCheck && checkIds.has(record.targetedCheck.checkId)) throw new Error(`duplicate check id: ${record.targetedCheck.checkId}`);
  if (record.patch && patchIds.has(record.patch.patchId)) throw new Error(`duplicate patch id: ${record.patch.patchId}`);
}

async function appendRecord(
  store: TaskRunStore,
  taskRunId: string,
  record: HeavyTaskEngineeringRecord,
  ts: number,
  newId: () => string,
): Promise<void> {
  await store.appendEvent(taskRunId, {
    type: 'heavy_task_engineering_recorded',
    id: newId(),
    taskRunId,
    ts,
    record,
  });
}

function recordResult(record: HeavyTaskEngineeringRecord): Extract<HeavyTaskEngineeringRecordResult, { accepted: true }> {
  const missingLinks = [
    ...record.projection?.missingTodoIds ?? [],
    ...record.projection?.missingEvidenceIds ?? [],
    ...record.projection?.missingArtifactIds ?? [],
    ...record.projection?.missingCheckIds ?? [],
  ];
  return {
    accepted: true,
    record,
    missingLinks,
    complete: record.completeness === 'complete',
  };
}

function missing(values: readonly string[], known: Set<string>): string[] {
  return values.filter((value) => !known.has(value));
}

function missingSummary(record: HeavyTaskEngineeringRecord): string {
  const parts: string[] = [];
  if (record.projection?.missingTodoIds.length) parts.push(`missingTodos=${record.projection.missingTodoIds.join(',')}`);
  if (record.projection?.missingEvidenceIds.length) parts.push(`missingEvidence=${record.projection.missingEvidenceIds.join(',')}`);
  if (record.projection?.missingArtifactIds.length) parts.push(`missingArtifacts=${record.projection.missingArtifactIds.join(',')}`);
  if (record.projection?.missingCheckIds.length) parts.push(`missingChecks=${record.projection.missingCheckIds.join(',')}`);
  return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}

function joinOrNone(values: readonly string[]): string {
  return values.length > 0 ? values.slice(0, 8).join(',') : 'none';
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function oneLine(value: string, maxChars: number): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean.length <= maxChars ? clean : `${clean.slice(0, Math.max(0, maxChars - 3))}...`;
}

function issue(ctx: z.RefinementCtx, path: (string | number)[], message: string): void {
  ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export type HeavyTaskEngineeringEvent = Extract<TaskEvent, { type: 'heavy_task_engineering_recorded' }>;
export type HeavyTaskEngineeringArtifactLink = Pick<TaskRunArtifact, 'artifactId'>;
