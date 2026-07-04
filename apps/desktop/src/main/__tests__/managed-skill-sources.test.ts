import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  importManagedSkillSource,
  listManagedSkillSources,
  readManagedSkillSource,
  resolveManagedSkillSourcesRoot,
} from '../managed-skill-sources.js';

describe('managed skill sources', () => {
  it('resolves the global source cache under .maka without making it a runtime path', () => {
    assert.equal(resolveManagedSkillSourcesRoot('C:\\Users\\Ada'), join('C:\\Users\\Ada', '.maka', 'skill-sources'));
  });

  it('imports a local SKILL.md into a managed source cache', async () => {
    await withTempRoot(async (root) => {
      const sourceDir = join(root, 'incoming', 'research-brief');
      await mkdir(sourceDir, { recursive: true });
      const sourceFile = join(sourceDir, 'SKILL.md');
      const sourceText = `---
name: Research Brief
description: Summarize research notes.
allowed-tools: [Read]
---
# Research Brief
Use concise bullets.`;
      await writeFile(sourceFile, sourceText, 'utf8');

      const cacheRoot = join(root, 'cache');
      const result = await importManagedSkillSource({ root: cacheRoot, sourceFile });
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.source.id, 'research-brief');
      assert.equal(result.source.name, 'Research Brief');
      assert.equal(result.source.description, 'Summarize research notes.');
      assert.equal(result.source.sourceType, 'local');
      assert.match(result.source.contentSha256, /^sha256:[a-f0-9]{64}$/);
      assert.equal(result.source.sourcePath, join(cacheRoot, 'research-brief', 'SKILL.md'));

      assert.equal(await readFile(join(cacheRoot, 'research-brief', 'SKILL.md'), 'utf8'), sourceText);

      const listed = await listManagedSkillSources(cacheRoot);
      assert.deepEqual(listed.map((source) => source.id), ['research-brief']);
      assert.equal(listed[0].contentSha256, result.source.contentSha256);

      const read = await readManagedSkillSource(cacheRoot, 'research-brief');
      assert.equal(read.ok, true);
      if (!read.ok) return;
      assert.equal(read.source.id, 'research-brief');
      assert.equal(read.content, sourceText);
    });
  });

  it('rejects invalid or duplicate managed sources', async () => {
    await withTempRoot(async (root) => {
      const cacheRoot = join(root, 'cache');
      const invalid = join(root, 'not-a-skill.md');
      await writeFile(invalid, '# Missing front matter name', 'utf8');

      assert.deepEqual(await importManagedSkillSource({ root: cacheRoot, sourceFile: invalid }), {
        ok: false,
        reason: 'invalid_skill',
      });

      const sourceDir = join(root, 'incoming', 'deck-helper');
      await mkdir(sourceDir, { recursive: true });
      const sourceFile = join(sourceDir, 'SKILL.md');
      await writeFile(sourceFile, `---
name: Deck Helper
description: Build decks.
---
# Deck Helper`, 'utf8');

      const first = await importManagedSkillSource({ root: cacheRoot, sourceFile });
      assert.equal(first.ok, true);
      assert.deepEqual(await importManagedSkillSource({ root: cacheRoot, sourceFile }), {
        ok: false,
        reason: 'already_exists',
      });
    });
  });
});

async function withTempRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-managed-sources-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
