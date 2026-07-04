#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createMakaSessionDriver } from './session-driver.js';
import { createMakaCliRuntimeContext } from './runtime-bootstrap.js';
import { selectableModelIdsForTarget } from './connection-target.js';
import { resolveMakaWorkspaceRoot } from './workspace-root.js';
import { runMakaPiTui } from './pi-tui-runner.js';

export type MakaCliCommand =
  | { kind: 'run' }
  | { kind: 'help'; text: string }
  | { kind: 'version'; text: string }
  | { kind: 'error'; message: string; exitCode: number };

export function parseMakaCliArgs(argv: string[], version: string): MakaCliCommand {
  if (argv.length === 0) return { kind: 'run' };
  const [first] = argv;
  if (first === '--help' || first === '-h') return { kind: 'help', text: helpText() };
  if (first === '--version' || first === '-v') return { kind: 'version', text: version };
  return {
    kind: 'error',
    message: `Unexpected argument: ${first ?? ''}`,
    exitCode: 2,
  };
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
    case 'help':
      process.stdout.write(`${command.text}\n`);
      return 0;
    case 'version':
      process.stdout.write(`${command.text}\n`);
      return 0;
    case 'error':
      process.stderr.write(`${command.message}\n\n${helpText()}\n`);
      return command.exitCode;
    case 'run': {
      const context = await createMakaCliRuntimeContext({
        workspaceRoot: resolveMakaWorkspaceRoot(),
        cwd: process.cwd(),
      });
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
        connectionSlug: context.target.connection.slug,
        permissionMode: 'ask',
      });
      return 0;
    }
  }
}

async function readPackageVersion(): Promise<string> {
  const raw = await readFile(new URL('../package.json', import.meta.url), 'utf8');
  const parsed = JSON.parse(raw) as { version?: unknown };
  return typeof parsed.version === 'string' ? parsed.version : '0.0.0';
}

if (isMainModule()) {
  runMakaCli().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}

function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
