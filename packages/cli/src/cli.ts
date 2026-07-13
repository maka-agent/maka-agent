#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describeChatConfigurationReason, parseNoRealConnectionError } from '@maka/core';
import { handleGoalContinuation } from '@maka/runtime';
import { createMakaSessionDriver } from './session-driver.js';
import { createMakaCliRuntimeContext } from './runtime-bootstrap.js';
import { selectableModelIdsForTarget } from './connection-target.js';
import { resolveMakaWorkspaceRoot } from './workspace-root.js';
import { runMakaPiTui } from './pi-tui-runner.js';

export type MakaCliCommand =
  | { kind: 'tui' }
  | { kind: 'run'; args: string[] }
  | { kind: 'eval'; args: string[] }
  | { kind: 'help'; text: string }
  | { kind: 'version'; text: string }
  | { kind: 'error'; message: string; exitCode: number };

export function parseMakaCliArgs(argv: string[], version: string): MakaCliCommand {
  if (argv.length === 0) return { kind: 'tui' };
  const [first] = argv;
  if (first === '--help' || first === '-h') return { kind: 'help', text: helpText() };
  if (first === '--version' || first === '-v') return { kind: 'version', text: version };
  if (first === 'run' || first === '-p') return { kind: 'run', args: argv.slice(1) };
  if (first === 'eval') return { kind: 'eval', args: argv.slice(1) };
  return {
    kind: 'error',
    message: `Unexpected argument: ${first ?? ''}`,
    exitCode: 2,
  };
}

export function resolveMakaCliExitCode(
  commandExitCode: number,
  pendingExitCode: number | string | null | undefined,
): number | string {
  return pendingExitCode === undefined || pendingExitCode === null || pendingExitCode === 0
    ? commandExitCode
    : pendingExitCode;
}

export function formatMakaCliFatalError(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

let processExitTimer: NodeJS.Timeout | undefined;

export function beginMakaCliExit(commandExitCode: number): void {
  const exitCode = resolveMakaCliExitCode(commandExitCode, process.exitCode);
  process.exitCode = exitCode;
  if (processExitTimer) return;
  processExitTimer = setTimeout(() => process.exit(process.exitCode ?? 0), PROCESS_EXIT_GRACE_MS);
  processExitTimer.unref();
}

export function handleMakaCliProcessExit(
  exitCode: number,
  error?: unknown,
  writeFatal: (message: string) => unknown = (message) => process.stderr.write(message),
): void {
  beginMakaCliExit(exitCode);
  if (error) writeFatal(`${formatMakaCliFatalError(error)}\n`);
}

function helpText(): string {
  return [
    'Usage: maka',
    '',
    'Launches the Maka terminal UI in the current working directory.',
    '',
    'Commands:',
    '  maka              Start the TUI',
    '  maka-agent        Start the TUI',
    '  maka run ...      Run one non-interactive model turn',
    '  maka -p ...       Alias for maka run',
    '  maka eval ...     Run evaluation and autonomous task commands',
    '',
    'Options:',
    '  -h, --help        Show help',
    '  -v, --version     Show version',
  ].join('\n');
}

export async function runMakaCli(argv: string[] = process.argv.slice(2)): Promise<number> {
  const version = await readPackageVersion();
  const command = parseMakaCliArgs(argv, version);
  switch (command.kind) {
    case 'run': {
      const { runMakaTextCli } = await import('./run-command.js');
      return runMakaTextCli(command.args);
    }
    case 'eval': {
      const { runMakaEvalCli } = await import('@maka/headless/eval-router');
      return runMakaEvalCli(command.args);
    }
    case 'help':
      process.stdout.write(`${command.text}\n`);
      return 0;
    case 'version':
      process.stdout.write(`${command.text}\n`);
      return 0;
    case 'error':
      process.stderr.write(`${command.message}\n\n${helpText()}\n`);
      return command.exitCode;
    case 'tui': {
      const workspaceRoot = resolveMakaWorkspaceRoot();
      let context;
      try {
        context = await createMakaCliRuntimeContext({
          workspaceRoot,
          cwd: process.cwd(),
        });
      } catch (error) {
        // A missing / misconfigured connection is the first thing a new user
        // hits. Translate the raw `NO_REAL_CONNECTION:<reason>` throw into
        // actionable guidance; let anything else propagate to the top-level
        // handler unchanged.
        const guidance = formatStartupConnectionError(error, workspaceRoot);
        if (guidance === null) throw error;
        process.stderr.write(`${guidance}\n`);
        return 1;
      }
      try {
        const driver = createMakaSessionDriver({
          runtime: context.runtime,
          cwd: context.cwd,
          llmConnectionSlug: context.target.connection.slug,
          model: context.target.model,
          permissionMode: 'ask',
        });
        await runMakaPiTui({
          driver,
          title: 'Maka',
          cwd: context.cwd,
          model: context.target.model,
          models: selectableModelIdsForTarget(context.target),
          modelChoices: context.modelChoices,
          connectionSlug: context.target.connection.slug,
          providerType: context.target.connection.providerType,
          permissionMode: 'ask',
          subscribeShellRunUpdates: context.subscribeShellRunUpdates,
          listShellRunUpdates: context.listShellRunUpdates,
          onProcessExit: handleMakaCliProcessExit,
          onTurnComplete: (injectTurn) => {
            const sessionId = driver.getSessionId();
            if (!sessionId) return;
            void handleGoalContinuation(
              { ...context.goalContinuationDeps, injectTurn: (_s, text) => injectTurn(text) },
              sessionId,
            ).catch(() => {});
          },
        });
        return 0;
      } finally {
        await context.close();
      }
    }
  }
}

/**
 * Turn a startup failure into first-run connection guidance, or `null` when the
 * error is not a `NO_REAL_CONNECTION` failure (so the caller re-throws it). The
 * reason-specific line reuses the shared core copy; the footer explains the CLI
 * has no in-app settings — connections are configured in the desktop app, which
 * writes the same workspace this CLI reads.
 */
export function formatStartupConnectionError(error: unknown, workspaceRoot: string): string | null {
  // `resolveDefaultSessionTarget` is the only producer of `NO_REAL_CONNECTION`
  // on this startup path. A matched error with an unknown reason still yields
  // generic fix copy below; a non-match returns null so the real error keeps
  // propagating to the top-level handler unchanged.
  const { matched, reason } = parseNoRealConnectionError(error);
  if (!matched) return null;
  return [
    '无法启动 Maka：还没有可用的模型连接。',
    '',
    describeChatConfigurationReason(reason),
    '',
    'Maka CLI 复用 Maka 桌面应用的配置。请打开 Maka 桌面应用，在 设置 · 模型',
    '添加并启用一个模型连接（含 API key），然后重新运行 maka。',
    `连接与凭据存储于：${workspaceRoot}`,
  ].join('\n');
}

async function readPackageVersion(): Promise<string> {
  const raw = await readFile(new URL('../package.json', import.meta.url), 'utf8');
  const parsed = JSON.parse(raw) as { version?: unknown };
  return typeof parsed.version === 'string' ? parsed.version : '0.0.0';
}

if (isMainModule()) {
  runMakaCli().then(
    (code) => {
      beginMakaCliExit(code);
    },
    (error) => {
      handleMakaCliProcessExit(1, error);
    },
  );
}

// ShellRun escalates SIGTERM to SIGKILL after two seconds. Keep the CLI alive
// long enough for that cleanup to finish before the final process fallback.
const PROCESS_EXIT_GRACE_MS = 3_000;

function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
