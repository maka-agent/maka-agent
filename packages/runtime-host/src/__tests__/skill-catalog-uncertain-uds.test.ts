import assert from 'node:assert/strict';
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { RuntimeHostOperationError, type RuntimeHostConnection } from '../client/index.js';
import type { SkillCatalogEntry, SkillCatalogQueryResult } from '../protocol/index.js';
import { connectClient, withExecutionRoot } from './support/execution-root-fixture.js';

test('a committed Skill enablement with an uncertain projection requires refresh before further CAS', async () => {
  await withExecutionRoot(async (fixture) => {
    const machineSourceRoot = join(fixture.base, 'home', '.maka', 'skill-sources');
    const statePath = join(fixture.root, '.maka', 'skills-state.json');
    await assert.rejects(lstat(machineSourceRoot), { code: 'ENOENT' });
    const host = await fixture.startHost();
    let client: RuntimeHostConnection | undefined;
    try {
      client = await connectClient(fixture.root, 'desktop');
      const initial = await queryInstalled(client);
      const created = await client.request('skill.catalog.mutate', {
        expectedRevision: initial.revision,
        mutation: { kind: 'create_starter' },
      });
      assert.equal(created.kind, 'committed');
      if (created.kind !== 'committed' || !created.entry) {
        assert.fail('Starter creation must publish its canonical entry');
      }
      const canonicalRevision = created.revision;
      const starterId = created.entry.id;
      assert.equal(created.entry.enabled, true);

      await mkdir(join(fixture.base, 'home', '.maka'), { recursive: true });
      await writeFile(machineSourceRoot, 'blocks machine source scans', 'utf8');

      await expectOperationError(
        client.request('skill.catalog.mutate', {
          expectedRevision: canonicalRevision,
          mutation: { kind: 'set_enabled', skillId: starterId, enabled: false },
        }),
        'commit_outcome_unknown',
      );
      const stateAfterFirstMutation = await readFile(statePath, 'utf8');
      const persisted = JSON.parse(stateAfterFirstMutation) as {
        skills: Record<string, { enabled: boolean }>;
      };
      assert.equal(persisted.skills[starterId]?.enabled, false);

      await expectOperationError(
        client.request('skill.catalog.query', { kind: 'start', view: 'installed' }),
        'internal_failure',
      );
      await expectOperationError(
        client.request('skill.catalog.mutate', {
          expectedRevision: canonicalRevision,
          mutation: { kind: 'set_enabled', skillId: starterId, enabled: true },
        }),
        'commit_outcome_unknown',
      );
      assert.equal(await readFile(statePath, 'utf8'), stateAfterFirstMutation);

      await rm(machineSourceRoot);
      const refreshed = await client.request('skill.catalog.refresh', {
        expectedRevision: canonicalRevision,
      });
      assert.equal(refreshed.kind, 'revision_conflict');
      if (refreshed.kind !== 'revision_conflict') {
        assert.fail('Recovery refresh must report the rebuilt canonical revision');
      }
      assert.equal(refreshed.expectedRevision, canonicalRevision);
      assert.notEqual(refreshed.actualRevision, canonicalRevision);

      const recovered = await queryInstalled(client);
      assert.equal(recovered.revision, refreshed.actualRevision);
      const starter = recovered.items.find(
        (item): item is SkillCatalogEntry => item.kind === 'skill' && item.id === starterId,
      );
      assert.ok(starter);
      assert.equal(starter.enabled, false);
      assert.equal(starter.runtimeStatus, 'disabled');
    } finally {
      await client?.close();
      await fixture.stopHost(host);
    }
  });
});

async function queryInstalled(
  client: RuntimeHostConnection,
): Promise<Extract<SkillCatalogQueryResult, { kind: 'page' }>> {
  const result = await client.request('skill.catalog.query', {
    kind: 'start',
    view: 'installed',
  });
  assert.equal(result.kind, 'page');
  if (result.kind !== 'page') assert.fail('A start query must return a catalog page');
  assert.equal(result.nextCursor, null, 'The isolated catalog must fit in one page');
  return result;
}

async function expectOperationError(
  request: Promise<unknown>,
  code: RuntimeHostOperationError['code'],
): Promise<void> {
  await assert.rejects(request, (error: unknown) => {
    assert.ok(error instanceof RuntimeHostOperationError);
    assert.equal(error.code, code);
    return true;
  });
}
