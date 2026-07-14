#!/usr/bin/env node

import { closeSync, openSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { resolveFixedPromptRunRoot } from '#fixed-prompt-task-source';
import { DEFAULT_HARNESS_AB_RUN_ID } from './run-harness-ab.mjs';

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
    logPath: join(runRoot, LOG_FILENAME),
  };
}

async function launchDetached() {
  const { runRoot, logPath } = detachedRunPaths();
  await mkdir(runRoot, { recursive: true });
  const logFd = openSync(logPath, 'a', 0o600);
  const startedAt = new Date().toISOString();
  const workerPath = fileURLToPath(new URL('./run-harness-ab.mjs', import.meta.url));
  let child;
  try {
    child = spawn(process.execPath, [workerPath], {
      detached: true,
      env: {
        ...process.env,
        MAKA_HARNESS_AB_BACKGROUND_RUN: '1',
        MAKA_HARNESS_AB_DETACHED_STARTED_AT: startedAt,
      },
      stdio: ['ignore', logFd, logFd],
    });
  } finally {
    closeSync(logFd);
  }
  child.unref();
  console.log(`detached harness runner started: pid ${child.pid}; journal ${join(runRoot, JOURNAL_FILENAME)}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  launchDetached().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
