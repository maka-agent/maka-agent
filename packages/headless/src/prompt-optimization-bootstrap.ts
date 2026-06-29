import { execFile } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface EnsurePromptOptimizationPromptRepoInput {
  promptRepoDir: string;
  program: string;
  systemPrompt: string;
}

export interface PromptOptimizationPromptRepoPaths {
  agentCwdPath: string;
  programPath: string;
  systemPromptPath: string;
}

export async function ensurePromptOptimizationPromptRepo(
  input: EnsurePromptOptimizationPromptRepoInput,
): Promise<PromptOptimizationPromptRepoPaths> {
  const agentCwdPath = join(input.promptRepoDir, 'agent-cwd');
  const programPath = join(input.promptRepoDir, 'program.md');
  const systemPromptPath = join(input.promptRepoDir, 'system_prompt.md');
  await mkdir(agentCwdPath, { recursive: true });

  if (await pathExists(join(input.promptRepoDir, '.git'))) {
    await assertPromptRepoHeadIsSeed(input.promptRepoDir);
    await assertExistingSeedFile(programPath, input.program);
    await assertExistingSeedFile(systemPromptPath, input.systemPrompt);
    return { agentCwdPath, programPath, systemPromptPath };
  }

  await writeFile(programPath, input.program, 'utf8');
  await writeFile(systemPromptPath, input.systemPrompt, 'utf8');
  await git(input.promptRepoDir, 'init', '-q');
  await git(input.promptRepoDir, 'config', 'user.email', 'rsi@maka.local');
  await git(input.promptRepoDir, 'config', 'user.name', 'RSI Loop');
  await git(input.promptRepoDir, 'add', 'program.md', 'system_prompt.md');
  await git(input.promptRepoDir, 'commit', '-q', '-m', 'seed prompt');
  return { agentCwdPath, programPath, systemPromptPath };
}

export async function assertPromptOptimizationResumeSupported(input: {
  promptRepoDir: string;
  resultsJsonlPath: string;
}): Promise<void> {
  await assertPromptRepoHeadIsSeed(input.promptRepoDir);
  let raw: string;
  try {
    raw = await readFile(input.resultsJsonlPath, 'utf8');
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    const event = JSON.parse(line) as { type?: unknown };
    if (event.type === 'prompt_candidate_committed' || event.type === 'prompt_candidate_decided') {
      throw unsupportedPostCandidateResumeError();
    }
  }
}

async function assertPromptRepoHeadIsSeed(promptRepoDir: string): Promise<void> {
  const head = await gitOutput(promptRepoDir, 'rev-parse', 'HEAD');
  const seedCommitSha = await gitOutput(promptRepoDir, 'rev-list', '--max-parents=0', 'HEAD');
  if (head !== seedCommitSha) {
    throw unsupportedPostCandidateResumeError();
  }
}

async function assertExistingSeedFile(path: string, expected: string): Promise<void> {
  const actual = await readFile(path, 'utf8');
  if (actual !== expected) {
    throw new Error(`existing prompt repo seed files do not match this run: ${path}`);
  }
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd });
}

async function gitOutput(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
  return stdout.trim();
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNotFound(error)) {
      return false;
    }
    throw error;
  }
}

function unsupportedPostCandidateResumeError(): Error {
  return new Error(
    'post-candidate RSI resume is not supported yet; use a new MAKA_PROMPT_RUN_ID or implement whole-loop WAL replay before resuming after candidate commits/decisions',
  );
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT';
}
