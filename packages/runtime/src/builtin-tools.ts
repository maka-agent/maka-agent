// packages/runtime/src/builtin-tools.ts
// Phase 1 baseline tool set. Each tool returned as MakaTool[] so
// wrapToolExecute can decorate with permission round-trip + tool_call/tool_result write.
//
// Read / Glob / Grep auto-approve.
// Bash / Write / Edit go through PermissionEngine.

import { z } from 'zod';
import { promises as fs } from 'node:fs';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { glob as nodeGlob } from 'node:fs/promises'; // Node 22+ stable glob
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { computeEditedSource } from './edit-replace.js';
import { truncateToolOutput } from './tool-output.js';
import { runShellWithBoundedTail } from './shell-exec.js';

// Single source of truth for tool shape. AiSdkBackend exports them; we just
// re-export here for back-compat with external callers that imported from
// builtin-tools directly.
import type { MakaTool, MakaToolContext } from './ai-sdk-backend.js';
export type { MakaTool, MakaToolContext };

const execAsync = promisify(exec);
// Generous wall-clock cap for the ripgrep-backed Grep tool. A search should be
// near-instant; this only bounds a pathological hang now that the stream
// watchdog is paused during tool execution.
const GREP_TIMEOUT_MS = 120_000;

export function buildBuiltinTools(): MakaTool[] {
  return [
    {
      name: 'Bash',
      description: 'Run a shell command in the session cwd. Subject to permission policy.',
      parameters: z.object({
        command: z.string().describe('The shell command to execute'),
        timeout_ms: z.number().int().positive().max(600_000).optional(),
      }),
      permissionRequired: true,
      impl: async ({ command, timeout_ms }, { cwd, abortSignal, emitOutput }) => {
        const result = await runStreamingShell(command, {
          cwd,
          timeout: timeout_ms ?? 120_000,
          abortSignal,
          emitOutput,
        });
        return {
          kind: 'terminal',
          cwd,
          cmd: command,
          exitCode: result.exitCode,
          stdout: truncateToolOutput(result.stdout, { direction: 'tail' }).content,
          stderr: truncateToolOutput(result.stderr, { direction: 'tail' }).content,
        };
      },
    },
    {
      name: 'Read',
      description: 'Read a file from disk by path relative to session cwd.',
      parameters: z.object({
        path: z.string(),
        offset: z.number().int().nonnegative().optional(),
        limit: z.number().int().positive().optional(),
      }),
      permissionRequired: false,
      impl: async ({ path, offset, limit }, { cwd }) => {
        const abs = await resolveExistingInsideCwd(cwd, path, 'Read');
        const content = await fs.readFile(abs, 'utf8');
        if (offset === undefined && limit === undefined) return { content };
        const lines = content.split('\n');
        const start = offset ?? 0;
        const end = limit ? start + limit : lines.length;
        return { content: lines.slice(start, end).join('\n') };
      },
    },
    {
      name: 'Write',
      description: 'Write content to a file (creates or overwrites). Subject to permission policy.',
      parameters: z.object({ path: z.string(), content: z.string() }),
      permissionRequired: true,
      impl: async ({ path, content }, { cwd }) => {
        const abs = await resolveWritableInsideCwd(cwd, path, 'Write');
        await fs.writeFile(abs, content, 'utf8');
        return { ok: true, path: abs, bytes: Buffer.byteLength(content, 'utf8') };
      },
    },
    {
      name: 'Edit',
      description:
        'Replace old_string with new_string in a file. Prefers an exact, unique match; '
        + 'if exact fails it tolerates limited whitespace/indentation/escape drift in old_string, '
        + 'but only when the match is unambiguous (otherwise it errors — re-read and retry with exact text). '
        + 'new_string is written verbatim, so provide the exact final text/indentation you want. '
        + 'Errors if old_string is not found or not unique.',
      parameters: z.object({
        path: z.string(),
        old_string: z.string(),
        new_string: z.string(),
      }),
      permissionRequired: true,
      impl: async ({ path, old_string, new_string }, { cwd }) => {
        const abs = await resolveExistingInsideCwd(cwd, path, 'Edit');
        const current = await fs.readFile(abs, 'utf8');
        const result = computeEditedSource(current, old_string, new_string, path);
        await fs.writeFile(abs, result.content, 'utf8');
        return {
          ok: true,
          path: abs,
          replacements: 1,
          matchedVia: result.matchedVia,
          startLine: result.startLine,
          endLine: result.endLine,
        };
      },
    },
    {
      name: 'Glob',
      description:
        'Find files matching a glob pattern (case-insensitive, capped at 200, sorted by walk order).',
      parameters: z.object({
        pattern: z.string(),
        cwd: z.string().optional(),
      }),
      permissionRequired: false,
      impl: async ({ pattern, cwd: relCwd }, { cwd }) => {
        assertRelativeGlobPattern(pattern);
        const base = relCwd ? await resolveExistingInsideCwd(cwd, relCwd, 'Glob cwd') : await fs.realpath(cwd);
        const files: string[] = [];
        for await (const f of nodeGlob(pattern, { cwd: base })) {
          files.push(typeof f === 'string' ? f : (f as any).name);
          if (files.length >= 200) break;
        }
        return { files };
      },
    },
    {
      name: 'Grep',
      description: 'Search file contents with a regex via ripgrep.',
      parameters: z.object({
        pattern: z.string(),
        path: z.string().optional(),
        glob: z.string().optional(),
      }),
      permissionRequired: false,
      impl: async ({ pattern, path, glob }, { cwd, abortSignal }) => {
        const args = ['-n', '--no-heading', '--max-count=50'];
        if (glob) args.push('--glob', glob);
        args.push(pattern);
        const searchPath = path ? await resolveExistingInsideCwd(cwd, path, 'Grep') : await fs.realpath(cwd);
        args.push(searchPath);
        const cmd = `rg ${args.map(shellEscape).join(' ')}`;
        try {
          // Self-bound: ripgrep finishes in well under a second normally, but a
          // pathological tree (network mount, /proc, a FIFO) could hang it. The
          // stream watchdog no longer caps tool execution, so each spawning tool
          // must carry its own wall-clock timeout and honour the turn's abort.
          const { stdout } = await execAsync(cmd, {
            cwd,
            maxBuffer: 5 * 1024 * 1024,
            timeout: GREP_TIMEOUT_MS,
            ...(abortSignal ? { signal: abortSignal } : {}),
          });
          return { matches: stdout.split('\n').filter(Boolean).slice(0, 200) };
        } catch (e: any) {
          if (e?.code === 1) return { matches: [] }; // ripgrep "no match"
          throw e;
        }
      },
    },
  ];
}

// Thin wrapper over the shared runShellWithBoundedTail (the one place a shell
// command actually runs — see shell-exec.ts). Keeps the builtin's contract:
// throw on timeout / abort / non-zero exit (with stdout+stderr+code attached),
// stream live via emitOutput, and return the bounded tail on success.
async function runStreamingShell(
  command: string,
  options: {
    cwd: string;
    timeout: number;
    abortSignal: AbortSignal;
    emitOutput: (stream: 'stdout' | 'stderr', chunk: string) => void;
  },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const result = await runShellWithBoundedTail(command, {
    cwd: options.cwd,
    timeoutMs: options.timeout,
    abortSignal: options.abortSignal,
    emitOutput: options.emitOutput,
  });
  // Attach the captured (bounded) stdout/stderr + an exit code to EVERY failure,
  // not just non-zero exit. coerceTerminalFailure only folds the tail into the
  // model-facing result when error.code is a number, so without a code on
  // timeout/abort the model would be blind to the logs leading up to the failure
  // (124 = timeout, 130 = aborted, both conventional).
  if (result.timedOut) throw terminalError(`Command timed out after ${options.timeout}ms`, result, 124);
  if (result.aborted) throw terminalError('Command aborted', result, 130);
  if (result.exitCode !== 0) throw terminalError(`Command failed with exit code ${result.exitCode}`, result, result.exitCode);
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
}

function terminalError(
  message: string,
  result: { stdout: string; stderr: string },
  code: number,
): Error {
  const error = new Error(message);
  Object.assign(error, { stdout: result.stdout, stderr: result.stderr, code });
  return error;
}

function shellEscape(arg: string): string {
  return `'${arg.replaceAll("'", "'\\''")}'`;
}

async function resolveWritableInsideCwd(cwd: string, inputPath: string, label: string): Promise<string> {
  if (isAbsolute(inputPath)) {
    throw new Error(`${label} path must be relative to session cwd`);
  }
  const root = await fs.realpath(cwd);
  const candidate = resolve(root, inputPath);
  if (!isInside(root, candidate)) {
    throw new Error(`${label} path must stay inside session cwd`);
  }
  const parent = await fs.realpath(dirname(candidate));
  if (!isInside(root, parent)) {
    throw new Error(`${label} path must stay inside session cwd`);
  }
  return candidate;
}

async function resolveExistingInsideCwd(cwd: string, inputPath: string, label: string): Promise<string> {
  if (isAbsolute(inputPath)) {
    throw new Error(`${label} path must be relative to session cwd`);
  }
  const root = await fs.realpath(cwd);
  const candidate = resolve(root, inputPath);
  if (!isInside(root, candidate)) {
    throw new Error(`${label} path must stay inside session cwd`);
  }
  const target = await fs.realpath(candidate);
  if (!isInside(root, target)) {
    throw new Error(`${label} path must stay inside session cwd`);
  }
  return target;
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function assertRelativeGlobPattern(pattern: string): void {
  if (isAbsolute(pattern) || pattern.split(/[\\/]+/).includes('..')) {
    throw new Error('Glob pattern must stay inside session cwd');
  }
}
