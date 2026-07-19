import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  harborOfficialVerifierOutputFromArtifacts,
  readHarborOfficialVerifierOutput,
} from '../harbor-official-artifacts.js';

describe('Harbor official verifier artifacts', () => {
  test('maps Harbor reward result and container artifacts to official verifier output', () => {
    const output = harborOfficialVerifierOutputFromArtifacts({
      resultJson: { verifier_result: { rewards: { reward: 1 } } },
      details: { instanceId: 'terminal-bench/example' },
      artifacts: [
        {
          kind: 'container_workspace',
          workspacePath: '/app',
          authority: { source: 'container_capture', authoritative: true },
        },
        {
          kind: 'workspace_diff',
          path: '/logs/artifacts/submission.diff',
          workspacePath: '/app',
          authority: { source: 'container_capture', authoritative: true },
        },
        {
          kind: 'source_code',
          path: '/logs/artifacts/app/vm.js',
          workspacePath: '/app/vm.js',
          authority: { source: 'container_capture', authoritative: true },
        },
        {
          kind: 'generated_output',
          path: '/logs/artifacts/frame.bmp',
          workspacePath: '/app/frame.bmp',
          authority: { source: 'container_capture', authoritative: true },
        },
        {
          kind: 'benchmark_manifest',
          path: '/logs/artifacts/manifest.json',
          authority: { source: 'official_harbor_verifier', authoritative: true },
        },
      ],
    });

    assert.equal(output.kind, 'terminal_bench');
    assert.equal(output.passed, true);
    assert.equal(output.exitCode, 0);
    assert.equal(output.score, 1);
    assert.equal(output.authority?.source, 'official_harbor_verifier');
    assert.equal(output.details?.official, true);
    assert.equal(output.artifacts?.[0]?.workspacePath, '/app');
    assert.equal(output.artifacts?.[2]?.workspacePath, '/app/vm.js');
  });

  test('reads result.json, reward.txt, and CTRF-style summaries from paths', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-harbor-official-'));
    try {
      const resultJsonPath = join(dir, 'result.json');
      const rewardPath = join(dir, 'reward.txt');
      const ctrfJsonPath = join(dir, 'ctrf.json');
      await writeFile(resultJsonPath, JSON.stringify({ taskId: 'example' }), 'utf8');
      await writeFile(rewardPath, '1\n', 'utf8');
      await writeFile(
        ctrfJsonPath,
        JSON.stringify({ results: { summary: { tests: 3, passed: 3, failed: 0 } } }),
        'utf8',
      );

      const output = await readHarborOfficialVerifierOutput({
        resultJsonPath,
        rewardPath,
        ctrfJsonPath,
      });

      assert.equal(output.passed, true);
      assert.equal(output.score, 1);
      assert.deepEqual(output.details?.ctrf, {
        passed: true,
        score: 1,
        maxScore: 1,
        tests: 3,
        failed: 0,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('treats an explicit official pass flag as a verifier signal', () => {
    const output = harborOfficialVerifierOutputFromArtifacts({ resultJson: { passed: false } });

    assert.equal(output.passed, false);
    assert.equal(output.exitCode, 1);
    assert.equal(output.errorClass, 'verification_failed');
    assert.equal(output.authority?.source, 'official_harbor_verifier');
    assert.equal(output.authority?.authoritative, true);
  });

  test('keeps missing official signals non-authoritative', () => {
    const output = harborOfficialVerifierOutputFromArtifacts({});

    assert.equal(output.passed, false);
    assert.equal(output.exitCode, null);
    assert.equal(output.errorClass, 'missing_official_verifier');
    assert.equal(output.authority?.source, 'system');
    assert.equal(output.authority?.authoritative, false);
    assert.equal(output.details?.official, false);
  });
});
