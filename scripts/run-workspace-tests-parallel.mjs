#!/usr/bin/env node
/**
 * Run each workspace's `test:dist` script.
 *
 * Default: parallel batch, then serial-only workspaces.
 * `--serial`: every workspace in package.json workspaces order (CI).
 *
 * Each workspace owns how its dist tests run via package.json `test:dist`.
 * This script only owns scheduling (parallel vs serial) and failure reporting.
 */

import { spawn as defaultSpawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepoRoot = dirname(dirname(scriptPath));

// Headless is kept out of the concurrent batch after observed flakes when
// co-scheduled with other workspace suites. Isolation of HOME/XDG is already
// handled inside scripts/run-headless-tests.mjs; serial scheduling is extra
// conservatism for root orchestration, not a claim that its suite shares FS
// state with other packages.
export const SERIAL_WORKSPACE_DIRS = ['packages/headless'];

export function loadWorkspaceDirs(repoRoot, readFile = readFileSync) {
  const rootPkg = JSON.parse(readFile(join(repoRoot, 'package.json'), 'utf8'));
  return Array.isArray(rootPkg.workspaces) ? rootPkg.workspaces : [];
}

export function partitionWorkspaces(workspaceDirs, serialDirs = SERIAL_WORKSPACE_DIRS) {
  const serialSet = new Set(serialDirs);
  return {
    parallel: workspaceDirs.filter((dir) => !serialSet.has(dir)),
    serial: workspaceDirs.filter((dir) => serialSet.has(dir)),
  };
}

export function nameForDir(dir) {
  return dir.replace(/^(packages|apps)\//, '');
}

export function runWorkspace(dir, { repoRoot, spawn = defaultSpawn } = {}) {
  const name = nameForDir(dir);
  // Package-owned contract: each workspace declares how dist tests run.
  const command = 'npm run test:dist';
  const cwd = join(repoRoot, dir);
  console.log(`\n[${name}] start: ${command}`);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, { cwd, stdio: 'inherit', shell: true });
    let settled = false;
    const settle = (fn) => {
      if (settled) return;
      settled = true;
      fn();
    };
    child.on('error', (err) => {
      settle(() => reject(new Error(`[${name}] spawn failed: ${err.message}`)));
    });
    child.on('close', (code) => {
      settle(() => {
        if (code === 0) {
          console.log(`[${name}] passed`);
          resolvePromise(name);
        } else {
          reject(new Error(`[${name}] failed with code ${code}`));
        }
      });
    });
  });
}

async function runSerial(dirs, options) {
  for (const dir of dirs) {
    await runWorkspace(dir, options);
  }
}

async function runParallel(dirs, options) {
  const results = await Promise.allSettled(dirs.map((dir) => runWorkspace(dir, options)));
  const failures = results.filter((r) => r.status === 'rejected');
  if (failures.length > 0) {
    const messages = failures.map((r) => r.reason?.message ?? String(r.reason));
    throw new Error(messages.join('\n'));
  }
}

export async function runWorkspaceTests(options = {}) {
  const repoRoot = options.repoRoot ?? defaultRepoRoot;
  const serialFlag = options.serial ?? false;
  const spawn = options.spawn ?? defaultSpawn;
  const workspaceDirs = options.workspaceDirs ?? loadWorkspaceDirs(repoRoot);
  const serialDirs = options.serialWorkspaceDirs ?? SERIAL_WORKSPACE_DIRS;
  const runOptions = { repoRoot, spawn };

  if (serialFlag) {
    await runSerial(workspaceDirs, runOptions);
  } else {
    const { parallel, serial } = partitionWorkspaces(workspaceDirs, serialDirs);
    await runParallel(parallel, runOptions);
    await runSerial(serial, runOptions);
  }
}

async function main(args) {
  const serial = args.includes('--serial');
  await runWorkspaceTests({ serial });
  console.log('\nAll workspace tests passed.');
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
