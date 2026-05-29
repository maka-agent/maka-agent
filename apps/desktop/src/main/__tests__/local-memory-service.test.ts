import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it } from 'node:test';
import { createDefaultSettings, type AppSettings } from '@maka/core';
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
    assert.match(await readFile(service.file, 'utf8'), /喜欢短回答/);
    assert.match(await readFile(`${service.file}.bak`, 'utf8'), /示例/);
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
    assert.equal(state.latestEntry?.id, 'active');
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
