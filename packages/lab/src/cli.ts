#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { registerAiSdkBackend, registerFakeBackend, type LabConnection } from './backends.js';
import { runMatrix, type ExperimentSpec } from './matrix.js';
import { readResults, toComparisonTable, writeResults } from './results.js';

/** A run spec is the experiment (configs × tasks) plus the connections a
 *  real ('ai-sdk') run resolves slugs against. */
interface LabSpec extends ExperimentSpec {
  connections?: LabConnection[];
}

async function runCommand(args: string[]): Promise<number> {
  let positional: string[];
  let flags: Record<string, string>;
  try {
    ({ positional, flags } = parseArgs(args, ['out']));
  } catch (error) {
    console.error(`${(error as Error).message}\nusage: maka-lab run <spec.json> [--out <dir>]`);
    return 1;
  }
  const specPath = positional[0];
  if (!specPath) {
    console.error('usage: maka-lab run <spec.json> [--out <dir>]');
    return 1;
  }
  const specDir = dirname(resolve(specPath));
  const spec = JSON.parse(await readFile(specPath, 'utf8')) as LabSpec;
  // Task workspace fixtures are resolved relative to the spec file so a
  // spec is portable alongside its fixtures.
  const tasks = spec.tasks.map((task) => ({
    ...task,
    workspaceDir: isAbsolute(task.workspaceDir) ? task.workspaceDir : resolve(specDir, task.workspaceDir),
  }));
  const outDir = resolve(flags.out ?? 'maka-lab-out');

  console.log(`running ${spec.configs.length} config(s) × ${tasks.length} task(s)…`);
  const records = await runMatrix(
    { configs: spec.configs, tasks },
    {
      storageRoot: join(outDir, 'runs'),
      registerBackends: (registry) => {
        registerFakeBackend(registry);
        if (spec.connections?.length) registerAiSdkBackend(registry, spec.connections);
      },
    },
    (r) => console.log(`  ${mark(r.passed, r.error)} ${r.taskId} × ${r.configId}${r.error ? ` — ${r.error}` : ''}`),
  );

  const resultsPath = join(outDir, 'results.jsonl');
  const tablePath = join(outDir, 'comparison.md');
  const table = toComparisonTable(records);
  await writeResults(resultsPath, records);
  await writeFile(tablePath, table, 'utf8');
  console.log(`\n${table}\nresults: ${resultsPath}\ntable:   ${tablePath}`);
  return 0;
}

async function compareCommand(args: string[]): Promise<number> {
  const path = args[0];
  if (!path) {
    console.error('usage: maka-lab compare <results.jsonl>');
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
  console.error('maka-lab — headless agent experiment lab\n');
  console.error('  maka-lab run <spec.json> [--out <dir>]   run configs × tasks, write results + table');
  console.error('  maka-lab compare <results.jsonl>         print the comparison table');
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === 'run') return runCommand(rest);
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
