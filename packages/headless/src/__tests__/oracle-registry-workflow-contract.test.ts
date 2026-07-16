import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('Oracle registry audit is manual, incremental, bounded, and append-only', async () => {
  const workflow = await readFile(new URL('../../../../.github/workflows/oracle-evidence-audit.yml', import.meta.url), 'utf8');

  assert.match(workflow, /^on:\n  workflow_dispatch:/m);
  assert.doesNotMatch(workflow, /^\s+(push|pull_request|schedule):/m);
  assert.match(workflow, /permissions:\n  contents: read/);
  assert.match(workflow, /publish:[\s\S]*?permissions:\n      contents: write/);
  assert.match(workflow, /fromJSON\(needs\.prepare\.outputs\.matrix\)/);
  assert.match(workflow, /max-parallel: 6/);
  assert.match(workflow, /args=\([\s\S]*?\n            plan\n[\s\S]*?run-oracle-registry-audit\.mjs "\$\{args\[@\]\}"/);
  assert.match(workflow, /run-oracle-registry-audit\.mjs task/);
  assert.match(workflow, /run-oracle-registry-audit\.mjs merge/);
  assert.match(workflow, /d49e28f1e4ddd13d289e85a5f312a66750951932/);
  assert.match(workflow, /gh release create/);
  assert.doesNotMatch(workflow, /--clobber/);
});
