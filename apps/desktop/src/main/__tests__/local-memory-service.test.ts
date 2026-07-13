import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it } from 'node:test';
import {
  createDefaultSettings,
  readLocalMemoryDocumentVersion,
  withLocalMemoryDocumentVersion,
  type AppSettings,
} from '@maka/core';
import { LocalMemoryService } from '../local-memory-service.js';

function makeService(now = 1_700_000_000_000) {
  return async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-memory-'));
    let settings = createDefaultSettings();
    const service = new LocalMemoryService({
      workspaceRoot,
      now: () => now,
      getSettings: async () => settings,
      updateSettings: async (patch: { localMemory: Partial<AppSettings['localMemory']> }) => {
        settings = {
          ...settings,
          localMemory: { ...settings.localMemory, ...patch.localMemory },
        };
        return settings;
      },
      getPrivacyContext: async () => ({ incognitoActive: false }),
    });
    return { service, workspaceRoot };
  };
}

describe('LocalMemoryService', () => {
  it('enforces agent read context before and after backend snapshot creation', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-memory-read-gates-'));
    let settings = {
      ...createDefaultSettings(),
      localMemory: { enabled: true, agentReadEnabled: true },
    };
    let incognitoActive = false;
    const deps = {
      workspaceRoot,
      getSettings: async () => settings,
      updateSettings: async (patch: { localMemory: Partial<AppSettings['localMemory']> }) => {
        settings = { ...settings, localMemory: { ...settings.localMemory, ...patch.localMemory } };
        return settings;
      },
      getPrivacyContext: async () => ({ incognitoActive }),
    };
    const service = new LocalMemoryService(deps);
    await service.getState();
    await service.save(agentReadFixture());
    const snapshot = await service.captureAgentMemoryContent();
    assert.ok(snapshot);

    const sessionA = await service.readForAgent({ workspaceRoot, sessionId: 'session-a', contentSnapshot: snapshot });
    assert.equal(sessionA.status, 'visible');
    if (sessionA.status === 'visible') {
      assert.match(sessionA.promptBody, /workspace-visible|session-a-visible/);
      assert.doesNotMatch(sessionA.promptBody, /session-b-private/);
      assert.doesNotMatch(JSON.stringify(sessionA.trace), /workspace-visible|session-a-visible|session-b-private/);
    }

    incognitoActive = true;
    const afterCreation = await service.readForAgent({ workspaceRoot, sessionId: 'session-a', contentSnapshot: snapshot });
    assert.equal(afterCreation.status, 'empty');
    if (afterCreation.status === 'empty') assert.equal(afterCreation.reason, 'incognito_active');

    const beforeCreation = await service.captureAgentMemoryContent();
    assert.equal(beforeCreation, undefined);
    incognitoActive = false;
    const restart = new LocalMemoryService(deps);
    const restartedRead = await restart.readForAgent({ workspaceRoot, sessionId: 'session-b' });
    assert.equal(restartedRead.status, 'visible');
    if (restartedRead.status === 'visible') {
      assert.match(restartedRead.promptBody, /session-b-private/);
      assert.doesNotMatch(restartedRead.promptBody, /session-a-visible/);
    }

    const crossWorkspace = await restart.readForAgent({ workspaceRoot: `${workspaceRoot}-other`, sessionId: 'session-b' });
    assert.equal(crossWorkspace.status, 'empty');
    if (crossWorkspace.status === 'empty') assert.equal(crossWorkspace.reason, 'workspace_mismatch');
  });

  it('fails closed when privacy status changes while an agent read is in progress', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-memory-read-race-'));
    const settings = {
      ...createDefaultSettings(),
      localMemory: { enabled: true, agentReadEnabled: true },
    };
    let privacyReads = 0;
    const service = new LocalMemoryService({
      workspaceRoot,
      getSettings: async () => settings,
      updateSettings: async () => settings,
      getPrivacyContext: async () => ({ incognitoActive: ++privacyReads >= 2 }),
    });
    const result = await service.readForAgent({
      workspaceRoot,
      sessionId: 'session-a',
      contentSnapshot: agentReadFixture(),
    });
    assert.equal(result.status, 'empty');
    if (result.status === 'empty') assert.equal(result.reason, 'incognito_active');
  });

  it('applies current entry status to a backend content snapshot and retains privacy-safe traces', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-memory-status-authority-'));
    let settings = {
      ...createDefaultSettings(),
      localMemory: { enabled: true, agentReadEnabled: true },
    };
    const service = new LocalMemoryService({
      workspaceRoot,
      getSettings: async () => settings,
      updateSettings: async (patch: { localMemory: Partial<AppSettings['localMemory']> }) => {
        settings = { ...settings, localMemory: { ...settings.localMemory, ...patch.localMemory } };
        return settings;
      },
      getPrivacyContext: async () => ({ incognitoActive: false }),
    });
    await service.getState();
    await service.save(agentReadFixture());
    const snapshot = await service.captureAgentMemoryContent();
    assert.ok(snapshot);

    await service.archiveEntry('session-a');
    const read = await service.readForAgent({ workspaceRoot, sessionId: 'session-a', contentSnapshot: snapshot });
    assert.equal(read.status, 'visible');
    if (read.status === 'visible') {
      assert.match(read.promptBody, /workspace-visible/);
      assert.doesNotMatch(read.promptBody, /session-a-visible/);
    }
    const traces = service.listAgentReadTraces();
    assert.equal(traces.length, 1);
    assert.ok(traces[0]?.decisions.some((item) => item.decision === 'rejected_not_current_or_active'));
    assert.doesNotMatch(JSON.stringify(traces), /workspace-visible|session-a-visible|session-b-private/);
  });

  it('bounds agent read traces to the newest 100 decisions', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-memory-trace-cap-'));
    let settings = {
      ...createDefaultSettings(),
      localMemory: { enabled: false, agentReadEnabled: true },
    };
    let incognitoActive = false;
    const service = new LocalMemoryService({
      workspaceRoot,
      getSettings: async () => settings,
      updateSettings: async (patch: { localMemory: Partial<AppSettings['localMemory']> }) => {
        settings = { ...settings, localMemory: { ...settings.localMemory, ...patch.localMemory } };
        return settings;
      },
      getPrivacyContext: async () => ({ incognitoActive }),
    });

    await service.readForAgent({ workspaceRoot, sessionId: 'session-a' });
    settings = { ...settings, localMemory: { enabled: true, agentReadEnabled: true } };
    incognitoActive = true;
    for (let index = 0; index < 100; index += 1) {
      await service.readForAgent({ workspaceRoot, sessionId: 'session-a' });
    }

    const traces = service.listAgentReadTraces();
    assert.equal(traces.length, 100);
    assert.ok(traces.every((trace) => trace.reason === 'incognito_active'));
  });

  it('advances durable versions and refreshes one reused projection after committed lifecycle changes', async () => {
    const { service, workspaceRoot } = await makeService(1_700_000_000_000)();
    await service.setAgentReadEnabled(true);
    const projection = await service.captureAgentMemoryProjection();
    assert.ok(projection);
    if (!projection) return;
    const initialVersion = projection.version;
    assert.notEqual(initialVersion, null);
    if (initialVersion === null) return;

    await service.save([
      '# Maka Memory',
      '',
      '## Seed',
      '<!-- maka-memory: id=seed status=active scope=workspace -->',
      'seed-v1',
    ].join('\n'));
    const afterSave = await service.readForAgent({ workspaceRoot, sessionId: 'session-a', projection });
    assert.equal(afterSave.status, 'visible');
    if (afterSave.status === 'visible') assert.match(afterSave.promptBody, /seed-v1/);
    assert.ok(projection.version !== null && projection.version > initialVersion);

    const proposed = await service.proposeMemory({ title: 'Approved', content: 'approved-v2' });
    assert.equal(proposed.ok, true);
    if (!proposed.ok) return;
    const proposalId = proposed.proposal?.proposalId ?? proposed.proposal?.id;
    assert.ok(proposalId);
    const beforeApprove = projection.version;
    assert.notEqual(beforeApprove, null);
    if (beforeApprove === null) return;
    assert.equal((await service.approveProposal(proposalId)).ok, true);
    const afterApprove = await service.readForAgent({ workspaceRoot, sessionId: 'session-a', projection });
    assert.equal(afterApprove.status, 'visible');
    if (afterApprove.status === 'visible') assert.match(afterApprove.promptBody, /approved-v2/);
    assert.ok(projection.version !== null && projection.version > beforeApprove);

    const rejectedProposal = await service.proposeMemory({ title: 'Rejected', content: 'rejected-v3' });
    assert.equal(rejectedProposal.ok, true);
    if (!rejectedProposal.ok) return;
    const rejectedId = rejectedProposal.proposal?.proposalId ?? rejectedProposal.proposal?.id;
    assert.ok(rejectedId);
    const beforeReject = projection.version;
    assert.notEqual(beforeReject, null);
    if (beforeReject === null) return;
    assert.equal((await service.rejectProposal(rejectedId)).ok, true);
    await service.readForAgent({ workspaceRoot, sessionId: 'session-a', projection });
    assert.ok(projection.version !== null && projection.version > beforeReject);

    const seedId = (await service.getState()).activeEntries.find((entry) => entry.id === 'seed')?.id;
    assert.equal(seedId, 'seed');
    const beforeArchive = projection.version;
    assert.notEqual(beforeArchive, null);
    if (beforeArchive === null) return;
    assert.equal((await service.archiveEntry('seed')).ok, true);
    const afterArchive = await service.readForAgent({ workspaceRoot, sessionId: 'session-a', projection });
    if (afterArchive.status === 'visible') assert.doesNotMatch(afterArchive.promptBody, /seed-v1/);
    assert.ok(projection.version !== null && projection.version > beforeArchive);

    const beforeRestore = projection.version;
    assert.notEqual(beforeRestore, null);
    if (beforeRestore === null) return;
    assert.equal((await service.restoreEntry('seed')).ok, true);
    const afterRestore = await service.readForAgent({ workspaceRoot, sessionId: 'session-a', projection });
    if (afterRestore.status === 'visible') assert.match(afterRestore.promptBody, /seed-v1/);
    assert.ok(projection.version !== null && projection.version > beforeRestore);

    const beforeDelete = projection.version;
    assert.notEqual(beforeDelete, null);
    if (beforeDelete === null) return;
    assert.equal((await service.deleteEntry('seed')).ok, true);
    const afterDelete = await service.readForAgent({ workspaceRoot, sessionId: 'session-a', projection });
    if (afterDelete.status === 'visible') assert.doesNotMatch(afterDelete.promptBody, /seed-v1/);
    assert.ok(projection.version !== null && projection.version > beforeDelete);

    const beforeReset = projection.version;
    assert.notEqual(beforeReset, null);
    if (beforeReset === null) return;
    await service.reset();
    await service.readForAgent({ workspaceRoot, sessionId: 'session-a', projection });
    assert.ok(projection.version !== null && projection.version > beforeReset);
  });

  it('does not advance a reused projection after a failed write', async () => {
    const { service, workspaceRoot } = await makeService(1_700_000_000_000)();
    await service.setAgentReadEnabled(true);
    const projection = await service.captureAgentMemoryProjection();
    assert.ok(projection);
    if (!projection) return;
    const version = projection.version;

    const failed = await service.rememberUserAuthored({ title: 'Too large', content: 'x'.repeat(200_000) });
    assert.equal(failed.ok, false);
    await service.readForAgent({ workspaceRoot, sessionId: 'session-a', projection });
    assert.equal(projection.version, version);
  });

  it('rolls back a filesystem commit failure without advancing the durable projection', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-memory-write-failure-'));
    const settings = { ...createDefaultSettings(), localMemory: { enabled: true, agentReadEnabled: true } };
    let failCommit = false;
    const service = new LocalMemoryService({
      workspaceRoot,
      getSettings: async () => settings,
      updateSettings: async () => settings,
      getPrivacyContext: async () => ({ incognitoActive: false }),
      beforeVersionedCommit: async () => {
        if (failCommit) throw new Error('simulated disk failure');
      },
    });
    const projection = await service.captureAgentMemoryProjection();
    assert.ok(projection);
    if (!projection) return;
    const version = projection.version;

    failCommit = true;
    await assert.rejects(() => service.save('## Failed\nwrite-must-not-commit'), /simulated disk failure/);
    const read = await service.readForAgent({ workspaceRoot, sessionId: 'session-a', projection });
    assert.equal(projection.version, version);
    if (read.status === 'visible') assert.doesNotMatch(read.promptBody, /write-must-not-commit/);
    assert.equal(await stat(service.transactionFile).catch(() => null), null);
    assert.equal(await stat(`${service.file}.transaction.tmp`).catch(() => null), null);
  });

  it('does not follow transaction temp or journal symlinks outside the workspace', async () => {
    const { service } = await makeService(1_700_000_000_000)();
    const outsideRoot = await mkdtemp(join(tmpdir(), 'maka-memory-transaction-outside-'));
    const outside = join(outsideRoot, 'outside.txt');
    await writeFile(outside, 'outside-must-stay-unchanged', { mode: 0o600 });
    await service.getState();
    await symlink(outside, `${service.file}.transaction.tmp`);

    await service.save('## Safe\n<!-- maka-memory: id=safe status=active scope=workspace -->\ninside-only');
    await symlink(outside, service.transactionFile);
    await assert.rejects(
      () => service.save('## Blocked\ntransaction-journal-symlink'),
      /transaction file is not a contained regular file/,
    );

    assert.equal(await readFile(outside, 'utf8'), 'outside-must-stay-unchanged');
    assert.equal(await readFile(service.file, 'utf8').then((content) => content.includes('inside-only')), true);
  });

  it('falls back to uncached current content when durable version metadata is malformed', async () => {
    const { service, workspaceRoot } = await makeService(1_700_000_000_000)();
    await service.setAgentReadEnabled(true);
    const projection = await service.captureAgentMemoryProjection();
    assert.ok(projection);
    if (!projection) return;
    await writeFile(service.file, [
      '# Maka Memory',
      '<!-- maka-memory-version: invalid -->',
      '',
      '## Current',
      '<!-- maka-memory: id=current status=active scope=workspace -->',
      'uncached-current-content',
    ].join('\n'), { mode: 0o600 });

    assert.equal(await service.captureAgentMemoryProjection(), undefined);
    const read = await service.readForAgent({ workspaceRoot, sessionId: 'session-a', projection });
    assert.equal(read.status, 'visible');
    if (read.status === 'visible') assert.match(read.promptBody, /uncached-current-content/);
    assert.equal(projection.version, null);
  });

  it('recovers an interrupted multi-file approval transaction on restart', async () => {
    const { service, workspaceRoot } = await makeService(1_700_000_000_000)();
    await service.setAgentReadEnabled(true);
    const proposed = await service.proposeMemory({ title: 'Pending', content: 'pending-content' });
    assert.equal(proposed.ok, true);
    const currentProjection = await service.captureAgentMemoryProjection();
    assert.ok(currentProjection?.version !== null);
    if (!currentProjection || currentProjection.version === null) return;
    const interruptedVersion = currentProjection.version + 1;
    const memoryDraft = withLocalMemoryDocumentVersion([
      '# Maka Memory',
      '',
      '## Recovered approval',
      '<!-- maka-memory: id=recovered status=active scope=workspace -->',
      'recovered-after-restart',
    ].join('\n'), interruptedVersion);
    const pendingDraft = withLocalMemoryDocumentVersion('# Maka Pending Memory\n', interruptedVersion);
    assert.equal(memoryDraft.ok, true);
    assert.equal(pendingDraft.ok, true);
    if (!memoryDraft.ok || !pendingDraft.ok) return;

    await writeFile(service.file, memoryDraft.draft, { mode: 0o600 });
    await writeFile(`${service.pendingFile}.transaction.tmp`, pendingDraft.draft, { mode: 0o600 });
    await writeFile(service.transactionFile, `${JSON.stringify({
      schemaVersion: 'maka.local_memory.transaction.v1',
      version: interruptedVersion,
      targets: ['memory', 'pending'],
    })}\n`, { mode: 0o600 });

    let settings = { ...createDefaultSettings(), localMemory: { enabled: true, agentReadEnabled: false } };
    const restarted = new LocalMemoryService({
      workspaceRoot,
      getSettings: async () => settings,
      updateSettings: async (patch: { localMemory: Partial<AppSettings['localMemory']> }) => {
        settings = { ...settings, localMemory: { ...settings.localMemory, ...patch.localMemory } };
        return settings;
      },
      getPrivacyContext: async () => ({ incognitoActive: false }),
    });
    const recoveredState = await restarted.getState();
    assert.equal(recoveredState.status, 'ok');
    assert.match(recoveredState.content, /recovered-after-restart/);
    settings = { ...settings, localMemory: { enabled: true, agentReadEnabled: true } };
    const recovered = await restarted.captureAgentMemoryProjection();
    assert.equal(recovered?.version, interruptedVersion);
    assert.match(recovered?.content ?? '', /recovered-after-restart/);
    assert.equal(readLocalMemoryDocumentVersion(await readFile(restarted.pendingFile, 'utf8')).version, interruptedVersion);
    assert.equal(await stat(restarted.transactionFile).catch(() => null), null);
  });

  it('never lets an older concurrent read regress a shared projection', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-memory-projection-race-'));
    let settings = { ...createDefaultSettings(), localMemory: { enabled: true, agentReadEnabled: true } };
    let settingsReads = 0;
    let releaseOlderRead!: () => void;
    let reportOlderReadBlocked!: () => void;
    const olderReadBlocked = new Promise<void>((resolve) => { reportOlderReadBlocked = resolve; });
    const olderReadRelease = new Promise<void>((resolve) => { releaseOlderRead = resolve; });
    const service = new LocalMemoryService({
      workspaceRoot,
      getSettings: async () => {
        settingsReads += 1;
        if (settingsReads === 6) {
          reportOlderReadBlocked();
          await olderReadRelease;
        }
        return settings;
      },
      updateSettings: async (patch: { localMemory: Partial<AppSettings['localMemory']> }) => {
        settings = { ...settings, localMemory: { ...settings.localMemory, ...patch.localMemory } };
        return settings;
      },
      getPrivacyContext: async () => ({ incognitoActive: false }),
    });
    await service.save('## Shared\n<!-- maka-memory: id=shared status=active scope=workspace -->\nversion-two');
    const projection = await service.captureAgentMemoryProjection();
    assert.ok(projection);
    if (!projection) return;

    const olderRead = service.readForAgent({ workspaceRoot, sessionId: 'session-a', projection });
    await olderReadBlocked;
    await service.save('## Shared\n<!-- maka-memory: id=shared status=active scope=workspace -->\nversion-three');
    const newerRead = await service.readForAgent({ workspaceRoot, sessionId: 'session-a', projection });
    const newerVersion = projection.version;
    releaseOlderRead();
    await olderRead;

    assert.equal(projection.version, newerVersion);
    assert.match(projection.content, /version-three/);
    if (newerRead.status === 'visible') assert.match(newerRead.promptBody, /version-three/);
  });

  it('serializes concurrent save and projection reads without exposing partial content', async () => {
    const { service, workspaceRoot } = await makeService(1_700_000_000_000)();
    await service.setAgentReadEnabled(true);
    await service.save('## Stable\n<!-- maka-memory: id=stable status=active scope=workspace -->\nold-complete');
    const projection = await service.captureAgentMemoryProjection();
    assert.ok(projection);
    if (!projection) return;

    const save = service.save('## Stable\n<!-- maka-memory: id=stable status=active scope=workspace -->\nnew-complete');
    const read = service.readForAgent({ workspaceRoot, sessionId: 'session-a', projection });
    const [, result] = await Promise.all([save, read]);
    assert.equal(result.status, 'visible');
    if (result.status === 'visible') {
      assert.ok(/old-complete|new-complete/.test(result.promptBody));
      assert.doesNotMatch(result.promptBody, /old-complete[\s\S]*new-complete|new-complete[\s\S]*old-complete/);
    }
    const next = await service.readForAgent({ workspaceRoot, sessionId: 'session-a', projection });
    if (next.status === 'visible') assert.match(next.promptBody, /new-complete/);
  });

  it('serializes committed writes across independent service instances', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-memory-cross-instance-'));
    let settings = { ...createDefaultSettings(), localMemory: { enabled: true, agentReadEnabled: true } };
    const deps = {
      workspaceRoot,
      now: () => 1_700_000_000_000,
      getSettings: async () => settings,
      updateSettings: async (patch: { localMemory: Partial<AppSettings['localMemory']> }) => {
        settings = { ...settings, localMemory: { ...settings.localMemory, ...patch.localMemory } };
        return settings;
      },
      getPrivacyContext: async () => ({ incognitoActive: false }),
    };
    const first = new LocalMemoryService(deps);
    const second = new LocalMemoryService(deps);

    const [firstWrite, secondWrite] = await Promise.all([
      first.rememberUserAuthored({ title: 'First', content: 'cross-instance-first' }),
      second.rememberUserAuthored({ title: 'Second', content: 'cross-instance-second' }),
    ]);
    assert.equal(firstWrite.ok, true);
    assert.equal(secondWrite.ok, true);
    const state = await first.getState();
    assert.match(state.content, /cross-instance-first/);
    assert.match(state.content, /cross-instance-second/);

    const projection = await second.captureAgentMemoryProjection();
    assert.ok(projection);
    if (!projection) return;
    const thirdWrite = first.rememberUserAuthored({ title: 'Third', content: 'cross-instance-third' });
    const concurrentRead = second.readForAgent({ workspaceRoot, sessionId: 'session-a', projection });
    const [thirdResult, observed] = await Promise.all([thirdWrite, concurrentRead]);
    assert.equal(thirdResult.ok, true);
    if (observed.status === 'visible') {
      assert.doesNotMatch(observed.promptBody, /cross-instance-third[\s\S]*cross-instance-third/);
    }
    const refreshed = await second.readForAgent({ workspaceRoot, sessionId: 'session-a', projection });
    assert.equal(refreshed.status, 'visible');
    if (refreshed.status === 'visible') assert.match(refreshed.promptBody, /cross-instance-third/);
  });

  it('restores the latest durable projection version after restart', async () => {
    const { service, workspaceRoot } = await makeService(1_700_000_000_000)();
    await service.setAgentReadEnabled(true);
    await service.save('## Restart\n<!-- maka-memory: id=restart status=active scope=workspace -->\nrestart-latest');
    const before = await service.captureAgentMemoryProjection();
    assert.ok(before);

    let settings = { ...createDefaultSettings(), localMemory: { enabled: true, agentReadEnabled: true } };
    const restarted = new LocalMemoryService({
      workspaceRoot,
      getSettings: async () => settings,
      updateSettings: async (patch: { localMemory: Partial<AppSettings['localMemory']> }) => {
        settings = { ...settings, localMemory: { ...settings.localMemory, ...patch.localMemory } };
        return settings;
      },
      getPrivacyContext: async () => ({ incognitoActive: false }),
    });
    const after = await restarted.captureAgentMemoryProjection();
    assert.ok(after);
    assert.equal(after?.version, before?.version);
    assert.match(after?.content ?? '', /restart-latest/);
  });

  it('creates MEMORY.md with 0700 directory and 0600 file', async () => {
    const { service } = await makeService()();
    const state = await service.getState();
    assert.equal(state.status, 'ok');
    const dirStat = await stat(service.dir);
    const fileStat = await stat(service.file);
    assert.equal(dirStat.mode & 0o777, 0o700);
    assert.equal(fileStat.mode & 0o777, 0o600);
  });

  it('saves content and keeps a backup', async () => {
    const { service } = await makeService()();
    await service.getState();
    const next = [
      '# Maka Memory',
      '',
      '## 偏好',
      '<!-- maka-memory: id=pref-1 origin=manual createdAt=1700000000000 -->',
      '喜欢短回答。',
      '',
    ].join('\n');
    const state = await service.save(next);
    assert.equal(state.entryCount, 1);
    assert.equal(state.activeEntryCount, 1);
    assert.equal(state.archivedEntryCount, 0);
    assert.equal(state.entries.length, 1);
    assert.equal(state.activeEntries.length, 1);
    assert.equal(state.archivedEntries.length, 0);
    assert.equal(state.latestBackup?.kind, 'save');
    assert.match(state.latestBackup?.path ?? '', /MEMORY\.md\.bak$/);
    assert.equal(typeof state.latestBackup?.updatedAt, 'number');
    assert.equal(state.latestBackup?.activeEntryCount, 1);
    assert.equal(state.latestBackup?.archivedEntryCount, 0);
    assert.equal(state.latestBackup?.safeMode, false);
    assert.ok((state.latestBackup?.sizeBytes ?? 0) > 0);
    assert.match(await readFile(service.file, 'utf8'), /喜欢短回答/);
    assert.match(await readFile(`${service.file}.bak`, 'utf8'), /示例/);
  });

  it('restores the latest backup while preserving the current file as restore backup', async () => {
    const { service } = await makeService()();
    await service.getState();
    await service.save([
      '# Maka Memory',
      '',
      '## First',
      '<!-- maka-memory: id=first origin=manual createdAt=1700000000000 -->',
      '第一版。',
      '',
    ].join('\n'));
    await service.save([
      '# Maka Memory',
      '',
      '## Second',
      '<!-- maka-memory: id=second origin=manual createdAt=1700000000001 -->',
      '第二版。',
      '',
    ].join('\n'));

    const restored = await service.restoreLatestBackup();

    assert.equal(restored.ok, true);
    assert.match(restored.state.content, /第一版/);
    assert.doesNotMatch(restored.state.content, /第二版/);
    assert.match(await readFile(service.file, 'utf8'), /第一版/);
    assert.match(await readFile(`${service.file}.restore.bak`, 'utf8'), /第二版/);
  });

  it('returns a failure envelope when there is no backup to restore', async () => {
    const { service } = await makeService()();
    await service.getState();

    const restored = await service.restoreLatestBackup();

    assert.equal(restored.ok, false);
    assert.match(restored.message, /没有找到上一版 MEMORY\.md 备份/);
    assert.equal(restored.state.status, 'ok');
  });

  it('can restore the reset backup as the latest previous MEMORY.md version', async () => {
    const { service, workspaceRoot } = await makeService(1_700_000_000_000)();
    await service.save([
      '# Maka Memory',
      '',
      '## Before reset',
      '<!-- maka-memory: id=before-reset origin=manual createdAt=1700000000000 -->',
      '重置前。',
      '',
    ].join('\n'));
    await service.reset();

    const restored = await service.restoreLatestBackup();

    assert.equal(restored.ok, true);
    assert.match(restored.state.content, /重置前/);
    assert.doesNotMatch(restored.state.content, /示例/);
  });

  it('can restore a specific backup candidate by kind', async () => {
    const { service } = await makeService(1_700_000_000_000)();
    await service.save([
      '# Maka Memory',
      '',
      '## First',
      '<!-- maka-memory: id=first origin=manual createdAt=1700000000000 -->',
      '第一版。',
      '',
    ].join('\n'));
    await service.save([
      '# Maka Memory',
      '',
      '## Second',
      '<!-- maka-memory: id=second origin=manual createdAt=1700000000001 -->',
      '第二版。',
      '',
    ].join('\n'));

    const restored = await service.restoreBackup('save');

    assert.equal(restored.ok, true);
    assert.match(restored.state.content, /第一版/);
    assert.doesNotMatch(restored.state.content, /第二版/);
  });

  it('surfaces the pre-restore backup as a restorable candidate', async () => {
    const { service } = await makeService(1_700_000_000_000)();
    await service.save([
      '# Maka Memory',
      '',
      '## First',
      '<!-- maka-memory: id=first origin=manual createdAt=1700000000000 -->',
      '第一版。',
      '',
    ].join('\n'));
    await service.save([
      '# Maka Memory',
      '',
      '## Second',
      '<!-- maka-memory: id=second origin=manual createdAt=1700000000001 -->',
      '第二版。',
      '',
    ].join('\n'));

    const restored = await service.restoreBackup('save');
    const restoreBackup = await service.resolveBackupForOpen('restore');

    assert.equal(restored.ok, true);
    assert.equal(restored.state.latestBackup?.kind, 'restore');
    assert.match(restored.state.latestBackup?.path ?? '', /MEMORY\.md\.restore\.bak$/);
    assert.ok(restored.state.backups?.some((backup) => backup.kind === 'restore'));
    assert.equal(restoreBackup.ok, true);
    if (restoreBackup.ok) assert.match(restoreBackup.path, /MEMORY\.md\.restore\.bak$/);
  });

  it('keeps the previous restore undo when restoring twice', async () => {
    const { service } = await makeService(1_700_000_000_000)();
    await service.save([
      '# Maka Memory',
      '',
      '## First',
      '<!-- maka-memory: id=first origin=manual createdAt=1700000000000 -->',
      '第一版。',
      '',
    ].join('\n'));
    await service.save([
      '# Maka Memory',
      '',
      '## Second',
      '<!-- maka-memory: id=second origin=manual createdAt=1700000000001 -->',
      '第二版。',
      '',
    ].join('\n'));

    const firstRestore = await service.restoreBackup('save');
    assert.equal(firstRestore.ok, true);
    assert.match(await readFile(`${service.file}.restore.bak`, 'utf8'), /第二版/);

    await service.save([
      '# Maka Memory',
      '',
      '## Third',
      '<!-- maka-memory: id=third origin=manual createdAt=1700000000002 -->',
      '第三版。',
      '',
    ].join('\n'));
    const secondRestore = await service.restoreBackup('save');

    assert.equal(secondRestore.ok, true);
    assert.match(await readFile(`${service.file}.restore.bak`, 'utf8'), /第三版/);
    assert.match(await readFile(`${service.file}.restore.1.bak`, 'utf8'), /第二版/);
  });

  it('can restore the restore backup without overwriting the selected backup first', async () => {
    const { service } = await makeService(1_700_000_000_000)();
    await service.save([
      '# Maka Memory',
      '',
      '## First',
      '<!-- maka-memory: id=first origin=manual createdAt=1700000000000 -->',
      '第一版。',
      '',
    ].join('\n'));
    await service.save([
      '# Maka Memory',
      '',
      '## Second',
      '<!-- maka-memory: id=second origin=manual createdAt=1700000000001 -->',
      '第二版。',
      '',
    ].join('\n'));
    const firstRestore = await service.restoreBackup('save');
    assert.equal(firstRestore.ok, true);

    const undoRestore = await service.restoreBackup('restore');

    assert.equal(undoRestore.ok, true);
    assert.match(undoRestore.state.content, /第二版/);
    assert.doesNotMatch(undoRestore.state.content, /第一版/);
    assert.match(await readFile(`${service.file}.restore.1.bak`, 'utf8'), /第二版/);
  });

  it('surfaces reset backup metadata so restore is visible before click', async () => {
    const { service } = await makeService(1_700_000_000_000)();
    await service.save([
      '# Maka Memory',
      '',
      '## Before reset',
      '<!-- maka-memory: id=before-reset origin=manual createdAt=1700000000000 -->',
      '重置前。',
      '',
    ].join('\n'));

    const state = await service.reset();

    assert.equal(state.latestBackup?.kind, 'reset');
    assert.match(state.latestBackup?.path ?? '', /MEMORY\.md\.reset\.bak$/);
    assert.equal(typeof state.latestBackup?.updatedAt, 'number');
    assert.equal(state.latestBackup?.activeEntryCount, 1);
    assert.equal(state.latestBackup?.archivedEntryCount, 0);
    assert.equal(state.latestBackup?.safeMode, false);
    assert.ok((state.latestBackup?.sizeBytes ?? 0) > 0);
  });

  it('surfaces all validated MEMORY.md backup candidates without exposing content', async () => {
    const { service } = await makeService(1_700_000_000_000)();
    await service.save([
      '# Maka Memory',
      '',
      '## Before reset',
      '<!-- maka-memory: id=before-reset origin=manual createdAt=1700000000000 -->',
      '重置前。',
      '',
    ].join('\n'));
    const state = await service.reset();

    assert.equal(state.backups?.length, 2);
    assert.deepEqual(new Set(state.backups?.map((backup) => backup.kind)), new Set(['save', 'reset']));
    assert.equal(state.latestBackup?.path, state.backups?.[0]?.path);
    assert.ok(state.backups?.every((backup) => backup.sizeBytes > 0));
    assert.ok(state.backups?.every((backup) => typeof backup.activeEntryCount === 'number'));
    assert.ok(state.backups?.every((backup) => !('content' in backup)));
  });

  it('resolves the latest backup for explicit user inspection', async () => {
    const { service } = await makeService()();
    await service.getState();
    await service.save([
      '# Maka Memory',
      '',
      '## Inspectable',
      '<!-- maka-memory: id=inspectable origin=manual createdAt=1700000000000 -->',
      '可检查。',
      '',
    ].join('\n'));

    const result = await service.resolveLatestBackupForOpen();

    assert.equal(result.ok, true);
    if (result.ok) assert.match(result.path, /MEMORY\.md\.bak$/);
  });

  it('resolves a specific backup candidate by kind for explicit user inspection', async () => {
    const { service } = await makeService()();
    await service.save([
      '# Maka Memory',
      '',
      '## Before reset',
      '<!-- maka-memory: id=before-reset origin=manual createdAt=1700000000000 -->',
      '重置前。',
      '',
    ].join('\n'));
    await service.reset();

    const saveBackup = await service.resolveBackupForOpen('save');
    const resetBackup = await service.resolveBackupForOpen('reset');

    assert.equal(saveBackup.ok, true);
    assert.equal(resetBackup.ok, true);
    if (saveBackup.ok) assert.match(saveBackup.path, /MEMORY\.md\.bak$/);
    if (resetBackup.ok) assert.match(resetBackup.path, /MEMORY\.md\.reset\.bak$/);
  });

  it('does not resolve a backup symlink that escapes the workspace', async () => {
    const { service, workspaceRoot } = await makeService()();
    const outsideRoot = await mkdtemp(join(tmpdir(), 'maka-memory-backup-outside-'));
    await service.getState();
    const outsideFile = join(outsideRoot, 'MEMORY.md.bak');
    await writeFile(outsideFile, '# outside backup\n', 'utf8');
    await symlink(outsideFile, `${service.file}.bak`);

    const result = await service.resolveLatestBackupForOpen();
    const explicitResult = await service.resolveBackupForOpen('save');
    const state = await service.getState();

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'missing');
    assert.equal(explicitResult.ok, false);
    if (!explicitResult.ok) assert.equal(explicitResult.reason, 'missing');
    assert.equal(state.latestBackup, undefined);
    assert.match(service.file, new RegExp(workspaceRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  it('redacts secrets before writing durable MEMORY.md content', async () => {
    const { service } = await makeService()();
    await service.getState();
    const state = await service.save([
      '# Maka Memory',
      '',
      '## Provider token',
      '<!-- maka-memory: id=secret origin=manual createdAt=1700000000000 -->',
      'Authorization: Bearer sk-ant-api03-abc123def456ghi789jkl0mn1opq',
      'URL: https://api.example.test/models?api_key=raw-secret-value&timeout=30',
    ].join('\n'));

    assert.equal(state.status, 'ok');
    assert.doesNotMatch(state.content, /sk-ant-api03|raw-secret-value/);
    assert.match(state.content, /Authorization: Bearer \[redacted\]/);
    assert.match(state.content, /api_key=\[redacted\]/);

    const persisted = await readFile(service.file, 'utf8');
    assert.doesNotMatch(persisted, /sk-ant-api03|raw-secret-value/);
    assert.match(persisted, /Authorization: Bearer \[redacted\]/);
    assert.match(persisted, /api_key=\[redacted\]/);
  });

  it('counts archived entries but previews the latest active entry', async () => {
    const { service } = await makeService()();
    const state = await service.save([
      '# Maka Memory',
      '',
      '## Active',
      '<!-- maka-memory: id=active origin=manual status=active -->',
      'Use this.',
      '',
      '## Archived',
      '<!-- maka-memory: id=archived origin=manual status=archived -->',
      'Do not use this.',
    ].join('\n'));

    assert.equal(state.entryCount, 2);
    assert.equal(state.activeEntryCount, 1);
    assert.equal(state.archivedEntryCount, 1);
    assert.equal(state.activeEntries[0]?.id, 'active');
    assert.equal(state.archivedEntries[0]?.id, 'archived');
    assert.equal(state.latestEntry?.id, 'active');
  });

  it('stores assistant proposals in PENDING.md until approval', async () => {
    const { service } = await makeService(1_700_000_000_000)();

    const proposed = await service.proposeMemory({
      title: 'Tone',
      content: 'Prefer direct answers.',
      sourceTurnId: 'turn-1',
    });

    assert.equal(proposed.ok, true);
    assert.equal((await service.getState()).activeEntryCount, 1); // default example remains the only active MEMORY.md entry.
    assert.match(await readFile(service.pendingFile, 'utf8'), /status=review_required/);
    assert.match(await readFile(service.pendingFile, 'utf8'), /Prefer direct answers/);
    assert.doesNotMatch(await readFile(service.file, 'utf8'), /Prefer direct answers/);
    assert.equal((await service.listProposals()).length, 1);
  });

  it('approves a pending proposal into active MEMORY.md and removes it from the queue', async () => {
    const { service } = await makeService(1_700_000_000_000)();
    const proposed = await service.proposeMemory({
      title: 'Tone',
      content: 'Prefer direct answers.',
      sourceTurnId: 'turn-1',
    });
    assert.equal(proposed.ok, true);
    if (!proposed.ok) return;
    const proposalId = proposed.proposal?.proposalId ?? proposed.proposal?.id;
    assert.ok(proposalId);

    const approved = await service.approveProposal(proposalId);

    assert.equal(approved.ok, true);
    assert.equal(approved.entry?.source, 'chat_extracted');
    assert.equal(approved.entry?.status, 'active');
    assert.equal(approved.entry?.confirmedAt, 1_700_000_000_000);
    assert.match(await readFile(service.file, 'utf8'), /source=chat_extracted/);
    assert.match(await readFile(service.file, 'utf8'), /confirmedAt=1700000000000/);
    assert.match(await readFile(service.file, 'utf8'), /Prefer direct answers/);
    assert.doesNotMatch(await readFile(service.pendingFile, 'utf8'), /Prefer direct answers/);
    assert.equal((await service.listProposals()).length, 0);
    const updates = service.consumePendingPromptUpdates();
    assert.equal(updates.length, 1);
    assert.equal(updates[0]?.action, 'approved');
    assert.equal(updates[0]?.title, 'Tone');
    assert.equal(service.consumePendingPromptUpdates().length, 0);
  });

  it('rejects a pending proposal without creating active memory', async () => {
    const { service } = await makeService(1_700_000_000_000)();
    const proposed = await service.proposeMemory({
      title: 'Tone',
      content: 'Do not save this.',
    });
    assert.equal(proposed.ok, true);
    if (!proposed.ok) return;
    const proposalId = proposed.proposal?.proposalId ?? proposed.proposal?.id;
    assert.ok(proposalId);

    const rejected = await service.rejectProposal(proposalId);

    assert.equal(rejected.ok, true);
    assert.match(await readFile(service.pendingFile, 'utf8'), /status=rejected/);
    assert.match(await readFile(service.pendingFile, 'utf8'), /rejectedAt=1700000000000/);
    assert.doesNotMatch(await readFile(service.file, 'utf8'), /Do not save this/);
    assert.equal((await service.listProposals()).length, 0);
  });

  it('archives and restores entries through the service with lifecycle metadata', async () => {
    const { service } = await makeService(1_700_000_000_000)();
    const remembered = await service.rememberUserAuthored({
      title: 'Tone',
      content: 'Prefer direct answers.',
    });
    assert.equal(remembered.ok, true);
    if (!remembered.ok) return;
    const entryId = remembered.entry?.id;
    assert.ok(entryId);
    assert.equal(service.consumePendingPromptUpdates()[0]?.action, 'remembered');

    const archived = await service.archiveEntry(entryId, 'user requested');
    assert.equal(archived.ok, true);
    assert.equal(archived.entry?.status, 'archived');
    assert.match(await readFile(service.file, 'utf8'), /status=archived/);
    assert.match(await readFile(service.file, 'utf8'), /archivedAt=1700000000000/);
    assert.equal((await service.getState()).activeEntries.some((entry) => entry.id === entryId), false);

    const restored = await service.restoreEntry(entryId);
    assert.equal(restored.ok, true);
    assert.equal(restored.entry?.status, 'active');
    assert.equal((await service.getState()).activeEntries.some((entry) => entry.id === entryId), true);
    const updates = service.consumePendingPromptUpdates();
    assert.deepEqual(updates.map((update) => update.action), ['archived', 'restored']);
    assert.equal(updates[0]?.entryId, entryId);
    assert.equal(updates[1]?.entryId, entryId);
  });

  it('blocks proposal and approval mutations while incognito is active', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-memory-incognito-mutate-'));
    const service = new LocalMemoryService({
      workspaceRoot,
      getSettings: async () => createDefaultSettings(),
      updateSettings: async () => createDefaultSettings(),
      getPrivacyContext: async () => ({ incognitoActive: true }),
    });

    const proposed = await service.proposeMemory({ title: 'Blocked', content: 'Do not store.' });
    const remembered = await service.rememberUserAuthored({ title: 'Blocked', content: 'Do not store.' });
    const archived = await service.archiveEntry('mem-missing');

    assert.equal(proposed.ok, false);
    if (!proposed.ok) assert.equal(proposed.reason, 'incognito_active');
    assert.equal(remembered.ok, false);
    if (!remembered.ok) assert.equal(remembered.reason, 'incognito_active');
    assert.equal(archived.ok, false);
    if (!archived.ok) assert.equal(archived.reason, 'incognito_active');
  });

  it('does not write oversized content', async () => {
    const { service } = await makeService()();
    await service.getState();
    const state = await service.save('x'.repeat(200_000));
    assert.equal(state.status, 'safe_mode');
    assert.doesNotMatch(await readFile(service.file, 'utf8'), /^x+$/);
  });

  it('returns incognito_blocked without creating the file', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-memory-incognito-'));
    const service = new LocalMemoryService({
      workspaceRoot,
      getSettings: async () => createDefaultSettings(),
      updateSettings: async () => createDefaultSettings(),
      getPrivacyContext: async () => ({ incognitoActive: true }),
    });
    const state = await service.getState();
    assert.equal(state.status, 'incognito_blocked');
  });

  it('resolves MEMORY.md for opening only after the file is inside the workspace', async () => {
    const { service } = await makeService()();
    const result = await service.resolveFileForOpen();
    assert.equal(result.ok, true);
    if (result.ok) assert.match(result.path, /MEMORY\.md$/);
  });

  it('does not resolve MEMORY.md for opening in incognito mode', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-memory-open-incognito-'));
    const service = new LocalMemoryService({
      workspaceRoot,
      getSettings: async () => createDefaultSettings(),
      updateSettings: async () => createDefaultSettings(),
      getPrivacyContext: async () => ({ incognitoActive: true }),
    });

    assert.deepEqual(await service.resolveFileForOpen(), { ok: false, reason: 'incognito_blocked' });
  });

  it('rejects a symlinked MEMORY.md that escapes the workspace', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-memory-symlink-workspace-'));
    const outsideRoot = await mkdtemp(join(tmpdir(), 'maka-memory-symlink-outside-'));
    await mkdir(join(workspaceRoot, 'memory'), { recursive: true });
    const outsideFile = join(outsideRoot, 'MEMORY.md');
    await writeFile(outsideFile, '# outside\n', 'utf8');
    await symlink(outsideFile, join(workspaceRoot, 'memory', 'MEMORY.md'));
    const service = new LocalMemoryService({
      workspaceRoot,
      getSettings: async () => createDefaultSettings(),
      updateSettings: async () => createDefaultSettings(),
      getPrivacyContext: async () => ({ incognitoActive: false }),
    });

    const state = await service.getState();

    assert.equal(state.status, 'error');
    assert.match(state.reason ?? '', /outside the workspace/);
  });
});

function agentReadFixture(): string {
  return [
    '# Maka Memory',
    '',
    '## Workspace',
    '<!-- maka-memory: id=workspace status=active scope=workspace -->',
    'workspace-visible',
    '',
    '## Session A',
    '<!-- maka-memory: id=session-a status=active scope=session sessionId=session-a -->',
    'session-a-visible',
    '',
    '## Session B',
    '<!-- maka-memory: id=session-b status=active scope=session sessionId=session-b -->',
    'session-b-private',
  ].join('\n');
}
