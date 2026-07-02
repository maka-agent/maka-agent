import type { MakaTool, MakaToolContext } from '@maka/runtime';
import { z } from 'zod';
import type {
  HeavyTaskArtifactEvidence,
  HeavyTaskCommandEvidence,
  HeavyTaskSemanticSelfCheckState,
  HeavyTaskSelfCheckExecutionHygiene,
  HeavyTaskSourceGuardResult,
  TaskEvent,
} from './task-contracts.js';
import type { TaskRunStore } from './task-run-store.js';

export const HEAVY_TASK_SELF_CHECK_TOOL_NAMES = ['self_check_submit'] as const;

const MAX_REASON_CHARS = 2_000;
const MAX_COMMAND_CHARS = 1_000;
const MAX_OUTPUT_CHARS = 2_000;
const MAX_PATH_CHARS = 500;
const MAX_HASH_CHARS = 200;
const MAX_EVIDENCE_ITEMS = 25;
const MAX_ARTIFACT_REFS = 20;
const MAX_METADATA_KEYS = 30;
const MAX_METADATA_DEPTH = 3;
const MAX_METADATA_STRING_CHARS = 500;
const MAX_GUARD_STRING_CHARS = 2_000;

const metadataValueSchema: z.ZodType<unknown> = z.lazy(() => z.union([
  z.string().max(MAX_METADATA_STRING_CHARS),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(metadataValueSchema).max(MAX_METADATA_KEYS),
  z.record(z.string(), metadataValueSchema),
]));

export const heavyTaskCommandEvidenceSchema = z.object({
  command: z.string().trim().min(1).max(MAX_COMMAND_CHARS),
  exitCode: z.number().int().optional().nullable(),
  timedOut: z.boolean().optional(),
  outputExcerpt: z.string().trim().min(1).max(MAX_OUTPUT_CHARS).optional(),
  artifactRefs: z.array(z.string().trim().min(1).max(MAX_PATH_CHARS)).max(MAX_ARTIFACT_REFS).optional(),
}).strict();

export const heavyTaskArtifactEvidenceSchema = z.object({
  path: z.string().trim().min(1).max(MAX_PATH_CHARS),
  kind: z.enum(['file', 'directory', 'log', 'build_output', 'generated_output', 'other']),
  exists: z.boolean().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  hash: z.string().trim().min(1).max(MAX_HASH_CHARS).optional(),
  metadata: z.record(z.string(), metadataValueSchema).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.metadata && !metadataWithinBounds(value.metadata)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['metadata'],
      message: `artifact metadata must be bounded to depth ${MAX_METADATA_DEPTH}`,
    });
  }
});

export const heavyTaskSelfCheckExecutionHygieneSchema = z.object({
  sandbox: z.object({
    root: z.string().trim().min(1).max(MAX_PATH_CHARS),
    strategy: z.enum(['scratch_dir', 'copied_inputs', 'read_only_deliverable_refs']).optional(),
    inputPaths: z.array(z.string().trim().min(1).max(MAX_PATH_CHARS)).max(MAX_ARTIFACT_REFS).optional(),
    commandCwd: z.string().trim().min(1).max(MAX_PATH_CHARS).optional(),
    outputPolicy: z.enum(['scratch_only', 'read_only_deliverable_refs']).optional(),
    publicReason: z.string().trim().min(1).max(MAX_REASON_CHARS).optional(),
  }).strict().optional(),
  scratchUsed: z.boolean().optional(),
  scratchPath: z.string().trim().min(1).max(MAX_PATH_CHARS).optional(),
  cleanupPerformed: z.boolean().optional(),
  workspaceSideEffects: z.enum(['none', 'cleaned', 'present', 'unknown']).optional(),
  remainingSideEffectPaths: z.array(z.string().trim().min(1).max(MAX_PATH_CHARS)).max(MAX_ARTIFACT_REFS).optional(),
  workspaceGuard: z.object({
    checked: z.boolean().optional(),
    checkedPaths: z.array(z.string().trim().min(1).max(MAX_PATH_CHARS)).max(MAX_ARTIFACT_REFS).optional(),
    beforeListingCommand: z.string().trim().min(1).max(MAX_COMMAND_CHARS).optional(),
    afterListingCommand: z.string().trim().min(1).max(MAX_COMMAND_CHARS).optional(),
    addedPaths: z.array(z.string().trim().min(1).max(MAX_PATH_CHARS)).max(MAX_ARTIFACT_REFS).optional(),
    modifiedPaths: z.array(z.string().trim().min(1).max(MAX_PATH_CHARS)).max(MAX_ARTIFACT_REFS).optional(),
    removedPaths: z.array(z.string().trim().min(1).max(MAX_PATH_CHARS)).max(MAX_ARTIFACT_REFS).optional(),
    publicReason: z.string().trim().min(1).max(MAX_REASON_CHARS).optional(),
  }).strict().optional(),
  publicReason: z.string().trim().min(1).max(MAX_REASON_CHARS).optional(),
}).strict();

export const heavyTaskSelfCheckSubmitSchema = z.object({
  status: z.enum(['pass', 'fail', 'inconclusive']),
  publicReason: z.string().trim().min(1).max(MAX_REASON_CHARS),
  commandEvidence: z.array(heavyTaskCommandEvidenceSchema).max(MAX_EVIDENCE_ITEMS).optional(),
  artifactEvidence: z.array(heavyTaskArtifactEvidenceSchema).max(MAX_EVIDENCE_ITEMS).optional(),
  executionHygiene: heavyTaskSelfCheckExecutionHygieneSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if ((value.commandEvidence?.length ?? 0) + (value.artifactEvidence?.length ?? 0) === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['commandEvidence'],
      message: 'at least one commandEvidence or artifactEvidence item is required',
    });
  }
});

export type HeavyTaskSelfCheckSubmitInput = z.infer<typeof heavyTaskSelfCheckSubmitSchema>;

export type HeavyTaskPublicSelfCheckValidation =
  | { ok: true; guard: HeavyTaskSourceGuardResult & { status: 'accepted' } }
  | { ok: false; guard: HeavyTaskSourceGuardResult & { status: 'rejected' } };

export interface HeavyTaskSelfCheckRecorder {
  recordSelfCheck(
    input: HeavyTaskSelfCheckSubmitInput,
    ctx: MakaToolContext,
  ): Promise<
    | { accepted: true; selfCheck: HeavyTaskSemanticSelfCheckState }
    | { accepted: false; guard: HeavyTaskSourceGuardResult & { status: 'rejected' } }
  >;
}

export function createHeavyTaskSelfCheckRecorder(input: {
  taskRunId: string;
  attemptId?: string;
  store: TaskRunStore;
  now: () => number;
  newId: () => string;
}): HeavyTaskSelfCheckRecorder {
  return {
    async recordSelfCheck(args, ctx) {
      const ts = input.now();
      const validation = validateHeavyTaskPublicSelfCheck(args, ts);
      if (!validation.ok) {
        return { accepted: false, guard: validation.guard };
      }
      const selfCheck: HeavyTaskSemanticSelfCheckState = {
        schemaVersion: 1,
        selfCheckId: input.newId(),
        taskRunId: input.taskRunId,
        ...(input.attemptId ? { attemptId: input.attemptId } : {}),
        ts,
        status: args.status,
        publicReason: args.publicReason,
        commandEvidence: args.commandEvidence ?? [],
        artifactEvidence: args.artifactEvidence ?? [],
        ...(args.executionHygiene ? { executionHygiene: args.executionHygiene } : {}),
        guard: validation.guard,
        source: sourceFromContext(ctx),
      };
      await input.store.appendEvent(input.taskRunId, {
        type: 'heavy_task_self_check_recorded',
        id: input.newId(),
        taskRunId: input.taskRunId,
        ts,
        selfCheck,
      });
      return { accepted: true, selfCheck };
    },
  };
}

export function buildHeavyTaskSelfCheckTools(recorder: HeavyTaskSelfCheckRecorder): MakaTool[] {
  return [
    {
      name: 'self_check_submit',
      description: 'Submit public, task-derived advisory semantic self-check evidence for this heavy-task run, including scratch/cleanup hygiene for any local check side effects.',
      parameters: heavyTaskSelfCheckSubmitSchema,
      permissionRequired: false,
      impl: async (args, ctx) => recorder.recordSelfCheck(heavyTaskSelfCheckSubmitSchema.parse(args), ctx),
    },
  ];
}

export function validateHeavyTaskPublicSelfCheck(
  input: Pick<HeavyTaskSelfCheckSubmitInput, 'publicReason' | 'commandEvidence' | 'artifactEvidence' | 'executionHygiene'>,
  now: number,
): HeavyTaskPublicSelfCheckValidation {
  const categories = new Set<string>();
  for (const value of stringsFromSelfCheck(input)) {
    for (const category of categoriesForString(value)) {
      categories.add(category);
    }
  }
  if (categories.size > 0) {
    return {
      ok: false,
      guard: {
        status: 'rejected',
        checkedAt: now,
        categories: [...categories].sort(),
        publicReason: 'Rejected because submitted evidence referenced private, hidden, or evaluator-only material.',
      },
    };
  }
  return {
    ok: true,
    guard: {
      status: 'accepted',
      checkedAt: now,
      categories: [],
      publicReason: 'Accepted as public, task-derived advisory self-check evidence.',
    },
  };
}

export function isAcceptedHeavyTaskSelfCheck(
  selfCheck: HeavyTaskSemanticSelfCheckState,
  now = selfCheck.guard.checkedAt,
): boolean {
  if (selfCheck.guard.status !== 'accepted') return false;
  return validateHeavyTaskPublicSelfCheck(selfCheck, now).ok;
}

export function hasBlockingHeavyTaskSelfCheckWorkspaceDelta(selfCheck: HeavyTaskSemanticSelfCheckState): boolean {
  const hygiene = selfCheck.executionHygiene;
  if (!hygiene) return false;
  if (hygiene.workspaceSideEffects === 'present') return true;
  if ((hygiene.remainingSideEffectPaths?.length ?? 0) > 0) return true;
  if ((hygiene.workspaceGuard?.addedPaths?.length ?? 0) > 0) return true;
  return false;
}

export function heavyTaskSelfCheckSandboxStatus(
  selfCheck: HeavyTaskSemanticSelfCheckState,
): 'present' | 'missing' {
  return selfCheck.executionHygiene?.sandbox?.root ? 'present' : 'missing';
}

export function heavyTaskSelfCheckStrongPassBlocker(selfCheck: HeavyTaskSemanticSelfCheckState): string | undefined {
  if (heavyTaskSelfCheckSandboxStatus(selfCheck) !== 'present') {
    return 'latest self-check is missing sandbox execution evidence';
  }
  if (hasBlockingHeavyTaskSelfCheckWorkspaceDelta(selfCheck)) {
    return 'latest self-check reports uncleaned workspace side effects';
  }
  if (selfCheck.executionHygiene?.workspaceGuard?.checked !== true) {
    return 'latest self-check is missing public workspace hygiene guard evidence';
  }
  return undefined;
}

export function heavyTaskSelfCheckWorkspaceGuardStatus(
  selfCheck: HeavyTaskSemanticSelfCheckState,
): 'clean' | 'dirty' | 'unchecked' | 'unknown' {
  const hygiene = selfCheck.executionHygiene;
  if (!hygiene) return 'unchecked';
  if (hasBlockingHeavyTaskSelfCheckWorkspaceDelta(selfCheck)) return 'dirty';
  if (hygiene.workspaceGuard?.checked === true || hygiene.workspaceSideEffects === 'none' || hygiene.workspaceSideEffects === 'cleaned') {
    return 'clean';
  }
  return 'unknown';
}

export function renderHeavyTaskSelfCheckForPrompt(projection: {
  latestHeavyTaskSelfCheck?: HeavyTaskSemanticSelfCheckState;
}): string | undefined {
  const selfCheck = projection.latestHeavyTaskSelfCheck;
  if (!selfCheck) return undefined;
  const lines = [
    'Heavy-task semantic self-check state from prior task-run events:',
    `- Latest advisory status: ${selfCheck.status}`,
    `- Public reason: ${oneLine(selfCheck.publicReason, 240)}`,
  ];
  for (const command of selfCheck.commandEvidence.slice(0, 5)) {
    lines.push(`  - command: ${oneLine(command.command, 160)} exit=${command.exitCode ?? 'unknown'}`);
  }
  for (const artifact of selfCheck.artifactEvidence.slice(0, 5)) {
    lines.push(`  - artifact: ${artifact.kind} ${oneLine(artifact.path, 160)}`);
  }
  if (selfCheck.executionHygiene) {
    const hygiene = selfCheck.executionHygiene;
    if (hygiene.sandbox) {
      lines.push(`- Self-check sandbox: root=${oneLine(hygiene.sandbox.root, 160)} strategy=${hygiene.sandbox.strategy ?? 'unknown'} outputPolicy=${hygiene.sandbox.outputPolicy ?? 'unknown'}`);
    }
    lines.push(`- Self-check execution hygiene: scratchUsed=${hygiene.scratchUsed ?? 'unknown'} cleanupPerformed=${hygiene.cleanupPerformed ?? 'unknown'} workspaceSideEffects=${hygiene.workspaceSideEffects ?? 'unknown'}`);
    if (hygiene.scratchPath) lines.push(`  - scratch: ${oneLine(hygiene.scratchPath, 160)}`);
    if (hygiene.remainingSideEffectPaths?.length) {
      lines.push(`  - remaining side-effect paths: ${hygiene.remainingSideEffectPaths.slice(0, 5).map((path) => oneLine(path, 120)).join(', ')}`);
    }
    if (hygiene.workspaceGuard) {
      const guard = hygiene.workspaceGuard;
      lines.push(`  - workspace guard: checked=${guard.checked ?? 'unknown'} added=${guard.addedPaths?.length ?? 0} modified=${guard.modifiedPaths?.length ?? 0} removed=${guard.removedPaths?.length ?? 0}`);
      if (guard.checkedPaths?.length) lines.push(`  - checked paths: ${guard.checkedPaths.slice(0, 5).map((path) => oneLine(path, 120)).join(', ')}`);
    }
  }
  lines.push('Use self_check_submit to refresh advisory public semantic evidence after running public checks.');
  return lines.join('\n');
}

function stringsFromSelfCheck(input: Pick<HeavyTaskSelfCheckSubmitInput, 'publicReason' | 'commandEvidence' | 'artifactEvidence' | 'executionHygiene'>): string[] {
  const strings = [input.publicReason];
  for (const command of input.commandEvidence ?? []) {
    strings.push(command.command);
    if (command.outputExcerpt) strings.push(command.outputExcerpt);
    strings.push(...(command.artifactRefs ?? []));
  }
  for (const artifact of input.artifactEvidence ?? []) {
    strings.push(artifact.path);
    collectMetadataStrings(artifact.metadata, strings);
  }
  collectExecutionHygieneStrings(input.executionHygiene, strings);
  return strings.filter((value) => value.length > 0).map((value) => value.slice(0, MAX_GUARD_STRING_CHARS));
}

function collectExecutionHygieneStrings(value: HeavyTaskSelfCheckExecutionHygiene | undefined, output: string[]): void {
  if (!value) return;
  if (value.sandbox?.root) output.push(value.sandbox.root);
  if (value.sandbox?.commandCwd) output.push(value.sandbox.commandCwd);
  if (value.sandbox?.publicReason) output.push(value.sandbox.publicReason);
  output.push(...(value.sandbox?.inputPaths ?? []));
  if (value.scratchPath) output.push(value.scratchPath);
  if (value.publicReason) output.push(value.publicReason);
  output.push(...(value.remainingSideEffectPaths ?? []));
  const guard = value.workspaceGuard;
  if (!guard) return;
  if (guard.beforeListingCommand) output.push(guard.beforeListingCommand);
  if (guard.afterListingCommand) output.push(guard.afterListingCommand);
  if (guard.publicReason) output.push(guard.publicReason);
  output.push(...(guard.checkedPaths ?? []));
  output.push(...(guard.addedPaths ?? []));
  output.push(...(guard.modifiedPaths ?? []));
  output.push(...(guard.removedPaths ?? []));
}

function collectMetadataStrings(value: unknown, output: string[], depth = 0): void {
  if (depth > MAX_METADATA_DEPTH) return;
  if (typeof value === 'string') {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectMetadataStrings(item, output, depth + 1);
    return;
  }
  if (recordValue(value)) {
    for (const [key, item] of Object.entries(value)) {
      output.push(key);
      collectMetadataStrings(item, output, depth + 1);
    }
  }
}

const THRESHOLD_EVIDENCE_PATTERN =
  /\bhidden[ _-]?thresholds?\b|\bprivate[ _-]?thresholds?\b|\b(?:expected[ _-]?)?thresholds?[ _:=/-]*(?:0?\.\d+|\d+(?:\.\d+)?%?)\b|\b(?:pass(?:ing)?|score|similarity|accuracy)[ _-]*(?:cutoff|threshold)[ _:=/-]*(?:0?\.\d+|\d+(?:\.\d+)?%?)\b/;
const RAW_ASSERTION_EVIDENCE_PATTERN =
  /\bpytest[ _-]?assertions?\b|\bassertion[ _-]?derived\b|\bassertionerror\b|\bassert\s+\S+(?:\s+\S+){0,8}\s*(?:==|!=|<=|>=|<|>)\s*\S+|\bexpected\s*(?:==|!=|<=|>=|<|>|=|:)\s*\S+|\bexpected\b.{0,80}\bactual\b|\bactual\b.{0,80}\bexpected\b/;
const EVALUATOR_FILE_PATTERN =
  /\bevaluator[ _-]?only\b|\bnon[ _-]?public[ _-]?evaluator\b|\bevaluator[ _-]?(?:file|fixture|path|material|artifact)s?\b/;

function categoriesForString(value: string): string[] {
  const normalized = value.toLowerCase();
  const categories: string[] = [];
  const checks: Array<[string, RegExp]> = [
    ['hidden_tests', /\bhidden[ _/-]?tests?\b|\bhidden\/tests?\b/],
    ['hidden_reference_artifacts', /\bhidden[ _-]?references?\b|\bhidden[ _-]?artifacts?\b/],
    ['hidden_thresholds', THRESHOLD_EVIDENCE_PATTERN],
    ['private_scoring_criteria', /\bprivate[ _-]?scor(?:e|ing)[ _-]?criteria\b/],
    ['scorer_constants', /\bscorer[ _-]?(?:specific[ _-]?)?constants?\b/],
    ['pytest_assertions', RAW_ASSERTION_EVIDENCE_PATTERN],
    ['official_verifier_artifacts', /\bofficial[ _-]?verifier\b|\bverifier[ _-]?output\.json\b/],
    ['hidden_assertion_text', /\bhidden[ _-]?assertion[ _-]?text\b|\bprivate[ _-]?assertion\b/],
    ['non_public_evaluator_files', EVALUATOR_FILE_PATTERN],
    ['private_verifier_details', /\bprivate[ _-]?verifier\b|\bverifier[ _-]?(?:timing|order|execution[ _-]?order)\b/],
    ['private_benchmark_identifiers', /\bprivate[ _-]?benchmark\b|\bbenchmark[ _-]?private\b/],
  ];
  for (const [category, pattern] of checks) {
    if (pattern.test(normalized)) categories.push(category);
  }
  return categories;
}

function metadataWithinBounds(value: unknown, depth = 0): boolean {
  if (depth > MAX_METADATA_DEPTH) return false;
  if (typeof value === 'string') return value.length <= MAX_METADATA_STRING_CHARS;
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.length <= MAX_METADATA_KEYS && value.every((item) => metadataWithinBounds(item, depth + 1));
  if (!recordValue(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= MAX_METADATA_KEYS
    && entries.every(([key, item]) => key.length <= MAX_METADATA_STRING_CHARS && metadataWithinBounds(item, depth + 1));
}

function sourceFromContext(ctx: MakaToolContext): HeavyTaskSemanticSelfCheckState['source'] {
  return {
    kind: 'model_tool',
    toolCallId: ctx.toolCallId,
    ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
    ...(ctx.turnId ? { turnId: ctx.turnId } : {}),
  };
}

function oneLine(value: string, maxChars: number): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean.length <= maxChars ? clean : `${clean.slice(0, maxChars - 3)}...`;
}

function recordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type HeavyTaskSelfCheckEvent = Extract<TaskEvent, { type: 'heavy_task_self_check_recorded' }>;
export type { HeavyTaskArtifactEvidence, HeavyTaskCommandEvidence, HeavyTaskSemanticSelfCheckState };
