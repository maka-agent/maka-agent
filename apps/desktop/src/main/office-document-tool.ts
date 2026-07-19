import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, extname, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { redactSecrets } from '@maka/core/redaction';
import { isPathInside, toRelative, type MakaTool } from '@maka/runtime';
import { buildOfficeCliEnv } from './officecli-env.js';

export const OFFICE_DOCUMENT_TOOL_NAME = 'OfficeDocument';
export const OFFICE_DOCUMENT_EDIT_TOOL_NAME = 'OfficeDocumentEdit';

export const OFFICE_DOCUMENT_OPERATIONS = ['help', 'view', 'get', 'query', 'validate'] as const;
export type OfficeDocumentOperation = typeof OFFICE_DOCUMENT_OPERATIONS[number];
export const OFFICE_DOCUMENT_EDIT_OPERATIONS = ['create', 'add', 'set', 'remove'] as const;
export type OfficeDocumentEditOperation = typeof OFFICE_DOCUMENT_EDIT_OPERATIONS[number];
export type OfficeDocumentToolOperation = OfficeDocumentOperation | OfficeDocumentEditOperation;

export const OFFICE_DOCUMENT_VIEW_MODES = ['outline', 'text', 'stats', 'issues', 'annotated'] as const;
export type OfficeDocumentViewMode = typeof OFFICE_DOCUMENT_VIEW_MODES[number];
export const OFFICE_DOCUMENT_HELP_TOPICS = ['docx', 'xlsx', 'pptx'] as const;
export type OfficeDocumentHelpTopic = typeof OFFICE_DOCUMENT_HELP_TOPICS[number];
const OFFICE_DOCUMENT_PROP_VALUE = z.union([z.string().max(500), z.number().finite(), z.boolean()]);
const OFFICE_DOCUMENT_PROPS = z.record(z.string().min(1).max(80), OFFICE_DOCUMENT_PROP_VALUE).optional();

const OFFICE_DOCUMENT_EXTENSIONS = new Set(['.docx', '.xlsx', '.pptx']);
const OFFICE_DOCUMENT_OUTPUT_MAX_CHARS = 60_000;
const OFFICE_DOCUMENT_TIMEOUT_MS = 15_000;
const OFFICE_DOCUMENT_MAX_BUFFER = 512 * 1024;

export type OfficeDocumentResult =
  | {
      kind: 'office_document';
      ok: true;
      operation: OfficeDocumentToolOperation;
      path?: string;
      args: string[];
      stdout: string;
      stderr?: string;
      truncated: boolean;
    }
  | {
      kind: 'office_document';
      ok: false;
      operation?: OfficeDocumentToolOperation;
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
        | 'invalid_props'
        | 'file_exists'
        | 'officecli_missing'
        | 'officecli_aborted'
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
    impl: async ({ path, operation, topic, viewMode, selector, query, depth }, { cwd, abortSignal }) => runOfficeDocumentOperation({
      cwd,
      path,
      operation,
      topic,
      viewMode,
      selector,
      query,
      depth,
      abortSignal,
    }),
  };
}

export function buildOfficeDocumentEditTool(): MakaTool<
  {
    path: string;
    operation: OfficeDocumentEditOperation;
    target?: string;
    elementType?: string;
    props?: Record<string, string | number | boolean>;
    index?: number;
  },
  OfficeDocumentResult
> {
  return {
    name: OFFICE_DOCUMENT_EDIT_TOOL_NAME,
    displayName: 'Office 文档编辑',
    description:
      'Create or edit a .docx, .xlsx, or .pptx file through a bounded Office document adapter. ' +
      'Allowed write operations are create, add, set, and remove. ' +
      'The tool only accepts paths inside the session cwd, prompts for file-write permission, and never runs raw, watch, batch, shell, or arbitrary officecli commands. ' +
      'Use OfficeDocument help/view/get/query/validate first when you are unsure about selectors or properties.',
    parameters: z.object({
      path: z.string().min(1).max(500)
        .describe('Relative path to a .docx, .xlsx, or .pptx file under the session cwd.'),
      operation: z.enum(OFFICE_DOCUMENT_EDIT_OPERATIONS),
      target: z.string().min(1).max(500).optional()
        .describe('Required for add/set/remove. Example: /body or /body/p[1].'),
      elementType: z.string().min(1).max(80).optional()
        .describe('Required for add. Example: paragraph, table, footer.'),
      props: OFFICE_DOCUMENT_PROPS
        .describe('Optional flat property map. Converted to repeated --prop key=value arguments.'),
      index: z.number().int().min(0).max(9999).optional()
        .describe('Optional insertion index for add.'),
    }),
    permissionRequired: true,
    categoryHint: 'file_write',
    impl: async ({ path, operation, target, elementType, props, index }, { cwd, abortSignal }) => runOfficeDocumentEditOperation({
      cwd,
      path,
      operation,
      target,
      elementType,
      props,
      index,
      abortSignal,
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
  abortSignal?: AbortSignal;
}): Promise<OfficeDocumentResult> {
  const operation = normalizeOperation(input.operation);
  if (!operation) {
    return {
      kind: 'office_document',
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
      abortSignal: input.abortSignal,
    });
  }

  const pathResult = await resolveOfficeDocumentPath(input.cwd, input.path);
  if (!pathResult.ok) {
    return {
      kind: 'office_document',
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
      kind: 'office_document',
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
    abortSignal: input.abortSignal,
  });
}

async function runOfficeCliOperation(input: {
  cwd: string;
  operation: OfficeDocumentToolOperation;
  relPath?: string;
  absPath?: string;
  args: string[];
  runner?: OfficeCliRunner;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}): Promise<OfficeDocumentResult> {
  const workspaceRoot = await realpath(input.cwd);
  const runner = input.runner ?? execFile;
  const timeoutMs = input.timeoutMs ?? OFFICE_DOCUMENT_TIMEOUT_MS;
  try {
    const output = await runOfficeCli(runner, input.args, timeoutMs, input.abortSignal);
    const stdout = sanitizeOfficeCliOutput(output.stdout, workspaceRoot);
    const stderr = sanitizeOfficeCliOutput(output.stderr, workspaceRoot);
    const cappedStdout = capOutput(stdout);
    const cappedStderr = capOutput(stderr);
    return {
      kind: 'office_document',
      ok: true,
      operation: input.operation,
      ...(input.relPath ? { path: input.relPath } : {}),
      args: input.absPath && input.relPath ? displayArgs(input.args, input.absPath, input.relPath) : input.args,
      stdout: cappedStdout.text,
      ...(stderr.length > 0 ? { stderr: cappedStderr.text } : {}),
      truncated: cappedStdout.truncated || cappedStderr.truncated,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const killed = (error as { killed?: boolean }).killed;
    if (code === 'ENOENT') {
      return {
        kind: 'office_document',
        ok: false,
        operation: input.operation,
        ...(input.relPath ? { path: input.relPath } : {}),
        args: input.absPath && input.relPath ? displayArgs(input.args, input.absPath, input.relPath) : input.args,
        reason: 'officecli_missing',
        message: '本机未检测到 officecli。请先安装 officecli，并确认 `officecli --version` 可运行后重试。',
      };
    }
    if (code === 'ABORT_ERR' || (error as Error).name === 'AbortError') {
      return {
        kind: 'office_document',
        ok: false,
        operation: input.operation,
        ...(input.relPath ? { path: input.relPath } : {}),
        args: input.absPath && input.relPath ? displayArgs(input.args, input.absPath, input.relPath) : input.args,
        reason: 'officecli_aborted',
        message: 'officecli 操作已取消。',
      };
    }
    if (code === 'ETIMEDOUT' || killed) {
      return {
        kind: 'office_document',
        ok: false,
        operation: input.operation,
        ...(input.relPath ? { path: input.relPath } : {}),
        args: input.absPath && input.relPath ? displayArgs(input.args, input.absPath, input.relPath) : input.args,
        reason: 'officecli_timeout',
        message: 'officecli 读取超时。',
      };
    }
    return {
      kind: 'office_document',
      ok: false,
      operation: input.operation,
      ...(input.relPath ? { path: input.relPath } : {}),
      args: input.absPath && input.relPath ? displayArgs(input.args, input.absPath, input.relPath) : input.args,
      reason: 'officecli_failed',
      message: sanitizeOfficeCliOutput((error as Error).message || 'officecli 执行失败。', workspaceRoot),
    };
  }
}

export async function runOfficeDocumentEditOperation(input: {
  cwd: string;
  path?: unknown;
  operation: unknown;
  target?: unknown;
  elementType?: unknown;
  props?: unknown;
  index?: unknown;
  runner?: OfficeCliRunner;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}): Promise<OfficeDocumentResult> {
  const operation = normalizeEditOperation(input.operation);
  if (!operation) {
    return {
      kind: 'office_document',
      ok: false,
      reason: 'invalid_operation',
      message: 'Office 文档编辑只支持 create / add / set / remove 操作。',
    };
  }

  const pathResult = operation === 'create'
    ? await resolveNewOfficeDocumentPath(input.cwd, input.path)
    : await resolveOfficeDocumentPath(input.cwd, input.path);
  if (!pathResult.ok) {
    return {
      kind: 'office_document',
      ok: false,
      operation,
      reason: pathResult.reason,
      message: pathResult.message,
    };
  }

  const argsResult = buildOfficeCliEditArgs({
    filePath: pathResult.abs,
    operation,
    target: input.target,
    elementType: input.elementType,
    props: input.props,
    index: input.index,
  });
  if (!argsResult.ok) {
    return {
      kind: 'office_document',
      ok: false,
      operation,
      path: pathResult.rel,
      reason: argsResult.reason,
      message: argsResult.message,
    };
  }

  return runOfficeCliOperation({
    cwd: input.cwd,
    operation,
    relPath: pathResult.rel,
    absPath: pathResult.abs,
    args: argsResult.args,
    runner: input.runner,
    timeoutMs: input.timeoutMs,
    abortSignal: input.abortSignal,
  });
}

function normalizeOperation(value: unknown): OfficeDocumentOperation | null {
  return typeof value === 'string' && (OFFICE_DOCUMENT_OPERATIONS as readonly string[]).includes(value)
    ? value as OfficeDocumentOperation
    : null;
}

function normalizeEditOperation(value: unknown): OfficeDocumentEditOperation | null {
  return typeof value === 'string' && (OFFICE_DOCUMENT_EDIT_OPERATIONS as readonly string[]).includes(value)
    ? value as OfficeDocumentEditOperation
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
  if (!isPathInside(workspaceRoot, abs)) {
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
  if (!isPathInside(workspaceRoot, actual)) {
    return { ok: false, reason: 'symlink_escape', message: 'Office 文档路径不能通过符号链接离开工作目录。' };
  }
  return { ok: true, workspaceRoot, abs: actual, rel: toRelative(workspaceRoot, actual) };
}

async function resolveNewOfficeDocumentPath(cwd: string, inputPath: unknown): Promise<
  | { ok: true; workspaceRoot: string; abs: string; rel: string }
  | {
      ok: false;
      reason: 'invalid_path' | 'unsupported_extension' | 'file_exists' | 'not_file' | 'symlink_escape';
      message: string;
    }
> {
  if (typeof inputPath !== 'string' || inputPath.trim().length === 0 || inputPath.includes('\0') || isAbsolute(inputPath)) {
    return { ok: false, reason: 'invalid_path', message: 'Office 文档路径必须是工作目录内的相对路径。' };
  }

  const workspaceRoot = await realpath(cwd);
  const abs = resolve(workspaceRoot, inputPath);
  if (!isPathInside(workspaceRoot, abs)) {
    return { ok: false, reason: 'invalid_path', message: 'Office 文档路径不能离开工作目录。' };
  }
  const ext = extname(abs).toLowerCase();
  if (!OFFICE_DOCUMENT_EXTENSIONS.has(ext)) {
    return { ok: false, reason: 'unsupported_extension', message: '只支持 .docx / .xlsx / .pptx 文件。' };
  }

  try {
    const stat = await lstat(abs);
    if (stat.isSymbolicLink()) return { ok: false, reason: 'symlink_escape', message: '为避免路径绕过，Office 文档工具不写入符号链接文件。' };
    return { ok: false, reason: stat.isFile() ? 'file_exists' : 'not_file', message: '目标 Office 文档已存在或不是可创建的文件。' };
  } catch {
    // Missing target is expected for create; validate the parent instead.
  }

  const parent = dirname(abs);
  let parentStat;
  try {
    parentStat = await lstat(parent);
  } catch {
    return { ok: false, reason: 'invalid_path', message: 'Office 文档所在文件夹不存在。' };
  }
  if (parentStat.isSymbolicLink()) {
    return { ok: false, reason: 'symlink_escape', message: '为避免路径绕过，Office 文档工具不写入符号链接文件夹。' };
  }
  if (!parentStat.isDirectory()) {
    return { ok: false, reason: 'not_file', message: 'Office 文档所在路径必须是文件夹。' };
  }
  const actualParent = await realpath(parent);
  if (!isPathInside(workspaceRoot, actualParent)) {
    return { ok: false, reason: 'symlink_escape', message: 'Office 文档路径不能通过符号链接离开工作目录。' };
  }
  return { ok: true, workspaceRoot, abs, rel: toRelative(workspaceRoot, abs) };
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

function buildOfficeCliEditArgs(input: {
  filePath: string;
  operation: OfficeDocumentEditOperation;
  target?: unknown;
  elementType?: unknown;
  props?: unknown;
  index?: unknown;
}): | { ok: true; args: string[] }
  | { ok: false; reason: 'invalid_selector' | 'invalid_props'; message: string } {
  if (input.operation === 'create') {
    return { ok: true, args: ['create', input.filePath] };
  }

  const target = normalizeBoundedText(input.target);
  if (!target) return { ok: false, reason: 'invalid_selector', message: `${input.operation} 操作需要目标 selector。` };

  if (input.operation === 'remove') {
    return { ok: true, args: ['remove', input.filePath, target] };
  }

  if (input.operation === 'add') {
    const elementType = normalizeElementType(input.elementType);
    if (!elementType) return { ok: false, reason: 'invalid_props', message: 'add 操作需要合法的 elementType。' };
    const propArgs = normalizePropArgs(input.props);
    if (!propArgs.ok) return propArgs;
    const args = ['add', input.filePath, target, '--type', elementType, ...propArgs.args];
    if (typeof input.index === 'number' && Number.isInteger(input.index) && input.index >= 0 && input.index <= 9999) {
      args.push('--index', String(input.index));
    }
    return { ok: true, args };
  }

  const propArgs = normalizePropArgs(input.props);
  if (!propArgs.ok) return propArgs;
  if (propArgs.args.length === 0) return { ok: false, reason: 'invalid_props', message: 'set 操作至少需要一个属性。' };
  return { ok: true, args: ['set', input.filePath, target, ...propArgs.args] };
}

function normalizeElementType(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return /^[A-Za-z][A-Za-z0-9_-]{0,80}$/.test(text) ? text : null;
}

function normalizePropArgs(value: unknown): { ok: true; args: string[] } | { ok: false; reason: 'invalid_props'; message: string } {
  if (value === undefined || value === null) return { ok: true, args: [] };
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'invalid_props', message: 'props 必须是扁平对象。' };
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 24) return { ok: false, reason: 'invalid_props', message: 'props 最多支持 24 个属性。' };
  const args: string[] = [];
  for (const [key, raw] of entries) {
    if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(key)) {
      return { ok: false, reason: 'invalid_props', message: 'props 包含不合法属性名。' };
    }
    if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean') {
      return { ok: false, reason: 'invalid_props', message: 'props 只支持字符串、数字或布尔值。' };
    }
    const valueText = String(raw);
    if (valueText.length > 500 || valueText.includes('\0')) {
      return { ok: false, reason: 'invalid_props', message: 'props 包含过长或非法属性值。' };
    }
    args.push('--prop', `${key}=${valueText}`);
  }
  return { ok: true, args };
}

function normalizeBoundedText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length === 0 || text.length > 500 || text.includes('\0')) return null;
  return text;
}

function runOfficeCli(
  runner: OfficeCliRunner,
  args: string[],
  timeoutMs: number,
  abortSignal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    if (abortSignal?.aborted) {
      reject(abortError());
      return;
    }
    const child = runner(
      'officecli',
      args,
      {
        timeout: timeoutMs,
        maxBuffer: OFFICE_DOCUMENT_MAX_BUFFER,
        env: buildOfficeCliEnv(),
        ...(abortSignal ? { signal: abortSignal } : {}),
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

function abortError(): Error {
  const error = new Error('officecli aborted') as Error & { code?: string };
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

function sanitizeOfficeCliOutput(text: string, workspaceRoot: string): string {
  return redactSecrets(text.replaceAll(workspaceRoot, '<workspace>')).trim();
}

function capOutput(text: string): { text: string; truncated: boolean } {
  const chars = Array.from(text);
  if (chars.length <= OFFICE_DOCUMENT_OUTPUT_MAX_CHARS) return { text, truncated: false };
  return {
    text: `${chars.slice(0, OFFICE_DOCUMENT_OUTPUT_MAX_CHARS).join('')}\n[Office 文档输出已截断；请缩小 selector/query 或拆分读取范围后继续研读]`,
    truncated: true,
  };
}

function displayArgs(args: string[], abs: string, rel: string): string[] {
  return args.map((arg) => arg === abs ? rel : arg);
}
