import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RuntimeHostOperationError, type RuntimeHostConnection } from '../client/index.js';
import type { ArtifactQueryResult } from '../protocol/index.js';
import { connectClient, withExecutionRoot } from './support/execution-root-fixture.js';

test('two UDS Clients share revision-pinned Artifact reads, deletes, recovery, and restart state', async () => {
  await withExecutionRoot(async (fixture) => {
    const seeded = await fixture.createArtifacts([
      ...Array.from({ length: 130 }, (_, index) => ({
        id: `artifact-${index.toString().padStart(3, '0')}`,
        name: `artifact-${index}.txt`,
        content: `content ${index}`,
        now: 10_000 - index,
      })),
      {
        id: 'small-text',
        name: 'small.txt',
        content: 'small text preview',
        mimeType: 'text/plain',
        now: 20_000,
      },
      {
        id: 'small-binary',
        name: 'small.png',
        content: tinyPng(),
        kind: 'image',
        mimeType: 'image/png',
        now: 19_999,
      },
      {
        id: 'deep-research-report',
        name: 'research-report.md',
        content: '# Durable research report',
        mimeType: 'text/markdown',
        source: 'deep_research',
        now: 19_998,
      },
    ]);
    const residue = await fixture.seedArtifactPublicationResidue();
    const firstHost = await fixture.startHost();
    assert.ok(!(await fixture.artifactDirectoryEntries()).includes(residue));

    let desktop: RuntimeHostConnection | undefined;
    let tui: RuntimeHostConnection | undefined;
    const deleteA = seeded[4]!;
    const deleteB = seeded[5]!;
    const deepResearchArtifact = seeded.at(-1)!;
    try {
      desktop = await connectClient(fixture.root, 'desktop');
      tui = await connectClient(fixture.root, 'tui');
      const [desktopPage, tuiPage] = await Promise.all([
        firstArtifactPage(desktop, fixture.sessionId),
        firstArtifactPage(tui, fixture.sessionId),
      ]);
      assert.deepEqual(tuiPage, desktopPage);
      assert.ok(desktopPage.nextCursor);
      const [desktopArtifacts, tuiArtifacts] = await Promise.all([
        collectArtifacts(desktop, desktopPage),
        collectArtifacts(tui, tuiPage),
      ]);
      assert.deepEqual(tuiArtifacts, desktopArtifacts);
      assert.equal(desktopArtifacts.length, 133);
      assert.equal(new Set(desktopArtifacts.map((artifact) => artifact.id)).size, 133);
      assert.equal(JSON.stringify(desktopArtifacts).includes('relativePath'), false);
      assert.deepEqual(
        desktopArtifacts.slice(0, 5).map((artifact) => artifact.id),
        ['small-text', 'small-binary', deepResearchArtifact.id, 'artifact-000', 'artifact-001'],
      );

      const [text, binary] = await Promise.all([
        desktop.request('artifact.query', {
          kind: 'read_text',
          sessionId: fixture.sessionId,
          artifactId: 'small-text',
        }),
        tui.request('artifact.query', {
          kind: 'read_binary',
          sessionId: fixture.sessionId,
          artifactId: 'small-binary',
        }),
      ]);
      assert.deepEqual(text, {
        kind: 'text',
        sessionId: fixture.sessionId,
        artifactId: 'small-text',
        preview: { ok: true, text: 'small text preview' },
      });
      assert.equal(binary.kind, 'binary');
      if (binary.kind !== 'binary' || !binary.preview.ok) return;
      assert.equal(binary.preview.mimeType, 'image/png');
      assert.deepEqual(Buffer.from(binary.preview.base64, 'base64'), tinyPng());

      const [deletedA, deletedB] = await Promise.all([
        desktop.request('artifact.delete', {
          sessionId: fixture.sessionId,
          artifactId: deleteA.id,
        }),
        tui.request('artifact.delete', {
          sessionId: fixture.sessionId,
          artifactId: deleteB.id,
        }),
      ]);
      assert.equal(deletedA.artifact.status, 'deleted');
      assert.equal(deletedB.artifact.status, 'deleted');
      assert.notEqual(deletedA.artifact.id, deletedB.artifact.id);

      await Promise.all([
        assert.rejects(
          desktop.request('artifact.delete', {
            sessionId: fixture.sessionId,
            artifactId: deepResearchArtifact.id,
          }),
          operationError('invalid_request'),
        ),
        assert.rejects(
          tui.request('artifact.delete', {
            sessionId: fixture.sessionId,
            artifactId: deepResearchArtifact.id,
          }),
          operationError('invalid_request'),
        ),
      ]);

      const retry = await desktop.request('artifact.delete', {
        sessionId: fixture.sessionId,
        artifactId: deleteA.id,
      });
      assert.deepEqual(retry, deletedA);
      await assert.rejects(
        tui.request('artifact.delete', {
          sessionId: fixture.sessionId,
          artifactId: 'missing-artifact',
        }),
        operationError('not_found'),
      );
      await assert.rejects(
        tui.request('artifact.delete', {
          sessionId: 'different-session',
          artifactId: deleteA.id,
        }),
        operationError('not_found'),
      );

      const stale = await tui.request('artifact.query', {
        kind: 'list_continue',
        sessionId: fixture.sessionId,
        revision: desktopPage.revision,
        cursor: desktopPage.nextCursor!,
      });
      assert.equal(stale.kind, 'revision_changed');
      if (stale.kind !== 'revision_changed') return;
      assert.equal(stale.expected, desktopPage.revision);
      assert.notEqual(stale.actual, desktopPage.revision);
    } finally {
      await Promise.all([desktop?.close(), tui?.close()]);
      await fixture.stopHost(firstHost);
    }

    const successor = await fixture.startHost();
    let client: RuntimeHostConnection | undefined;
    try {
      client = await connectClient(fixture.root, 'run');
      const successorPage = await firstArtifactPage(client, fixture.sessionId);
      const successorTombstones = successorPage.artifacts.filter(
        (artifact) => artifact.id === deleteA.id || artifact.id === deleteB.id,
      );
      assert.deepEqual(
        successorTombstones.map((artifact) => artifact.status),
        ['deleted', 'deleted'],
      );
      for (const artifact of [deleteA, deleteB]) {
        const getResult: ArtifactQueryResult = await client.request('artifact.query', {
          kind: 'get',
          sessionId: fixture.sessionId,
          artifactId: artifact.id,
        });
        const readResult: ArtifactQueryResult = await client.request('artifact.query', {
          kind: 'read_text',
          sessionId: fixture.sessionId,
          artifactId: artifact.id,
        });
        assert.equal(getResult.kind, 'artifact');
        if (getResult.kind !== 'artifact') return;
        assert.equal(getResult.artifact?.status, 'deleted');
        assert.equal(readResult.kind, 'text');
        if (readResult.kind !== 'text') return;
        assert.deepEqual(readResult.preview, { ok: false, reason: 'deleted' });
      }

      const deepResearchGet = await client.request('artifact.query', {
        kind: 'get',
        sessionId: fixture.sessionId,
        artifactId: deepResearchArtifact.id,
      });
      const deepResearchRead = await client.request('artifact.query', {
        kind: 'read_text',
        sessionId: fixture.sessionId,
        artifactId: deepResearchArtifact.id,
      });
      assert.equal(deepResearchGet.kind, 'artifact');
      if (deepResearchGet.kind !== 'artifact') return;
      assert.equal(deepResearchGet.artifact?.status, 'live');
      assert.equal(deepResearchGet.artifact?.source, 'deep_research');
      assert.deepEqual(deepResearchRead, {
        kind: 'text',
        sessionId: fixture.sessionId,
        artifactId: deepResearchArtifact.id,
        preview: { ok: true, text: '# Durable research report' },
      });
    } finally {
      await client?.close();
      await fixture.stopHost(successor);
    }
  });
});

type Page = Extract<ArtifactQueryResult, { kind: 'page' }>;

async function firstArtifactPage(client: RuntimeHostConnection, sessionId: string): Promise<Page> {
  const result = await client.request('artifact.query', { kind: 'list_start', sessionId });
  assert.equal(result.kind, 'page');
  if (result.kind !== 'page') assert.fail('Artifact start query must return a page');
  return result;
}

async function collectArtifacts(
  client: RuntimeHostConnection,
  first: Page,
): Promise<Page['artifacts']> {
  const artifacts = [...first.artifacts];
  let cursor = first.nextCursor;
  while (cursor !== null) {
    const result = await client.request('artifact.query', {
      kind: 'list_continue',
      sessionId: first.sessionId,
      revision: first.revision,
      cursor,
    });
    assert.equal(result.kind, 'page');
    if (result.kind !== 'page') assert.fail('Stable Artifact continuation must return a page');
    artifacts.push(...result.artifacts);
    cursor = result.nextCursor;
  }
  return artifacts;
}

function tinyPng(): Buffer {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );
}

function operationError(code: RuntimeHostOperationError['code']) {
  return (error: unknown): boolean =>
    error instanceof RuntimeHostOperationError && error.code === code;
}
