import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outfile = resolve(packageRoot, 'dist', 'workers', 'filesystem-worker.js');

await mkdir(dirname(outfile), { recursive: true });
await build({
  entryPoints: [resolve(packageRoot, 'src', 'filesystem-worker', 'worker-entry.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: false,
  legalComments: 'none',
});
