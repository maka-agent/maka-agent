import { randomUUID } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  appendFixedPromptWalEvent,
  FIXED_PROMPT_WAL_SCHEMA_VERSION,
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
  gitRootPath: string;
  systemPromptGitPath: string;
  assertSystemPromptClean(): Promise<void>;
  changedFiles(): Promise<readonly string[]>;
  commit(message: string): Promise<string>;
  restoreSystemPrompt(): Promise<void>;
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
  heldInTaskIds: readonly string[];
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
  assertHeldInAndHeldOutDisjoint(input.heldInTaskIds, input.heldOutDigests ?? []);
  await assertSystemPromptPathMatchesGit(input.systemPromptPath, input.git);
  await assertRegularSystemPromptFile(input.systemPromptPath, input.git.gitRootPath);
  await input.git.assertSystemPromptClean();
  const program = await readFile(input.programPath, 'utf8');
  const currentSystemPrompt = await readFile(input.systemPromptPath, 'utf8');
  const resultsTsv = filterResultsTsvForHeldIn(
    await readFile(input.resultsTsvPath, 'utf8'),
    input.heldInTaskIds,
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
  let commitSha: string;
  try {
    assertOnlySystemPromptChanged(await input.git.changedFiles(), input.git.systemPromptGitPath);
    commitSha = await input.git.commit(`candidate prompt ${input.roundId}`);
  } catch (error) {
    await input.git.restoreSystemPrompt();
    throw error;
  }
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

async function assertSystemPromptPathMatchesGit(
  systemPromptPath: string,
  git: PromptCandidateGit,
): Promise<void> {
  const [inputRealPath, gitRealPath] = await Promise.all([
    realpath(systemPromptPath),
    realpath(resolve(git.gitRootPath, git.systemPromptGitPath)),
  ]);
  if (inputRealPath !== gitRealPath) {
    throw new Error('system prompt path must match git prompt path');
  }
}

function assertHeldInAndHeldOutDisjoint(
  heldInTaskIds: readonly string[],
  heldOutDigests: readonly TrajectoryDigest[],
): void {
  const heldInTasks = new Set(heldInTaskIds);
  const overlap = heldOutDigests.find((digest) => heldInTasks.has(digest.taskId));
  if (overlap) {
    throw new Error(`held-in and held-out task sets must be disjoint: ${overlap.taskId}`);
  }
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
  heldInTaskIds: readonly string[],
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

  const heldInTasks = new Set(heldInTaskIds);
  const filtered = [
    header,
    ...lines.slice(1).filter((line) => {
      const columns = line.split('\t');
      return heldInTasks.has(columns[taskIdIndex] ?? '');
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
    schemaVersion: FIXED_PROMPT_WAL_SCHEMA_VERSION,
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

async function assertRegularSystemPromptFile(systemPromptPath: string, gitRootPath: string): Promise<void> {
  const stat = await lstat(systemPromptPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('system_prompt.md must be a regular file');
  }
  const [promptRealPath, gitRootRealPath] = await Promise.all([
    realpath(systemPromptPath),
    realpath(gitRootPath),
  ]);
  if (!isPathInside(gitRootRealPath, promptRealPath)) {
    throw new Error('system_prompt.md must stay inside the git cwd');
  }
}

export function createCliPromptCandidateGit(input: CreateCliPromptCandidateGitInput): PromptCandidateGit {
  const gitRootPath = realpathSync(findGitRoot(input.cwd));
  const systemPromptPath = isAbsolute(input.systemPromptPath)
    ? realpathSync(input.systemPromptPath)
    : realpathSync(resolve(input.cwd, input.systemPromptPath));
  const systemPromptGitPath = toGitRelativePath(gitRootPath, systemPromptPath);
  return {
    gitRootPath,
    systemPromptGitPath,
    async assertSystemPromptClean(): Promise<void> {
      if (!(await isGitTracked(gitRootPath, systemPromptGitPath))) {
        throw new Error('system_prompt.md must be tracked before candidate round');
      }
      const [worktreeDirty, indexDirty] = await Promise.all([
        hasGitDiff(gitRootPath, ['diff', '--quiet', '--', systemPromptGitPath]),
        hasGitDiff(gitRootPath, ['diff', '--cached', '--quiet', '--', systemPromptGitPath]),
      ]);
      if (worktreeDirty || indexDirty) {
        throw new Error('system_prompt.md must be clean before candidate round');
      }
    },
    async changedFiles(): Promise<readonly string[]> {
      const { stdout } = await execFileAsync('git', [
        'status',
        '--porcelain',
        '--untracked-files=all',
        '--',
        systemPromptGitPath,
      ], { cwd: gitRootPath });
      return stdout
        .split('\n')
        .map((line) => line.slice(3).trim())
        .filter((line) => line.length > 0);
    },
    async commit(message: string): Promise<string> {
      await execFileAsync('git', ['add', '--', systemPromptGitPath], { cwd: gitRootPath });
      await execFileAsync('git', ['commit', '-m', message, '--', systemPromptGitPath], { cwd: gitRootPath });
      const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: gitRootPath });
      return stdout.trim();
    },
    async restoreSystemPrompt(): Promise<void> {
      await execFileAsync('git', ['restore', '--staged', '--worktree', '--', systemPromptGitPath], { cwd: gitRootPath });
    },
  };
}

async function isGitTracked(cwd: string, path: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['ls-files', '--error-unmatch', '--', path], { cwd });
    return true;
  } catch {
    return false;
  }
}

async function hasGitDiff(cwd: string, args: readonly string[]): Promise<boolean> {
  try {
    await execFileAsync('git', [...args], { cwd });
    return false;
  } catch {
    return true;
  }
}

function findGitRoot(cwd: string): string {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' }).trim();
}

function isPathInside(rootPath: string, targetPath: string): boolean {
  const relativePath = relative(rootPath, targetPath).split('\\').join('/');
  return relativePath !== '' && relativePath !== '..' && !relativePath.startsWith('../') && !isAbsolute(relativePath);
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
