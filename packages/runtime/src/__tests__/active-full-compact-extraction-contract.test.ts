import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const REPO_ROOT = resolveRepoRoot();

test('active-full compact delegates summary fact extraction to a one-way leaf', async () => {
  const facade = await readRepo('packages/runtime/src/active-full-compact.ts');
  const facts = await readRepo('packages/runtime/src/active-full-compact-facts.ts');

  assert.match(facade, /from '\.\/active-full-compact-facts\.js'/);
  assert.match(facade, /return buildActiveFullCompactFactSummary\(input\);/);
  assert.doesNotMatch(facade, /const PROCESS_FACT_PATTERN/);
  assert.doesNotMatch(facade, /function extractLatestVerifierFailure/);

  assert.match(facts, /export function buildActiveFullCompactFactSummary/);
  assert.match(facts, /const PROCESS_FACT_PATTERN/);
  assert.match(facts, /function extractLatestVerifierFailure/);
  assert.doesNotMatch(facts, /from '\.\/active-full-compact\.js'/);
});

async function readRepo(path: string): Promise<string> {
  return readFile(join(REPO_ROOT, path), 'utf8');
}

function resolveRepoRoot(): string {
  const cwd = resolve(process.cwd());
  if (existsSync(join(cwd, 'packages', 'runtime', 'src', 'active-full-compact.ts'))) return cwd;
  const fromWorkspace = resolve(cwd, '..', '..');
  if (existsSync(join(fromWorkspace, 'packages', 'runtime', 'src', 'active-full-compact.ts')))
    return fromWorkspace;
  return cwd;
}
