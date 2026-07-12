import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { SessionEvent } from '@maka/core/events';
import { isThinkingLevel, type ThinkingLevel } from '@maka/core/model-thinking';
import {
  isToolCategory,
  type PermissionMode,
  type ToolPermissionRule,
} from '@maka/core/permission';
import type { CreateSessionInput, UserMessageInput } from '@maka/core/runtime-inputs';
import type { SessionSummary } from '@maka/core/session';
import type { InvocationResult } from '@maka/runtime';
import { createSessionStore } from '@maka/storage';
import {
  createMakaCliRuntimeContext,
  type CreateMakaCliRuntimeContextInput,
} from './runtime-bootstrap.js';
import type { ReadySessionTarget } from './connection-target.js';
import { selectMakaRunSession } from './run-session-selection.js';
import { resolveMakaWorkspaceRoot } from './workspace-root.js';

export type NonInteractivePermissionMode = Exclude<PermissionMode, 'ask'>;

export interface MakaRunOptions {
  prompt?: string;
  stdinPrompt: boolean;
  cwd?: string;
  connection?: string;
  model?: string;
  thinking?: ThinkingLevel;
  timeoutMs?: number;
  maxSteps?: number;
  permissionMode?: NonInteractivePermissionMode;
  permissionRules?: ToolPermissionRule[];
  resumeId?: string;
  continueLatest?: boolean;
  thinkingDefaultExplicit?: boolean;
}

export type ParseMakaRunArgsResult =
  | { kind: 'run'; options: MakaRunOptions }
  | { kind: 'help' }
  | { kind: 'error'; message: string };

export interface MakaRunRuntime {
  createSession(input: CreateSessionInput): Promise<SessionSummary>;
  sendMessage(sessionId: string, input: UserMessageInput): AsyncIterable<SessionEvent>;
  respondToPermission(
    sessionId: string,
    response: { requestId: string; decision: 'deny'; rememberForTurn?: boolean },
  ): Promise<void>;
  stopSession(sessionId: string, input?: { source?: 'stop_button' }): Promise<void>;
}

export interface MakaRunContext {
  runtime: MakaRunRuntime;
  target: ReadySessionTarget;
  close(): Promise<void>;
}

export interface MakaRunDeps {
  createContext(input: CreateMakaCliRuntimeContextInput): Promise<MakaRunContext>;
  listSessions(workspaceRoot: string): Promise<SessionSummary[]>;
  workspaceRoot(): string;
  processCwd(): string;
  stdinIsTTY(): boolean;
  readStdin(): Promise<string>;
  writeStdout(text: string): void;
  writeStderr(text: string): void;
  onSigint(handler: () => void): () => void;
  setTimer(handler: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
  newId(): string;
}

const VALUE_FLAGS = new Set([
  'cwd',
  'connection',
  'model',
  'thinking',
  'timeout',
  'max-steps',
  'permission-mode',
  'allow',
  'deny',
  'resume',
]);

const REPEATABLE_VALUE_FLAGS = new Set(['allow', 'deny']);
const BOOLEAN_FLAGS = new Set(['continue']);

export function parseMakaRunArgs(argv: readonly string[]): ParseMakaRunArgsResult {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  const booleanFlags = new Set<string>();
  const permissionRuleFlags: Array<{ effect: 'allow' | 'deny'; value: string }> = [];
  let literal = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (!literal && (arg === '--help' || arg === '-h')) return { kind: 'help' };
    if (!literal && arg === '--') {
      literal = true;
      continue;
    }
    if (!literal && arg.startsWith('--')) {
      const name = arg.slice(2);
      if (BOOLEAN_FLAGS.has(name)) {
        if (booleanFlags.has(name)) return { kind: 'error', message: `option repeated: ${arg}` };
        booleanFlags.add(name);
        continue;
      }
      if (!VALUE_FLAGS.has(name)) return { kind: 'error', message: `unknown option: ${arg}` };
      if (!REPEATABLE_VALUE_FLAGS.has(name) && flags.has(name)) {
        return { kind: 'error', message: `option repeated: ${arg}` };
      }
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        return { kind: 'error', message: `option ${arg} needs a value` };
      }
      if (REPEATABLE_VALUE_FLAGS.has(name)) {
        permissionRuleFlags.push({ effect: name as 'allow' | 'deny', value });
      } else {
        flags.set(name, value);
      }
      index += 1;
      continue;
    }
    if (!literal && arg.startsWith('-') && arg !== '-') {
      return { kind: 'error', message: `unknown option: ${arg}` };
    }
    positional.push(arg);
  }

  if (positional.length > 1) {
    return { kind: 'error', message: 'maka run accepts at most one positional prompt' };
  }
  const prompt = positional[0];
  const timeout = flags.get('timeout');
  const maxSteps = flags.get('max-steps');
  const thinking = flags.get('thinking');
  const permissionMode = flags.get('permission-mode');
  const resumeId = flags.get('resume');
  const continueLatest = booleanFlags.has('continue');
  if (resumeId !== undefined && continueLatest) {
    return { kind: 'error', message: '--resume and --continue cannot be used together' };
  }
  const timeoutSeconds = timeout === undefined ? undefined : Number(timeout);
  if (timeoutSeconds !== undefined && (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0)) {
    return { kind: 'error', message: '--timeout must be a positive number of seconds' };
  }
  const parsedMaxSteps = maxSteps === undefined ? undefined : Number(maxSteps);
  if (parsedMaxSteps !== undefined && (!Number.isInteger(parsedMaxSteps) || parsedMaxSteps < 1)) {
    return { kind: 'error', message: '--max-steps must be a positive integer' };
  }
  if (thinking !== undefined && thinking !== 'default' && !isThinkingLevel(thinking)) {
    return { kind: 'error', message: `unknown thinking level: ${thinking}` };
  }
  if (
    permissionMode !== undefined
    && permissionMode !== 'explore'
    && permissionMode !== 'execute'
    && permissionMode !== 'bypass'
  ) {
    return {
      kind: 'error',
      message: '--permission-mode must be explore, execute, or bypass',
    };
  }
  const permissionRules: ToolPermissionRule[] = [];
  for (const { effect, value } of permissionRuleFlags) {
    const rule = parseToolPermissionRule(value, effect);
    if (!rule.ok) return { kind: 'error', message: rule.message };
    permissionRules.push(rule.value);
  }

  return {
    kind: 'run',
    options: {
      ...(prompt !== undefined && prompt !== '-' ? { prompt } : {}),
      stdinPrompt: prompt === '-',
      ...(flags.get('cwd') !== undefined ? { cwd: flags.get('cwd') } : {}),
      ...(flags.get('connection') !== undefined ? { connection: flags.get('connection') } : {}),
      ...(flags.get('model') !== undefined ? { model: flags.get('model') } : {}),
      ...(thinking !== undefined && thinking !== 'default' ? { thinking } : {}),
      ...(timeoutSeconds !== undefined ? { timeoutMs: Math.ceil(timeoutSeconds * 1_000) } : {}),
      ...(parsedMaxSteps !== undefined ? { maxSteps: parsedMaxSteps } : {}),
      ...(permissionMode !== undefined ? { permissionMode } : {}),
      ...(permissionRules.length > 0 ? { permissionRules } : {}),
      ...(resumeId !== undefined ? { resumeId } : {}),
      ...(continueLatest ? { continueLatest: true } : {}),
      ...(thinking === 'default' ? { thinkingDefaultExplicit: true } : {}),
    },
  };
}

export async function runMakaTextCli(
  argv: readonly string[],
  overrides: Partial<MakaRunDeps> = {},
): Promise<number> {
  const deps = { ...defaultMakaRunDeps(), ...overrides };
  const parsed = parseMakaRunArgs(argv);
  if (parsed.kind === 'help') {
    deps.writeStdout(`${makaRunHelpText()}\n`);
    return 0;
  }
  if (parsed.kind === 'error') {
    deps.writeStderr(`maka run: ${parsed.message}\n\n${makaRunHelpText()}\n`);
    return 2;
  }

  let prompt: string;
  let selection: Awaited<ReturnType<typeof selectMakaRunSession>>;
  const workspaceRoot = deps.workspaceRoot();
  try {
    prompt = await resolveRunPrompt(parsed.options, deps);
    const sessions = parsed.options.resumeId !== undefined || parsed.options.continueLatest === true
      ? await deps.listSessions(workspaceRoot)
      : [];
    selection = await selectMakaRunSession({
      sessions,
      ...(parsed.options.resumeId !== undefined ? { resumeId: parsed.options.resumeId } : {}),
      continueLatest: parsed.options.continueLatest === true,
      ...(parsed.options.cwd !== undefined ? { explicitCwd: parsed.options.cwd } : {}),
      processCwd: deps.processCwd(),
      ...(parsed.options.connection !== undefined
        ? { explicitConnection: parsed.options.connection }
        : {}),
      ...(parsed.options.model !== undefined ? { explicitModel: parsed.options.model } : {}),
      thinkingSpecified: parsed.options.thinking !== undefined
        || parsed.options.thinkingDefaultExplicit === true,
      ...(parsed.options.thinking !== undefined
        ? { explicitThinking: parsed.options.thinking }
        : {}),
      ...(parsed.options.permissionMode !== undefined
        ? { explicitPermissionMode: parsed.options.permissionMode }
        : {}),
    }, { canonicalizeDirectory: canonicalDirectory });
  } catch (error) {
    deps.writeStderr(`maka run: ${errorMessage(error)}\n`);
    return 2;
  }

  let invocation: InvocationResult | undefined;
  let context: MakaRunContext;
  try {
    context = await deps.createContext({
      workspaceRoot,
      cwd: selection.cwd,
      ...((selection.kind === 'existing' || parsed.options.connection)
        ? {
            requestedConnectionSlug: selection.kind === 'existing'
              ? selection.session.llmConnectionSlug
              : parsed.options.connection,
          }
        : {}),
      ...((selection.kind === 'existing' || parsed.options.model)
        ? {
            requestedModel: selection.kind === 'existing'
              ? selection.session.model
              : parsed.options.model,
          }
        : {}),
      ...(selection.kind === 'existing'
        ? { sessionCwdOverride: { sessionId: selection.session.id, cwd: selection.cwd } }
        : {}),
      ...(parsed.options.maxSteps !== undefined ? { maxSteps: parsed.options.maxSteps } : {}),
      ...(parsed.options.permissionRules !== undefined
        ? { permissionRules: parsed.options.permissionRules }
        : {}),
      runtimeInvocationObserver: (result) => {
        invocation = result;
      },
    });
  } catch (error) {
    deps.writeStderr(`maka run: ${errorMessage(error)}\n`);
    return 2;
  }

  let session: SessionSummary;
  try {
    session = selection.kind === 'existing'
      ? selection.session
      : await context.runtime.createSession({
          cwd: selection.cwd,
          name: firstLine(prompt).slice(0, 42) || 'Maka run',
          backend: 'ai-sdk',
          llmConnectionSlug: context.target.connection.slug,
          model: context.target.model,
          permissionMode: parsed.options.permissionMode ?? 'explore',
          ...(parsed.options.thinking !== undefined ? { thinkingLevel: parsed.options.thinking } : {}),
        });
  } catch (error) {
    await context.close();
    deps.writeStderr(`maka run: ${errorMessage(error)}\n`);
    return 2;
  }

  let interrupted = false;
  let timedOut = false;
  let streamFailed = false;
  let stopPromise: Promise<void> | undefined;
  const stop = (): void => {
    if (stopPromise) return;
    stopPromise = context.runtime.stopSession(session.id, { source: 'stop_button' });
    void stopPromise.catch(() => {});
  };
  const removeSigint = deps.onSigint(() => {
    interrupted = true;
    stop();
  });
  const timer = parsed.options.timeoutMs === undefined
    ? undefined
    : deps.setTimer(() => {
      timedOut = true;
      stop();
    }, parsed.options.timeoutMs);

  try {
    for await (const event of context.runtime.sendMessage(session.id, {
      turnId: deps.newId(),
      text: prompt,
    })) {
      if (event.type === 'permission_request') {
        deps.writeStderr(`maka run: denied permission request for ${event.toolName}\n`);
        await context.runtime.respondToPermission(session.id, {
          requestId: event.requestId,
          decision: 'deny',
        });
      }
    }
    await stopPromise;
  } catch (error) {
    streamFailed = true;
    await stopPromise?.catch(() => undefined);
    if (!interrupted && !timedOut) {
      deps.writeStderr(`maka run: ${errorMessage(error)}\n`);
    }
  } finally {
    removeSigint();
    if (timer !== undefined) deps.clearTimer(timer);
    await context.close();
  }

  if (interrupted) return 130;
  if (timedOut) {
    deps.writeStderr(`maka run: timed out after ${parsed.options.timeoutMs}ms\n`);
    return 1;
  }
  if (streamFailed) return 1;
  if (!invocation) {
    deps.writeStderr('maka run: runtime produced no InvocationResult\n');
    return 1;
  }
  if (invocation.status !== 'completed' || invocation.finalOutput === undefined) {
    const detail = invocation.failure?.message ?? invocation.failure?.class ?? 'runtime failure';
    deps.writeStderr(`maka run: ${detail}\n`);
    return 1;
  }
  deps.writeStdout(withTrailingNewline(invocation.finalOutput));
  return 0;
}

async function resolveRunPrompt(options: MakaRunOptions, deps: MakaRunDeps): Promise<string> {
  const shouldReadStdin = options.stdinPrompt || !deps.stdinIsTTY();
  const stdin = shouldReadStdin ? await deps.readStdin() : '';
  if (options.stdinPrompt || options.prompt === undefined) {
    if (stdin.trim().length === 0) throw new Error('missing prompt input');
    return stdin;
  }
  if (options.prompt.trim().length === 0) throw new Error('missing prompt input');
  return stdin.trim().length > 0 ? `${options.prompt}\n\n${stdin}` : options.prompt;
}

async function canonicalDirectory(input: string): Promise<string> {
  const canonical = await realpath(resolve(input));
  if (!(await stat(canonical)).isDirectory()) throw new Error(`cwd is not a directory: ${input}`);
  return canonical;
}

function makaRunHelpText(): string {
  return [
    'Usage: maka run [PROMPT] [options]',
    '       maka -p [PROMPT] [options]',
    '',
    'Input:',
    '  -                         Read the complete prompt from stdin',
    '  PROMPT with piped stdin   Use PROMPT as instruction and stdin as context',
    '',
    'Options:',
    '  --cwd <path>              Working directory (default: current directory)',
    '  --connection <slug>       Model connection to use',
    '  --model <id>              Model to use',
    '  --thinking <level>        off|minimal|low|medium|high|xhigh|max|default',
    '  --timeout <seconds>       Invocation timeout',
    '  --max-steps <count>       Tool-step cap',
    '  --permission-mode <mode>  explore|execute|bypass (default: explore)',
    '  --allow <rule>            Repeatable category:<name>, tool:<name>, or Bash(<exact command>)',
    '  --deny <rule>             Repeatable category:<name>, tool:<name>, or Bash(<exact command>)',
    '  --resume <session-id>     Continue an explicit compatible session',
    '  --continue                Continue the latest compatible session for cwd',
    '  -h, --help                Show help',
  ].join('\n');
}

function parseToolPermissionRule(
  input: string,
  effect: 'allow' | 'deny',
): { ok: true; value: ToolPermissionRule } | { ok: false; message: string } {
  if (input.startsWith('category:')) {
    const category = input.slice('category:'.length);
    if (!isToolCategory(category)) {
      return { ok: false, message: `invalid --${effect} category rule: ${input}` };
    }
    return { ok: true, value: { effect, kind: 'category', category } };
  }
  if (input.startsWith('tool:')) {
    const toolName = input.slice('tool:'.length);
    if (toolName.length === 0 || toolName.trim() !== toolName) {
      return { ok: false, message: `invalid --${effect} tool rule: ${input}` };
    }
    return { ok: true, value: { effect, kind: 'tool', toolName } };
  }
  if (input.startsWith('Bash(') && input.endsWith(')')) {
    const command = input.slice('Bash('.length, -1);
    if (command.length === 0) {
      return { ok: false, message: `invalid --${effect} Bash rule: command is empty` };
    }
    return { ok: true, value: { effect, kind: 'bash_exact', command } };
  }
  return {
    ok: false,
    message: `invalid --${effect} rule: expected category:<name>, tool:<name>, or Bash(<exact command>)`,
  };
}

function defaultMakaRunDeps(): MakaRunDeps {
  return {
    createContext: createMakaCliRuntimeContext,
    listSessions: (workspaceRoot) => createSessionStore(workspaceRoot).list(),
    workspaceRoot: () => resolveMakaWorkspaceRoot(),
    processCwd: () => process.cwd(),
    stdinIsTTY: () => process.stdin.isTTY === true,
    readStdin: readProcessStdin,
    writeStdout: (text) => { process.stdout.write(text); },
    writeStderr: (text) => { process.stderr.write(text); },
    onSigint: (handler) => {
      process.on('SIGINT', handler);
      return () => process.off('SIGINT', handler);
    },
    setTimer: (handler, ms) => {
      const timer = setTimeout(handler, ms);
      timer.unref();
      return timer;
    },
    clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    newId: randomUUID,
  };
}

async function readProcessStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function firstLine(text: string): string {
  return text.split('\n').map((line) => line.trim()).find(Boolean) ?? '';
}

function withTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
