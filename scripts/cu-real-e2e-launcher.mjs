import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const monitorPath = join(here, 'cu-real-e2e-monitor.swift');
const harnessPath = join(here, 'cu-real-e2e.mjs');
const labRoot = '/Users/haoqing/Documents/Learning/codex-computer-use-lab';
const statePath = join(labRoot, 'test-app', 'runtime', 'state.json');
const concurrentUserMode = process.argv.includes('--concurrent-user');

const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function runChild(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: options.stdio ?? ['ignore', 'inherit', 'inherit'],
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(
        `${file} failed (${signal ?? code})`,
      ));
    });
  });
}

async function runFixtureScript(name) {
  await runChild(join(labRoot, 'test-app', name), []);
}

async function runBuilds() {
  await runChild('npm', ['--workspace', '@maka/core', 'run', 'build'], {
    cwd: repoRoot,
  });
  await runChild('npm', ['--workspace', '@maka/runtime', 'run', 'build'], {
    cwd: repoRoot,
  });
  await runChild('npm', ['--workspace', '@maka/computer-use', 'run', 'build'], {
    cwd: repoRoot,
  });
  await runChild('npm', ['run', 'check:cua-driver-artifact'], {
    cwd: repoRoot,
  });
}

async function frontmostApplication() {
  const script = [
    'tell application "System Events"',
    'set frontProcess to first application process whose frontmost is true',
    'return (unix id of frontProcess as text) & tab & (bundle identifier of frontProcess as text)',
    'end tell',
  ].join('\n');
  let output = '';
  await new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/osascript', ['-e', script], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`failed to capture frontmost application (${code})`));
    });
  });
  const [pid, bundleIdentifier] = output.trim().split('\t');
  if (!Number.isInteger(Number(pid)) || !bundleIdentifier) {
    throw new Error(`invalid frontmost application identity: ${output.trim()}`);
  }
  return { pid: Number(pid), bundleIdentifier };
}

async function activateBundle(bundleIdentifier) {
  await runChild('/usr/bin/osascript', [
    '-e',
    `tell application id "${bundleIdentifier}" to activate`,
  ], { stdio: ['ignore', 'ignore', 'inherit'] });
  await delay(500);
}

async function restoreFrontmost(application) {
  const escapedBundleIdentifier = application.bundleIdentifier
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"');
  const script = [
    'tell application "System Events"',
    `if exists (first application process whose unix id is ${application.pid}) then`,
    `set frontmost of first application process whose unix id is ${application.pid} to true`,
    'else',
    `tell application id "${escapedBundleIdentifier}" to activate`,
    'end if',
    'end tell',
  ].join('\n');
  await runChild('/usr/bin/osascript', ['-e', script], {
    stdio: ['ignore', 'ignore', 'ignore'],
  });
}

async function terminateChild(child, label, timeoutMs = 3_000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  if (await Promise.race([exited.then(() => true), delay(timeoutMs).then(() => false)])) {
    return;
  }
  child.kill('SIGKILL');
  if (!await Promise.race([exited.then(() => true), delay(timeoutMs).then(() => false)])) {
    throw new Error(`${label} did not exit after SIGKILL`);
  }
}

async function waitForJson(path, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    await delay(50);
  }
  throw new Error(`${label} timeout`);
}

function startMonitor(input = {}) {
  const args = [monitorPath];
  if (input.concurrentUserMode) {
    args.push('--concurrent-user', String(input.fixturePID));
  }
  const child = spawn('swift', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let buffer = '';
  let stderr = '';
  let readyResolve;
  let readyReject;
  let failureResolve;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const failure = new Promise((resolve) => { failureResolve = resolve; });
  let readySettled = false;
  let failureSettled = false;

  const fail = (error) => {
    const normalized = error instanceof Error ? error : new Error(String(error));
    if (!readySettled) {
      readySettled = true;
      readyReject(normalized);
    }
    if (!failureSettled) {
      failureSettled = true;
      failureResolve(normalized);
    }
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines.map((value) => value.trim()).filter(Boolean)) {
      const [kind, ...fields] = line.split('\t');
      if (kind === 'READY') {
        readySettled = true;
        readyResolve({
          mode: fields[0],
          frontmostPID: Number(fields[1]),
          pointer: { x: Number(fields[2]), y: Number(fields[3]) },
          bundleIdentifier: fields[4],
          canonicalAppPath: fields.slice(5).join('\t'),
        });
      } else if (kind === 'CHANGE' || kind === 'ERROR') {
        fail(new Error(fields.join('\t') || line));
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('error', fail);
  child.on('exit', (code, signal) => {
    if (!failureSettled && code !== 0 && signal !== 'SIGTERM') {
      fail(new Error(
        `monitor exited (${signal ?? code})${stderr.trim() ? `: ${stderr.trim()}` : ''}`,
      ));
    }
  });
  return {
    child,
    ready,
    failure,
    stop: () => terminateChild(child, 'safety monitor'),
  };
}

async function run() {
  const originalFrontmost = await frontmostApplication();
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'maka-cu-real-e2e-'));
  let fixtureTouched = false;
  let caffeinate;
  let monitor;
  let harness;
  try {
    caffeinate = spawn('/usr/bin/caffeinate', ['-dimsu'], {
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    await runBuilds();
    fixtureTouched = true;
    await runFixtureScript('stop.sh');
    await runFixtureScript('reset.sh');
    const frontmostBeforeFixtureLaunch = concurrentUserMode
      ? await frontmostApplication()
      : originalFrontmost;
    await runFixtureScript('launch.sh');
    const fixtureState = JSON.parse(await readFile(statePath, 'utf8'));
    const fixturePID = fixtureState?.oop?.hostPID;
    if (!Number.isInteger(fixturePID) || fixturePID <= 0) {
      throw new Error('synthetic fixture did not publish a valid PID');
    }
    await activateBundle('com.openai.codex.cualab');
    const preparedPath = join(temporaryDirectory, 'concurrent-prepared.json');
    const proceedPath = join(temporaryDirectory, 'concurrent-proceed.json');
    let baseline;
    if (!concurrentUserMode) {
      monitor = startMonitor({ concurrentUserMode, fixturePID });
      baseline = await Promise.race([
        monitor.ready,
        delay(10_000).then(() => {
          throw new Error('safety monitor startup timeout');
        }),
      ]);
      baseline.fixturePID = fixturePID;
    } else {
      baseline = {
        mode: 'concurrent_user',
        fixturePID,
        frontmostPID: frontmostBeforeFixtureLaunch.pid,
        pointer: { x: 0, y: 0 },
        bundleIdentifier: frontmostBeforeFixtureLaunch.bundleIdentifier,
        canonicalAppPath: 'pending-concurrent-monitor',
      };
    }
    harness = spawn(process.execPath, [harnessPath], {
      cwd: repoRoot,
      env: {
        ...process.env,
        MAKA_CU_REAL_E2E_BASELINE: JSON.stringify(baseline),
        MAKA_CU_REAL_E2E_MODE: concurrentUserMode ? 'concurrent_user' : 'isolated',
        MAKA_CU_REAL_E2E_TEMP_DIR: temporaryDirectory,
      },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    const exit = new Promise((resolve, reject) => {
      harness.once('error', reject);
      harness.once('exit', (code, signal) => resolve({ code, signal }));
    });
    if (concurrentUserMode) {
      await Promise.race([
        waitForJson(preparedPath, 'concurrent E2E prepare'),
        exit.then((result) => {
          throw new Error(
            `real E2E exited before concurrent prepare (${result.signal ?? result.code})`,
          );
        }),
      ]);
      await restoreFrontmost(frontmostBeforeFixtureLaunch);
      await delay(750);
      monitor = startMonitor({ concurrentUserMode, fixturePID });
      const concurrentBaseline = await Promise.race([
        monitor.ready,
        delay(10_000).then(() => {
          throw new Error('concurrent safety monitor startup timeout');
        }),
      ]);
      concurrentBaseline.fixturePID = fixturePID;
      await runChild(process.execPath, [
        '-e',
        "require('fs').writeFileSync(process.argv[1], process.argv[2], {flag:'wx',mode:0o600})",
        proceedPath,
        JSON.stringify(concurrentBaseline),
      ], { stdio: ['ignore', 'ignore', 'inherit'] });
    }
    const first = await Promise.race([
      exit.then((result) => ({ type: 'exit', result })),
      monitor.failure.then((error) => ({ type: 'safety', error })),
    ]);
    if (first.type === 'safety') {
      await terminateChild(harness, 'real E2E harness');
      throw first.error;
    }
    if (first.result.code !== 0) {
      throw new Error(`real E2E failed (${first.result.signal ?? first.result.code})`);
    }
  } finally {
    await terminateChild(harness, 'real E2E harness').catch(() => {});
    await monitor?.stop().catch(() => {});
    if (fixtureTouched) await runFixtureScript('stop.sh').catch(() => {});
    if (!concurrentUserMode) {
      await restoreFrontmost(originalFrontmost).catch(() => {});
    }
    await terminateChild(caffeinate, 'caffeinate').catch(() => {});
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error('Computer Use real E2E failed:', error);
  process.exitCode = 1;
});
