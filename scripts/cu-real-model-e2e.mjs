import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const sourceWorkspace = join(
  homedir(),
  'Library',
  'Application Support',
  'Maka',
  'workspaces',
  'default',
);
const prompt = process.env.MAKA_CU_REAL_E2E_PROMPT
  ?? 'Use the computer tool to inspect the screen. In the window titled "Maka Real Model Computer Use Fixture", click the blue "Increment blue" button exactly once. Do not click the red button. Verify the visible count becomes 1, then stop.';

async function copyIfPresent(name, destination) {
  try {
    await cp(join(sourceWorkspace, name), join(destination, name));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
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
  const userData = await mkdtemp(join(tmpdir(), 'maka-cu-real-e2e-'));
  const reportPath = process.env.MAKA_CU_REAL_E2E_REPORT
    ?? join(repoRoot, '.agents-workspace-data', 'cu-real-model-e2e', `report-${Date.now()}.json`);
  const workspace = join(userData, 'workspaces', 'default');
  await mkdir(workspace, { recursive: true });
  await mkdir(dirname(reportPath), { recursive: true });
  await Promise.all([
    copyIfPresent('llm-connections.json', workspace),
    copyIfPresent('credentials.json', workspace),
    copyIfPresent('settings.json', workspace),
  ]);

  const electron = join(repoRoot, 'node_modules', '.bin', 'electron');
  const cdpPort = await reserveLoopbackPort();
  const child = spawn(electron, [
    `--remote-debugging-port=${cdpPort}`,
    '--remote-allow-origins=*',
    'apps/desktop',
  ], {
    cwd: repoRoot,
    env: {
      ...process.env,
      MAKA_CU_REAL_E2E: '1',
      MAKA_E2E_USER_DATA_DIR: userData,
      MAKA_CU_E2E_PROMPT: prompt,
      MAKA_CU_E2E_MODE: 'bypass',
      MAKA_CU_E2E_CDP_PORT: String(cdpPort),
      MAKA_CU_REAL_E2E_REPORT: reportPath,
    },
    stdio: 'inherit',
  });

  try {
    const exit = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    if (exit.code !== 0) {
      throw new Error(`real model E2E exited with ${exit.signal ?? `code ${exit.code}`}`);
    }
    console.log(`Real model Computer Use report: ${reportPath}`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await rm(userData, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error('Real model Computer Use E2E failed:', error);
  process.exitCode = 1;
});
