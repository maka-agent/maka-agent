import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { projectToolReviewPresentation } from '../tool-review-presentation.js';

describe('closed tool review presentation', () => {
  test('preserves command and cwd as human-readable tool-card data', () => {
    assert.deepEqual(projectToolReviewPresentation({
      kind: 'command',
      command: 'npm test',
      cwd: '/workspace/maka-agent',
    }), {
      command: 'npm test',
      cwd: '/workspace/maka-agent',
    });
  });

  test('projects search semantics without reconstructing execution arguments', () => {
    assert.deepEqual(projectToolReviewPresentation({
      kind: 'search',
      operation: 'grep',
      pattern: 'ToolActivity',
      root: 'packages/ui/src',
      glob: '*.tsx',
      cwd: '/workspace/maka-agent',
    }), {
      pattern: 'ToolActivity',
      path: 'packages/ui/src',
      glob: '*.tsx',
      cwd: '/workspace/maka-agent',
      operation: 'grep',
    });
  });

  test('bounds stdin display text while retaining the reviewed byte count', () => {
    const input = 'x'.repeat(200);
    assert.deepEqual(projectToolReviewPresentation({
      kind: 'stdin',
      ref: 'maka://runtime/background-tasks/pty-1',
      input: { text: input, bytes: 640 },
    }), {
      ref: 'maka://runtime/background-tasks/pty-1',
      inputPreview: { text: 'x'.repeat(160), bytes: 640, truncated: true },
    });
  });

  test('projects a swarm as bounded aggregate presentation data', () => {
    assert.equal(projectToolReviewPresentation({
      kind: 'agent',
      operation: 'swarm',
      itemCount: 3,
      resumeCount: 0,
      concurrency: 2,
      profiles: ['local_read', 'web_research'],
      writeBack: ['summary', 'patch'],
      isolation: ['same_workspace', 'worktree'],
    }), '3 tasks · concurrency 2 · profiles local_read, web_research · write-back summary, patch · isolation same_workspace, worktree');

    assert.equal(projectToolReviewPresentation({
      kind: 'agent',
      operation: 'swarm',
      itemCount: 2,
      resumeCount: 2,
      concurrency: 2,
      profiles: [],
      writeBack: [],
      isolation: [],
    }), '2 tasks · concurrency 2 · resumed 2');
  });
});
