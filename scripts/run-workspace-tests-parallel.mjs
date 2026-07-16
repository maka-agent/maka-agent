import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const serialFlag = process.argv.includes('--serial');

const rootPkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const workspaceDirs = Array.isArray(rootPkg.workspaces) ? rootPkg.workspaces : [];

// Some workspace test suites rely on shared filesystem state (e.g. headless task
// sessions). Running them concurrently with other workspaces causes races, so
// they are executed in a serial pass after the parallel batch.
const serialWorkspaceDirs = ['packages/headless'];
const parallelWorkspaceDirs = workspaceDirs.filter((dir) => !serialWorkspaceDirs.includes(dir));

function commandForDir(dir) {
  if (dir === 'packages/headless') return 'node ../../scripts/run-headless-tests.mjs';
  if (dir === 'apps/desktop') return 'npm run test:dist';
  return 'node --test "dist/**/*.test.js"';
}

function nameForDir(dir) {
  return dir.replace(/^(packages|apps)\//, '');
}

function runWorkspace(dir) {
  const name = nameForDir(dir);
  const command = commandForDir(dir);
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

async function runSerial(dirs) {
  for (const dir of dirs) {
    await runWorkspace(dir);
  }
}

async function runParallel(dirs) {
  const results = await Promise.allSettled(dirs.map(runWorkspace));
  const failures = results.filter((r) => r.status === 'rejected');
  if (failures.length > 0) throw failures[0].reason;
}

try {
  if (serialFlag) {
    await runSerial(workspaceDirs);
  } else {
    await runParallel(parallelWorkspaceDirs);
    await runSerial(serialWorkspaceDirs);
  }
  console.log('\nAll workspace tests passed.');
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
