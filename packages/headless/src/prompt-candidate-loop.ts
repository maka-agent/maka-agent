import { createHash, randomUUID } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { lstat, readdir, readFile, readlink, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
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
  toolFailures?: readonly TrajectoryToolFailureDigest[];
}

export interface TrajectoryToolCallDigest {
  name: string;
  argsPreview: string;
}

export interface TrajectoryToolFailureDigest {
  name: string;
  count: number;
  errorClass?: string;
  argsPreview?: string;
}

export interface ExtractTrajectoryDigestInput {
  taskId: string;
  errorClass?: string;
  runtimeEventsPath: string;
  traceEventsPath?: string;
  verifierSummary: string;
}

export interface RewardHackScanInput {
  runtimeEventsPath: string;
  verifierPatterns: readonly string[];
}

export type RewardHackScanResult =
  | { decision: 'clean' }
  | { decision: 'quarantine'; reason: 'runtime_events_unreadable' }
  | { decision: 'quarantine'; reason: 'runtime_events_empty' }
  | { decision: 'quarantine'; reason: 'no_verifier_patterns' }
  | { decision: 'quarantine'; reason: 'no_model_visible_events' }
  | { decision: 'quarantine'; reason: 'verifier_pattern'; matchedPatterns: readonly string[] };

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
  rollbackCommit(commitSha: string): Promise<void>;
  restoreSystemPrompt(): Promise<void>;
}

export interface CreateCliPromptCandidateGitInput {
  cwd: string;
  systemPromptPath: string;
}

export interface RunPromptCandidateRoundInput {
  runId: string;
  roundId: string;
  agentCwdPath: string;
  programPath: string;
  systemPromptPath: string;
  resultsTsvPath: string;
  resultsJsonlPath: string;
  heldInTaskIds: readonly string[];
  heldInDigests: readonly TrajectoryDigest[];
  heldOutDigests?: readonly TrajectoryDigest[];
  heldOutArtifactPaths?: readonly string[];
  metaAgent: MetaAgent;
  git: PromptCandidateGit;
  now?: () => number;
  newId?: () => string;
}

interface ArtifactTargetPath {
  absolutePath: string;
  realPath: string;
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
  assertHeldInDigestsBelongToHeldInTasks(input.heldInTaskIds, input.heldInDigests);
  assertHeldInAndHeldOutDisjoint(input.heldInTaskIds, input.heldOutDigests ?? []);
  const heldOutArtifactPaths = input.heldOutArtifactPaths ?? [];
  if (input.agentCwdPath === undefined) {
    throw new Error('agentCwdPath is required before exposing controller artifacts');
  }
  await assertControllerOnlyArtifactsOutsideAgentCwd(
    input.agentCwdPath,
    [input.resultsTsvPath, input.resultsJsonlPath, ...heldOutArtifactPaths],
  );
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
  try {
    await appendFixedPromptWalEvent(input.resultsJsonlPath, promptCandidateCommittedEvent({
      runId: input.runId,
      roundId: input.roundId,
      id: newId(),
      ts: now(),
      commitSha,
      summary: result.summary,
      systemPrompt: result.systemPrompt,
    }));
  } catch (error) {
    await input.git.rollbackCommit(commitSha);
    throw error;
  }
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

function assertHeldInDigestsBelongToHeldInTasks(
  heldInTaskIds: readonly string[],
  heldInDigests: readonly TrajectoryDigest[],
): void {
  const heldInTasks = new Set(heldInTaskIds);
  const outside = heldInDigests.find((digest) => !heldInTasks.has(digest.taskId));
  if (outside) {
    throw new Error(`held-in digests must belong to held-in task set: ${outside.taskId}`);
  }
}

async function assertControllerOnlyArtifactsOutsideAgentCwd(
  agentCwdPath: string,
  artifactPaths: readonly string[],
): Promise<void> {
  const agentCwdAbsolutePath = resolve(agentCwdPath);
  const agentCwdRealPath = await realpath(agentCwdPath);
  const visibleArtifacts = new Set<string>();
  const artifactTargetPaths: ArtifactTargetPath[] = [];
  for (const artifactPath of artifactPaths) {
    const artifactAbsolutePath = resolve(artifactPath);
    if (artifactAbsolutePath === agentCwdAbsolutePath || isPathInside(agentCwdAbsolutePath, artifactAbsolutePath)) {
      visibleArtifacts.add(normalizeGitPath(relative(agentCwdAbsolutePath, artifactAbsolutePath) || basename(artifactPath)));
    }
    const artifactRealPath = await realOrParentResolvedPath(artifactPath);
    artifactTargetPaths.push({ absolutePath: artifactAbsolutePath, realPath: artifactRealPath });
    if (artifactRealPath === agentCwdRealPath || isPathInside(agentCwdRealPath, artifactRealPath)) {
      visibleArtifacts.add(normalizeGitPath(relative(agentCwdRealPath, artifactRealPath) || basename(artifactPath)));
    }
  }
  await addSymlinkedControllerArtifacts(agentCwdAbsolutePath, agentCwdAbsolutePath, artifactTargetPaths, visibleArtifacts);
  if (visibleArtifacts.size > 0) {
    throw new Error(`controller-only artifacts must stay outside agent cwd: ${[...visibleArtifacts].join(', ')}`);
  }
}

async function addSymlinkedControllerArtifacts(
  agentCwdPath: string,
  currentPath: string,
  artifactPaths: readonly ArtifactTargetPath[],
  visibleArtifacts: Set<string>,
): Promise<void> {
  const entries = await readdir(currentPath, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = resolve(currentPath, entry.name);
    if (entry.isSymbolicLink()) {
      const targetPath = resolve(dirname(entryPath), await readlink(entryPath));
      let targetRealPath: string | undefined;
      try {
        targetRealPath = await realpath(entryPath);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      if (artifactPaths.some((artifactPath) => (
        artifactPath.absolutePath === targetPath
        || artifactPath.realPath === targetPath
        || artifactPath.realPath === targetRealPath
        || isPathInside(targetPath, artifactPath.absolutePath)
        || isPathInside(targetPath, artifactPath.realPath)
        || (targetRealPath !== undefined && isPathInside(targetRealPath, artifactPath.realPath))
      ))) {
        visibleArtifacts.add(normalizeGitPath(relative(agentCwdPath, entryPath)));
      }
      continue;
    }
    if (entry.isDirectory()) {
      await addSymlinkedControllerArtifacts(agentCwdPath, entryPath, artifactPaths, visibleArtifacts);
    }
  }
}

async function realOrParentResolvedPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (!isNotFound(error)) throw error;
    return resolve(await realpath(dirname(path)), basename(path));
  }
}

export async function extractTrajectoryDigest(
  input: ExtractTrajectoryDigestInput,
): Promise<TrajectoryDigest> {
  const events = await readRuntimeEventsJsonl(input.runtimeEventsPath);
  const callsById = new Map<string, TrajectoryToolCallDigest>();
  for (const event of events) {
    const call = functionCallDigestWithId(event);
    if (call) callsById.set(call.id, { name: call.name, argsPreview: call.argsPreview });
  }
  const recentToolCalls = events
    .map((event) => functionCallDigest(event))
    .filter((call): call is TrajectoryToolCallDigest => call !== undefined)
    .slice(-2);
  const toolFailures = input.traceEventsPath
    ? await extractToolFailureDigests(input.traceEventsPath, callsById)
    : [];
  return {
    taskId: input.taskId,
    ...(input.errorClass ? { errorClass: input.errorClass } : {}),
    summary: input.verifierSummary,
    ...(recentToolCalls.length > 0 ? { recentToolCalls } : {}),
    ...(toolFailures.length > 0 ? { toolFailures } : {}),
  };
}

export async function scanRuntimeEventsForRewardHack(
  input: RewardHackScanInput,
): Promise<RewardHackScanResult> {
  let events: unknown[];
  try {
    events = await readRuntimeEventsJsonl(input.runtimeEventsPath);
  } catch {
    return { decision: 'quarantine', reason: 'runtime_events_unreadable' };
  }

  const patterns = input.verifierPatterns.filter((pattern) => pattern.trim().length > 0);
  if (patterns.length === 0) return { decision: 'quarantine', reason: 'no_verifier_patterns' };
  if (events.length === 0) return { decision: 'quarantine', reason: 'runtime_events_empty' };
  const matchedPatterns = new Set<string>();
  let visibleValues = 0;
  for (const event of events) {
    for (const value of modelVisibleStrings(event)) {
      visibleValues += 1;
      for (const pattern of patterns) {
        if (value.includes(pattern)) matchedPatterns.add(pattern);
      }
    }
  }
  if (visibleValues === 0) return { decision: 'quarantine', reason: 'no_model_visible_events' };
  if (matchedPatterns.size > 0) {
    return {
      decision: 'quarantine',
      reason: 'verifier_pattern',
      matchedPatterns: [...matchedPatterns].sort((a, b) => a.localeCompare(b)),
    };
  }
  return { decision: 'clean' };
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
    ...renderToolFailureSummary(input.heldInDigests),
    '# Held-In Digests',
    JSON.stringify(stripPromptOnlyToolFailures(input.heldInDigests), null, 2),
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
  let statusBaseline: ReadonlyMap<string, string> | undefined;
  let headBaseline: string | undefined;
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
      [statusBaseline, headBaseline] = await Promise.all([
        gitStatusSnapshot(gitRootPath),
        gitHeadSha(gitRootPath),
      ]);
    },
    async changedFiles(): Promise<readonly string[]> {
      await assertGitHeadUnchanged(gitRootPath, headBaseline);
      const baseline = statusBaseline ?? new Map<string, string>();
      const current = await gitStatusSnapshot(gitRootPath);
      const paths = new Set([...baseline.keys(), ...current.keys()]);
      return [...paths].filter((path) => (
        baseline.get(path) !== current.get(path)
      ));
    },
    async commit(message: string): Promise<string> {
      await assertGitHeadUnchanged(gitRootPath, headBaseline);
      await execFileAsync('git', ['add', '--', systemPromptGitPath], { cwd: gitRootPath });
      await execFileAsync('git', ['commit', '-m', message, '--', systemPromptGitPath], { cwd: gitRootPath });
      const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: gitRootPath });
      return stdout.trim();
    },
    async rollbackCommit(commitSha: string): Promise<void> {
      const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: gitRootPath });
      if (stdout.trim() !== commitSha) {
        throw new Error('candidate prompt commit cannot be rolled back because HEAD moved');
      }
      await execFileAsync('git', ['reset', '--soft', `${commitSha}^`], { cwd: gitRootPath });
      await execFileAsync('git', ['restore', '--staged', '--worktree', '--', systemPromptGitPath], { cwd: gitRootPath });
    },
    async restoreSystemPrompt(): Promise<void> {
      await execFileAsync('git', ['restore', '--staged', '--worktree', '--', systemPromptGitPath], { cwd: gitRootPath });
    },
  };
}

async function assertGitHeadUnchanged(cwd: string, baseline: string | undefined): Promise<void> {
  if (baseline === undefined) return;
  const current = await gitHeadSha(cwd);
  if (current !== baseline) {
    throw new Error('candidate round HEAD moved before prompt commit');
  }
}

async function gitHeadSha(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd });
  return stdout.trim();
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

async function gitStatusFiles(cwd: string): Promise<readonly string[]> {
  const { stdout } = await execFileAsync('git', [
    'status',
    '--porcelain',
    '--untracked-files=all',
  ], { cwd });
  return stdout
    .split('\n')
    .map((line) => statusPath(line))
    .filter((path): path is string => path !== undefined);
}

async function gitStatusSnapshot(cwd: string): Promise<ReadonlyMap<string, string>> {
  const snapshot = new Map<string, string>();
  for (const path of await gitStatusFiles(cwd)) {
    snapshot.set(path, await gitStatusFingerprint(cwd, path));
  }
  return snapshot;
}

async function gitStatusFingerprint(cwd: string, path: string): Promise<string> {
  const [fileHash, worktreeDiff, indexDiff] = await Promise.all([
    fileFingerprint(resolve(cwd, path)),
    gitDiffFingerprint(cwd, ['diff', '--binary', '--', path]),
    gitDiffFingerprint(cwd, ['diff', '--cached', '--binary', '--', path]),
  ]);
  return [fileHash, worktreeDiff, indexDiff].join('\0');
}

async function fileFingerprint(path: string): Promise<string> {
  try {
    const content = await readFile(path);
    return createHash('sha256').update(content).digest('hex');
  } catch (error) {
    if (isNotFound(error)) return 'missing';
    throw error;
  }
}

async function gitDiffFingerprint(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', [...args], { cwd, encoding: 'buffer' });
  return createHash('sha256').update(stdout).digest('hex');
}

function statusPath(line: string): string | undefined {
  const path = line.slice(3).trim();
  if (path.length === 0) return undefined;
  const renameSeparator = ' -> ';
  const renameIndex = path.indexOf(renameSeparator);
  return renameIndex === -1 ? path : path.slice(renameIndex + renameSeparator.length);
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

async function extractToolFailureDigests(
  traceEventsPath: string,
  callsById: ReadonlyMap<string, TrajectoryToolCallDigest>,
): Promise<TrajectoryToolFailureDigest[]> {
  let events: unknown[];
  try {
    events = await readRuntimeEventsJsonl(traceEventsPath);
  } catch (error) {
    if (!isNotFound(error)) throw error;
    return [];
  }
  const failures = new Map<string, TrajectoryToolFailureDigest>();
  for (const event of events) {
    const failure = toolFailureDigest(event, callsById);
    if (!failure) continue;
    const key = [failure.name, failure.errorClass ?? '', failure.argsPreview ?? ''].join('\0');
    const current = failures.get(key);
    failures.set(key, {
      ...failure,
      count: (current?.count ?? 0) + 1,
    });
  }
  return [...failures.values()]
    .sort(compareToolFailures)
    .slice(0, 5);
}

function renderToolFailureSummary(digests: readonly TrajectoryDigest[]): string[] {
  const failures = new Map<string, { digest: TrajectoryToolFailureDigest; taskIds: Set<string> }>();
  for (const digest of digests) {
    for (const failure of digest.toolFailures ?? []) {
      const key = [failure.name, failure.errorClass ?? '', failure.argsPreview ?? ''].join('\0');
      const current = failures.get(key) ?? { digest: { ...failure, count: 0 }, taskIds: new Set<string>() };
      current.digest = { ...failure, count: current.digest.count + failure.count };
      current.taskIds.add(digest.taskId);
      failures.set(key, current);
    }
  }
  const lines = [...failures.values()]
    .sort((a, b) => compareToolFailures(a.digest, b.digest))
    .slice(0, 10)
    .map(({ digest, taskIds }) => [
      `${digest.name} x${digest.count}`,
      ...(digest.errorClass ? [`error=${digest.errorClass}`] : []),
      ...(digest.argsPreview ? [`args=${digest.argsPreview}`] : []),
      `tasks=${[...taskIds].sort((a, b) => a.localeCompare(b)).join(',')}`,
    ].join(' '));
  return lines.length > 0 ? ['# Held-In Tool Failure Summary', ...lines] : [];
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

function functionCallDigestWithId(event: unknown): (TrajectoryToolCallDigest & { id: string }) | undefined {
  const call = functionCallDigest(event);
  if (!call || !isRecord(event) || !isRecord(event.content) || typeof event.content.id !== 'string') return undefined;
  return { ...call, id: event.content.id };
}

function toolFailureDigest(
  event: unknown,
  callsById: ReadonlyMap<string, TrajectoryToolCallDigest>,
): TrajectoryToolFailureDigest | undefined {
  if (!isRecord(event) || event.type !== 'tool_failed' || !isRecord(event.data)) return undefined;
  const data = event.data;
  if (typeof data.toolName !== 'string') return undefined;
  const call = typeof data.toolUseId === 'string' ? callsById.get(data.toolUseId) : undefined;
  return {
    name: promptSafeToken(data.toolName, 'unknown_tool'),
    count: 1,
    ...(typeof data.errorClass === 'string' ? { errorClass: promptSafeToken(data.errorClass, 'unknown_error') } : {}),
    ...(call?.argsPreview ? { argsPreview: call.argsPreview } : {}),
  };
}

function compareToolFailures(a: TrajectoryToolFailureDigest, b: TrajectoryToolFailureDigest): number {
  return b.count - a.count
    || a.name.localeCompare(b.name)
    || (a.errorClass ?? '').localeCompare(b.errorClass ?? '')
    || (a.argsPreview ?? '').localeCompare(b.argsPreview ?? '');
}

function modelVisibleStrings(event: unknown): readonly string[] {
  if (!isRecord(event) || !isRecord(event.content)) return [];
  const content = event.content;
  if (content.kind === 'text' && typeof content.text === 'string') return [content.text];
  if (content.kind === 'thinking' && typeof content.text === 'string') return [content.text];
  if (content.kind === 'function_call') return stringValues(content.args);
  if (content.kind === 'function_response') return stringValues(content.result);
  if (content.kind === 'error') return stringValues([content.message, content.details]);
  return [];
}

function stringValues(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap((item) => stringValues(item));
  if (isRecord(value)) return Object.values(value).flatMap((item) => stringValues(item));
  return [];
}

function argsPreview(args: unknown): string {
  if (!isRecord(args)) return typeof args;
  return Object.keys(args)
    .map((key) => promptSafeToken(key, 'arg'))
    .sort((a, b) => a.localeCompare(b))
    .join(',');
}

function stripPromptOnlyToolFailures(digests: readonly TrajectoryDigest[]): readonly Omit<TrajectoryDigest, 'toolFailures'>[] {
  return digests.map(({ toolFailures: _toolFailures, ...digest }) => digest);
}

function promptSafeToken(value: string, fallback: string): string {
  if (/^[A-Za-z0-9_.:-]{1,64}$/.test(value)) return value;
  return fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}
