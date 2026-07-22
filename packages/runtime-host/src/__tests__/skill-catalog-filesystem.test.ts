import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import {
  resolveRootControlNamespace,
  resolveStorageRoot,
  tryAcquireInteractiveRootOwner,
  type InteractiveRootOwner,
} from '@maka/storage/root-authority';
import type {
  SkillCatalogEntry,
  SkillCatalogItem,
  SkillCatalogRevision,
  SkillCatalogSourceEntry,
  SkillCatalogView,
} from '../protocol/index.js';
import type { ConnectionContext } from '../server/operation-dispatcher.js';
import { HostSkillCatalogCoordinator } from '../server/skill-catalog-coordinator.js';
import {
  HostSkillCatalogFilesystem,
  HostSkillCatalogFilesystemError,
} from '../server/skill-catalog-filesystem.js';

const context: ConnectionContext = {
  hostEpoch: 'skill-catalog-filesystem-test-epoch',
  connectionId: 'skill-catalog-filesystem-test-connection',
  surface: 'desktop',
  principal: 'local_os_user',
  acquireResidency: () => ({ release: () => undefined }),
};

const absentDigest = `sha256:${'0'.repeat(64)}` as const;

test('missing machine sources stay absent while unlocked workspace Skills are query-only', async () => {
  await withCoordinator(async ({ root, managedSourceRoot, coordinator }) => {
    const workspaceContent = skillDocument(
      'Workspace Skill',
      'An unlocked workspace Skill',
      'WORKSPACE_CONTENT_MUST_NOT_LEAK',
    );
    await durableWrite(join(root, 'skills', 'workspace-skill'), 'SKILL.md', workspaceContent);
    const before = await snapshotTree(root);

    await coordinator.recover();
    const installed = await queryAll(coordinator, 'installed');
    const sources = await queryAll(coordinator, 'sources');
    const diagnostics = await queryAll(coordinator, 'diagnostics');
    const workspace = installed.items.find(
      (item) => item.kind === 'skill' && item.id === 'workspace-skill',
    );
    assert.ok(workspace && workspace.kind === 'skill');
    assert.equal(workspace.sourceType, 'workspace');
    assert.equal(workspace.validationStatus, 'missing_lock');

    const missingInstall = await coordinator.handlers['skill.catalog.mutate'](
      {
        expectedRevision: installed.revision,
        mutation: {
          kind: 'install',
          sourceType: 'managed',
          sourceId: 'missing-machine-skill',
          expectedSourceSha256: absentDigest,
        },
      },
      context,
    );
    assert.deepEqual(missingInstall, {
      ok: true,
      result: { kind: 'rejected', reason: 'source_missing' },
    });

    const rejectedUpdate = await coordinator.handlers['skill.catalog.mutate'](
      {
        expectedRevision: installed.revision,
        mutation: {
          kind: 'update_managed',
          skillId: workspace.id,
          expectedCurrentSha256: workspace.contentSha256,
          expectedSourceSha256: absentDigest,
          force: true,
        },
      },
      context,
    );
    assert.deepEqual(rejectedUpdate, {
      ok: true,
      result: { kind: 'rejected', reason: 'not_managed' },
    });

    const rejectedDelete = await coordinator.handlers['skill.catalog.mutate'](
      {
        expectedRevision: installed.revision,
        mutation: { kind: 'delete', skillId: workspace.id },
      },
      context,
    );
    assert.deepEqual(rejectedDelete, {
      ok: true,
      result: { kind: 'rejected', reason: 'not_managed' },
    });

    assert.equal(await pathExists(managedSourceRoot), false);
    assert.deepEqual(await snapshotTree(root), before);
    assert.equal(
      await readFile(join(root, 'skills', workspace.id, 'SKILL.md'), 'utf8'),
      workspaceContent,
    );

    const serializedQueries = JSON.stringify([installed.items, sources.items, diagnostics.items]);
    assert.equal(serializedQueries.includes(root), false);
    assert.equal(serializedQueries.includes(managedSourceRoot), false);
    assert.equal(serializedQueries.includes('WORKSPACE_CONTENT_MUST_NOT_LEAK'), false);
    assert.equal(serializedQueries.includes(workspaceContent), false);
  });
});

test('case-variant IDs conflict for install and starter allocation on a real root', async () => {
  await withCoordinator(async ({ root, managedSourceRoot, coordinator }) => {
    await durableWrite(
      join(root, 'skills', 'Managed-Journey'),
      'SKILL.md',
      skillDocument('Installed Variant', 'The installed case variant', 'INSTALLED_VARIANT'),
    );
    await durableWrite(
      join(root, 'skills', 'Starter-Skill'),
      'SKILL.md',
      skillDocument('Starter Placeholder', 'A case-variant placeholder', 'STARTER_PLACEHOLDER'),
    );
    await durableWrite(
      join(managedSourceRoot, 'managed-journey'),
      'SKILL.md',
      skillDocument('Managed Source', 'The source case variant', 'MANAGED_SOURCE'),
    );

    await coordinator.recover();
    const installed = await queryAll(coordinator, 'installed');
    const source = findSource((await queryAll(coordinator, 'sources')).items, 'managed-journey');
    assert.ok(source);

    const install = await coordinator.handlers['skill.catalog.mutate'](
      {
        expectedRevision: installed.revision,
        mutation: {
          kind: 'install',
          sourceType: 'managed',
          sourceId: source.id,
          expectedSourceSha256: source.contentSha256,
        },
      },
      context,
    );
    assert.deepEqual(install, {
      ok: true,
      result: { kind: 'rejected', reason: 'already_exists' },
    });
    assert.equal((await readdir(join(root, 'skills'))).includes(source.id), false);

    const starter = await coordinator.handlers['skill.catalog.mutate'](
      {
        expectedRevision: installed.revision,
        mutation: { kind: 'create_starter' },
      },
      context,
    );
    assert.equal(starter.ok, true);
    if (!starter.ok || starter.result.kind !== 'committed' || !starter.result.entry) return;
    assert.equal(starter.result.entry.id, 'starter-skill-2');
    assert.equal(await pathExists(join(root, 'skills', 'starter-skill-2', 'SKILL.md')), true);
  });
});

test('case-variant directories retain one canonical inventory item on a real POSIX filesystem', {
  skip: process.platform === 'win32',
}, async (t) => {
  await withCoordinator(async ({ root, coordinator }) => {
    const [firstDirectoryId, secondDirectoryId] = ['Case-Variant', 'case-variant'].sort(
      (left, right) => left.localeCompare(right),
    );
    await durableWrite(
      join(root, 'skills', firstDirectoryId),
      'SKILL.md',
      skillDocument('Zulu Variant', 'The first directory variant', 'ZULU_VARIANT'),
    );
    await durableWrite(
      join(root, 'skills', secondDirectoryId),
      'SKILL.md',
      skillDocument('Alpha Variant', 'The second directory variant', 'ALPHA_VARIANT'),
    );
    const variants = (await readdir(join(root, 'skills'))).filter(
      (entry) => entry.toLowerCase() === 'case-variant',
    );
    if (variants.length !== 2) {
      t.skip('temporary filesystem is case-insensitive');
      return;
    }

    await coordinator.recover();
    const installed = (await queryAll(coordinator, 'installed')).items.filter(
      (item): item is SkillCatalogEntry =>
        item.kind === 'skill' && item.id.toLowerCase() === 'case-variant',
    );
    assert.equal(installed.length, 1);
    assert.equal(installed[0]?.id, secondDirectoryId);
    assert.equal(installed[0]?.name, 'Alpha Variant');

    const duplicateDiagnostics = (await queryAll(coordinator, 'diagnostics')).items.filter(
      (item) =>
        item.kind === 'diagnostic' &&
        item.scope === 'installed' &&
        item.id.toLowerCase() === 'case-variant' &&
        item.codes.includes('duplicate_id'),
    );
    assert.equal(duplicateDiagnostics.length, 1);
    assert.equal(duplicateDiagnostics[0]?.id, firstDirectoryId);
  });
});

test('managed machine sources change only through refresh and drive the CAS lifecycle', async () => {
  await withCoordinator(async ({ root, managedSourceRoot, coordinator }) => {
    await coordinator.recover();
    const beforePublication = await queryAll(coordinator, 'sources');
    const firstSourceContent = skillDocument(
      'Managed Journey',
      'A managed source used by the filesystem journey',
      'MACHINE_SOURCE_V1_PRIVATE_BODY',
    );
    const sourceDirectory = join(managedSourceRoot, 'managed-journey');
    const sourcePath = join(sourceDirectory, 'SKILL.md');
    await durableWrite(sourceDirectory, 'SKILL.md', firstSourceContent);
    const firstSourceFingerprint = await fileFingerprint(sourcePath);

    const cachedBeforeRefresh = await queryAll(coordinator, 'sources');
    assert.equal(findSource(cachedBeforeRefresh.items, 'managed-journey'), undefined);

    const refreshed = await coordinator.handlers['skill.catalog.refresh'](
      { expectedRevision: beforePublication.revision },
      context,
    );
    assert.equal(refreshed.ok, true);
    if (!refreshed.ok || refreshed.result.kind === 'revision_conflict') return;
    assert.equal(refreshed.result.kind, 'committed');
    const afterRefresh = await queryAll(coordinator, 'sources');
    const source = findSource(afterRefresh.items, 'managed-journey');
    assert.ok(source);

    const staleInstall = await coordinator.handlers['skill.catalog.mutate'](
      {
        expectedRevision: beforePublication.revision,
        mutation: {
          kind: 'install',
          sourceType: 'managed',
          sourceId: source.id,
          expectedSourceSha256: source.contentSha256,
        },
      },
      context,
    );
    assert.deepEqual(staleInstall, {
      ok: true,
      result: {
        kind: 'revision_conflict',
        expectedRevision: beforePublication.revision,
        actualRevision: afterRefresh.revision,
      },
    });

    const installed = await coordinator.handlers['skill.catalog.mutate'](
      {
        expectedRevision: afterRefresh.revision,
        mutation: {
          kind: 'install',
          sourceType: 'managed',
          sourceId: source.id,
          expectedSourceSha256: source.contentSha256,
        },
      },
      context,
    );
    assert.equal(installed.ok, true);
    if (!installed.ok || installed.result.kind !== 'committed' || !installed.result.entry) return;
    assert.equal(installed.result.entry.sourceType, 'managed');
    assert.equal(
      await readFile(join(root, 'skills', source.id, 'SKILL.md'), 'utf8'),
      firstSourceContent,
    );

    const disabled = await coordinator.handlers['skill.catalog.mutate'](
      {
        expectedRevision: installed.result.revision,
        mutation: { kind: 'set_enabled', skillId: source.id, enabled: false },
      },
      context,
    );
    assert.equal(disabled.ok, true);
    if (!disabled.ok || disabled.result.kind !== 'committed' || !disabled.result.entry) return;
    assert.equal(disabled.result.entry.enabled, false);
    assert.equal(disabled.result.entry.runtimeStatus, 'disabled');
    assert.deepEqual(await fileFingerprint(sourcePath), firstSourceFingerprint);

    const installedPath = join(root, 'skills', source.id, 'SKILL.md');
    const locallyModifiedContent = skillDocument(
      'Managed Journey Locally Modified',
      'A direct workspace edit of the installed managed Skill',
      'LOCALLY_MODIFIED_PRIVATE_BODY',
    );
    await durableWrite(join(root, 'skills', source.id), 'SKILL.md', locallyModifiedContent);
    const refreshedLocalEdit = await coordinator.handlers['skill.catalog.refresh'](
      { expectedRevision: disabled.result.revision },
      context,
    );
    assert.equal(refreshedLocalEdit.ok, true);
    if (!refreshedLocalEdit.ok || refreshedLocalEdit.result.kind !== 'committed') return;
    const localEditProjection = await queryAll(coordinator, 'installed');
    const locallyModified = findInstalled(localEditProjection.items, source.id);
    assert.ok(locallyModified);
    assert.equal(locallyModified.userModified, true);
    assert.equal(locallyModified.validationStatus, 'modified');
    assert.equal(locallyModified.managedUpdateStatus, 'local_modified');

    const preview = await coordinator.handlers['skill.catalog.preview-update'](
      { skillId: source.id, expectedRevision: localEditProjection.revision },
      context,
    );
    assert.equal(preview.ok, true);
    if (!preview.ok || preview.result.kind !== 'preview') return;
    assert.equal(preview.result.currentContent, locallyModifiedContent);
    assert.equal(preview.result.sourceContent, firstSourceContent);
    assert.equal(preview.result.currentContentSha256, sha256(locallyModifiedContent));
    assert.equal(preview.result.sourceContentSha256, source.contentSha256);

    const forcedRestore = await coordinator.handlers['skill.catalog.mutate'](
      {
        expectedRevision: localEditProjection.revision,
        mutation: {
          kind: 'update_managed',
          skillId: source.id,
          expectedCurrentSha256: locallyModified.contentSha256,
          expectedSourceSha256: source.contentSha256,
          force: true,
        },
      },
      context,
    );
    assert.equal(forcedRestore.ok, true);
    if (
      !forcedRestore.ok ||
      forcedRestore.result.kind !== 'committed' ||
      !forcedRestore.result.entry
    ) {
      return;
    }
    assert.equal(forcedRestore.result.entry.userModified, false);
    assert.equal(forcedRestore.result.entry.validationStatus, 'ok');
    assert.equal(forcedRestore.result.entry.managedUpdateStatus, 'up_to_date');
    assert.equal(forcedRestore.result.entry.runtimeStatus, 'disabled');
    assert.equal(await readFile(installedPath, 'utf8'), firstSourceContent);
    assert.deepEqual(await fileFingerprint(sourcePath), firstSourceFingerprint);

    const secondSourceContent = skillDocument(
      'Managed Journey Updated',
      'The externally updated managed source',
      'MACHINE_SOURCE_V2_PRIVATE_BODY',
    );
    await durableWrite(sourceDirectory, 'SKILL.md', secondSourceContent);
    const secondSourceFingerprint = await fileFingerprint(sourcePath);
    assert.notDeepEqual(secondSourceFingerprint, firstSourceFingerprint);

    const cachedSources = await queryAll(coordinator, 'sources');
    const cachedSource = findSource(cachedSources.items, source.id);
    assert.ok(cachedSource);
    assert.equal(cachedSource.contentSha256, source.contentSha256);
    const cachedInstalled = await queryAll(coordinator, 'installed');
    const cachedManaged = findInstalled(cachedInstalled.items, source.id);
    assert.ok(cachedManaged);
    assert.equal(cachedManaged.managedUpdateStatus, 'up_to_date');

    const sourceChanged = await coordinator.handlers['skill.catalog.mutate'](
      {
        expectedRevision: cachedInstalled.revision,
        mutation: {
          kind: 'update_managed',
          skillId: source.id,
          expectedCurrentSha256: cachedManaged.contentSha256,
          expectedSourceSha256: sha256(secondSourceContent),
          force: false,
        },
      },
      context,
    );
    assert.deepEqual(sourceChanged, {
      ok: true,
      result: { kind: 'rejected', reason: 'source_changed' },
    });

    const refreshedUpdate = await coordinator.handlers['skill.catalog.refresh'](
      { expectedRevision: cachedInstalled.revision },
      context,
    );
    assert.equal(refreshedUpdate.ok, true);
    if (!refreshedUpdate.ok || refreshedUpdate.result.kind !== 'committed') return;
    const refreshProjection = await queryAll(coordinator, 'installed');
    const updateAvailable = findInstalled(refreshProjection.items, source.id);
    assert.ok(updateAvailable);
    assert.equal(updateAvailable.managedUpdateStatus, 'update_available');
    const sourceAfterExternalUpdate = findSource(
      (await queryAll(coordinator, 'sources')).items,
      source.id,
    );
    assert.ok(sourceAfterExternalUpdate);
    assert.equal(sourceAfterExternalUpdate.contentSha256, sha256(secondSourceContent));

    const inodeBeforeUpdate = (await stat(installedPath, { bigint: true })).ino;
    const updated = await coordinator.handlers['skill.catalog.mutate'](
      {
        expectedRevision: refreshProjection.revision,
        mutation: {
          kind: 'update_managed',
          skillId: source.id,
          expectedCurrentSha256: updateAvailable.contentSha256,
          expectedSourceSha256: sourceAfterExternalUpdate.contentSha256,
          force: false,
        },
      },
      context,
    );
    assert.equal(updated.ok, true);
    if (!updated.ok || updated.result.kind !== 'committed' || !updated.result.entry) return;
    assert.equal(updated.result.entry.managedUpdateStatus, 'up_to_date');
    assert.equal(await readFile(installedPath, 'utf8'), secondSourceContent);
    assert.notEqual((await stat(installedPath, { bigint: true })).ino, inodeBeforeUpdate);

    const deleted = await coordinator.handlers['skill.catalog.mutate'](
      {
        expectedRevision: updated.result.revision,
        mutation: { kind: 'delete', skillId: source.id },
      },
      context,
    );
    assert.equal(deleted.ok, true);
    if (!deleted.ok || deleted.result.kind !== 'committed') return;
    assert.equal(deleted.result.entry, null);
    assert.equal(await pathExists(join(root, 'skills', source.id)), false);
    assert.equal(
      findInstalled((await queryAll(coordinator, 'installed')).items, source.id),
      undefined,
    );
    assert.deepEqual(await fileFingerprint(sourcePath), secondSourceFingerprint);

    const serializedQueries = JSON.stringify([
      (await queryAll(coordinator, 'sources')).items,
      (await queryAll(coordinator, 'installed')).items,
      (await queryAll(coordinator, 'diagnostics')).items,
    ]);
    assert.equal(serializedQueries.includes(root), false);
    assert.equal(serializedQueries.includes(managedSourceRoot), false);
    assert.equal(serializedQueries.includes('MACHINE_SOURCE_V2_PRIVATE_BODY'), false);
    assert.equal(serializedQueries.includes(secondSourceContent), false);
  });
});

test('startup recovery completes a partially published managed update without replacing its directory', async () => {
  await withCoordinator(async ({ root, coordinator }) => {
    const skillId = 'recover-managed-update';
    const oldContent = skillDocument('Recover Managed', 'The previous managed body', 'OLD_BODY');
    const nextContent = skillDocument('Recover Managed', 'The recovered managed body', 'NEXT_BODY');
    const skillDirectory = join(root, 'skills', skillId);
    const stagingDirectory = join(root, '.maka', 'skill-catalog-staging');
    const stage = join(stagingDirectory, 'update-recovery-fixture');
    const abandonedStage = join(stagingDirectory, 'update-abandoned-fixture');
    const invalidStage = join(stagingDirectory, 'update-invalid-fixture');
    const oldLock = managedLock(skillId, oldContent, '2026-07-20T00:00:00.000Z');
    const nextLock = managedLock(skillId, nextContent, '2026-07-20T00:01:00.000Z');

    await durableWrite(skillDirectory, 'SKILL.md', nextContent);
    await durableWrite(skillDirectory, 'skill.lock.json', oldLock);
    await durableWrite(skillDirectory, 'notes.txt', 'must survive update recovery\n');
    await durableWrite(stage, 'SKILL.md', nextContent);
    await durableWrite(stage, 'skill.lock.json', nextLock);
    await durableWrite(stage, 'expected.skill.lock.json', oldLock);
    await durableWrite(abandonedStage, 'SKILL.md', nextContent);
    await durableWrite(
      invalidStage,
      'update-intent.json',
      '{"schemaVersion":1,"unexpected":true}\n',
    );
    await durableWrite(
      stage,
      'update-intent.json',
      `${JSON.stringify(
        {
          schemaVersion: 1,
          kind: 'managed-skill-update',
          skillId,
          expectedCurrentSha256: sha256(oldContent),
          nextContentSha256: sha256(nextContent),
        },
        null,
        2,
      )}\n`,
    );

    await assert.rejects(
      coordinator.recover(),
      (error: unknown) =>
        error instanceof HostSkillCatalogFilesystemError && error.code === 'persistence_failed',
    );
    assert.equal(await pathExists(abandonedStage), false);
    assert.equal(await pathExists(invalidStage), true);
    assert.equal(await readFile(join(skillDirectory, 'skill.lock.json'), 'utf8'), oldLock);
    await rm(invalidStage, { recursive: true });

    await coordinator.recover();
    await coordinator.recover();

    assert.equal(await readFile(join(skillDirectory, 'SKILL.md'), 'utf8'), nextContent);
    assert.equal(await readFile(join(skillDirectory, 'skill.lock.json'), 'utf8'), nextLock);
    assert.equal(
      await readFile(join(skillDirectory, 'notes.txt'), 'utf8'),
      'must survive update recovery\n',
    );
    assert.deepEqual(await readdir(stagingDirectory), []);
  });
});

interface Fixture {
  readonly root: string;
  readonly managedSourceRoot: string;
  readonly coordinator: HostSkillCatalogCoordinator;
}

async function withCoordinator(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'maka-skill-catalog-filesystem-'));
  const root = join(base, 'root');
  const managedSourceRoot = join(base, 'machine-sources');
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  const coordinator = new HostSkillCatalogCoordinator(
    new HostSkillCatalogFilesystem(owner.lease, managedSourceRoot),
  );
  try {
    await run({ root, managedSourceRoot, coordinator });
  } finally {
    await coordinator.close();
    await closeOwner(owner);
    await rm(join(resolveRootControlNamespace(), capability.rootId), {
      recursive: true,
      force: true,
    });
    await rm(base, { recursive: true, force: true });
  }
}

async function closeOwner(owner: InteractiveRootOwner): Promise<void> {
  if (!owner.closed) {
    owner.beginClose();
    await owner.close();
  }
}

async function queryAll(
  coordinator: HostSkillCatalogCoordinator,
  view: SkillCatalogView,
): Promise<{
  readonly revision: SkillCatalogRevision;
  readonly items: readonly SkillCatalogItem[];
}> {
  const items: SkillCatalogItem[] = [];
  let revision: SkillCatalogRevision | undefined;
  let cursor: string | null = null;
  do {
    const outcome = await coordinator.handlers['skill.catalog.query'](
      revision
        ? { kind: 'continue', view, revision, cursor: cursor ?? '' }
        : { kind: 'start', view },
      context,
    );
    assert.equal(outcome.ok, true);
    if (!outcome.ok || outcome.result.kind !== 'page') assert.fail('Expected a catalog page');
    revision = outcome.result.revision;
    items.push(...outcome.result.items);
    cursor = outcome.result.nextCursor;
  } while (cursor !== null);
  assert.ok(revision);
  return { revision, items };
}

function findSource(
  items: readonly SkillCatalogItem[],
  id: string,
): SkillCatalogSourceEntry | undefined {
  return items.find(
    (item): item is SkillCatalogSourceEntry => item.kind === 'source' && item.id === id,
  );
}

function findInstalled(
  items: readonly SkillCatalogItem[],
  id: string,
): SkillCatalogEntry | undefined {
  return items.find((item): item is SkillCatalogEntry => item.kind === 'skill' && item.id === id);
}

function skillDocument(name: string, description: string, privateBody: string): string {
  return `---\nname: ${name}\ndescription: ${description}\nallowed-tools:\n  - Read\n---\n\n# ${name}\n\n${privateBody}\n`;
}

function managedLock(skillId: string, content: string, installedAt: string): string {
  const contentSha256 = sha256(content);
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      owner: 'maka-runtime-host',
      id: skillId,
      sourceType: 'managed',
      contentSha256,
      installedAt,
      sourceId: skillId,
      sourceContentSha256: contentSha256,
    },
    null,
    2,
  )}\n`;
}

async function durableWrite(directory: string, fileName: string, content: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = join(directory, fileName);
  const temporary = join(directory, `${fileName}.${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, target);
  const directoryHandle = await open(directory, 'r');
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}

async function fileFingerprint(path: string): Promise<{
  readonly content: string;
  readonly mtimeNs: bigint;
  readonly ino: bigint;
}> {
  const [content, metadata] = await Promise.all([
    readFile(path, 'utf8'),
    stat(path, { bigint: true }),
  ]);
  return { content, mtimeNs: metadata.mtimeNs, ino: metadata.ino };
}

async function snapshotTree(root: string): Promise<readonly unknown[]> {
  const snapshot: unknown[] = [];
  async function visit(path: string): Promise<void> {
    const metadata = await lstat(path, { bigint: true });
    const entry = {
      path: relative(root, path) || '.',
      kind: metadata.isDirectory() ? 'directory' : 'file',
      mode: metadata.mode,
      size: metadata.size,
      mtimeNs: metadata.mtimeNs,
      ino: metadata.ino,
      ...(metadata.isFile()
        ? {
            sha256: createHash('sha256')
              .update(await readFile(path))
              .digest('hex'),
          }
        : {}),
    };
    snapshot.push(entry);
    if (!metadata.isDirectory()) return;
    for (const child of (await readdir(path)).sort()) await visit(join(path, child));
  }
  await visit(root);
  return snapshot;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function sha256(content: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}
