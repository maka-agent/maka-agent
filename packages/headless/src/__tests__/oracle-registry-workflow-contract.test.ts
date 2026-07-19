import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { HARBOR_ORACLE_VERSION } from '../harness-oracle-policy.js';

test('Oracle registry audit is manual, incremental, bounded, and append-only', async () => {
  const workflow = await readFile(
    new URL('../../../../.github/workflows/oracle-evidence-audit.yml', import.meta.url),
    'utf8',
  );

  assert.match(workflow, /^on:\n  workflow_dispatch:/m);
  assert.doesNotMatch(workflow, /^\s+(push|pull_request|schedule):/m);
  assert.match(workflow, /permissions:\n  contents: read/);
  assert.match(workflow, /publish:[\s\S]*?permissions:\n      contents: write/);
  assert.match(workflow, /fromJSON\(needs\.prepare\.outputs\.matrix\)/);
  assert.match(workflow, /max-parallel: 6/);
  assert.match(
    workflow,
    /args=\([\s\S]*?\n            plan\n[\s\S]*?run-oracle-registry-audit\.mjs "\$\{args\[@\]\}"/,
  );
  assert.match(workflow, /run-oracle-registry-audit\.mjs task/);
  assert.match(workflow, /run-oracle-registry-audit\.mjs merge/);
  assert.match(workflow, /d49e28f1e4ddd13d289e85a5f312a66750951932/);
  assert.match(
    workflow,
    new RegExp(`HARBOR_VERSION: ${HARBOR_ORACLE_VERSION.replaceAll('.', '\\.')}`),
  );
  assert.equal(workflow.match(/retention-days: 7/g)?.length, 2);
  assert.doesNotMatch(workflow, /retention-days: 1\b/);
  assert.match(workflow, /gh release create/);
  assert.doesNotMatch(workflow, /--clobber/);
});

test('Oracle task evidence records the workflow and observed runner runtime', async () => {
  const { workflowExecutionProvenance } = await import(
    new URL('../../harbor/run-oracle-registry-audit.mjs', import.meta.url).href
  );
  const provenance = await workflowExecutionProvenance({
    env: {
      GITHUB_REPOSITORY: 'maka-agent/maka-agent',
      GITHUB_WORKFLOW: 'Oracle evidence audit',
      GITHUB_SHA: 'abc123',
      GITHUB_RUN_ID: '456',
      GITHUB_RUN_ATTEMPT: '2',
    },
    readToolVersion: async (command: string, args: string[]) =>
      command === 'harbor' ? `harbor ${HARBOR_ORACLE_VERSION}` : `${command} ${args.join(' ')}`,
  });

  assert.deepEqual(provenance, {
    issuer: 'github-actions',
    repository: 'maka-agent/maka-agent',
    workflow: 'Oracle evidence audit',
    commitSha: 'abc123',
    runId: '456',
    runAttempt: '2',
    runtime: {
      nodeVersion: process.version,
      harborVersion: `harbor ${HARBOR_ORACLE_VERSION}`,
      dockerVersion: 'docker --version',
      dockerBuildxVersion: 'docker buildx version',
    },
  });
});

test('Oracle task evidence rejects a Harbor runtime outside the controlled policy', async () => {
  const { workflowExecutionProvenance } = await import(
    new URL('../../harbor/run-oracle-registry-audit.mjs', import.meta.url).href
  );

  await assert.rejects(
    workflowExecutionProvenance({
      env: {
        GITHUB_REPOSITORY: 'maka-agent/maka-agent',
        GITHUB_WORKFLOW: 'Oracle evidence audit',
        GITHUB_SHA: 'abc123',
        GITHUB_RUN_ID: '456',
        GITHUB_RUN_ATTEMPT: '2',
      },
      readToolVersion: async (command: string) =>
        command === 'harbor' ? 'harbor 0.14.0' : `${command} test-version`,
    }),
    /Harbor runtime does not match controlled Oracle policy/,
  );
});
