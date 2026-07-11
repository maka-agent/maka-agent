import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const electronPath = join(
  repoRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'electron.cmd' : 'electron',
);
const childScript = join(here, 'cu-e2e-full.mjs');
const monitorScript = join(here, 'cu-e2e-monitor.swift');

function startSafetyMonitor() {
  const child = spawn('swift', [monitorScript], { stdio: ['ignore', 'pipe', 'pipe'] });

  let stopped = false;
  let settled = false;
  let stdoutBuffer = '';
  let stderrBuffer = '';
  let readyResolve;
  let readyReject;
  let failureResolve;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const failure = new Promise((resolve) => {
    failureResolve = resolve;
  });

  function fail(error) {
    if (settled) return;
    settled = true;
    const failureError = error instanceof Error ? error : new Error(String(error));
    readyReject(failureError);
    failureResolve(failureError);
  }

  function consumeLine(line) {
    if (!line) return;
    const [kind, ...fields] = line.split('\t');
    if (kind === 'READY') {
      const baseline = {
        originalFrontmostPid: Number(fields[0]),
        originalPointerPosition: {
          x: Number(fields[1]),
          y: Number(fields[2]),
        },
      };
      if (
        !Number.isInteger(baseline.originalFrontmostPid)
        || !Number.isFinite(baseline.originalPointerPosition.x)
        || !Number.isFinite(baseline.originalPointerPosition.y)
      ) {
        fail(new Error(`invalid safety monitor baseline: ${line}`));
        return;
      }
      readyResolve(baseline);
      return;
    }
    if (kind === 'CHANGE' || kind === 'ERROR') {
      fail(new Error(fields.join('\t') || 'safety monitor reported an unknown failure'));
      return;
    }
    fail(new Error(`unexpected safety monitor output: ${line}`));
  }

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop() ?? '';
    for (const line of lines) consumeLine(line.trim());
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderrBuffer += chunk;
  });
  child.on('error', (error) => {
    fail(new Error(`safety monitor failed to start: ${error.message}`));
  });
  child.on('exit', (code, signal) => {
    if (stopped || settled) return;
    fail(new Error(
      `safety monitor exited unexpectedly (${signal ?? `code ${code}`})`
        + `${stderrBuffer.trim() ? `: ${stderrBuffer.trim()}` : ''}`,
    ));
  });

  return {
    ready,
    failure,
    async stop() {
      if (stopped) return;
      stopped = true;
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        await new Promise((resolve) => child.once('exit', resolve));
      }
    },
  };
}

async function waitForBaseline(ready) {
  let timer;
  try {
    return await Promise.race([
      ready,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('safety monitor did not become ready within 10000ms')),
          10_000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function reserveLoopbackPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  if (!Number.isInteger(port) || port <= 0) throw new Error('failed to reserve a CDP port');
  return port;
}

async function run() {
  const monitor = startSafetyMonitor();
  let electron;
  let forcedTimer;
  try {
    const baseline = await waitForBaseline(monitor.ready);
    const cdpPort = await reserveLoopbackPort();
    electron = spawn(electronPath, [
      `--remote-debugging-port=${cdpPort}`,
      '--remote-allow-origins=*',
      childScript,
    ], {
      cwd: repoRoot,
      env: {
        ...process.env,
        MAKA_CU_E2E_BASELINE: JSON.stringify(baseline),
        MAKA_CU_E2E_CDP_PORT: String(cdpPort),
      },
      stdio: ['pipe', 'inherit', 'inherit'],
    });

    const childExit = new Promise((resolve, reject) => {
      electron.on('error', reject);
      electron.on('exit', (code, signal) => resolve({ code, signal }));
    });
    const monitorFailure = monitor.failure.then((error) => {
      if (electron?.stdin.writable) {
        electron.stdin.write(`ABORT\t${error.message.replace(/\s+/g, ' ')}\n`);
      }
      forcedTimer = setTimeout(() => {
        if (electron?.exitCode === null && electron?.signalCode === null) electron.kill('SIGKILL');
      }, 10_000);
      return error;
    });

    const first = await Promise.race([
      childExit.then((exit) => ({ kind: 'exit', exit })),
      monitorFailure.then((error) => ({ kind: 'monitor-failure', error })),
    ]);
    const exit = first.kind === 'exit' ? first.exit : await childExit;

    if (first.kind === 'monitor-failure') {
      console.error(`Computer Use E2E safety monitor failed: ${first.error.message}`);
      process.exitCode = 1;
    } else {
      const trailingFailure = await Promise.race([
        monitorFailure,
        new Promise((resolve) => setTimeout(() => resolve(undefined), 25)),
      ]);
      if (trailingFailure) {
        console.error(`Computer Use E2E safety monitor failed: ${trailingFailure.message}`);
        process.exitCode = 1;
      } else {
        process.exitCode = exit.code ?? 1;
        if (exit.signal) console.error(`Computer Use E2E exited from signal ${exit.signal}`);
      }
    }
  } finally {
    if (forcedTimer) clearTimeout(forcedTimer);
    await monitor.stop();
  }
}

run().catch((error) => {
  console.error('Computer Use E2E launcher failed:', error);
  process.exitCode = 1;
});
