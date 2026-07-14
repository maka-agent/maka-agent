import { copyFile, mkdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(desktopRoot, '..', '..', 'packages', 'runtime', 'dist', 'workers', 'filesystem-worker.js');
const target = resolve(desktopRoot, 'resources', 'workers', 'filesystem-worker.js');
const metadata = await stat(source).catch(() => undefined);
if (!metadata?.isFile()) throw new Error(`Runtime filesystem worker bundle is missing: ${source}`);
await mkdir(dirname(target), { recursive: true });
await copyFile(source, target);
