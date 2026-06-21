import type { MakaTool, ToolAvailabilityConfig } from '@maka/runtime';
import {
  buildSubagentProjectionTools,
  buildSubagentSpawnTool,
} from '@maka/runtime';
import { z } from 'zod';
import type { IsolatedToolExecutor } from './isolation.js';

/**
 * Build Maka's standard headless tool surface with shell and file operations
 * routed through the isolated executor boundary.
 */
export function buildIsolatedHeadlessTools(executor: IsolatedToolExecutor): MakaTool[] {
  return [
    buildIsolatedBashTool(executor),
    buildIsolatedReadTool(executor),
    buildIsolatedWriteTool(executor),
    buildIsolatedEditTool(executor),
    buildIsolatedGlobTool(executor),
    buildIsolatedGrepTool(executor),
    buildSubagentSpawnTool(),
    ...buildSubagentProjectionTools(),
  ];
}

export function buildIsolatedHeadlessToolAvailability(): ToolAvailabilityConfig {
  return {
    economy: true,
    groups: [{
      id: 'agent',
      label: 'Agent',
      description: 'Spawn and inspect foreground child agents.',
      toolNames: ['agent_spawn', 'agent_list', 'agent_output'],
    }],
  };
}

export function buildIsolatedBashTool(executor: IsolatedToolExecutor): MakaTool {
  return {
    name: 'Bash',
    description: 'Run a shell command in the isolated headless task workspace.',
    parameters: z.object({
      command: z.string().describe('The shell command to execute'),
      timeout_ms: z.number().int().positive().max(600_000).optional(),
    }),
    permissionRequired: true,
    impl: async ({ command, timeout_ms }, { cwd, emitOutput }) => {
      const result = await executor.exec({
        command,
        cwd,
        timeoutMs: timeout_ms ?? 120_000,
      });
      if (result.stdout) emitOutput('stdout', result.stdout);
      if (result.stderr) emitOutput('stderr', result.stderr);
      return {
        kind: 'terminal',
        cwd,
        cmd: command,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    },
  };
}

export function buildIsolatedReadTool(executor: IsolatedToolExecutor): MakaTool {
  return {
    name: 'Read',
    description: 'Read a file from the isolated headless task workspace.',
    parameters: z.object({
      path: z.string(),
      offset: z.number().int().nonnegative().optional(),
      limit: z.number().int().positive().optional(),
    }),
    permissionRequired: false,
    impl: async ({ path, offset, limit }, { cwd }) => {
      assertRelativePath(path, 'Read path');
      if (executor.readFile) return await executor.readFile({ cwd, path, offset, limit });
      const stdout = await execFileCommand(executor, cwd, nodeFileCommand(READ_SCRIPT, [
        path,
        numberArg(offset),
        numberArg(limit),
      ]));
      return { content: stdout };
    },
  };
}

export function buildIsolatedWriteTool(executor: IsolatedToolExecutor): MakaTool {
  return {
    name: 'Write',
    description: 'Write content to a file in the isolated headless task workspace.',
    parameters: z.object({ path: z.string(), content: z.string() }),
    permissionRequired: true,
    impl: async ({ path, content }, { cwd }) => {
      assertRelativePath(path, 'Write path');
      if (executor.writeFile) return await executor.writeFile({ cwd, path, content });
      await execFileCommand(executor, cwd, nodeFileCommand(WRITE_SCRIPT, [
        path,
        Buffer.from(content, 'utf8').toString('base64'),
      ]));
      return { ok: true, path, bytes: Buffer.byteLength(content, 'utf8') };
    },
  };
}

export function buildIsolatedEditTool(executor: IsolatedToolExecutor): MakaTool {
  return {
    name: 'Edit',
    description: 'Replace an exact string in a file in the isolated headless task workspace.',
    parameters: z.object({
      path: z.string(),
      old_string: z.string(),
      new_string: z.string(),
    }),
    permissionRequired: true,
    impl: async ({ path, old_string, new_string }, { cwd }) => {
      assertRelativePath(path, 'Edit path');
      if (executor.editFile) {
        return await executor.editFile({ cwd, path, oldString: old_string, newString: new_string });
      }
      await execFileCommand(executor, cwd, nodeFileCommand(EDIT_SCRIPT, [
        path,
        Buffer.from(old_string, 'utf8').toString('base64'),
        Buffer.from(new_string, 'utf8').toString('base64'),
      ]));
      return { ok: true, path, replacements: 1 };
    },
  };
}

export function buildIsolatedGlobTool(executor: IsolatedToolExecutor): MakaTool {
  return {
    name: 'Glob',
    description: 'Find files in the isolated headless task workspace matching a glob pattern.',
    parameters: z.object({
      pattern: z.string(),
      cwd: z.string().optional(),
    }),
    permissionRequired: false,
    impl: async ({ pattern, cwd: relCwd }, { cwd }) => {
      assertRelativeGlobPattern(pattern, 'Glob pattern');
      if (relCwd !== undefined) assertRelativePath(relCwd, 'Glob cwd');
      if (executor.globFiles) return await executor.globFiles({ cwd, pattern, searchCwd: relCwd });
      const stdout = await execFileCommand(executor, cwd, nodeFileCommand(GLOB_SCRIPT, [pattern, relCwd ?? '']));
      return { files: parseStringArray(stdout, 'Glob') };
    },
  };
}

export function buildIsolatedGrepTool(executor: IsolatedToolExecutor): MakaTool {
  return {
    name: 'Grep',
    description: 'Search file contents with a regex in the isolated headless task workspace.',
    parameters: z.object({
      pattern: z.string(),
      path: z.string().optional(),
      glob: z.string().optional(),
    }),
    permissionRequired: false,
    impl: async ({ pattern, path, glob }, { cwd }) => {
      if (path !== undefined) assertRelativePath(path, 'Grep path');
      if (glob !== undefined) assertRelativeGlobPattern(glob, 'Grep glob');
      if (executor.grepFiles) return await executor.grepFiles({ cwd, pattern, path, glob });
      const stdout = await execFileCommand(executor, cwd, nodeFileCommand(GREP_SCRIPT, [
        pattern,
        path ?? '',
        glob ?? '',
      ]));
      return { matches: parseStringArray(stdout, 'Grep') };
    },
  };
}

async function execFileCommand(executor: IsolatedToolExecutor, cwd: string, command: string): Promise<string> {
  const result = await executor.exec({ command, cwd, timeoutMs: 120_000 });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `isolated file command failed with exit code ${result.exitCode}`);
  }
  return result.stdout;
}

function nodeFileCommand(script: string, args: string[]): string {
  return ['node', '-e', shellQuote(script), '--', ...args.map(shellQuote)].join(' ');
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function numberArg(value: number | undefined): string {
  return value === undefined ? '' : String(value);
}

function parseStringArray(stdout: string, label: string): string[] {
  const parsed: unknown = JSON.parse(stdout || '[]');
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
    throw new Error(`${label} command returned an invalid string array`);
  }
  return parsed;
}

function assertRelativePath(inputPath: string, label: string): void {
  if (
    inputPath.length === 0
    || inputPath.startsWith('/')
    || /^[A-Za-z]:[\\/]/.test(inputPath)
    || inputPath.split(/[\\/]+/).includes('..')
  ) {
    throw new Error(`${label} must stay inside the isolated workspace`);
  }
}

function assertRelativeGlobPattern(pattern: string, label: string): void {
  if (
    pattern.length === 0
    || pattern.startsWith('/')
    || /^[A-Za-z]:[\\/]/.test(pattern)
    || pattern.split(/[\\/]+/).includes('..')
  ) {
    throw new Error(`${label} must stay inside the isolated workspace`);
  }
}

const COMMON_NODE_HELPERS = String.raw`
const fs = require('fs');
const path = require('path');
function inside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
function workspaceRoot() {
  return fs.realpathSync(process.cwd());
}
function existingTarget(root, inputPath, label) {
  const target = fs.realpathSync(path.resolve(root, inputPath));
  if (!inside(root, target)) throw new Error(label + ' must stay inside workspace');
  return target;
}
function writableTarget(root, inputPath, label) {
  const target = path.resolve(root, inputPath);
  const parent = fs.realpathSync(path.dirname(target));
  if (!inside(root, parent)) throw new Error(label + ' must stay inside workspace');
  try {
    const existing = fs.realpathSync(target);
    if (!inside(root, existing)) throw new Error(label + ' must stay inside workspace');
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
  return target;
}
`;

const READ_SCRIPT = `${COMMON_NODE_HELPERS}
const [inputPath, offsetRaw, limitRaw] = process.argv.slice(1);
const root = workspaceRoot();
const target = existingTarget(root, inputPath, 'Read path');
let content = fs.readFileSync(target, 'utf8');
if (offsetRaw || limitRaw) {
  const lines = content.split('\\n');
  const start = offsetRaw ? Number(offsetRaw) : 0;
  const end = limitRaw ? start + Number(limitRaw) : lines.length;
  content = lines.slice(start, end).join('\\n');
}
process.stdout.write(content);
`;

const WRITE_SCRIPT = `${COMMON_NODE_HELPERS}
const [inputPath, contentBase64] = process.argv.slice(1);
const root = workspaceRoot();
const target = writableTarget(root, inputPath, 'Write path');
fs.writeFileSync(target, Buffer.from(contentBase64, 'base64'));
`;

const EDIT_SCRIPT = `${COMMON_NODE_HELPERS}
const [inputPath, oldBase64, nextBase64] = process.argv.slice(1);
const root = workspaceRoot();
const target = existingTarget(root, inputPath, 'Edit path');
const oldString = Buffer.from(oldBase64, 'base64').toString('utf8');
const newString = Buffer.from(nextBase64, 'base64').toString('utf8');
const current = fs.readFileSync(target, 'utf8');
const count = current.split(oldString).length - 1;
if (count === 0) throw new Error('old_string not found in ' + inputPath);
if (count > 1) throw new Error('old_string is not unique in ' + inputPath + ' (' + count + ' matches)');
fs.writeFileSync(target, current.replace(oldString, newString), 'utf8');
`;

const GLOB_SCRIPT = `${COMMON_NODE_HELPERS}
const [pattern, searchCwd] = process.argv.slice(1);
const root = workspaceRoot();
const base = searchCwd ? existingTarget(root, searchCwd, 'Glob cwd') : root;
const files = [];
for (const entry of fs.globSync(pattern, { cwd: base })) {
  files.push(typeof entry === 'string' ? entry : entry.name);
  if (files.length >= 200) break;
}
process.stdout.write(JSON.stringify(files));
`;

const GREP_SCRIPT = `${COMMON_NODE_HELPERS}
const [pattern, inputPath, globPattern] = process.argv.slice(1);
const root = workspaceRoot();
const start = inputPath ? existingTarget(root, inputPath, 'Grep path') : root;
const regex = new RegExp(pattern);
const matches = [];
const perFile = new Map();
const globRegex = globPattern ? globToRegExp(globPattern) : null;
function globToRegExp(glob) {
  let out = '^';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    const next = glob[i + 1];
    if (ch === '*' && next === '*') {
      out += '.*';
      i += 1;
    } else if (ch === '*') {
      out += '[^/]*';
    } else if (ch === '?') {
      out += '[^/]';
    } else {
      out += ch.replace(/[|\\{}()[\\]^$+?.]/g, '\\$&');
    }
  }
  return new RegExp(out + '$');
}
function shouldSearch(file) {
  if (!globRegex) return true;
  return globRegex.test(path.relative(root, file).split(path.sep).join('/'));
}
function visit(file) {
  if (matches.length >= 200) return;
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) return;
  const real = fs.realpathSync(file);
  if (!inside(root, real)) return;
  if (stat.isDirectory()) {
    for (const child of fs.readdirSync(file)) visit(path.join(file, child));
    return;
  }
  if (!stat.isFile() || !shouldSearch(file)) return;
  const rel = path.relative(root, file).split(path.sep).join('/');
  const lines = fs.readFileSync(file, 'utf8').split('\\n');
  for (let i = 0; i < lines.length && matches.length < 200; i += 1) {
    if (!regex.test(lines[i])) continue;
    const seen = perFile.get(file) ?? 0;
    if (seen >= 50) break;
    perFile.set(file, seen + 1);
    matches.push(rel + ':' + (i + 1) + ':' + lines[i]);
  }
}
visit(start);
process.stdout.write(JSON.stringify(matches));
`;
