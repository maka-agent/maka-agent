import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { redactSecrets } from '@maka/core/redaction';
import type { MakaTool } from '@maka/runtime';

export const OFFICE_DOCUMENT_TOOL_NAME = 'OfficeDocument';

export const OFFICE_DOCUMENT_OPERATIONS = ['help', 'view', 'get', 'query', 'validate'] as const;
export type OfficeDocumentOperation = typeof OFFICE_DOCUMENT_OPERATIONS[number];

export const OFFICE_DOCUMENT_VIEW_MODES = ['outline', 'text', 'stats', 'issues', 'annotated'] as const;
export type OfficeDocumentViewMode = typeof OFFICE_DOCUMENT_VIEW_MODES[number];
export const OFFICE_DOCUMENT_HELP_TOPICS = ['docx', 'xlsx', 'pptx'] as const;
export type OfficeDocumentHelpTopic = typeof OFFICE_DOCUMENT_HELP_TOPICS[number];

const OFFICE_DOCUMENT_EXTENSIONS = new Set(['.docx', '.xlsx', '.pptx']);
const OFFICE_DOCUMENT_OUTPUT_MAX_CHARS = 60_000;
const OFFICE_DOCUMENT_TIMEOUT_MS = 15_000;
const OFFICE_DOCUMENT_MAX_BUFFER = 512 * 1024;

export type OfficeDocumentResult =
  | {
      ok: true;
      operation: OfficeDocumentOperation;
      path?: string;
      args: string[];
      stdout: string;
      stderr?: string;
      truncated: boolean;
    }
  | {
      ok: false;
      operation?: OfficeDocumentOperation;
      path?: string;
      args?: string[];
      reason:
        | 'invalid_operation'
        | 'invalid_path'
        | 'unsupported_extension'
        | 'missing_file'
        | 'not_file'
        | 'symlink_escape'
        | 'invalid_selector'
        | 'invalid_query'
        | 'officecli_missing'
        | 'officecli_timeout'
        | 'officecli_failed';
      message: string;
    };

type OfficeCliRunner = typeof execFile;

export function buildOfficeDocumentTool(): MakaTool<
  {
    path?: string;
    operation: OfficeDocumentOperation;
    topic?: OfficeDocumentHelpTopic;
    viewMode?: OfficeDocumentViewMode;
    selector?: string;
    query?: string;
    depth?: number;
  },
  OfficeDocumentResult
> {
  return {
    name: OFFICE_DOCUMENT_TOOL_NAME,
    displayName: 'Office 文档',
    description:
      'Inspect a .docx, .xlsx, or .pptx file through a bounded read-only Office document adapter. ' +
      'Allowed operations are help, view outline/text/stats/issues/annotated, get selector, query selector, and validate. ' +
      'The tool only accepts paths inside the session cwd and never runs editing, create, open, close, add, set, remove, raw, watch, or batch commands.',
    parameters: z.object({
      path: z.string().min(1).max(500).optional()
        .describe('Relative path to a .docx, .xlsx, or .pptx file under the session cwd. Required unless operation=help.'),
      operation: z.enum(OFFICE_DOCUMENT_OPERATIONS),
      topic: z.enum(OFFICE_DOCUMENT_HELP_TOPICS).optional()
        .describe('Optional help topic for operation=help.'),
      viewMode: z.enum(OFFICE_DOCUMENT_VIEW_MODES).optional()
        .describe('Required for operation=view. Defaults to outline. html is intentionally not supported.'),
      selector: z.string().min(1).max(500).optional()
        .describe('Required for operation=get. Example: /body/p[1] or a spreadsheet/presentation selector.'),
      query: z.string().min(1).max(500).optional()
        .describe('Required for operation=query. Example: paragraph[style=Heading1].'),
      depth: z.number().int().min(1).max(6).optional()
        .describe('Optional depth for get; capped at 6.'),
    }),
    permissionRequired: false,
    impl: async ({ path, operation, topic, viewMode, selector, query, depth }, { cwd }) => runOfficeDocumentOperation({
      cwd,
      path,
      operation,
      topic,
      viewMode,
      selector,
      query,
      depth,
    }),
  };
}

export async function runOfficeDocumentOperation(input: {
  cwd: string;
  path?: unknown;
  operation: unknown;
  topic?: unknown;
  viewMode?: unknown;
  selector?: unknown;
  query?: unknown;
  depth?: unknown;
  runner?: OfficeCliRunner;
  timeoutMs?: number;
}): Promise<OfficeDocumentResult> {
  const operation = normalizeOperation(input.operation);
  if (!operation) {
    return {
      ok: false,
      reason: 'invalid_operation',
      message: 'Office 文档工具只支持 help / view / get / query / validate 只读操作。',
    };
  }

  if (operation === 'help') {
    return runOfficeCliOperation({
      cwd: input.cwd,
      operation,
      relPath: undefined,
      absPath: undefined,
      args: buildOfficeHelpArgs(input.topic),
      runner: input.runner,
      timeoutMs: input.timeoutMs,
    });
  }

  const pathResult = await resolveOfficeDocumentPath(input.cwd, input.path);
  if (!pathResult.ok) {
    return {
      ok: false,
      operation,
      reason: pathResult.reason,
      message: pathResult.message,
    };
  }

  const argsResult = buildOfficeCliArgs({
    filePath: pathResult.abs,
    operation,
    viewMode: input.viewMode,
    selector: input.selector,
    query: input.query,
    depth: input.depth,
  });
  if (!argsResult.ok) {
    return {
      ok: false,
      operation,
      path: pathResult.rel,
      reason: argsResult.reason,
      message: argsResult.message,
    };
  }

  const runner = input.runner ?? execFile;
  const timeoutMs = input.timeoutMs ?? OFFICE_DOCUMENT_TIMEOUT_MS;
  return runOfficeCliOperation({
    cwd: input.cwd,
    operation,
    relPath: pathResult.rel,
    absPath: pathResult.abs,
    args: argsResult.args,
    runner,
    timeoutMs,
  });
}

async function runOfficeCliOperation(input: {
  cwd: string;
  operation: OfficeDocumentOperation;
  relPath?: string;
  absPath?: string;
  args: string[];
  runner?: OfficeCliRunner;
  timeoutMs?: number;
}): Promise<OfficeDocumentResult> {
  const workspaceRoot = await realpath(input.cwd);
  const runner = input.runner ?? execFile;
  const timeoutMs = input.timeoutMs ?? OFFICE_DOCUMENT_TIMEOUT_MS;
  try {
    const output = await runOfficeCli(runner, input.args, timeoutMs);
    const stdout = sanitizeOfficeCliOutput(output.stdout, workspaceRoot);
    const stderr = sanitizeOfficeCliOutput(output.stderr, workspaceRoot);
    const capped = capOutput(stdout);
    return {
      ok: true,
      operation: input.operation,
      ...(input.relPath ? { path: input.relPath } : {}),
      args: input.absPath && input.relPath ? displayArgs(input.args, input.absPath, input.relPath) : input.args,
      stdout: capped.text,
      ...(stderr.length > 0 ? { stderr: capOutput(stderr).text } : {}),
      truncated: capped.truncated,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const killed = (error as { killed?: boolean }).killed;
    if (code === 'ENOENT') {
      return {
        ok: false,
        operation: input.operation,
        ...(input.relPath ? { path: input.relPath } : {}),
        args: input.absPath && input.relPath ? displayArgs(input.args, input.absPath, input.relPath) : input.args,
        reason: 'officecli_missing',
        message: '本机未检测到 officecli。请先安装 officecli，并确认 `officecli --version` 可运行后重试。',
      };
    }
    if (code === 'ETIMEDOUT' || killed) {
      return {
        ok: false,
        operation: input.operation,
        ...(input.relPath ? { path: input.relPath } : {}),
        args: input.absPath && input.relPath ? displayArgs(input.args, input.absPath, input.relPath) : input.args,
        reason: 'officecli_timeout',
        message: 'officecli 读取超时。',
      };
    }
    return {
      ok: false,
      operation: input.operation,
      ...(input.relPath ? { path: input.relPath } : {}),
      args: input.absPath && input.relPath ? displayArgs(input.args, input.absPath, input.relPath) : input.args,
      reason: 'officecli_failed',
      message: sanitizeOfficeCliOutput((error as Error).message || 'officecli 执行失败。', workspaceRoot),
    };
  }
}

function normalizeOperation(value: unknown): OfficeDocumentOperation | null {
  return typeof value === 'string' && (OFFICE_DOCUMENT_OPERATIONS as readonly string[]).includes(value)
    ? value as OfficeDocumentOperation
    : null;
}

async function resolveOfficeDocumentPath(cwd: string, inputPath: unknown): Promise<
  | { ok: true; workspaceRoot: string; abs: string; rel: string }
  | {
      ok: false;
      reason: 'invalid_path' | 'unsupported_extension' | 'missing_file' | 'not_file' | 'symlink_escape';
      message: string;
    }
> {
  if (typeof inputPath !== 'string' || inputPath.trim().length === 0 || inputPath.includes('\0') || isAbsolute(inputPath)) {
    return { ok: false, reason: 'invalid_path', message: 'Office 文档路径必须是工作目录内的相对路径。' };
  }

  const workspaceRoot = await realpath(cwd);
  const abs = resolve(workspaceRoot, inputPath);
  if (!isInside(workspaceRoot, abs)) {
    return { ok: false, reason: 'invalid_path', message: 'Office 文档路径不能离开工作目录。' };
  }
  const ext = extname(abs).toLowerCase();
  if (!OFFICE_DOCUMENT_EXTENSIONS.has(ext)) {
    return { ok: false, reason: 'unsupported_extension', message: '只支持 .docx / .xlsx / .pptx 文件。' };
  }

  let linkStat;
  try {
    linkStat = await lstat(abs);
  } catch {
    return { ok: false, reason: 'missing_file', message: '找不到这个 Office 文档。' };
  }
  if (linkStat.isSymbolicLink()) {
    return { ok: false, reason: 'symlink_escape', message: '为避免路径绕过，Office 文档工具不读取符号链接文件。' };
  }
  if (!linkStat.isFile()) {
    return { ok: false, reason: 'not_file', message: 'Office 文档路径必须指向文件。' };
  }

  const actual = await realpath(abs);
  if (!isInside(workspaceRoot, actual)) {
    return { ok: false, reason: 'symlink_escape', message: 'Office 文档路径不能通过符号链接离开工作目录。' };
  }
  return { ok: true, workspaceRoot, abs: actual, rel: toRelative(workspaceRoot, actual) };
}

function buildOfficeHelpArgs(topic: unknown): string[] {
  if (typeof topic === 'string' && (OFFICE_DOCUMENT_HELP_TOPICS as readonly string[]).includes(topic)) {
    return ['help', topic];
  }
  return ['help'];
}

function buildOfficeCliArgs(input: {
  filePath: string;
  operation: Exclude<OfficeDocumentOperation, 'help'>;
  viewMode?: unknown;
  selector?: unknown;
  query?: unknown;
  depth?: unknown;
}): | { ok: true; args: string[] }
  | { ok: false; reason: 'invalid_selector' | 'invalid_query'; message: string } {
  switch (input.operation) {
    case 'view': {
      const mode = typeof input.viewMode === 'string' && (OFFICE_DOCUMENT_VIEW_MODES as readonly string[]).includes(input.viewMode)
        ? input.viewMode
        : 'outline';
      return { ok: true, args: ['view', input.filePath, mode] };
    }
    case 'get': {
      const selector = normalizeBoundedText(input.selector);
      if (!selector) return { ok: false, reason: 'invalid_selector', message: 'get 操作需要 selector。' };
      const args = ['get', input.filePath, selector];
      if (typeof input.depth === 'number' && Number.isInteger(input.depth) && input.depth >= 1 && input.depth <= 6) {
        args.push('--depth', String(input.depth));
      }
      return { ok: true, args };
    }
    case 'query': {
      const query = normalizeBoundedText(input.query);
      if (!query) return { ok: false, reason: 'invalid_query', message: 'query 操作需要查询表达式。' };
      return { ok: true, args: ['query', input.filePath, query] };
    }
    case 'validate':
      return { ok: true, args: ['validate', input.filePath] };
  }
}

function normalizeBoundedText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length === 0 || text.length > 500 || text.includes('\0')) return null;
  return text;
}

function runOfficeCli(runner: OfficeCliRunner, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = runner(
      'officecli',
      args,
      {
        timeout: timeoutMs,
        maxBuffer: OFFICE_DOCUMENT_MAX_BUFFER,
        env: { ...process.env, OFFICECLI_SKIP_UPDATE: '1' },
      },
      (error, stdout, stderr) => {
        if (error) {
          Object.assign(error, { stdout, stderr });
          reject(error);
          return;
        }
        resolvePromise({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      },
    );
    child.on('error', reject);
  });
}

function sanitizeOfficeCliOutput(text: string, workspaceRoot: string): string {
  return redactSecrets(text.replaceAll(workspaceRoot, '<workspace>')).trim();
}

function capOutput(text: string): { text: string; truncated: boolean } {
  const chars = Array.from(text);
  if (chars.length <= OFFICE_DOCUMENT_OUTPUT_MAX_CHARS) return { text, truncated: false };
  return {
    text: `${chars.slice(0, OFFICE_DOCUMENT_OUTPUT_MAX_CHARS).join('')}\n[output truncated]`,
    truncated: true,
  };
}

function displayArgs(args: string[], abs: string, rel: string): string[] {
  return args.map((arg) => arg === abs ? rel : arg);
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function toRelative(root: string, target: string): string {
  const rel = relative(root, target);
  return rel === '' ? '.' : rel.split(sep).join('/');
}
