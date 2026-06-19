import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  appendFixedPromptWalEvent,
  hashSystemPrompt,
  type PromptCandidateCommittedEvent,
} from './fixed-prompt-controller.js';

const execFileAsync = promisify(execFile);

export interface TrajectoryDigest {
  taskId: string;
  errorClass?: string;
  summary: string;
  recentToolCalls?: readonly TrajectoryToolCallDigest[];
}

export interface TrajectoryToolCallDigest {
  name: string;
  argsPreview: string;
}

export interface ExtractTrajectoryDigestInput {
  taskId: string;
  errorClass?: string;
  runtimeEventsPath: string;
  verifierSummary: string;
}

export interface MetaAgentPromptInput {
  runId: string;
  roundId: string;
  program: string;
  currentSystemPrompt: string;
  resultsTsv: string;
  heldInDigests: readonly TrajectoryDigest[];
}

export interface MetaAgentPromptResult {
  systemPrompt: string;
  summary: string;
}

export type MetaAgent = (input: MetaAgentPromptInput) => Promise<MetaAgentPromptResult>;

export interface MetaAgentCompletionInput {
  prompt: string;
}

export type MetaAgentCompletion = (input: MetaAgentCompletionInput) => Promise<string>;

export interface CreateScriptedMetaAgentInput {
  complete: MetaAgentCompletion;
}

export interface PromptCandidateGit {
  systemPromptGitPath: string;
  changedFiles(): Promise<readonly string[]>;
  commit(message: string): Promise<string>;
}

export interface CreateCliPromptCandidateGitInput {
  cwd: string;
  systemPromptPath: string;
}

export interface RunPromptCandidateRoundInput {
  runId: string;
  roundId: string;
  programPath: string;
  systemPromptPath: string;
  resultsTsvPath: string;
  resultsJsonlPath: string;
  heldInDigests: readonly TrajectoryDigest[];
  heldOutDigests?: readonly TrajectoryDigest[];
  metaAgent: MetaAgent;
  git: PromptCandidateGit;
  now?: () => number;
  newId?: () => string;
}

export interface PromptCandidateRoundResult {
  systemPrompt: string;
  summary: string;
  commitSha: string;
}

export async function runPromptCandidateRound(
  input: RunPromptCandidateRoundInput,
): Promise<PromptCandidateRoundResult> {
  const now = input.now ?? Date.now;
  const newId = input.newId ?? randomId;
  await assertRegularSystemPromptFile(input.systemPromptPath);
  const program = await readFile(input.programPath, 'utf8');
  const currentSystemPrompt = await readFile(input.systemPromptPath, 'utf8');
  const resultsTsv = filterResultsTsvForHeldIn(
    await readFile(input.resultsTsvPath, 'utf8'),
    input.heldInDigests,
  );
  const result = await input.metaAgent({
    runId: input.runId,
    roundId: input.roundId,
    program,
    currentSystemPrompt,
    resultsTsv,
    heldInDigests: input.heldInDigests,
  });

  await writeFile(input.systemPromptPath, result.systemPrompt, 'utf8');
  assertOnlySystemPromptChanged(await input.git.changedFiles(), input.git.systemPromptGitPath);
  const commitSha = await input.git.commit(`candidate prompt ${input.roundId}`);
  await appendFixedPromptWalEvent(input.resultsJsonlPath, promptCandidateCommittedEvent({
    runId: input.runId,
    roundId: input.roundId,
    id: newId(),
    ts: now(),
    commitSha,
    summary: result.summary,
    systemPrompt: result.systemPrompt,
  }));
  return {
    systemPrompt: result.systemPrompt,
    summary: result.summary,
    commitSha,
  };
}

export async function extractTrajectoryDigest(
  input: ExtractTrajectoryDigestInput,
): Promise<TrajectoryDigest> {
  const events = await readRuntimeEventsJsonl(input.runtimeEventsPath);
  const recentToolCalls = events
    .map((event) => functionCallDigest(event))
    .filter((call): call is TrajectoryToolCallDigest => call !== undefined)
    .slice(-2);
  return {
    taskId: input.taskId,
    ...(input.errorClass ? { errorClass: input.errorClass } : {}),
    summary: input.verifierSummary,
    ...(recentToolCalls.length > 0 ? { recentToolCalls } : {}),
  };
}

export function createScriptedMetaAgent(input: CreateScriptedMetaAgentInput): MetaAgent {
  return async (promptInput) => {
    const raw = await input.complete({ prompt: renderMetaAgentPrompt(promptInput) });
    return parseMetaAgentResult(raw);
  };
}

export function renderMetaAgentPrompt(input: MetaAgentPromptInput): string {
  return [
    'You are improving one system prompt for benchmark tasks.',
    'Return JSON only: {"systemPrompt":"...","summary":"..."}.',
    '',
    '# Program',
    input.program,
    '# Current System Prompt',
    input.currentSystemPrompt,
    '# Results TSV',
    input.resultsTsv,
    '# Held-In Digests',
    JSON.stringify(input.heldInDigests, null, 2),
    '',
  ].join('\n');
}

export function filterResultsTsvForHeldIn(
  resultsTsv: string,
  heldInDigests: readonly TrajectoryDigest[],
): string {
  const hasTrailingNewline = resultsTsv.endsWith('\n');
  const lines = resultsTsv.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  if (lines.length === 0) return '';

  const header = lines[0];
  const taskIdIndex = header.split('\t').indexOf('task_id');
  if (taskIdIndex === -1) {
    throw new Error('results TSV must include a task_id column');
  }

  const heldInTaskIds = new Set(heldInDigests.map((digest) => digest.taskId));
  const filtered = [
    header,
    ...lines.slice(1).filter((line) => {
      const columns = line.split('\t');
      return heldInTaskIds.has(columns[taskIdIndex] ?? '');
    }),
  ];
  return `${filtered.join('\n')}${hasTrailingNewline ? '\n' : ''}`;
}

export function parseMetaAgentResult(raw: string): MetaAgentPromptResult {
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) throw new Error('meta-agent output must be a JSON object');
  const systemPrompt = parsed.systemPrompt;
  const summary = parsed.summary;
  if (typeof systemPrompt !== 'string' || systemPrompt.length === 0) {
    throw new Error('meta-agent output systemPrompt must be a non-empty string');
  }
  if (typeof summary !== 'string' || summary.length === 0) {
    throw new Error('meta-agent output summary must be a non-empty string');
  }
  return { systemPrompt, summary };
}

function promptCandidateCommittedEvent(input: {
  runId: string;
  roundId: string;
  id: string;
  ts: number;
  commitSha: string;
  summary: string;
  systemPrompt: string;
}): PromptCandidateCommittedEvent {
  return {
    schemaVersion: 1,
    type: 'prompt_candidate_committed',
    id: input.id,
    ts: input.ts,
    runId: input.runId,
    roundId: input.roundId,
    commitSha: input.commitSha,
    summary: input.summary,
    promptHash: hashSystemPrompt(input.systemPrompt),
  };
}

export function assertOnlySystemPromptChanged(
  changedFiles: readonly string[],
  systemPromptGitPath: string,
): void {
  const allowed = normalizeGitPath(systemPromptGitPath);
  const unexpected = changedFiles.filter((file) => normalizeGitPath(file) !== allowed);
  if (unexpected.length > 0) {
    throw new Error(`only ${allowed} may change; unexpected files: ${unexpected.join(', ')}`);
  }
}

async function assertRegularSystemPromptFile(systemPromptPath: string): Promise<void> {
  const stat = await lstat(systemPromptPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('system_prompt.md must be a regular file');
  }
}

export function createCliPromptCandidateGit(input: CreateCliPromptCandidateGitInput): PromptCandidateGit {
  const systemPromptGitPath = toGitRelativePath(input.cwd, input.systemPromptPath);
  return {
    systemPromptGitPath,
    async changedFiles(): Promise<readonly string[]> {
      const { stdout } = await execFileAsync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: input.cwd });
      return stdout
        .split('\n')
        .map((line) => line.slice(3).trim())
        .filter((line) => line.length > 0);
    },
    async commit(message: string): Promise<string> {
      await execFileAsync('git', ['add', '--', systemPromptGitPath], { cwd: input.cwd });
      await execFileAsync('git', ['commit', '-m', message], { cwd: input.cwd });
      const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: input.cwd });
      return stdout.trim();
    },
  };
}

function toGitRelativePath(cwd: string, path: string): string {
  const absolutePath = isAbsolute(path) ? path : resolve(cwd, path);
  const relativePath = relative(cwd, absolutePath).split('\\').join('/');
  if (relativePath === '' || relativePath === '..' || relativePath.startsWith('../')) {
    throw new Error('system_prompt.md must be inside the git cwd');
  }
  return relativePath;
}

function normalizeGitPath(path: string): string {
  let current = path;
  current = current.split('\\').join('/');
  while (current.startsWith('./')) current = current.slice(2);
  return current;
}

function randomId(): string {
  return randomUUID();
}

async function readRuntimeEventsJsonl(path: string): Promise<unknown[]> {
  const raw = await readFile(path, 'utf8');
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

function functionCallDigest(event: unknown): TrajectoryToolCallDigest | undefined {
  if (!isRecord(event) || !isRecord(event.content)) return undefined;
  const content = event.content;
  if (content.kind !== 'function_call' || typeof content.name !== 'string') return undefined;
  return {
    name: content.name,
    argsPreview: argsPreview(content.args),
  };
}

function argsPreview(args: unknown): string {
  if (!isRecord(args)) return typeof args;
  return Object.keys(args).sort((a, b) => a.localeCompare(b)).join(',');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
