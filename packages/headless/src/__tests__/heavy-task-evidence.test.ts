import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  compactArtifactEvidence,
  compactSelfCheckEvidence,
  compactTextEvidence,
  compactToolEvidence,
  renderHeavyTaskEvidenceForPrompt,
} from '../heavy-task-evidence.js';
import type {
  HeavyTaskCompactEvidenceEnvelope,
  HeavyTaskSemanticSelfCheckState,
} from '../task-contracts.js';

const base = {
  evidenceId: 'evidence-1',
  taskRunId: 'run-1',
  attemptId: 'attempt-1',
  ts: 10,
  source: {
    kind: 'model_tool' as const,
    toolCallId: 'tool-call-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
  },
};

describe('heavy-task compact evidence', () => {
  test('compactTextEvidence bounds excerpts and records truncation metadata', () => {
    const large = `start\n${'x'.repeat(5_000)}`;
    const summary = compactTextEvidence(large, {
      stream: 'stdout',
      limitChars: 100,
      ref: 'runtime-event-1',
      refKind: 'runtime_event',
    });

    assert.equal(summary.stream, 'stdout');
    assert.equal(summary.truncated, true);
    assert.ok((summary.excerpt?.length ?? 0) <= 100);
    assert.equal(summary.truncationRef?.ref, 'runtime-event-1');
    assert.equal(summary.truncationRef?.refKind, 'runtime_event');
    assert.equal(summary.truncationRef?.originalBytes, Buffer.byteLength(large, 'utf8'));
    assert.ok((summary.truncationRef?.omittedBytes ?? 0) > 0);
    assert.notEqual(summary.excerpt, large);
  });

  test('Bash normalization records command, exit code, timeout, and bounded streams', () => {
    const largeStdout = `public output\n${'a'.repeat(5_000)}`;
    const evidence = compactToolEvidence({
      ...base,
      name: 'Bash',
      input: { command: 'npm test -- --runInBand', cwd: '/workspace', timeoutMs: 12_000 },
      result: { exitCode: 124, stdout: largeStdout, stderr: 'timeout\n', timedOut: true },
    });

    assert.equal(evidence.kind, 'tool');
    assert.equal(evidence.public, true);
    assert.equal(evidence.tool?.name, 'Bash');
    assert.equal(evidence.tool?.exitCode, 124);
    assert.equal(evidence.tool?.timedOut, true);
    assert.equal(evidence.tool?.ok, false);
    assert.equal(evidence.tool?.inputSummary.command, 'npm test -- --runInBand');
    assert.equal(evidence.tool?.outputs[0]?.stream, 'stdout');
    assert.equal(evidence.tool?.outputs[0]?.truncated, true);
    assert.notEqual(evidence.tool?.outputs[0]?.excerpt, largeStdout);
  });

  test('Read and Grep normalization records path/query and bounded excerpts', () => {
    const readEvidence = compactToolEvidence({
      ...base,
      evidenceId: 'read-evidence',
      name: 'Read',
      input: { cwd: '/workspace', path: 'src/file.ts', offset: 10, limit: 25 },
      result: { content: `line one\n${'b'.repeat(5_000)}` },
    });
    const grepEvidence = compactToolEvidence({
      ...base,
      evidenceId: 'grep-evidence',
      name: 'Grep',
      input: { cwd: '/workspace', pattern: 'needle', path: 'src', glob: '*.ts' },
      result: {
        matches: Array.from(
          { length: 200 },
          (_, i) => `src/file.ts:${i + 1}:needle ${'c'.repeat(50)}`,
        ),
      },
    });

    assert.equal(readEvidence.tool?.inputSummary.path, 'src/file.ts');
    assert.equal(readEvidence.tool?.inputSummary.offset, 10);
    assert.equal(readEvidence.tool?.outputs[0]?.stream, 'content');
    assert.equal(readEvidence.tool?.outputs[0]?.truncated, true);
    assert.equal(grepEvidence.tool?.inputSummary.pattern, 'needle');
    assert.equal(grepEvidence.tool?.inputSummary.matchCount, 200);
    assert.equal(grepEvidence.tool?.outputs[0]?.stream, 'matches');
    assert.equal(grepEvidence.tool?.outputs[0]?.truncated, true);
    assert.ok(
      (grepEvidence.tool?.outputs[0]?.excerpt?.length ?? 0) <
        grepEvidence.tool!.outputs[0]!.byteCount!,
    );
  });

  test('Write and Edit normalization omits mutation payloads and uses diff placeholders', () => {
    const writeContent = 'secret write body should not appear';
    const writeEvidence = compactToolEvidence({
      ...base,
      evidenceId: 'write-evidence',
      name: 'Write',
      input: { cwd: '/workspace', path: 'src/out.txt', content: writeContent },
      result: { ok: true, path: 'src/out.txt', bytes: Buffer.byteLength(writeContent, 'utf8') },
    });
    const editEvidence = compactToolEvidence({
      ...base,
      evidenceId: 'edit-evidence',
      name: 'Edit',
      input: {
        cwd: '/workspace',
        path: 'src/out.txt',
        oldString: 'old private body',
        newString: 'new private body',
      },
      result: { ok: true, path: 'src/out.txt', replacements: 1 },
    });
    const serialized = JSON.stringify([writeEvidence, editEvidence]);

    assert.equal(writeEvidence.tool?.inputSummary.contentOmitted, true);
    assert.equal(writeEvidence.tool?.diff?.status, 'not_captured');
    assert.equal(editEvidence.tool?.inputSummary.oldStringOmitted, true);
    assert.equal(editEvidence.tool?.inputSummary.newStringOmitted, true);
    assert.equal(editEvidence.tool?.inputSummary.replacements, 1);
    assert.equal(editEvidence.tool?.diff?.status, 'not_captured');
    assert.doesNotMatch(serialized, /secret write body|old private body|new private body/);
  });

  test('artifact normalization preserves metadata without artifact body content', () => {
    const evidence = compactArtifactEvidence({
      ...base,
      artifact: {
        schemaVersion: 1,
        artifactId: 'artifact-1',
        taskRunId: 'run-1',
        ts: 12,
        kind: 'generated_output',
        authority: { source: 'runtime', authoritative: false, label: 'public runtime capture' },
        path: '/tmp/out.log',
        workspacePath: 'out.log',
        artifactRef: 'file:/tmp/out.log',
        hash: 'sha256:abc',
        mimeType: 'text/plain',
        metadata: {
          sizeBytes: 123,
          content: 'raw artifact body',
          nested: { output: 'raw output', label: 'public label' },
        },
      },
    });

    assert.equal(evidence.kind, 'artifact');
    assert.equal(evidence.artifact?.artifactId, 'artifact-1');
    assert.equal(evidence.artifact?.path, '/tmp/out.log');
    assert.equal(evidence.artifact?.artifactRef, 'file:/tmp/out.log');
    assert.equal(evidence.artifact?.hash, 'sha256:abc');
    assert.deepEqual(evidence.artifact?.authority, {
      source: 'runtime',
      authoritative: false,
      label: 'public runtime capture',
    });
    assert.deepEqual(evidence.artifact?.metadata, {
      sizeBytes: 123,
      nested: { label: 'public label' },
    });
    assert.doesNotMatch(JSON.stringify(evidence), /raw artifact body|raw output/);
  });

  test('tool and artifact compaction omits non-public benchmark evidence patterns', () => {
    const bashEvidence = compactToolEvidence({
      ...base,
      evidenceId: 'guarded-bash',
      name: 'Bash',
      input: { command: 'cat hidden/tests/private_case.txt', cwd: '/workspace' },
      result: {
        exitCode: 1,
        stdout: 'hidden/tests/private_case.py expected == actual',
        stderr: 'official verifier output.json threshold 0.95',
      },
    });
    const readEvidence = compactToolEvidence({
      ...base,
      evidenceId: 'guarded-read',
      name: 'Read',
      input: { cwd: '/workspace', path: 'hidden/tests/private_case.py' },
      result: { content: 'private benchmark assertion text should stay out' },
    });
    const artifactEvidence = compactArtifactEvidence({
      ...base,
      evidenceId: 'guarded-artifact',
      artifact: {
        path: 'hidden/tests/reference.jpg',
        kind: 'generated_output',
        metadata: {
          safe: 'public label',
          nested: { verdict: 'private verifier timing order' },
        },
      },
    });
    const serialized = JSON.stringify([bashEvidence, readEvidence, artifactEvidence]);

    assert.match(serialized, /\[omitted: non-public benchmark evidence pattern\]/);
    assert.doesNotMatch(
      serialized,
      /hidden\/tests|private_case|expected == actual|official verifier output\.json|threshold 0\.95|private benchmark|private verifier timing order/,
    );
    assert.equal(artifactEvidence.artifact?.metadata?.safe, 'public label');
  });

  test('prompt renderer includes compact evidence and omits raw large output', () => {
    const large = 'z'.repeat(5_000);
    const evidence = compactToolEvidence({
      ...base,
      name: 'Bash',
      input: { command: 'npm test', cwd: '/workspace' },
      result: { exitCode: 1, stdout: `failed\n${large}`, stderr: '' },
    });
    const prompt = renderHeavyTaskEvidenceForPrompt({ heavyTaskEvidence: [evidence] });

    assert.match(prompt ?? '', /Heavy-task compact evidence/);
    assert.match(prompt ?? '', /tool:Bash exit=1/);
    assert.match(prompt ?? '', /truncated=true/);
    assert.doesNotMatch(prompt ?? '', new RegExp(`z{${3_000}}`));
    assert.equal(renderHeavyTaskEvidenceForPrompt({ heavyTaskEvidence: [] }), undefined);
  });

  test('accepted self-check evidence compacts and private rejected evidence is ignored', () => {
    const accepted = selfCheck('self-check-1', 'npm test passed on public files.');
    const privatePayload = selfCheck(
      'self-check-private',
      'hidden/tests/private_case.py revealed a failure.',
    );
    const ids = idFactory();
    const acceptedEvidence = compactSelfCheckEvidence({ selfCheck: accepted, newId: ids });
    const rejectedEvidence = compactSelfCheckEvidence({ selfCheck: privatePayload, newId: ids });

    assert.equal(acceptedEvidence[0]?.kind, 'check');
    assert.equal(acceptedEvidence[0]?.check?.linkedSelfCheckId, 'self-check-1');
    assert.ok(acceptedEvidence.some((item) => item.tool?.name === 'self_check_submit'));
    const artifactEvidence = acceptedEvidence.find(
      (item) => item.artifact?.path === 'build-output.log',
    );
    assert.equal(artifactEvidence?.artifact?.authority?.source, 'self_check');
    assert.equal(artifactEvidence?.artifact?.authority?.authoritative, false);
    assert.deepEqual(rejectedEvidence, []);
  });
});

function selfCheck(selfCheckId: string, publicReason: string): HeavyTaskSemanticSelfCheckState {
  return {
    schemaVersion: 1,
    selfCheckId,
    taskRunId: 'run-1',
    ts: 10,
    status: 'pass',
    publicReason,
    commandEvidence: [{ command: 'npm test', exitCode: 0, outputExcerpt: 'public tests passed' }],
    artifactEvidence: [{ path: 'build-output.log', kind: 'log', exists: true }],
    guard: {
      status: 'accepted',
      checkedAt: 10,
      categories: [],
      publicReason: 'Accepted as public, task-derived advisory self-check evidence.',
    },
    source: { kind: 'model_tool', toolCallId: 'tool-call-1' },
  };
}

function idFactory(): () => string {
  let i = 0;
  return () => `evidence-${++i}`;
}
