import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..');
const sourcePath = resolve(repoRoot, 'apps/desktop/src/renderer/public/THIRD_PARTY_LICENSES.txt');
const artifactPath = resolve(repoRoot, 'apps/desktop/dist-renderer/THIRD_PARTY_LICENSES.txt');

const [source, artifact] = await Promise.all([readFile(sourcePath), readFile(artifactPath)]);
if (!source.equals(artifact)) {
  throw new Error(
    'dist-renderer/THIRD_PARTY_LICENSES.txt does not match the governed public source',
  );
}

console.log(
  '[third-party-notices] OK — renderer artifact contains the byte-identical public notice.',
);
