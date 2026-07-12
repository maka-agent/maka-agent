import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  mergeShellRunState,
  mergeShellRunStateWithDiagnostics,
  normalizeShellToolResultContent,
  type ShellRunMergeDiagnostic,
  type ShellRunToolResult,
} from '../index.js';

describe('mergeShellRunState', () => {
  it('orders state by revision and strips child operations', () => {
    const current = shellRun({ revision: 2, output: pipeOutput('old') });
    const older = shellRun({ revision: 1, output: pipeOutput('stale') });
    const newer = shellRun({
      revision: 3,
      updatedAt: 3,
      output: pipeOutput('new'),
      operation: { kind: 'stop', applied: true },
    });

    const ignored = mergeShellRunState(current, older);
    assert.equal(ignored.result.output?.mode === 'pipes' ? ignored.result.output.stdout : '', 'old');
    const merged = mergeShellRunState(current, newer);
    assert.equal(merged.changed, true);
    assert.equal(merged.result.output?.mode === 'pipes' ? merged.result.output.stdout : '', 'new');
    assert.equal('operation' in merged.result, false);
  });

  it('only enriches a same-revision compact handoff with output', () => {
    const compact = shellRun({ revision: 1, output: undefined });
    const full = shellRun({ revision: 1, output: pipeOutput('ready') });

    const enriched = mergeShellRunState(compact, full);
    assert.equal(enriched.changed, true);
    assert.equal(enriched.result.output?.mode === 'pipes' ? enriched.result.output.stdout : '', 'ready');
    assert.equal(mergeShellRunState(full, compact).changed, false);
  });

  it('rejects conflicting state at one revision and a different ref', () => {
    const current = shellRun({ revision: 2, output: pipeOutput('one') });
    const conflicting = shellRun({ revision: 2, output: pipeOutput('two') });
    const other = shellRun({ ref: 'maka://runtime/background-tasks/other', revision: 3 });

    assert.equal(mergeShellRunState(current, conflicting).invariantViolation, 'same_revision_conflict');
    assert.equal(mergeShellRunState(current, other).invariantViolation, 'ref_mismatch');

    const diagnostics: ShellRunMergeDiagnostic[] = [];
    mergeShellRunStateWithDiagnostics(current, conflicting, 'test.reconciliation', (diagnostic) => {
      diagnostics.push(diagnostic);
    });
    assert.deepEqual(diagnostics, [{
      context: 'test.reconciliation',
      violation: 'same_revision_conflict',
      currentRef: current.ref,
      candidateRef: conflicting.ref,
      currentRevision: 2,
      candidateRevision: 2,
    }]);
  });
});

describe('normalizeShellToolResultContent', () => {
  it('accepts canonical current terminal state and rejects contradictory exit status', () => {
    const current = {
      kind: 'terminal',
      cwd: '/repo',
      cmd: 'printf ok',
      status: 'completed',
      exitCode: 0,
      output: pipeOutput('ok'),
    };
    assert.equal(normalizeShellToolResultContent(current).state, 'valid');
    assert.equal(normalizeShellToolResultContent({ ...current, exitCode: 1 }).state, 'invalid');
    assert.equal(normalizeShellToolResultContent({
      kind: 'terminal',
      cwd: '/repo',
      cmd: 'printf bad',
      status: 'completed',
      exitCode: 1,
      stdout: 'bad',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
    }).state, 'invalid');
  });

  it('rejects non-canonical nested output and contradictory current state', () => {
    const valid = shellRun();
    assert.equal(normalizeShellToolResultContent(valid).state, 'valid');

    const invalid = [
      {
        ...valid,
        output: { ...pipeOutput(''), stdoutTail: 'legacy' },
      },
      {
        ...valid,
        completedAt: 2,
      },
      {
        ...valid,
        status: 'completed',
        completedAt: 2,
        exitCode: 1,
      },
    ];
    for (const value of invalid) {
      assert.equal(normalizeShellToolResultContent(value).state, 'invalid');
    }
  });
});

function shellRun(
  overrides: Partial<Extract<ShellRunToolResult, { mode: 'pipes' }>> = {},
): Extract<ShellRunToolResult, { mode: 'pipes' }> {
  return {
    kind: 'shell_run',
    ref: 'maka://runtime/background-tasks/run-1',
    mode: 'pipes',
    status: 'running',
    cwd: '/repo',
    cmd: 'sleep 1',
    startedAt: 1,
    updatedAt: overrides.revision ?? 1,
    revision: 1,
    output: pipeOutput(''),
    ...overrides,
  };
}

function pipeOutput(
  stdout: string,
): NonNullable<Extract<ShellRunToolResult, { mode: 'pipes' }>['output']> {
  return {
    mode: 'pipes',
    stdout,
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    redacted: false,
  };
}
