import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { RuntimeHostConnection } from '../client/index.js';
import type {
  SkillCatalogEntry,
  SkillCatalogQueryResult,
  SkillCatalogSourceEntry,
} from '../protocol/index.js';
import { connectClient, withExecutionRoot } from './support/execution-root-fixture.js';

const SOURCE_ID = 'two-client-managed';
const PRIVATE_BODY_MARKER = 'PRIVATE_SKILL_BODY_MUST_NOT_CROSS_UDS';

test('two UDS Clients share one CAS-owned Skill catalog without exposing Skill files', async () => {
  await withExecutionRoot(async (fixture) => {
    const managedSourceDirectory = join(fixture.base, 'home', '.maka', 'skill-sources', SOURCE_ID);
    await mkdir(managedSourceDirectory, { recursive: true });
    await writeFile(
      join(managedSourceDirectory, 'SKILL.md'),
      [
        '---',
        'name: Two Client Managed',
        'description: Managed source used by the two Client UDS journey.',
        '---',
        `# ${PRIVATE_BODY_MARKER}`,
        '',
        'These complete instructions stay on the Host filesystem.',
      ].join('\n'),
      'utf8',
    );

    const host = await fixture.startHost();
    let clientA: RuntimeHostConnection | undefined;
    let clientB: RuntimeHostConnection | undefined;
    try {
      clientA = await connectClient(fixture.root, 'desktop');
      clientB = await connectClient(fixture.root, 'tui');

      const [initialA, initialB, sources] = await Promise.all([
        queryPage(clientA, 'installed'),
        queryPage(clientB, 'installed'),
        queryPage(clientA, 'sources'),
      ]);
      assert.equal(initialB.revision, initialA.revision);
      assert.equal(sources.revision, initialA.revision);

      const managedSource = sources.items.find(
        (item): item is SkillCatalogSourceEntry =>
          item.kind === 'source' && item.sourceType === 'managed' && item.id === SOURCE_ID,
      );
      assert.ok(managedSource);
      assert.deepEqual(Object.keys(managedSource).sort(), [
        'category',
        'contentSha256',
        'description',
        'id',
        'installed',
        'kind',
        'name',
        'sourceType',
      ]);
      assert.equal(JSON.stringify(managedSource).includes(managedSourceDirectory), false);
      assert.equal(JSON.stringify(managedSource).includes(PRIVATE_BODY_MARKER), false);

      const installed = await clientA.request('skill.catalog.mutate', {
        expectedRevision: initialA.revision,
        mutation: {
          kind: 'install',
          sourceType: 'managed',
          sourceId: SOURCE_ID,
          expectedSourceSha256: managedSource.contentSha256,
        },
      });
      assert.equal(installed.kind, 'committed');
      if (installed.kind !== 'committed') return;

      const visibleToB = await queryPage(clientB, 'installed');
      assert.equal(visibleToB.revision, installed.revision);
      const installedEntry = visibleToB.items.find(
        (item): item is SkillCatalogEntry => item.kind === 'skill' && item.id === SOURCE_ID,
      );
      assert.ok(installedEntry);
      assert.equal(installedEntry.enabled, true);
      assert.deepEqual(Object.keys(installedEntry).sort(), [
        'contentSha256',
        'declaredTools',
        'description',
        'enabled',
        'id',
        'kind',
        'managedUpdateStatus',
        'name',
        'requiredCapabilities',
        'requiredTools',
        'runtimeStatus',
        'sourceType',
        'userModified',
        'validationStatus',
      ]);
      assert.equal(JSON.stringify(installedEntry).includes(managedSourceDirectory), false);
      assert.equal(JSON.stringify(installedEntry).includes(PRIVATE_BODY_MARKER), false);

      const competingRevision = visibleToB.revision;
      const competing = await Promise.all([
        clientA.request('skill.catalog.mutate', {
          expectedRevision: competingRevision,
          mutation: { kind: 'set_enabled', skillId: SOURCE_ID, enabled: false },
        }),
        clientB.request('skill.catalog.mutate', {
          expectedRevision: competingRevision,
          mutation: { kind: 'delete', skillId: SOURCE_ID },
        }),
      ]);
      assert.deepEqual(competing.map((result) => result.kind).sort(), [
        'committed',
        'revision_conflict',
      ]);
      const winner = competing.find((result) => result.kind === 'committed');
      const conflict = competing.find((result) => result.kind === 'revision_conflict');
      assert.ok(winner);
      assert.ok(conflict);
      if (winner.kind !== 'committed') assert.fail('Expected one committed mutation');
      if (conflict.kind !== 'revision_conflict') assert.fail('Expected one revision conflict');
      assert.equal(conflict.expectedRevision, competingRevision);
      assert.equal(conflict.actualRevision, winner.revision);

      const [finalA, finalB] = await Promise.all([
        queryPage(clientA, 'installed'),
        queryPage(clientB, 'installed'),
      ]);
      assert.deepEqual(finalB, finalA);
      assert.equal(finalB.revision, winner.revision);
      const finalEntry = finalB.items.find(
        (item): item is SkillCatalogEntry => item.kind === 'skill' && item.id === SOURCE_ID,
      );
      if (competing[0].kind === 'committed') {
        assert.ok(finalEntry);
        assert.equal(finalEntry.enabled, false);
      } else {
        assert.equal(finalEntry, undefined);
      }
    } finally {
      await Promise.all([clientA?.close(), clientB?.close()]);
      await fixture.stopHost(host);
    }
  });
});

async function queryPage(
  client: RuntimeHostConnection,
  view: 'installed' | 'sources',
): Promise<Extract<SkillCatalogQueryResult, { kind: 'page' }>> {
  const result = await client.request('skill.catalog.query', { kind: 'start', view });
  assert.equal(result.kind, 'page');
  if (result.kind !== 'page') assert.fail('A start query must return the first catalog page');
  assert.equal(result.nextCursor, null, 'The isolated journey must fit in one catalog page');
  return result;
}
