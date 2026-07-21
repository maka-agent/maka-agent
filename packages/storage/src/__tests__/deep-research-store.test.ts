import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { createDeepResearchStore } from '../deep-research-store.js';

const SESSION_ID = 'session-1';
const HASH = `sha256:${'b'.repeat(64)}`;

async function withTempRoot(
  fn: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-deep-research-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('DeepResearchStore', () => {
  it('persists an append-only run that can resume after store recreation', async () => {
    await withTempRoot(async (root) => {
      let id = 0;
      let now = 100;
      const store = createDeepResearchStore(root, {
        newId: () => `id-${++id}`,
        now: () => ++now,
      });

      await store.start(
        SESSION_ID,
        '  Reproduce durable Deep Research   in Maka. ',
        'deep',
        { runId: 'run-1', turnId: 'turn-1', toolCallId: 'call-start' },
      );
      await store.recordArtifact(SESSION_ID, {
        artifactId: 'source-1',
        role: 'source',
        name: 'paper.md',
        createdAt: 110,
        locator: 'https://arxiv.org/abs/2602.01566',
        contentHash: HASH,
        sourceArtifactIds: [],
      });
      await store.recordCheckpoint(SESSION_ID, {
        round: 1,
        stage: 'knowledge_base',
        status: 'active',
        summary: 'Paper and Maka architecture are mapped.',
        openQuestions: ['Which slice is smallest?'],
        nextSteps: ['Build the event ledger.'],
        taskIds: ['T1'],
        artifactIds: ['source-1'],
      });
      for (const [key, artifactId] of [
        ['conclusion', 'section-conclusion'],
        ['source_evidence', 'section-source-evidence'],
        ['borrow_diverge_risk_gate', 'section-tradeoffs'],
        ['implementation_recommendations', 'section-implementation'],
        ['verification', 'section-verification'],
      ] as const) {
        await store.recordArtifact(SESSION_ID, {
          artifactId,
          role: 'report_section',
          name: `${artifactId}.md`,
          createdAt: 115,
          contentHash: HASH,
          sourceArtifactIds: ['source-1'],
          reportSectionKey: key,
          reportSectionStatus: 'completed',
        });
      }
      await store.recordArtifact(SESSION_ID, {
        artifactId: 'report-1',
        role: 'report',
        name: 'report.md',
        createdAt: 120,
        contentHash: HASH,
        sourceArtifactIds: ['source-1'],
      });
      await store.recordArtifact(SESSION_ID, {
        artifactId: 'handoff-1',
        role: 'handoff',
        name: 'handoff.md',
        createdAt: 121,
        contentHash: HASH,
        sourceArtifactIds: ['source-1'],
      });
      for (const itemId of [
        'project_entrypoints',
        'core_flow',
        'boundaries',
        'verification_evidence',
      ]) {
        await store.updateChecklist(SESSION_ID, {
          itemId,
          status: 'completed',
          evidenceArtifactIds: ['source-1'],
        });
      }
      const completed = await store.complete(
        SESSION_ID,
        'report-1',
        {
          artifactId: 'handoff-1',
          implementationTasks: ['Implement the workspace.'],
          recommendedIssues: ['Track the UI slice.'],
          recommendedPullRequests: [],
          verificationCommands: ['npm test'],
        },
        { runId: 'run-2', turnId: 'turn-2', toolCallId: 'call-complete' },
      );
      await store.complete(
        SESSION_ID,
        'report-1',
        {
          artifactId: 'handoff-1',
          implementationTasks: ['Implement the workspace.'],
          recommendedIssues: ['Track the UI slice.'],
          recommendedPullRequests: [],
          verificationCommands: ['npm test'],
        },
        { runId: 'run-2', turnId: 'turn-2', toolCallId: 'call-complete' },
      );
      await assert.rejects(
        () => store.complete(
          SESSION_ID,
          'report-1',
          {
            artifactId: 'handoff-1',
            implementationTasks: ['Implement the workspace.'],
            recommendedIssues: ['Track the UI slice.'],
            recommendedPullRequests: [],
            verificationCommands: ['npm run test:fast'],
          },
          { runId: 'run-2', turnId: 'turn-2', toolCallId: 'call-complete' },
        ),
        /retried with different input/,
      );

      assert.equal(completed.objective, 'Reproduce durable Deep Research in Maka.');
      assert.equal(completed.scopeLevel, 'deep');
      assert.equal(completed.status, 'completed');
      assert.equal(completed.reportArtifactId, 'report-1');

      const reopened = createDeepResearchStore(root);
      const restored = await reopened.read(SESSION_ID);
      assert.equal(restored?.status, 'completed');
      assert.equal(restored?.round, 1);
      assert.equal(restored?.checkpoints[0]?.taskIds[0], 'T1');

      const events = await reopened.readEvents(SESSION_ID);
      assert.equal(events.length, 15);
      assert.equal(events[0]?.type, 'research_started');
      assert.equal(events.at(-1)?.type, 'research_completed');
      assert.equal(
        events.filter((event) => event.type === 'research_checklist_updated').length,
        4,
      );
      assert.equal(events[0]?.refs?.toolCallId, 'call-start');
      assert.equal(events.at(-1)?.refs?.toolCallId, 'call-complete');

      const eventText = await readFile(
        join(root, 'sessions', SESSION_ID, 'deep-research', 'events.jsonl'),
        'utf8',
      );
      assert.equal(eventText.trim().split('\n').length, 15);
    });
  });

  it('rejects a mutation that would violate source traceability without appending it', async () => {
    await withTempRoot(async (root) => {
      let id = 0;
      const store = createDeepResearchStore(root, {
        newId: () => `id-${++id}`,
        now: () => 100,
      });
      await store.start(SESSION_ID, 'Trace every claim.', 'standard');

      await assert.rejects(
        () => store.recordArtifact(SESSION_ID, {
          artifactId: 'note-1',
          role: 'evidence_note',
          name: 'note.md',
          createdAt: 100,
          contentHash: HASH,
          sourceArtifactIds: ['missing-source'],
        }),
        /non-source artifact missing-source/,
      );

      assert.equal((await store.readEvents(SESSION_ID)).length, 1);
    });
  });

  it('accepts exact mutation replays and rejects conflicting input for the same tool call', async () => {
    await withTempRoot(async (root) => {
      let id = 0;
      const store = createDeepResearchStore(root, {
        newId: () => `id-${++id}`,
        now: () => 100,
      });
      const startContext = { turnId: 'turn-1', toolCallId: 'call-start' };
      await store.start(SESSION_ID, 'Trace every decision.', 'standard', startContext);
      await store.start(SESSION_ID, 'Trace every decision.', 'standard', startContext);
      await assert.rejects(
        () => store.start(SESSION_ID, 'A different objective.', 'standard', startContext),
        /retried with different input/,
      );

      const source = {
        artifactId: 'source-1',
        role: 'source' as const,
        name: 'source.md',
        summary: 'Primary source.',
        createdAt: 100,
        locator: 'https://example.com/source',
        contentHash: HASH,
        sourceArtifactIds: [],
      };
      const artifactContext = { turnId: 'turn-1', toolCallId: 'call-artifact' };
      await store.recordArtifact(SESSION_ID, source, artifactContext);
      await store.recordArtifact(SESSION_ID, source, artifactContext);
      await assert.rejects(
        () => store.recordArtifact(
          SESSION_ID,
          { ...source, locator: 'https://example.com/other' },
          artifactContext,
        ),
        /retried with different input/,
      );
      await assert.rejects(
        () => store.recordArtifact(
          SESSION_ID,
          { ...source, name: 'renamed-source.md' },
          artifactContext,
        ),
        /retried with different input/,
      );
      await assert.rejects(
        () => store.recordArtifact(
          SESSION_ID,
          { ...source, summary: 'Different summary.' },
          artifactContext,
        ),
        /retried with different input/,
      );
      await assert.rejects(
        () => store.recordCheckpoint(
          SESSION_ID,
          {
            round: 1,
            stage: 'knowledge_base',
            status: 'active',
            summary: 'Cross-tool replay.',
            openQuestions: [],
            nextSteps: [],
            taskIds: [],
            artifactIds: [],
          },
          artifactContext,
        ),
        /already used for research_artifact_recorded/,
      );

      const checklistContext = { turnId: 'turn-1', toolCallId: 'call-checklist' };
      await store.updateChecklist(SESSION_ID, {
        itemId: 'project_entrypoints',
        status: 'in_progress',
        evidenceArtifactIds: [],
      }, checklistContext);
      await store.updateChecklist(SESSION_ID, {
        itemId: 'project_entrypoints',
        status: 'in_progress',
        evidenceArtifactIds: [],
      }, checklistContext);
      await assert.rejects(
        () => store.updateChecklist(SESSION_ID, {
          itemId: 'project_entrypoints',
          status: 'completed',
          evidenceArtifactIds: ['source-1'],
        }, checklistContext),
        /retried with different input/,
      );

      const step = {
        kind: 'local_exploration' as const,
        status: 'stopped' as const,
        objective: 'Inspect the entrypoint.',
        summary: 'Stopped at the declared boundary.',
        roots: ['packages/core'],
        keywords: ['entrypoint'],
        ignoredPaths: ['dist'],
        stoppingCondition: 'Stop after the exported contract is found.',
        expectedEvidence: 'A concrete exported symbol.',
        evidenceArtifactIds: [],
        inspectedRefs: [{ kind: 'file' as const, locator: 'packages/core/src/index.ts' }],
        workerRunIds: [],
      };
      const stepContext = { turnId: 'turn-1', toolCallId: 'call-step' };
      await store.recordStep(SESSION_ID, step, stepContext);
      await store.recordStep(SESSION_ID, step, stepContext);
      await assert.rejects(
        () => store.recordStep(SESSION_ID, { ...step, summary: 'Different result.' }, stepContext),
        /retried with different input/,
      );

      const checkpoint = {
        round: 1,
        stage: 'knowledge_base' as const,
        status: 'active' as const,
        summary: 'Entrypoint inspected.',
        openQuestions: [],
        nextSteps: ['Continue.'],
        taskIds: [],
        artifactIds: ['source-1'],
      };
      const checkpointContext = { turnId: 'turn-1', toolCallId: 'call-checkpoint' };
      await store.recordCheckpoint(SESSION_ID, checkpoint, checkpointContext);
      await store.recordCheckpoint(SESSION_ID, checkpoint, checkpointContext);
      await assert.rejects(
        () => store.recordCheckpoint(
          SESSION_ID,
          { ...checkpoint, summary: 'Conflicting checkpoint.' },
          checkpointContext,
        ),
        /retried with different input/,
      );

      assert.equal((await store.readEvents(SESSION_ID)).length, 5);
    });
  });

  it('fails closed when the durable JSONL ledger is corrupt', async () => {
    await withTempRoot(async (root) => {
      const path = join(root, 'sessions', SESSION_ID, 'deep-research', 'events.jsonl');
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, '{"not":"an event"}\n', 'utf8');

      await assert.rejects(
        () => createDeepResearchStore(root).read(SESSION_ID),
        /unexpected event shape/,
      );
    });
  });
});
