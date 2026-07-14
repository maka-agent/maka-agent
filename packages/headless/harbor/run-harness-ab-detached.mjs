#!/usr/bin/env node

import { closeSync, openSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { resolveFixedPromptRunRoot } from '#fixed-prompt-task-source';
import { DEFAULT_HARNESS_AB_RUN_ID, main as runHarnessAb } from './run-harness-ab.mjs';

const WORKER_ARG = '--worker';
const JOURNAL_FILENAME = 'background-run.json';
const LOG_FILENAME = 'background-run.log';

function envPath(name) {
  const raw = process.env[name];
  if (!raw) throw new Error(`${name} is required`);
  return raw.startsWith('~') ? join(homedir(), raw.slice(1)) : resolve(raw);
}

function detachedRunPaths() {
  const outDir = envPath('MAKA_HARNESS_AB_OUT_DIR');
  const runId = process.env.MAKA_HARNESS_AB_RUN_ID || DEFAULT_HARNESS_AB_RUN_ID;
  const runRoot = resolveFixedPromptRunRoot(outDir, runId, 'MAKA_HARNESS_AB_RUN_ID');
  return {
    runRoot,
    journalPath: join(runRoot, JOURNAL_FILENAME),
    logPath: join(runRoot, LOG_FILENAME),
  };
}

async function writeJournal(path, value) {
  const pendingPath = `${path}.${process.pid}.tmp`;
  await writeFile(pendingPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(pendingPath, path);
}

async function runWorker() {
  const { runRoot, journalPath, logPath } = detachedRunPaths();
  await mkdir(runRoot, { recursive: true });
  const startedAt = process.env.MAKA_HARNESS_AB_DETACHED_STARTED_AT || new Date().toISOString();
  const base = {
    schemaVersion: 1,
    pid: process.pid,
    startedAt,
    logPath,
  };
  await writeJournal(journalPath, { ...base, status: 'running' });
  let exitCode = 0;
  try {
    await runHarnessAb();
  } catch (error) {
    exitCode = 1;
    console.error(error);
  } finally {
    await writeJournal(journalPath, {
      ...base,
      status: exitCode === 0 ? 'completed' : 'failed',
      finishedAt: new Date().toISOString(),
      exitCode,
    });
  }
  process.exitCode = exitCode;
}

async function launchDetached() {
  const { runRoot, logPath } = detachedRunPaths();
  await mkdir(runRoot, { recursive: true });
  const logFd = openSync(logPath, 'a', 0o600);
  const startedAt = new Date().toISOString();
  let child;
  try {
    child = spawn(process.execPath, [fileURLToPath(import.meta.url), WORKER_ARG], {
      detached: true,
      env: { ...process.env, MAKA_HARNESS_AB_DETACHED_STARTED_AT: startedAt },
      stdio: ['ignore', logFd, logFd],
    });
  } finally {
    closeSync(logFd);
  }
  child.unref();
  console.log(`detached harness runner started: pid ${child.pid}; journal ${join(runRoot, JOURNAL_FILENAME)}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const action = process.argv.includes(WORKER_ARG) ? runWorker : launchDetached;
  action().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
