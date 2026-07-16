import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const workspaces = [
  { name: 'core', dir: 'packages/core', command: 'node --test "dist/**/*.test.js"' },
  { name: 'storage', dir: 'packages/storage', command: 'node --test "dist/**/*.test.js"' },
  { name: 'runtime', dir: 'packages/runtime', command: 'node --test "dist/**/*.test.js"' },
  { name: 'computer-use', dir: 'packages/computer-use', command: 'node --test "dist/**/*.test.js"' },
  { name: 'headless', dir: 'packages/headless', command: 'node ../../scripts/run-headless-tests.mjs' },
  { name: 'cli', dir: 'packages/cli', command: 'node --test "dist/**/*.test.js"' },
  { name: 'ui', dir: 'packages/ui', command: 'node --test "dist/**/*.test.js"' },
  { name: 'desktop', dir: 'apps/desktop', command: 'npm run test:dist' },
];

function runWorkspace({ name, dir, command }) {
  const cwd = join(repoRoot, dir);
  console.log(`\n[${name}] start: ${command}`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd, stdio: 'inherit', shell: true });
    child.on('close', (code) => {
      if (code === 0) {
        console.log(`[${name}] passed`);
        resolve(name);
      } else {
        reject(new Error(`[${name}] failed with code ${code}`));
      }
    });
  });
}

const results = await Promise.allSettled(workspaces.map(runWorkspace));
const failures = results.filter((r) => r.status === 'rejected');

if (failures.length > 0) {
  for (const f of failures) console.error(f.reason.message);
  process.exit(1);
}

console.log('\nAll workspace tests passed.');
