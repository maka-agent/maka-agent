import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { defaultLocalMemoryMarkdown, parseLocalMemoryMarkdown } from '@maka/core/local-memory';
import type { RuntimeHostConnection } from '../client/index.js';
import type { MemoryQueryResult } from '../protocol/index.js';
import { connectClient, withExecutionRoot } from './support/execution-root-fixture.js';

const NOW = 1_700_000_000_000;
const ORPHAN = 'MEMORY.md.12345678-1234-4123-8123-123456789abc.tmp';
const SECRET = 'm3-memory-secret';

test('two UDS Clients CAS-mutate canonical Memory through policy gates and Host restart', async () => {
  await withExecutionRoot(async (fixture) => {
    const memoryDirectory = join(fixture.root, 'memory');
    const memoryPath = join(memoryDirectory, 'MEMORY.md');
    await mkdir(memoryDirectory, { recursive: true });
    await writeFile(join(memoryDirectory, ORPHAN), 'orphan', 'utf8');

    const firstHost = await fixture.startHost({ frozenNow: NOW });
    assert.equal((await readdir(memoryDirectory)).includes(ORPHAN), false);
    const defaultDocument = defaultLocalMemoryMarkdown(NOW);
    assert.equal(await readFile(memoryPath, 'utf8'), defaultDocument);

    let desktop: RuntimeHostConnection | undefined;
    let tui: RuntimeHostConnection | undefined;
    let finalDocument: Extract<MemoryQueryResult, { kind: 'document' }> | undefined;
    try {
      desktop = await connectClient(fixture.root, 'desktop');
      tui = await connectClient(fixture.root, 'tui');

      const initialPolicy = await desktop.request('runtime.policy.query', {});
      assert.deepEqual(initialPolicy.policy.memory, { enabled: true, agentReadEnabled: false });

      const [desktopInitial, tuiInitial] = await Promise.all([
        queryDocument(desktop),
        queryDocument(tui),
      ]);
      assert.deepEqual(tuiInitial, desktopInitial);
      assert.equal(decodeDocument(desktopInitial), defaultDocument);

      const mutations = [
        {
          kind: 'propose' as const,
          title: `Needs review token=${SECRET}`,
          content: `Keep this preference; token=${SECRET}`,
          scope: 'workspace' as const,
          sourceTurnId: 'memory-m3-turn',
        },
        {
          kind: 'remember' as const,
          title: 'Always remembered',
          content: 'Use concise summaries.',
          scope: 'session' as const,
        },
      ] as const;
      const outcomes = await Promise.all([
        desktop.request('memory.mutate', {
          expectedRevision: desktopInitial.revision,
          mutation: mutations[0],
        }),
        tui.request('memory.mutate', {
          expectedRevision: desktopInitial.revision,
          mutation: mutations[1],
        }),
      ]);
      assert.deepEqual(outcomes.map((outcome) => outcome.kind).sort(), [
        'committed',
        'revision_conflict',
      ]);
      const loserIndex = outcomes.findIndex((outcome) => outcome.kind === 'revision_conflict');
      assert.notEqual(loserIndex, -1);
      const conflict = outcomes[loserIndex]!;
      assert.equal(conflict.kind, 'revision_conflict');
      if (conflict.kind !== 'revision_conflict') return;
      assert.equal(conflict.expectedRevision, desktopInitial.revision);
      assert.notEqual(conflict.actualRevision, desktopInitial.revision);

      const loser = loserIndex === 0 ? desktop : tui;
      const retried = await loser.request('memory.mutate', {
        expectedRevision: conflict.actualRevision,
        mutation: mutations[loserIndex]!,
      });
      assert.equal(retried.kind, 'committed');
      if (retried.kind !== 'committed') return;

      const [desktopConverged, tuiConverged] = await Promise.all([
        queryDocument(desktop),
        queryDocument(tui),
      ]);
      assert.deepEqual(tuiConverged, desktopConverged);
      assert.equal(desktopConverged.revision, retried.revision);
      const convergedText = decodeDocument(desktopConverged);
      const convergedEntries = parseLocalMemoryMarkdown(convergedText).entries;
      const proposal = convergedEntries.find(
        (entry) => entry.title === 'Needs review token=[redacted]',
      );
      const remembered = convergedEntries.find((entry) => entry.title === 'Always remembered');
      assert.ok(proposal);
      assert.equal(proposal.status, 'proposal');
      assert.equal(proposal.sourceTurnId, 'memory-m3-turn');
      assert.match(proposal.content, /token=\[redacted\]/);
      assert.equal(remembered?.status, 'active');
      assert.equal(remembered?.content, 'Use concise summaries.');
      assert.equal(convergedText.includes(SECRET), false);
      assert.equal((await readFile(memoryPath, 'utf8')).includes(SECRET), false);

      const approved = await desktop.request('memory.mutate', {
        expectedRevision: desktopConverged.revision,
        mutation: { kind: 'approve', entryId: proposal.id },
      });
      assert.equal(approved.kind, 'committed');
      if (approved.kind !== 'committed') return;
      const approvedDocument = await queryDocument(tui);
      const approvedEntry = parseLocalMemoryMarkdown(decodeDocument(approvedDocument)).entries.find(
        (entry) => entry.title === proposal.title,
      );
      assert.equal(approvedEntry?.id, proposal.id);
      assert.equal(approvedEntry?.status, 'active');

      const handEdited = `${decodeDocument(approvedDocument).trimEnd()}\n\n## 中文标题\n偏好使用中文回答。\n`;
      const saved = await tui.request('memory.mutate', {
        expectedRevision: approvedDocument.revision,
        mutation: { kind: 'save', contentBase64: Buffer.from(handEdited).toString('base64') },
      });
      assert.equal(saved.kind, 'committed');
      if (saved.kind !== 'committed') return;
      const handEditedEntry = parseLocalMemoryMarkdown(
        decodeDocument(await queryDocument(desktop)),
      ).entries.find((entry) => entry.title === '中文标题');
      assert.equal(handEditedEntry?.id, '中文标题');
      assert.equal(handEditedEntry?.status, 'active');

      const archived = await desktop.request('memory.mutate', {
        expectedRevision: saved.revision,
        mutation: { kind: 'set_status', entryId: '中文标题', target: 'archived' },
      });
      assert.equal(archived.kind, 'committed');
      if (archived.kind !== 'committed') return;
      const archivedDocument = await queryDocument(tui);
      assert.equal(
        parseLocalMemoryMarkdown(decodeDocument(archivedDocument)).archivedEntries.some(
          (entry) => entry.id === '中文标题',
        ),
        true,
      );

      const disabledPolicy = await desktop.request('runtime.policy.mutate', {
        expectedRevision: initialPolicy.revision,
        operation: {
          kind: 'set_memory',
          value: { enabled: false, agentReadEnabled: false },
        },
      });
      assert.equal(disabledPolicy.kind, 'committed');
      if (disabledPolicy.kind !== 'committed') return;
      assert.deepEqual(await tui.request('memory.query', {}), {
        kind: 'blocked',
        reason: 'disabled',
      });
      assert.deepEqual(
        await desktop.request('memory.mutate', {
          expectedRevision: archived.revision,
          mutation: {
            kind: 'remember',
            title: 'Must stay blocked',
            content: 'This must not persist.',
            scope: 'workspace',
          },
        }),
        { kind: 'rejected', reason: 'disabled' },
      );

      const enabledPolicy = await tui.request('runtime.policy.mutate', {
        expectedRevision: disabledPolicy.revision,
        operation: {
          kind: 'set_memory',
          value: { enabled: true, agentReadEnabled: false },
        },
      });
      assert.equal(enabledPolicy.kind, 'committed');
      if (enabledPolicy.kind !== 'committed') return;
      const incognitoPolicy = await desktop.request('runtime.policy.mutate', {
        expectedRevision: enabledPolicy.revision,
        operation: { kind: 'set_privacy', value: { incognitoActive: true } },
      });
      assert.equal(incognitoPolicy.kind, 'committed');
      if (incognitoPolicy.kind !== 'committed') return;
      assert.deepEqual(await desktop.request('memory.query', {}), {
        kind: 'blocked',
        reason: 'incognito_active',
      });
      assert.deepEqual(
        await tui.request('memory.mutate', {
          expectedRevision: archived.revision,
          mutation: {
            kind: 'remember',
            title: 'Also blocked',
            content: 'This must not persist either.',
            scope: 'workspace',
          },
        }),
        { kind: 'rejected', reason: 'incognito_active' },
      );

      const restoredPolicy = await tui.request('runtime.policy.mutate', {
        expectedRevision: incognitoPolicy.revision,
        operation: { kind: 'set_privacy', value: { incognitoActive: false } },
      });
      assert.equal(restoredPolicy.kind, 'committed');
      finalDocument = await queryDocument(desktop);
      assert.equal(finalDocument.revision, archived.revision);
      assert.equal(decodeDocument(finalDocument).includes('Must stay blocked'), false);
      assert.equal(decodeDocument(finalDocument).includes('Also blocked'), false);
    } finally {
      await Promise.all([desktop?.close(), tui?.close()]);
      await fixture.stopHost(firstHost);
    }

    assert.ok(finalDocument);
    const successor = await fixture.startHost({ frozenNow: NOW });
    let desktopAfterRestart: RuntimeHostConnection | undefined;
    let tuiAfterRestart: RuntimeHostConnection | undefined;
    try {
      desktopAfterRestart = await connectClient(fixture.root, 'desktop');
      tuiAfterRestart = await connectClient(fixture.root, 'tui');
      const [desktopRestarted, tuiRestarted] = await Promise.all([
        queryDocument(desktopAfterRestart),
        queryDocument(tuiAfterRestart),
      ]);
      assert.deepEqual(tuiRestarted, desktopRestarted);
      assert.deepEqual(desktopRestarted, finalDocument);
      assert.equal(await readFile(memoryPath, 'utf8'), decodeDocument(desktopRestarted));
      assert.equal(decodeDocument(desktopRestarted).includes(SECRET), false);
    } finally {
      await Promise.all([desktopAfterRestart?.close(), tuiAfterRestart?.close()]);
      await fixture.stopHost(successor);
    }
  });
});

async function queryDocument(
  client: RuntimeHostConnection,
): Promise<Extract<MemoryQueryResult, { kind: 'document' }>> {
  const result = await client.request('memory.query', {});
  assert.equal(result.kind, 'document');
  if (result.kind !== 'document') assert.fail('Memory query must return a document');
  return result;
}

function decodeDocument(document: Extract<MemoryQueryResult, { kind: 'document' }>): string {
  return Buffer.from(document.contentBase64, 'base64').toString('utf8');
}
