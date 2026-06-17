// packages/runtime/src/builtin-tools.ts
// Phase 1 baseline tool set. Each tool returned as MakaTool[] so
// wrapToolExecute can decorate with permission round-trip + tool_call/tool_result write.
//
// Read / Glob / Grep auto-approve.
// Bash / Write / Edit go through PermissionEngine.

import { z } from 'zod';
import { promises as fs } from 'node:fs';
import { exec, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { glob as nodeGlob } from 'node:fs/promises'; // Node 22+ stable glob
import { dirname, isAbsolute, relative, resolve } from 'node:path';

// Single source of truth for tool shape. AiSdkBackend exports them; we just
// re-export here for back-compat with external callers that imported from
// builtin-tools directly.
import type { MakaTool, MakaToolContext } from './ai-sdk-backend.js';
export type { MakaTool, MakaToolContext };

const execAsync = promisify(exec);
const BASH_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

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
      toolSource: {
        id: 'shell',
        label: 'Shell',
        description: 'Shell command execution tools.',
      },
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
          stdout: result.stdout,
          stderr: result.stderr,
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
      toolSource: {
        id: 'core',
        label: 'Core',
        description: 'Read-only file inspection tools.',
      },
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
      toolSource: {
        id: 'files.write',
        label: 'File writing',
        description: 'Workspace file creation and modification tools.',
      },
      impl: async ({ path, content }, { cwd }) => {
        const abs = await resolveWritableInsideCwd(cwd, path, 'Write');
        await fs.writeFile(abs, content, 'utf8');
        return { ok: true, path: abs, bytes: Buffer.byteLength(content, 'utf8') };
      },
    },
    {
      name: 'Edit',
      description:
        'Replace an exact string in a file. Errors if old_string is not unique or not found.',
      parameters: z.object({
        path: z.string(),
        old_string: z.string(),
        new_string: z.string(),
      }),
      permissionRequired: true,
      toolSource: {
        id: 'files.write',
        label: 'File writing',
        description: 'Workspace file creation and modification tools.',
      },
      impl: async ({ path, old_string, new_string }, { cwd }) => {
        const abs = await resolveExistingInsideCwd(cwd, path, 'Edit');
        const current = await fs.readFile(abs, 'utf8');
        const count = current.split(old_string).length - 1;
        if (count === 0) throw new Error(`old_string not found in ${path}`);
        if (count > 1) {
          throw new Error(`old_string is not unique in ${path} (${count} matches)`);
        }
        const next = current.replace(old_string, new_string);
        await fs.writeFile(abs, next, 'utf8');
        return { ok: true, path: abs, replacements: 1 };
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
      toolSource: {
        id: 'core',
        label: 'Core',
        description: 'Read-only file inspection tools.',
      },
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
      toolSource: {
        id: 'core',
        label: 'Core',
        description: 'Read-only file inspection tools.',
      },
      impl: async ({ pattern, path, glob }, { cwd }) => {
        const args = ['-n', '--no-heading', '--max-count=50'];
        if (glob) args.push('--glob', glob);
        args.push(pattern);
        const searchPath = path ? await resolveExistingInsideCwd(cwd, path, 'Grep') : await fs.realpath(cwd);
        args.push(searchPath);
        const cmd = `rg ${args.map(shellEscape).join(' ')}`;
        try {
          const { stdout } = await execAsync(cmd, {
            cwd,
            maxBuffer: 5 * 1024 * 1024,
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

async function runStreamingShell(
  command: string,
  options: {
    cwd: string;
    timeout: number;
    abortSignal: AbortSignal;
    emitOutput: (stream: 'stdout' | 'stderr', chunk: string) => void;
  },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, {
      cwd: options.cwd,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let settled = false;

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      rejectOnce(new Error(`Command timed out after ${options.timeout}ms`));
    }, options.timeout);

    const abort = () => {
      child.kill('SIGTERM');
      rejectOnce(new Error('Command aborted'));
    };
    if (options.abortSignal.aborted) abort();
    else options.abortSignal.addEventListener('abort', abort, { once: true });

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => append('stdout', chunk));
    child.stderr?.on('data', (chunk: string) => append('stderr', chunk));
    child.on('error', rejectOnce);
    child.on('close', (code, signal) => {
      if (settled) return;
      cleanup();
      const exitCode = code ?? (signal ? 128 : 1);
      if (exitCode !== 0) {
        const error = new Error(`Command failed with exit code ${exitCode}`);
        Object.assign(error, { stdout, stderr, code: exitCode });
        settled = true;
        reject(error);
        return;
      }
      settled = true;
      resolvePromise({ stdout, stderr, exitCode });
    });

    function append(stream: 'stdout' | 'stderr', chunk: string): void {
      outputBytes += Buffer.byteLength(chunk, 'utf8');
      if (outputBytes > BASH_MAX_OUTPUT_BYTES) {
        child.kill('SIGTERM');
        rejectOnce(new Error(`Command output exceeded ${BASH_MAX_OUTPUT_BYTES} bytes`));
        return;
      }
      if (stream === 'stdout') stdout += chunk;
      else stderr += chunk;
      options.emitOutput(stream, chunk);
    }

    function rejectOnce(error: Error): void {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    }

    function cleanup(): void {
      clearTimeout(timer);
      options.abortSignal.removeEventListener('abort', abort);
    }
  });
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
