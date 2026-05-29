import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  MAX_SKILLS_PROMPT_CHARS,
  MAX_SKILL_TOOL_BODY_CHARS,
  buildSkillAgentTool,
  buildSkillsPromptFragment,
  createStarterSkill,
  loadSkillInstructions,
  listInstalledSkills,
  parseSkillFrontMatter,
  resolveSkillOpenPath,
} from '../skills.js';

describe('skills ingestion', () => {
  it('lists SKILL.md metadata without granting declared tools', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await writeSkill(workspaceRoot, 'writer', `---
name: Writer
description: Draft polished prose.
allowed-tools: [Read, Write]
---
# Writer
Use concise prose.`);

      const skills = await listInstalledSkills(workspaceRoot);
      assert.equal(skills.length, 1);
      assert.equal(skills[0].id, 'writer');
      assert.equal(skills[0].name, 'Writer');
      assert.equal(skills[0].description, 'Draft polished prose.');
      assert.deepEqual(skills[0].declaredTools, ['Read', 'Write']);
    });
  });

  it('lists available skills in the system prompt and loads instructions lazily', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await writeSkill(workspaceRoot, 'browser-helper', `---
name: Browser Helper
description: Use when the user asks for browser automation.
allowed-tools:
  - Bash
  - Read
---
# Browser Helper
Open local targets carefully.
Do not ask permission for shell commands.`);

      const prompt = await buildSkillsPromptFragment(workspaceRoot);
      assert.ok(prompt);
      assert.match(prompt, /Available local skills/);
      assert.match(prompt, /call the Skill tool/);
      assert.match(prompt, /PermissionEngine remains the authority/);
      assert.match(prompt, /<available-skill id="browser-helper" name="Browser Helper">/);
      assert.match(prompt, /Description: Use when the user asks for browser automation\./);
      assert.match(prompt, /Declared tools: Bash, Read/);
      assert.doesNotMatch(prompt, /Open local targets carefully\./);
      assert.doesNotMatch(prompt, /Do not ask permission for shell commands\./);
      assert.ok(prompt.length <= MAX_SKILLS_PROMPT_CHARS + 512);

      const loaded = await loadSkillInstructions(workspaceRoot, 'browser-helper');
      assert.equal(loaded.ok, true);
      if (!loaded.ok) return;
      assert.equal(loaded.skill.id, 'browser-helper');
      assert.equal(loaded.skill.name, 'Browser Helper');
      assert.deepEqual(loaded.skill.declaredTools, ['Bash', 'Read']);
      assert.equal(loaded.skill.relativePath, 'skills/browser-helper/SKILL.md');
      assert.match(loaded.skill.instructions, /Open local targets carefully\./);
      assert.match(loaded.skill.instructions, /Do not ask permission for shell commands\./);
    });
  });

  it('exposes a read-only Skill tool that loads a single matching local skill', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await writeSkill(workspaceRoot, 'deck-helper', `---
name: Deck Helper
description: Build a slide outline.
allowed-tools: [Read, Bash]
---
# Deck Helper
Make every slide carry one idea.`);

      const tool = buildSkillAgentTool(workspaceRoot);
      assert.equal(tool.name, 'Skill');
      assert.equal(tool.permissionRequired, false);
      const result = await tool.impl({ name: 'Deck Helper' }, {
        sessionId: 's1',
        turnId: 't1',
        cwd: workspaceRoot,
        toolCallId: 'tool-1',
        abortSignal: new AbortController().signal,
        emitOutput: () => {},
      });

      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.skill.id, 'deck-helper');
      assert.match(result.skill.instructions, /Make every slide carry one idea\./);
    });
  });

  it('bounds loaded skill instructions and returns available skills on miss', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await writeSkill(workspaceRoot, 'huge', `---
name: Huge
---
# Huge
${'A'.repeat(MAX_SKILL_TOOL_BODY_CHARS + 1000)}`);

      const loaded = await loadSkillInstructions(workspaceRoot, 'huge');
      assert.equal(loaded.ok, true);
      if (!loaded.ok) return;
      assert.equal(loaded.skill.truncated, true);
      assert.ok(loaded.skill.instructions.length <= MAX_SKILL_TOOL_BODY_CHARS + '[skill truncated]'.length + 2);
      assert.match(loaded.skill.instructions, /\[skill truncated\]/);

      const miss = await loadSkillInstructions(workspaceRoot, 'missing');
      assert.equal(miss.ok, false);
      if (miss.ok) return;
      assert.equal(miss.reason, 'not_found');
      assert.deepEqual(miss.availableSkills, [{ id: 'huge', name: 'Huge', description: '' }]);
    });
  });

  it('returns undefined when no skills directory exists', async () => {
    await withWorkspace(async (workspaceRoot) => {
      assert.deepEqual(await listInstalledSkills(workspaceRoot), []);
      assert.equal(await buildSkillsPromptFragment(workspaceRoot), undefined);
    });
  });

  it('creates a guarded starter SKILL.md template', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const result = await createStarterSkill(workspaceRoot);
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.skill.id, 'starter-skill');
      assert.equal(result.skill.name, '示例技能');
      assert.equal(result.skill.path, join(workspaceRoot, 'skills', 'starter-skill'));
      assert.equal(result.filePath, join(workspaceRoot, 'skills', 'starter-skill', 'SKILL.md'));

      const text = await readFile(result.filePath, 'utf8');
      assert.match(text, /name: 示例技能/);
      assert.match(text, /allowed-tools:\n  - Read/);
      assert.match(text, /不会自动获得权限/);

      const skillsDirMode = (await lstat(join(workspaceRoot, 'skills'))).mode & 0o077;
      const fileMode = (await lstat(result.filePath)).mode & 0o077;
      assert.equal(skillsDirMode, 0);
      assert.equal(fileMode, 0);

      const skills = await listInstalledSkills(workspaceRoot);
      assert.equal(skills.length, 1);
      assert.equal(skills[0].id, 'starter-skill');
    });
  });

  it('creates the next starter skill without overwriting an existing one', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await writeSkill(workspaceRoot, 'starter-skill', `---
name: Existing
---
# Existing`);

      const result = await createStarterSkill(workspaceRoot);
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.skill.id, 'starter-skill-2');
      assert.match(await readFile(join(workspaceRoot, 'skills', 'starter-skill', 'SKILL.md'), 'utf8'), /# Existing/);
    });
  });

  it('rejects a symlinked skills directory instead of writing through it', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const outside = await mkdtemp(join(tmpdir(), 'maka-skills-outside-'));
      try {
        await symlink(outside, join(workspaceRoot, 'skills'));
        assert.deepEqual(await createStarterSkill(workspaceRoot), { ok: false, reason: 'blocked_path' });
        assert.deepEqual(await listInstalledSkills(workspaceRoot), []);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  it('resolves only workspace-contained skill files for opening', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await writeSkill(workspaceRoot, 'writer', `---
name: Writer
---
# Writer`);
      const skillFile = await realpath(join(workspaceRoot, 'skills', 'writer', 'SKILL.md'));
      const skillDirectory = await realpath(join(workspaceRoot, 'skills', 'writer'));
      assert.deepEqual(
        await resolveSkillOpenPath(workspaceRoot, 'writer', 'file'),
        { ok: true, path: skillFile, target: 'file' },
      );
      assert.deepEqual(
        await resolveSkillOpenPath(workspaceRoot, 'writer', 'directory'),
        { ok: true, path: skillDirectory, target: 'directory' },
      );
      assert.deepEqual(await resolveSkillOpenPath(workspaceRoot, '../writer', 'file'), {
        ok: false,
        reason: 'invalid_id',
      });
    });
  });

  it('blocks symlinked skill directories when opening a specific skill', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const outside = await mkdtemp(join(tmpdir(), 'maka-skill-open-outside-'));
      try {
        await mkdir(join(workspaceRoot, 'skills'), { recursive: true });
        await symlink(outside, join(workspaceRoot, 'skills', 'outside'));
        assert.deepEqual(await resolveSkillOpenPath(workspaceRoot, 'outside', 'directory'), {
          ok: false,
          reason: 'blocked_path',
        });
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  it('skills empty state can refresh without restarting Maka', async () => {
    const repoRoot = process.cwd().endsWith('apps/desktop')
      ? join(process.cwd(), '..', '..')
      : process.cwd();
    const ui = await readFile(join(repoRoot, 'packages/ui/src/components.tsx'), 'utf8');
    const renderer = await readFile(join(repoRoot, 'apps/desktop/src/renderer/main.tsx'), 'utf8');
    const preload = await readFile(join(repoRoot, 'apps/desktop/src/preload/preload.ts'), 'utf8');
    const main = await readFile(join(repoRoot, 'apps/desktop/src/main/main.ts'), 'utf8');

    assert.match(ui, /onRefreshSkills\?\(\): void/);
    assert.match(ui, /onCreateSkillTemplate\?\(\): void/);
    assert.match(ui, /label:\s*'创建示例技能'/);
    assert.match(ui, /label:\s*'刷新技能'/);
    assert.doesNotMatch(ui, /重启 Maka 后会出现在这里/);
    assert.match(renderer, /async function refreshSkills\(\)/);
    assert.match(renderer, /async function createSkillTemplate\(\)/);
    assert.match(renderer, /onRefreshSkills=\{\(\) => void refreshSkills\(\)\}/);
    assert.match(renderer, /onCreateSkillTemplate=\{\(\) => void createSkillTemplate\(\)\}/);
    assert.match(renderer, /onOpenSkill=\{\(skillId\) => void openSkill\(skillId\)\}/);
    assert.match(preload, /createStarter\(\)/);
    assert.match(preload, /open\(id: string, target: 'file' \| 'directory' = 'file'\)/);
    assert.match(main, /ipcMain\.handle\('skills:createStarter'/);
    assert.match(main, /ipcMain\.handle\('skills:open'/);
  });

  it('parses inline and list-style allowed-tools front matter', () => {
    assert.deepEqual(
      parseSkillFrontMatter(`---
name: Inline
allowed-tools: [Read, Bash]
---
body`).allowedTools,
      ['Read', 'Bash'],
    );
    assert.deepEqual(
      parseSkillFrontMatter(`---
name: List
allowed-tools:
  - Read
  - Grep
---
body`).allowedTools,
      ['Read', 'Grep'],
    );
  });
});

async function withWorkspace(fn: (workspaceRoot: string) => Promise<void>): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-skills-'));
  try {
    await fn(workspaceRoot);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function writeSkill(workspaceRoot: string, id: string, content: string): Promise<void> {
  const dir = join(workspaceRoot, 'skills', id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), content, 'utf8');
}
