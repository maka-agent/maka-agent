#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { runMatrix, type ExperimentSpec } from './matrix.js';
import { backendNeedsIsolation, validateTaskVerification } from './runner.js';
import { readResults, toComparisonTable, writeResults } from './results.js';

/**
 * Reject a spec we cannot run safely or score trustworthily, BEFORE any run
 * starts — eval is a hard boundary, not a per-cell failure:
 *  - a model-backed backend would execute the config under test on the host
 *    with no isolation; the CLI wires only "fake", while real backends use the
 *    programmatic API with explicit realBackendIsolation;
 *  - a task with no declared grading boundary cannot be scored honestly.
 */
function validateEvalSpec(spec: ExperimentSpec): void {
  for (const config of spec.configs) {
    if (backendNeedsIsolation(config.backend)) {
      throw new Error(
        `config "${config.id}": backend "${config.backend}" requires an isolated executor and programmatic backend wiring — the CLI only wires "fake" by default`,
      );
    }
  }
  for (const task of spec.tasks) {
    validateTaskVerification(task);
  }
}

async function evalCommand(args: string[]): Promise<number> {
  let positional: string[];
  let flags: Record<string, string>;
  try {
    ({ positional, flags } = parseArgs(args, ['out']));
  } catch (error) {
    console.error(`${(error as Error).message}\nusage: maka-headless eval <spec.json> [--out <dir>]`);
    return 1;
  }
  const specPath = positional[0];
  if (!specPath) {
    console.error('usage: maka-headless eval <spec.json> [--out <dir>]');
    return 1;
  }

  // Read + parse + validate up front: an unreadable file, malformed JSON, a
  // refused backend, or a missing grading boundary is an infrastructure error,
  // not benchmark data — fail before running anything.
  let spec: ExperimentSpec;
  try {
    spec = JSON.parse(await readFile(specPath, 'utf8')) as ExperimentSpec;
    validateEvalSpec(spec);
  } catch (error) {
    console.error(`maka-headless: ${(error as Error).message}`);
    return 1;
  }

  const specDir = dirname(resolve(specPath));
  // Task workspace fixtures are resolved relative to the spec file so a
  // spec is portable alongside its fixtures.
  const tasks = spec.tasks.map((task) => ({
    ...task,
    workspaceDir: isAbsolute(task.workspaceDir) ? task.workspaceDir : resolve(specDir, task.workspaceDir),
  }));
  const outDir = resolve(flags.out ?? 'maka-headless-out');

  console.log(`running ${spec.configs.length} config(s) × ${tasks.length} task(s)…`);
  const records = await runMatrix(
    { configs: spec.configs, tasks },
    {
      storageRoot: join(outDir, 'runs'),
      // registerBackends omitted → runExperiment defaults to the inert
      // FakeBackend, the only backend this build runs.
    },
    (r) => console.log(`  ${mark(r.passed, r.error)} ${r.taskId} × ${r.configId}${r.error ? ` — ${r.error}` : ''}`),
  );

  const resultsPath = join(outDir, 'results.jsonl');
  const tablePath = join(outDir, 'comparison.md');
  const table = toComparisonTable(records);
  await writeResults(resultsPath, records);
  await writeFile(tablePath, table, 'utf8');
  console.log(`\n${table}\nresults: ${resultsPath}\ntable:   ${tablePath}`);
  // Honest exit code: a run that THREW (missing workspace, unknown backend, …)
  // carries an `error` and never produced a trustworthy pass/fail — that is an
  // infrastructure failure, exit non-zero. A run that completed and merely
  // failed its verification is valid benchmark data and stays exit 0.
  return records.some((r) => r.error) ? 1 : 0;
}

async function compareCommand(args: string[]): Promise<number> {
  const path = args[0];
  if (!path) {
    console.error('usage: maka-headless compare <results.jsonl>');
    return 1;
  }
  process.stdout.write(toComparisonTable(await readResults(path)));
  return 0;
}

function mark(passed: boolean, error?: string): string {
  if (error) return '⚠️';
  return passed ? '✅' : '❌';
}

function parseArgs(args: string[], knownFlags: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (!knownFlags.includes(name)) throw new Error(`unknown flag: ${arg}`);
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`flag ${arg} needs a value`);
    flags[name] = value;
    i++;
  }
  return { positional, flags };
}

function printUsage(): void {
  console.error('maka-headless — headless agent runner (eval mode)\n');
  console.error('  maka-headless eval <spec.json> [--out <dir>]   run configs × tasks, write results + table');
  console.error('  maka-headless compare <results.jsonl>          print the comparison table');
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === 'eval') return evalCommand(rest);
  if (cmd === 'compare') return compareCommand(rest);
  printUsage();
  return cmd ? 1 : 0;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
