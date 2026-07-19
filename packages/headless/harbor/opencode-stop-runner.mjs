#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const args = process.argv.slice(2);
const commandIndex = args.indexOf('--');
const outputIndex = args.indexOf('--output');
const graceIndex = args.indexOf('--grace-ms');

if (commandIndex < 0 || outputIndex < 0 || outputIndex + 1 >= args.length) {
  console.error(
    'usage: opencode-stop-runner.mjs --output PATH [--grace-ms MS] -- COMMAND [ARGS...]',
  );
  process.exit(2);
}

const outputPath = args[outputIndex + 1];
const graceMs = graceIndex >= 0 ? Number(args[graceIndex + 1]) : 2000;
const command = args[commandIndex + 1];
const commandArgs = args.slice(commandIndex + 2);

if (!command) {
  console.error('opencode-stop-runner.mjs: missing command');
  process.exit(2);
}

if (!Number.isFinite(graceMs) || graceMs < 0) {
  console.error('opencode-stop-runner.mjs: --grace-ms must be a non-negative number');
  process.exit(2);
}

await mkdir(dirname(outputPath), { recursive: true });
const output = createWriteStream(outputPath, { flags: 'w' });
const child = spawn(command, commandArgs, {
  detached: process.platform !== 'win32',
  env: process.env,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stopSeen = false;
let terminating = false;
let terminatedByRunner = false;
let stdoutBuffer = '';
let stderrBuffer = '';

function write(chunk) {
  process.stdout.write(chunk);
  output.write(chunk);
}

function inspectLine(line) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }
  if (event?.type === 'step_finish' && event?.part?.reason === 'stop') {
    stopSeen = true;
    scheduleTermination();
  }
}

function consumeStdout(chunk) {
  const text = chunk.toString();
  write(text);
  stdoutBuffer += text;
  let newline;
  while ((newline = stdoutBuffer.indexOf('\n')) >= 0) {
    const line = stdoutBuffer.slice(0, newline).trim();
    stdoutBuffer = stdoutBuffer.slice(newline + 1);
    if (line) {
      inspectLine(line);
    }
  }
}

function consumeStderr(chunk) {
  const text = chunk.toString();
  write(text);
  stderrBuffer += text;
  let newline;
  while ((newline = stderrBuffer.indexOf('\n')) >= 0) {
    const line = stderrBuffer.slice(0, newline).trim();
    stderrBuffer = stderrBuffer.slice(newline + 1);
    if (line) {
      inspectLine(line);
    }
  }
}

async function scheduleTermination() {
  if (terminating) {
    return;
  }
  terminating = true;
  await delay(graceMs);
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  terminatedByRunner = true;
  terminateChild('SIGTERM');
  await delay(1000);
  if (child.exitCode === null && child.signalCode === null) {
    terminateChild('SIGKILL');
  }
}

function terminateChild(signal) {
  try {
    if (process.platform !== 'win32') {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The child already exited.
    }
  }
}

child.stdout.on('data', consumeStdout);
child.stderr.on('data', consumeStderr);
child.on('error', (error) => {
  console.error(String(error?.message || error));
});

const exitCode = await new Promise((resolve) => {
  child.on('close', (code, signal) => {
    const remainingStdout = stdoutBuffer.trim();
    const remainingStderr = stderrBuffer.trim();
    if (remainingStdout) {
      inspectLine(remainingStdout);
    }
    if (remainingStderr) {
      inspectLine(remainingStderr);
    }
    output.end(() => {
      if (stopSeen && terminatedByRunner) {
        resolve(0);
      } else if (typeof code === 'number') {
        resolve(code);
      } else {
        console.error(`opencode-stop-runner.mjs: child exited via ${signal || 'unknown signal'}`);
        resolve(1);
      }
    });
  });
});

process.exit(exitCode);
