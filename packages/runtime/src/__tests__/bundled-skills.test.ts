import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activateBundledSkillTemplate, BUNDLED_SKILL_TEMPLATES } from '../bundled-skills.js';

describe('shared bundled Skill activation', () => {
  it('creates one locked 0600 workspace copy without replacing it', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const id = 'summarization';
      assert.ok(BUNDLED_SKILL_TEMPLATES.some((template) => template.id === id));
      assert.deepEqual(await activateBundledSkillTemplate(workspaceRoot, id), { ok: true, id });

      const skillDir = join(workspaceRoot, 'skills', id);
      const skillFile = join(skillDir, 'SKILL.md');
      const lockFile = join(skillDir, 'skill.lock.json');
      const before = await readFile(skillFile, 'utf8');
      const lock = JSON.parse(await readFile(lockFile, 'utf8')) as Record<string, unknown>;
      assert.equal(lock.sourceType, 'bundled');
      assert.equal(lock.sourceName, 'maka-bundled');
      assert.equal((await stat(skillDir)).mode & 0o777, 0o700);
      assert.equal((await stat(skillFile)).mode & 0o777, 0o600);
      assert.equal((await stat(lockFile)).mode & 0o777, 0o600);

      assert.deepEqual(await activateBundledSkillTemplate(workspaceRoot, id), {
        ok: false,
        reason: 'already_exists',
      });
      assert.equal(await readFile(skillFile, 'utf8'), before);
    });
  });

  it('rejects unknown ids and a symlinked skills root', async () => {
    await withWorkspace(async (workspaceRoot) => {
      assert.deepEqual(await activateBundledSkillTemplate(workspaceRoot, '../escape'), {
        ok: false,
        reason: 'not_found',
      });

      const outside = await mkdtemp(join(tmpdir(), 'maka-bundled-outside-'));
      try {
        await writeFile(join(outside, 'sentinel'), 'safe');
        await symlink(outside, join(workspaceRoot, 'skills'), 'dir');
        assert.deepEqual(await activateBundledSkillTemplate(workspaceRoot, 'summarization'), {
          ok: false,
          reason: 'blocked_path',
        });
        assert.equal(await readFile(join(outside, 'sentinel'), 'utf8'), 'safe');
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });
});

async function withWorkspace(fn: (workspaceRoot: string) => Promise<void>): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-bundled-shared-'));
  try {
    await mkdir(workspaceRoot, { recursive: true });
    await fn(workspaceRoot);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}
