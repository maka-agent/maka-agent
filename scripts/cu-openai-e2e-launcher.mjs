import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

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

const port = await reservePort();
const directAzure = process.argv.includes('--azure-direct');
let bearerToken;
let baseUrl = process.env.MAKA_CU_OPENAI_BASE_URL;
if (directAzure) {
  baseUrl ??= 'https://msra-im-openai.openai.azure.com/openai/v1';
  bearerToken = await new Promise((resolve, reject) => {
    const child = spawn('az', [
      'account',
      'get-access-token',
      '--resource',
      'https://cognitiveservices.azure.com',
      '--query',
      'accessToken',
      '-o',
      'tsv',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0 && stdout.trim()) resolve(stdout.trim());
      else reject(new Error(`failed to acquire Azure token: ${stderr.trim() || `exit ${code}`}`));
    });
  });
}
const electron = join(repoRoot, 'node_modules', '.bin', 'electron');
const child = spawn(electron, [
  `--remote-debugging-port=${port}`,
  '--remote-allow-origins=*',
  join(here, 'cu-openai-model-e2e.mjs'),
], {
  cwd: repoRoot,
  env: {
    ...process.env,
    MAKA_CU_E2E_CDP_PORT: String(port),
    ...(baseUrl ? { MAKA_CU_OPENAI_BASE_URL: baseUrl } : {}),
    ...(bearerToken ? { MAKA_CU_OPENAI_BEARER_TOKEN: bearerToken } : {}),
  },
  stdio: 'inherit',
});
child.on('exit', (code, signal) => {
  if (signal) console.error(`OpenAI CU E2E exited from ${signal}`);
  process.exitCode = code ?? 1;
});
