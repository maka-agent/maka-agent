import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const { createConnectionStore, createFileCredentialStore } = await import(
  join(repoRoot, 'packages', 'storage', 'dist', 'index.js')
);

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  if (!port) throw new Error('failed to reserve CDP port');
  return port;
}

const userData = await mkdtemp(join(tmpdir(), 'maka-cu-openai-e2e-'));
const workspace = join(userData, 'workspaces', 'default');
const reportPath = process.env.MAKA_CU_OPENAI_REPORT
  ?? join(repoRoot, '.agents-workspace-data', 'cu-openai-maka-e2e', `report-${Date.now()}.json`);
await mkdir(workspace, { recursive: true });
await mkdir(dirname(reportPath), { recursive: true });
const connections = createConnectionStore(workspace);
const credentials = createFileCredentialStore(workspace);
await connections.create({
  slug: 'openai-azure-bridge',
  name: 'OpenAI Azure Bridge',
  providerType: 'openai',
  baseUrl: process.env.MAKA_CU_OPENAI_BASE_URL ?? 'http://127.0.0.1:8538/v1',
  defaultModel: process.env.MAKA_CU_OPENAI_MODEL ?? 'gpt-5.4',
});
await credentials.setSecret('openai-azure-bridge', 'api_key', 'local-bridge');
await connections.setDefault('openai-azure-bridge');

const port = await reservePort();
const electron = join(repoRoot, 'node_modules', '.bin', 'electron');
const child = spawn(electron, [
  `--remote-debugging-port=${port}`,
  '--remote-allow-origins=*',
  'apps/desktop',
], {
  cwd: repoRoot,
  env: {
    ...process.env,
    MAKA_CU_OPENAI_REAL_E2E: '1',
    MAKA_E2E_USER_DATA_DIR: userData,
    MAKA_CU_E2E_PROMPT:
      process.env.MAKA_CU_OPENAI_PROMPT
      ?? 'Inspect the screen. In the window titled "Maka Real Model Computer Use Fixture", click the blue "Increment blue" button exactly once. Do not click the red button. Verify the visible count becomes 1, then stop.',
    MAKA_CU_E2E_MODE: 'bypass',
    MAKA_CU_E2E_CDP_PORT: String(port),
    MAKA_CU_REAL_E2E_REPORT: reportPath,
    MAKA_CU_E2E_SCENARIO: process.env.MAKA_CU_E2E_SCENARIO ?? 'l1-single-click',
    MAKA_CU_E2E_EXPECT_BLUE: process.env.MAKA_CU_E2E_EXPECT_BLUE ?? '1',
    MAKA_CU_E2E_EXPECT_RED: process.env.MAKA_CU_E2E_EXPECT_RED ?? '0',
  },
  stdio: 'inherit',
});

try {
  const exit = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  if (exit.code !== 0) throw new Error(`OpenAI Maka E2E exited with ${exit.signal ?? `code ${exit.code}`}`);
  console.log(`OpenAI Maka Computer Use report: ${reportPath}`);
} finally {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await rm(userData, { recursive: true, force: true });
}
