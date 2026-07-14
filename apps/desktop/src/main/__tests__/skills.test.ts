import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readMainProcessCombinedSource } from './main-process-contract-source-helpers.js';
import {
  MAX_SKILLS_PROMPT_CHARS,
  MAX_SKILL_TOOL_BODY_CHARS,
  buildSkillAgentTool,
  buildSkillsPromptFragment,
  createStarterSkill,
  deleteSkill,
  ensureBundledOfficeSkills,
  getSkillGovernanceDetails,
  installManagedSkill,
  loadSkillInstructions,
  listInstalledSkills,
  parseSkillFrontMatter,
  previewManagedSkillUpdate,
  resolveSkillOpenPath,
  setSkillEnabled,
  updateManagedSkill,
} from '../skills.js';
import { importManagedSkillSource } from '../managed-skill-sources.js';
import { readRendererShellCombinedSource } from './renderer-shell-source-helpers.js';
import { extractFunctionBlock } from './function-block-helpers.js';

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
      assert.equal(skills[0].sourceType, 'workspace');
      assert.equal(skills[0].userModified, false);
      assert.equal(skills[0].validationStatus, 'missing_lock');
      assert.deepEqual(skills[0].validationCodes, ['missing_lock']);
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

  it('persists per-workspace skill enablement and excludes disabled skills from runtime loading', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await writeSkill(workspaceRoot, 'browser-helper', `---
name: Browser Helper
description: Use when the user asks for browser automation.
---
# Browser Helper
Open local targets carefully.`);
      await writeSkill(workspaceRoot, 'deck-helper', `---
name: Deck Helper
description: Build a slide outline.
---
# Deck Helper
Make every slide carry one idea.`);

      const disabled = await setSkillEnabled(workspaceRoot, 'browser-helper', false);
      assert.equal(disabled.ok, true);
      if (!disabled.ok) return;
      assert.equal(disabled.skill.enabled, false);
      assert.equal(disabled.skill.runtimeStatus, 'disabled');

      const skills = await listInstalledSkills(workspaceRoot);
      const browserSkill = skills.find((skill) => skill.id === 'browser-helper');
      const deckSkill = skills.find((skill) => skill.id === 'deck-helper');
      assert.ok(browserSkill);
      assert.ok(deckSkill);
      assert.equal(browserSkill.enabled, false);
      assert.equal(browserSkill.runtimeStatus, 'disabled');
      assert.equal(deckSkill.enabled, true);
      assert.equal(deckSkill.runtimeStatus, 'enabled');

      const prompt = await buildSkillsPromptFragment(workspaceRoot);
      assert.ok(prompt);
      assert.doesNotMatch(prompt, /browser-helper/);
      assert.match(prompt, /deck-helper/);

      const blocked = await loadSkillInstructions(workspaceRoot, 'browser-helper');
      assert.equal(blocked.ok, false);
      if (blocked.ok) return;
      assert.equal(blocked.reason, 'disabled');
      assert.deepEqual(blocked.availableSkills.map((skill) => skill.id), ['deck-helper']);

      const enabled = await setSkillEnabled(workspaceRoot, 'browser-helper', true);
      assert.equal(enabled.ok, true);
      const loaded = await loadSkillInstructions(workspaceRoot, 'browser-helper');
      assert.equal(loaded.ok, true);
    });
  });

  it('loads an enabled duplicate-name skill before reporting a disabled duplicate as blocked', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await writeSkill(workspaceRoot, 'disabled-copy', `---
name: Shared Helper
description: Disabled duplicate.
---
# Shared Helper
Disabled copy.`);
      await writeSkill(workspaceRoot, 'enabled-copy', `---
name: Shared Helper
description: Enabled duplicate.
---
# Shared Helper
Enabled copy.`);

      const disabled = await setSkillEnabled(workspaceRoot, 'disabled-copy', false);
      assert.equal(disabled.ok, true);

      const loadedByName = await loadSkillInstructions(workspaceRoot, 'Shared Helper');
      assert.equal(loadedByName.ok, true);
      if (!loadedByName.ok) return;
      assert.equal(loadedByName.skill.id, 'enabled-copy');
      assert.match(loadedByName.skill.instructions, /Enabled copy\./);

      const loadedDisabledById = await loadSkillInstructions(workspaceRoot, 'disabled-copy');
      assert.equal(loadedDisabledById.ok, false);
      if (loadedDisabledById.ok) return;
      assert.equal(loadedDisabledById.reason, 'disabled');
    });
  });

  it('fails closed when the workspace skill runtime state file is invalid', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await writeSkill(workspaceRoot, 'browser-helper', `---
name: Browser Helper
description: Use when the user asks for browser automation.
---
# Browser Helper
Open local targets carefully.`);
      await mkdir(join(workspaceRoot, '.maka'), { recursive: true });
      await writeFile(join(workspaceRoot, '.maka', 'skills-state.json'), '{not json', 'utf8');

      const skills = await listInstalledSkills(workspaceRoot);
      assert.equal(skills.length, 1);
      assert.equal(skills[0].enabled, false);
      assert.equal(skills[0].runtimeStatus, 'state_error');
      assert.equal(await buildSkillsPromptFragment(workspaceRoot), undefined);

      const loaded = await loadSkillInstructions(workspaceRoot, 'browser-helper');
      assert.equal(loaded.ok, false);
      if (loaded.ok) return;
      assert.equal(loaded.reason, 'disabled');
      assert.deepEqual(loaded.availableSkills, []);
      assert.deepEqual(await setSkillEnabled(workspaceRoot, 'browser-helper', true), { ok: false, reason: 'state_error' });
    });
  });

  it('does not write skill runtime state through a symlinked workspace metadata directory', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const outside = await mkdtemp(join(tmpdir(), 'maka-skill-state-outside-'));
      try {
        await writeSkill(workspaceRoot, 'browser-helper', `---
name: Browser Helper
description: Use when the user asks for browser automation.
---
# Browser Helper
Open local targets carefully.`);
        await symlink(outside, join(workspaceRoot, '.maka'));

        assert.deepEqual(await setSkillEnabled(workspaceRoot, 'browser-helper', false), { ok: false, reason: 'blocked_path' });
        await assert.rejects(readFile(join(outside, 'skills-state.json'), 'utf8'), { code: 'ENOENT' });

        const skills = await listInstalledSkills(workspaceRoot);
        assert.equal(skills.length, 1);
        assert.equal(skills[0].enabled, false);
        assert.equal(skills[0].runtimeStatus, 'state_error');
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  it('does not read or write skill runtime state through a symlinked state file', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const outside = await mkdtemp(join(tmpdir(), 'maka-skill-state-file-outside-'));
      try {
        await writeSkill(workspaceRoot, 'browser-helper', `---
name: Browser Helper
description: Use when the user asks for browser automation.
---
# Browser Helper
Open local targets carefully.`);
        await mkdir(join(workspaceRoot, '.maka'), { recursive: true });
        const externalState = join(outside, 'skills-state.json');
        await writeFile(externalState, 'outside state', 'utf8');
        await symlink(externalState, join(workspaceRoot, '.maka', 'skills-state.json'));

        const skills = await listInstalledSkills(workspaceRoot);
        assert.equal(skills.length, 1);
        assert.equal(skills[0].enabled, false);
        assert.equal(skills[0].runtimeStatus, 'state_error');
        assert.equal(await buildSkillsPromptFragment(workspaceRoot), undefined);
        assert.deepEqual(await setSkillEnabled(workspaceRoot, 'browser-helper', false), { ok: false, reason: 'blocked_path' });
        assert.equal(await readFile(externalState, 'utf8'), 'outside state');
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
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
description: Exercise instruction truncation.
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
      assert.deepEqual(miss.availableSkills, [{ id: 'huge', name: 'Huge', description: 'Exercise instruction truncation.' }]);
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
      assert.equal(result.created, true);
      assert.equal(result.skill.id, 'starter-skill');
      assert.equal(result.skill.name, '示例技能');
      assert.equal(result.skill.path, join(workspaceRoot, 'skills', 'starter-skill'));
      assert.equal(result.filePath, join(workspaceRoot, 'skills', 'starter-skill', 'SKILL.md'));
      await assert.rejects(readFile(join(workspaceRoot, 'skills', 'starter-skill', 'skill.lock.json'), 'utf8'), {
        code: 'ENOENT',
      });

      const text = await readFile(result.filePath, 'utf8');
      assert.match(text, /name: 示例技能/);

      assert.match(text, /allowed-tools:\n  - Read/);
      assert.match(text, /不会自动获得权限/);

      const skillsDirMode = (await lstat(join(workspaceRoot, 'skills'))).mode & 0o077;
      const fileMode = (await lstat(result.filePath)).mode & 0o077;
      if (process.platform !== 'win32') {
        assert.equal(skillsDirMode, 0);
        assert.equal(fileMode, 0);
      }

      const skills = await listInstalledSkills(workspaceRoot);
      assert.equal(skills.length, 1);
      assert.equal(skills[0].id, 'starter-skill');
      assert.equal(skills[0].sourceType, 'workspace');
      assert.equal(skills[0].validationStatus, 'missing_lock');

      // Idempotent seeding: a repeat create REUSES the existing starter-skill
      // (created:false) instead of minting a duplicate — three clicks used to
      // produce three indistinguishable 「示例技能」 rows. No new dir appears.
      const second = await createStarterSkill(workspaceRoot);
      assert.equal(second.ok, true);
      if (second.ok) {
        assert.equal(second.created, false);
        assert.equal(second.skill.id, 'starter-skill');
        assert.equal(second.filePath, join(workspaceRoot, 'skills', 'starter-skill', 'SKILL.md'));
      }
      const dirs = (await readdir(join(workspaceRoot, 'skills'), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
      assert.deepEqual(dirs, ['starter-skill']);
    });
  });

  it('reuses an existing starter skill instead of minting a duplicate', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await writeSkill(workspaceRoot, 'starter-skill', `---
name: Existing
description: Preserve an existing starter skill.
---
# Existing`);

      const result = await createStarterSkill(workspaceRoot);
      assert.equal(result.ok, true);
      if (!result.ok) return;
      // The existing starter-skill/SKILL.md is reused verbatim; no starter-skill-2
      // is created and the user's content is left untouched.
      assert.equal(result.created, false);
      assert.equal(result.skill.id, 'starter-skill');
      assert.match(await readFile(join(workspaceRoot, 'skills', 'starter-skill', 'SKILL.md'), 'utf8'), /# Existing/);
      await assert.rejects(lstat(join(workspaceRoot, 'skills', 'starter-skill-2')), { code: 'ENOENT' });
    });
  });

  it('deletes an installed skill directory', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await writeSkill(workspaceRoot, 'starter-skill', `---
name: 示例技能
description: 用于测试删除已安装技能。
---
# 示例技能`);
      assert.equal((await listInstalledSkills(workspaceRoot)).length, 1);

      assert.deepEqual(await deleteSkill(workspaceRoot, 'starter-skill'), { ok: true });
      assert.equal((await listInstalledSkills(workspaceRoot)).length, 0);
      await assert.rejects(lstat(join(workspaceRoot, 'skills', 'starter-skill')), { code: 'ENOENT' });

      // Deleting an absent skill is a clean not_found, not a throw.
      assert.deepEqual(await deleteSkill(workspaceRoot, 'starter-skill'), { ok: false, reason: 'not_found' });
    });
  });

  it('refuses to delete through a symlinked skill directory', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const outside = await mkdtemp(join(tmpdir(), 'maka-skill-delete-outside-'));
      try {
        await mkdir(join(workspaceRoot, 'skills'), { recursive: true });
        await symlink(outside, join(workspaceRoot, 'skills', 'outside'));
        assert.deepEqual(await deleteSkill(workspaceRoot, 'outside'), { ok: false, reason: 'blocked_path' });
        // The symlink target survives — deletion never followed the link.
        await lstat(outside);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  it('seeds bundled OfficeCLI skills without overwriting user edits', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const first = await ensureBundledOfficeSkills(workspaceRoot);
      assert.deepEqual(first.created.sort(), ['officecli-docx', 'officecli-pptx', 'officecli-xlsx']);
      assert.deepEqual(first.updated, []);
      assert.deepEqual(first.skipped, []);
      assert.deepEqual(first.failed, []);

      const skills = await listInstalledSkills(workspaceRoot);
      assert.equal(skills.length, 3);
      assert.deepEqual(skills.map((skill) => skill.id).sort(), ['officecli-docx', 'officecli-pptx', 'officecli-xlsx']);
      assert.ok(skills.every((skill) => skill.declaredTools.includes('OfficeDocument')));
      assert.ok(skills.every((skill) => skill.declaredTools.includes('OfficeDocumentEdit')));
      assert.ok(skills.every((skill) => !skill.declaredTools.includes('Bash')));
      assert.ok(skills.every((skill) => skill.requiredTools.includes('OfficeDocument')));
      assert.ok(skills.every((skill) => skill.requiredTools.includes('OfficeDocumentEdit')));
      assert.ok(skills.every((skill) => !skill.requiredTools.includes('Read')));
      assert.ok(skills.every((skill) => skill.sourceType === 'bundled'));
      assert.ok(skills.every((skill) => skill.sourceName === 'maka-officecli'));
      assert.ok(skills.every((skill) => skill.sourceVersion === '1'));
      assert.ok(skills.every((skill) => skill.userModified === false));
      assert.ok(skills.every((skill) => skill.validationStatus === 'ok'));
      assert.ok(skills.every((skill) => skill.contentSha256?.startsWith('sha256:')));

      const docxPath = join(workspaceRoot, 'skills', 'officecli-docx', 'SKILL.md');
      const docxLockPath = join(workspaceRoot, 'skills', 'officecli-docx', 'skill.lock.json');
      const before = await readFile(docxPath, 'utf8');
      const lockBytesBeforeSecondEnsure = await readFile(docxLockPath, 'utf8');
      const lock = JSON.parse(await readFile(docxLockPath, 'utf8')) as Record<string, unknown>;
      assert.deepEqual(lock, {
        schemaVersion: 1,
        id: 'officecli-docx',
        sourceType: 'bundled',
        sourceName: 'maka-officecli',
        sourceVersion: '1',
        contentSha256: `sha256:${sha256Hex(before)}`,
        installedAt: lock.installedAt,
      });
      assert.equal(typeof lock.installedAt, 'string');
      assert.match(lock.installedAt as string, /^\d{4}-\d{2}-\d{2}T/);
      assert.match(before, /Use `OfficeDocument` for read-only inspection/);
      assert.match(before, /Use `OfficeDocumentEdit` only for supported writes/);
      assert.doesNotMatch(before, /Check `officecli --version` first/);
      assert.doesNotMatch(before, /officecli open/);
      assert.doesNotMatch(before, /officecli close/);
      assert.doesNotMatch(before, /view "\$FILE" html/);
      if (process.platform !== 'win32') {
        assert.equal((await lstat(docxPath)).mode & 0o077, 0);
      }

      const secondClean = await ensureBundledOfficeSkills(workspaceRoot);
      assert.deepEqual(secondClean.created, []);
      assert.deepEqual(secondClean.updated, []);
      assert.deepEqual(secondClean.skipped.sort(), ['officecli-docx', 'officecli-pptx', 'officecli-xlsx']);
      assert.deepEqual(secondClean.failed, []);
      assert.equal(await readFile(docxLockPath, 'utf8'), lockBytesBeforeSecondEnsure);

      await writeFile(docxPath, `${before}\n\n# User edit\n`, 'utf8');
      const second = await ensureBundledOfficeSkills(workspaceRoot);
      assert.deepEqual(second.created, []);
      assert.deepEqual(second.updated, []);
      assert.deepEqual(second.skipped.sort(), ['officecli-docx', 'officecli-pptx', 'officecli-xlsx']);
      assert.deepEqual(second.failed, []);
      assert.match(await readFile(docxPath, 'utf8'), /# User edit/);

      const modified = await listInstalledSkills(workspaceRoot);
      const docx = modified.find((skill) => skill.id === 'officecli-docx');
      assert.ok(docx);
      assert.equal(docx.sourceType, 'bundled');
      assert.equal(docx.sourceName, 'maka-officecli');
      assert.equal(docx.userModified, true);
      assert.equal(docx.validationStatus, 'modified');
      assert.deepEqual(docx.validationCodes, ['modified']);
    });
  });

  it('does not write bundled skill locks through symlinks', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const outside = await mkdtemp(join(tmpdir(), 'maka-skill-lock-target-'));
      try {
        const skillDir = join(workspaceRoot, 'skills', 'officecli-docx');
        const externalLock = join(outside, 'external-lock.json');
        await mkdir(skillDir, { recursive: true, mode: 0o700 });
        await writeFile(externalLock, 'external sentinel', 'utf8');
        await symlink(externalLock, join(skillDir, 'skill.lock.json'));

        const result = await ensureBundledOfficeSkills(workspaceRoot);
        assert.deepEqual(result.created.sort(), ['officecli-pptx', 'officecli-xlsx']);
        assert.deepEqual(result.updated, []);
        assert.deepEqual(result.skipped, []);
        assert.deepEqual(result.failed, ['officecli-docx']);
        assert.equal(await readFile(externalLock, 'utf8'), 'external sentinel');
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  it('migrates unmodified legacy bundled OfficeCLI skills to tool-routed templates', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const skillDir = join(workspaceRoot, 'skills', 'officecli-docx');
      const skillPath = join(skillDir, 'SKILL.md');
      await mkdir(skillDir, { recursive: true, mode: 0o700 });
      await writeFile(skillPath, legacyOfficeCliDocxSkillTemplate(), { encoding: 'utf8', mode: 0o600 });

      const result = await ensureBundledOfficeSkills(workspaceRoot);
      assert.deepEqual(result.created.sort(), ['officecli-pptx', 'officecli-xlsx']);
      assert.deepEqual(result.updated, ['officecli-docx']);
      assert.deepEqual(result.skipped, []);
      assert.deepEqual(result.failed, []);

      const migrated = await readFile(skillPath, 'utf8');
      assert.match(migrated, /Use `OfficeDocument` for read-only inspection/);
      assert.match(migrated, /Use `OfficeDocumentEdit` only for supported writes/);
      assert.doesNotMatch(migrated, /allowed-tools:\n  - Bash/);
      assert.doesNotMatch(migrated, /officecli open/);
      assert.doesNotMatch(migrated, /officecli view "\$FILE" html/);

      const lock = JSON.parse(await readFile(join(skillDir, 'skill.lock.json'), 'utf8')) as Record<string, unknown>;
      assert.equal(lock.id, 'officecli-docx');
      assert.equal(lock.sourceType, 'bundled');
      assert.equal(lock.contentSha256, `sha256:${sha256Hex(migrated)}`);
    });
  });

  it('treats invalid skill locks as status metadata without changing runtime behavior', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await writeSkill(workspaceRoot, 'broken-lock', `---
name: Broken Lock
description: Still usable.
allowed-tools: [Read]
---
# Broken Lock
Load me anyway.`);
      await writeFile(join(workspaceRoot, 'skills', 'broken-lock', 'skill.lock.json'), '{not json', 'utf8');

      const skills = await listInstalledSkills(workspaceRoot);
      assert.equal(skills.length, 1);
      assert.equal(skills[0].id, 'broken-lock');
      assert.equal(skills[0].sourceType, 'unknown');
      assert.equal(skills[0].userModified, false);
      assert.equal(skills[0].validationStatus, 'metadata_error');
      assert.deepEqual(skills[0].validationCodes, ['invalid_json']);

      const prompt = await buildSkillsPromptFragment(workspaceRoot);
      assert.ok(prompt);
      assert.match(prompt, /<available-skill id="broken-lock" name="Broken Lock">/);
      assert.doesNotMatch(prompt, /skill\.lock\.json/);
      assert.doesNotMatch(prompt, /sourceType/);
      assert.doesNotMatch(prompt, /contentSha256/);
      assert.doesNotMatch(prompt, /sourceVersion/);

      const loaded = await loadSkillInstructions(workspaceRoot, 'broken-lock');
      assert.equal(loaded.ok, true);
      if (!loaded.ok) return;
      assert.match(loaded.skill.instructions, /Load me anyway\./);
      assert.doesNotMatch(JSON.stringify(loaded.skill), /skill\.lock\.json|sourceType|contentSha256|sourceVersion/);
    });
  });

  it('does not trust mismatched or symlinked skill lock metadata', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await writeSkill(workspaceRoot, 'copied', `---
name: Copied
description: Exercise mismatched lock metadata.
---
# Copied`);
      await writeFile(join(workspaceRoot, 'skills', 'copied', 'skill.lock.json'), JSON.stringify({
        schemaVersion: 1,
        id: 'other-id',
        sourceType: 'bundled',
        sourceName: 'maka-officecli',
        sourceVersion: '1',
        contentSha256: `sha256:${sha256Hex(await readFile(join(workspaceRoot, 'skills', 'copied', 'SKILL.md'), 'utf8'))}`,
        installedAt: new Date(0).toISOString(),
      }), 'utf8');

      const outside = await mkdtemp(join(tmpdir(), 'maka-skill-lock-outside-'));
      try {
        await writeSkill(workspaceRoot, 'linked-lock', `---
name: Linked Lock
description: Exercise symlinked lock metadata.
---
# Linked Lock`);
        await writeFile(join(outside, 'skill.lock.json'), JSON.stringify({
          schemaVersion: 1,
          id: 'linked-lock',
          sourceType: 'bundled',
          sourceName: 'maka-officecli',
          sourceVersion: '1',
          contentSha256: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
          installedAt: new Date(0).toISOString(),
        }), 'utf8');
        await symlink(join(outside, 'skill.lock.json'), join(workspaceRoot, 'skills', 'linked-lock', 'skill.lock.json'));

        const skills = await listInstalledSkills(workspaceRoot);
        const copied = skills.find((skill) => skill.id === 'copied');
        const linked = skills.find((skill) => skill.id === 'linked-lock');
        assert.ok(copied);
        assert.equal(copied.sourceType, 'unknown');
        assert.equal(copied.sourceName, undefined);
        assert.equal(copied.validationStatus, 'metadata_error');
        assert.deepEqual(copied.validationCodes, ['id_mismatch']);
        assert.ok(linked);
        assert.equal(linked.sourceType, 'unknown');
        assert.equal(linked.validationStatus, 'metadata_error');
        assert.deepEqual(linked.validationCodes, ['lock_symlink']);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  it('does not trust forged bundled or managed skill lock metadata', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await writeSkill(workspaceRoot, 'officecli-docx', `---
name: Fake OfficeCLI DOCX
description: Exercise forged bundled metadata.
---
# Fake OfficeCLI DOCX
This is not the bundled template.`);
      const fakeOfficeContent = await readFile(join(workspaceRoot, 'skills', 'officecli-docx', 'SKILL.md'), 'utf8');
      await writeFile(join(workspaceRoot, 'skills', 'officecli-docx', 'skill.lock.json'), JSON.stringify({
        schemaVersion: 1,
        id: 'officecli-docx',
        sourceType: 'bundled',
        sourceName: 'maka-officecli',
        sourceVersion: '1',
        contentSha256: `sha256:${sha256Hex(fakeOfficeContent)}`,
        installedAt: new Date(0).toISOString(),
      }), 'utf8');

      await writeSkill(workspaceRoot, 'not-officecli', `---
name: Not OfficeCLI
description: Exercise an invalid bundled skill id.
---
# Not OfficeCLI`);
      const notOfficeContent = await readFile(join(workspaceRoot, 'skills', 'not-officecli', 'SKILL.md'), 'utf8');
      await writeFile(join(workspaceRoot, 'skills', 'not-officecli', 'skill.lock.json'), JSON.stringify({
        schemaVersion: 1,
        id: 'not-officecli',
        sourceType: 'bundled',
        sourceName: 'maka-officecli',
        sourceVersion: '1',
        contentSha256: `sha256:${sha256Hex(notOfficeContent)}`,
        installedAt: new Date(0).toISOString(),
      }), 'utf8');

      await writeSkill(workspaceRoot, 'managed-forgery', `---
name: Managed Forgery
description: Exercise forged managed metadata.
---
# Managed Forgery`);
      const managedContent = await readFile(join(workspaceRoot, 'skills', 'managed-forgery', 'SKILL.md'), 'utf8');
      await writeFile(join(workspaceRoot, 'skills', 'managed-forgery', 'skill.lock.json'), JSON.stringify({
        schemaVersion: 1,
        id: 'managed-forgery',
        sourceType: 'managed',
        sourceName: 'local-library',
        sourceVersion: '1',
        contentSha256: `sha256:${sha256Hex(managedContent)}`,
        installedAt: new Date(0).toISOString(),
      }), 'utf8');

      const skills = await listInstalledSkills(workspaceRoot);
      const fakeOffice = skills.find((skill) => skill.id === 'officecli-docx');
      const notOffice = skills.find((skill) => skill.id === 'not-officecli');
      const managed = skills.find((skill) => skill.id === 'managed-forgery');
      assert.ok(fakeOffice);
      assert.equal(fakeOffice.sourceType, 'unknown');
      assert.equal(fakeOffice.sourceName, undefined);
      assert.equal(fakeOffice.validationStatus, 'metadata_error');
      assert.deepEqual(fakeOffice.validationCodes, ['unsupported_schema']);
      assert.ok(notOffice);
      assert.equal(notOffice.sourceType, 'unknown');
      assert.equal(notOffice.sourceName, undefined);
      assert.equal(notOffice.validationStatus, 'metadata_error');
      assert.deepEqual(notOffice.validationCodes, ['unsupported_schema']);
      assert.ok(managed);
      assert.equal(managed.sourceType, 'unknown');
      assert.equal(managed.sourceName, undefined);
      assert.equal(managed.validationStatus, 'metadata_error');
      assert.deepEqual(managed.validationCodes, ['unsupported_schema']);
    });
  });

  it('does not trust forged managed locks that do not match the source snapshot', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const sourceRoot = await mkdtemp(join(tmpdir(), 'maka-managed-source-cache-'));
      try {
        const incomingDir = join(workspaceRoot, 'incoming', 'research-brief');
        await mkdir(incomingDir, { recursive: true });
        const incomingFile = join(incomingDir, 'SKILL.md');
        await writeFile(incomingFile, `---
name: Research Brief
description: Summarize research.
---
# Research Brief
Source snapshot.`, 'utf8');
        const imported = await importManagedSkillSource({ root: sourceRoot, sourceFile: incomingFile });
        assert.equal(imported.ok, true);
        if (!imported.ok) return;

        await writeSkill(workspaceRoot, 'research-brief', `---
name: Research Brief
description: Forged workspace copy.
---
# Research Brief
Forged workspace content.`);
        const forgedContent = await readFile(join(workspaceRoot, 'skills', 'research-brief', 'SKILL.md'), 'utf8');
        const forgedContentSha256 = `sha256:${sha256Hex(forgedContent)}`;
        assert.notEqual(forgedContentSha256, imported.source.contentSha256);
        await writeFile(join(workspaceRoot, 'skills', 'research-brief', 'skill.lock.json'), JSON.stringify({
          schemaVersion: 1,
          id: 'research-brief',
          sourceType: 'managed',
          sourceName: 'local-library',
          sourceVersion: '1',
          contentSha256: forgedContentSha256,
          installedAt: new Date(0).toISOString(),
          sourceId: 'research-brief',
          sourceContentSha256: imported.source.contentSha256,
        }), 'utf8');

        const skills = await listInstalledSkills(workspaceRoot, { managedSourceRoot: sourceRoot });
        const forged = skills.find((skill) => skill.id === 'research-brief');
        assert.ok(forged);
        assert.equal(forged.sourceType, 'unknown');
        assert.equal(forged.validationStatus, 'metadata_error');
        assert.deepEqual(forged.validationCodes, ['unsupported_schema']);
        assert.equal(forged.managedUpdateStatus, 'metadata_error');
        assert.deepEqual(await updateManagedSkill(workspaceRoot, 'research-brief', sourceRoot), {
          ok: false,
          reason: 'metadata_error',
        });
      } finally {
        await rm(sourceRoot, { recursive: true, force: true });
      }
    });
  });

  it('installs managed sources into the workspace without using the source cache at runtime', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const sourceRoot = await mkdtemp(join(tmpdir(), 'maka-managed-source-cache-'));
      try {
        const incomingDir = join(workspaceRoot, 'incoming', 'research-brief');
        await mkdir(incomingDir, { recursive: true });
        const incomingFile = join(incomingDir, 'SKILL.md');
        await writeFile(incomingFile, `---
name: Research Brief
description: Summarize research.
allowed-tools: [Read]
---
# Research Brief
Use source version one.`, 'utf8');

        const imported = await importManagedSkillSource({ root: sourceRoot, sourceFile: incomingFile });
        assert.equal(imported.ok, true);
        if (!imported.ok) return;

        const installed = await installManagedSkill(workspaceRoot, imported.source.id, sourceRoot);
        assert.equal(installed.ok, true);
        if (!installed.ok) return;
        assert.equal(installed.skill.id, 'research-brief');
        assert.equal(installed.skill.sourceType, 'managed');
        assert.equal(installed.skill.sourceName, 'local-library');
        assert.equal(installed.skill.managedSourceId, 'research-brief');
        assert.equal(installed.skill.managedUpdateStatus, 'up_to_date');

        const lock = JSON.parse(await readFile(join(workspaceRoot, 'skills', 'research-brief', 'skill.lock.json'), 'utf8')) as Record<string, unknown>;
        assert.equal(lock.sourceType, 'managed');
        assert.equal(lock.sourceId, 'research-brief');
        assert.equal(lock.sourceContentSha256, imported.source.contentSha256);
        assert.match(await readFile(join(workspaceRoot, 'skills', 'research-brief', '.maka', 'baseline', 'SKILL.md'), 'utf8'), /Use source version one\./);

        await writeFile(join(sourceRoot, 'research-brief', 'SKILL.md'), `---
name: Research Brief
description: Summarize research.
allowed-tools: [Read]
---
# Research Brief
Use source version two.`, 'utf8');

        const loaded = await loadSkillInstructions(workspaceRoot, 'research-brief');
        assert.equal(loaded.ok, true);
        if (!loaded.ok) return;
        assert.match(loaded.skill.instructions, /Use source version one\./);
        assert.doesNotMatch(loaded.skill.instructions, /Use source version two\./);

        const skills = await listInstalledSkills(workspaceRoot, { managedSourceRoot: sourceRoot });
        const managed = skills.find((skill) => skill.id === 'research-brief');
        assert.ok(managed);
        assert.equal(managed.managedUpdateStatus, 'update_available');

        const details = await getSkillGovernanceDetails(workspaceRoot, 'research-brief', sourceRoot);
        assert.equal(details.ok, true);
        if (!details.ok) return;
        assert.equal(details.details.sourceType, 'managed');
        assert.equal(details.details.hasManagedBaseline, true);
        assert.equal(details.details.sourceAvailable, true);
        assert.equal(details.details.sourceChanged, true);
      } finally {
        await rm(sourceRoot, { recursive: true, force: true });
      }
    });
  });

  it('updates managed skills only when the workspace copy is clean', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const sourceRoot = await mkdtemp(join(tmpdir(), 'maka-managed-source-cache-'));
      try {
        const incomingDir = join(workspaceRoot, 'incoming', 'deck-helper');
        await mkdir(incomingDir, { recursive: true });
        const incomingFile = join(incomingDir, 'SKILL.md');
        await writeFile(incomingFile, `---
name: Deck Helper
description: Build decks.
---
# Deck Helper
Version one.`, 'utf8');
        const imported = await importManagedSkillSource({ root: sourceRoot, sourceFile: incomingFile });
        assert.equal(imported.ok, true);
        if (!imported.ok) return;
        const installed = await installManagedSkill(workspaceRoot, imported.source.id, sourceRoot);
        assert.equal(installed.ok, true);

        await writeFile(join(sourceRoot, 'deck-helper', 'SKILL.md'), `---
name: Deck Helper
description: Build decks.
---
# Deck Helper
Version two.`, 'utf8');

        const cleanPreview = await previewManagedSkillUpdate(workspaceRoot, 'deck-helper', sourceRoot);
        assert.equal(cleanPreview.ok, true);
        if (!cleanPreview.ok) return;
        await writeFile(join(sourceRoot, 'deck-helper', 'SKILL.md'), `---
name: Deck Helper
description: Build decks.
---
# Deck Helper
Version two changed after preview.`, 'utf8');
        assert.deepEqual(await updateManagedSkill(workspaceRoot, 'deck-helper', sourceRoot, {
          expectedCurrentSha256: cleanPreview.preview.expectedCurrentSha256,
          expectedSourceSha256: cleanPreview.preview.expectedSourceSha256,
        }), {
          ok: false,
          reason: 'local_modified',
        });
        assert.match(await readFile(join(workspaceRoot, 'skills', 'deck-helper', 'SKILL.md'), 'utf8'), /Version one\./);

        const freshCleanPreview = await previewManagedSkillUpdate(workspaceRoot, 'deck-helper', sourceRoot);
        assert.equal(freshCleanPreview.ok, true);
        if (!freshCleanPreview.ok) return;
        const updated = await updateManagedSkill(workspaceRoot, 'deck-helper', sourceRoot, {
          expectedCurrentSha256: freshCleanPreview.preview.expectedCurrentSha256,
          expectedSourceSha256: freshCleanPreview.preview.expectedSourceSha256,
        });
        assert.equal(updated.ok, true);
        if (!updated.ok) return;
        assert.equal(updated.skill.managedUpdateStatus, 'up_to_date');
        assert.match(await readFile(join(workspaceRoot, 'skills', 'deck-helper', 'SKILL.md'), 'utf8'), /Version two changed after preview\./);
        assert.match(await readFile(join(workspaceRoot, 'skills', 'deck-helper', '.maka', 'baseline', 'SKILL.md'), 'utf8'), /Version two changed after preview\./);

        await writeFile(join(sourceRoot, 'deck-helper', 'SKILL.md'), `---
name: Deck Helper
description: Build decks.
---
# Deck Helper
Version three.`, 'utf8');
        await writeFile(join(workspaceRoot, 'skills', 'deck-helper', 'SKILL.md'), `---
name: Deck Helper
description: Build decks.
---
# Deck Helper
Local edit.`, 'utf8');

        const blocked = await updateManagedSkill(workspaceRoot, 'deck-helper', sourceRoot);
        assert.deepEqual(blocked, { ok: false, reason: 'local_modified' });

        const preview = await previewManagedSkillUpdate(workspaceRoot, 'deck-helper', sourceRoot);
        assert.equal(preview.ok, true);
        if (!preview.ok) return;
        assert.match(preview.preview.currentContent, /Local edit\./);
        assert.match(preview.preview.sourceContent, /Version three\./);
        assert.match(preview.preview.baselineContent ?? '', /Version two changed after preview\./);
        assert.equal(preview.preview.skill.managedUpdateStatus, 'local_modified');
        assert.ok(preview.preview.summary.changedLineCount > 0);

        assert.deepEqual(await updateManagedSkill(workspaceRoot, 'deck-helper', sourceRoot, { force: true }), {
          ok: false,
          reason: 'local_modified',
        });
        await writeFile(join(workspaceRoot, 'skills', 'deck-helper', 'SKILL.md'), `---
name: Deck Helper
description: Build decks.
---
# Deck Helper
Changed after preview.`, 'utf8');
        assert.deepEqual(await updateManagedSkill(workspaceRoot, 'deck-helper', sourceRoot, {
          force: true,
          expectedCurrentSha256: preview.preview.expectedCurrentSha256,
          expectedSourceSha256: preview.preview.expectedSourceSha256,
        }), {
          ok: false,
          reason: 'local_modified',
        });

        const freshPreview = await previewManagedSkillUpdate(workspaceRoot, 'deck-helper', sourceRoot);
        assert.equal(freshPreview.ok, true);
        if (!freshPreview.ok) return;
        const forced = await updateManagedSkill(workspaceRoot, 'deck-helper', sourceRoot, {
          force: true,
          expectedCurrentSha256: freshPreview.preview.expectedCurrentSha256,
          expectedSourceSha256: freshPreview.preview.expectedSourceSha256,
        });
        assert.equal(forced.ok, true);
        if (!forced.ok) return;
        assert.match(await readFile(join(workspaceRoot, 'skills', 'deck-helper', 'SKILL.md'), 'utf8'), /Version three\./);
        assert.match(await readFile(join(workspaceRoot, 'skills', 'deck-helper', '.maka', 'baseline', 'SKILL.md'), 'utf8'), /Version three\./);

        const skills = await listInstalledSkills(workspaceRoot, { managedSourceRoot: sourceRoot });
        const managed = skills.find((skill) => skill.id === 'deck-helper');
        assert.ok(managed);
        assert.equal(managed.managedUpdateStatus, 'up_to_date');
      } finally {
        await rm(sourceRoot, { recursive: true, force: true });
      }
    });
  });

  it('does not write managed skill baselines through symlinks', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const sourceRoot = await mkdtemp(join(tmpdir(), 'maka-managed-source-cache-'));
      const outside = await mkdtemp(join(tmpdir(), 'maka-managed-baseline-outside-'));
      try {
        const incomingDir = join(workspaceRoot, 'incoming', 'deck-helper');
        await mkdir(incomingDir, { recursive: true });
        const incomingFile = join(incomingDir, 'SKILL.md');
        await writeFile(incomingFile, `---
name: Deck Helper
description: Build decks.
---
# Deck Helper
Version one.`, 'utf8');
        const imported = await importManagedSkillSource({ root: sourceRoot, sourceFile: incomingFile });
        assert.equal(imported.ok, true);
        if (!imported.ok) return;
        const installed = await installManagedSkill(workspaceRoot, imported.source.id, sourceRoot);
        assert.equal(installed.ok, true);

        const externalBaseline = join(outside, 'SKILL.md');
        await writeFile(externalBaseline, 'outside baseline', 'utf8');
        const baselinePath = join(workspaceRoot, 'skills', 'deck-helper', '.maka', 'baseline', 'SKILL.md');
        await rm(baselinePath);
        await symlink(externalBaseline, baselinePath);

        await writeFile(join(sourceRoot, 'deck-helper', 'SKILL.md'), `---
name: Deck Helper
description: Build decks.
---
# Deck Helper
Version two.`, 'utf8');
        const updated = await updateManagedSkill(workspaceRoot, 'deck-helper', sourceRoot);
        assert.deepEqual(updated, { ok: false, reason: 'write_failed' });
        assert.equal(await readFile(externalBaseline, 'utf8'), 'outside baseline');
        const baselineStat = await lstat(baselinePath);
        assert.equal(baselineStat.isSymbolicLink(), true);
        assert.match(await readFile(join(workspaceRoot, 'skills', 'deck-helper', 'SKILL.md'), 'utf8'), /Version one\./);
        const skills = await listInstalledSkills(workspaceRoot, { managedSourceRoot: sourceRoot });
        assert.equal(skills.find((skill) => skill.id === 'deck-helper')?.managedUpdateStatus, 'update_available');
      } finally {
        await rm(sourceRoot, { recursive: true, force: true });
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  it('does not write managed skill updates through symlinked SKILL files', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const sourceRoot = await mkdtemp(join(tmpdir(), 'maka-managed-source-cache-'));
      const outside = await mkdtemp(join(tmpdir(), 'maka-managed-skill-outside-'));
      try {
        const incomingDir = join(workspaceRoot, 'incoming', 'deck-helper');
        await mkdir(incomingDir, { recursive: true });
        const incomingFile = join(incomingDir, 'SKILL.md');
        await writeFile(incomingFile, `---
name: Deck Helper
description: Build decks.
---
# Deck Helper
Version one.`, 'utf8');
        const imported = await importManagedSkillSource({ root: sourceRoot, sourceFile: incomingFile });
        assert.equal(imported.ok, true);
        if (!imported.ok) return;
        const installed = await installManagedSkill(workspaceRoot, imported.source.id, sourceRoot);
        assert.equal(installed.ok, true);

        const externalSkillContent = `---
name: Deck Helper
description: Build decks.
---
# Deck Helper
Version one.`;
        const externalSkill = join(outside, 'SKILL.md');
        await writeFile(externalSkill, externalSkillContent, 'utf8');
        const skillPath = join(workspaceRoot, 'skills', 'deck-helper', 'SKILL.md');
        await rm(skillPath);
        await symlink(externalSkill, skillPath);
        await writeFile(join(sourceRoot, 'deck-helper', 'SKILL.md'), `---
name: Deck Helper
description: Build decks.
---
# Deck Helper
Version two.`, 'utf8');

        assert.deepEqual(await updateManagedSkill(workspaceRoot, 'deck-helper', sourceRoot), {
          ok: false,
          reason: 'blocked_path',
        });
        const preview = await previewManagedSkillUpdate(workspaceRoot, 'deck-helper', sourceRoot);
        assert.deepEqual(preview, { ok: false, reason: 'blocked_path' });
        assert.equal(await readFile(externalSkill, 'utf8'), externalSkillContent);
      } finally {
        await rm(sourceRoot, { recursive: true, force: true });
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  it('does not read managed skill baselines through symlinked metadata directories', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const sourceRoot = await mkdtemp(join(tmpdir(), 'maka-managed-source-cache-'));
      const outside = await mkdtemp(join(tmpdir(), 'maka-managed-baseline-parent-outside-'));
      try {
        const incomingDir = join(workspaceRoot, 'incoming', 'deck-helper');
        await mkdir(incomingDir, { recursive: true });
        const incomingFile = join(incomingDir, 'SKILL.md');
        await writeFile(incomingFile, `---
name: Deck Helper
description: Build decks.
---
# Deck Helper
Version one.`, 'utf8');
        const imported = await importManagedSkillSource({ root: sourceRoot, sourceFile: incomingFile });
        assert.equal(imported.ok, true);
        if (!imported.ok) return;
        const installed = await installManagedSkill(workspaceRoot, imported.source.id, sourceRoot);
        assert.equal(installed.ok, true);

        await mkdir(join(outside, 'baseline'), { recursive: true });
        await writeFile(join(outside, 'baseline', 'SKILL.md'), 'outside baseline', 'utf8');
        const metadataDir = join(workspaceRoot, 'skills', 'deck-helper', '.maka');
        await rm(metadataDir, { recursive: true, force: true });
        await symlink(outside, metadataDir);

        await writeFile(join(sourceRoot, 'deck-helper', 'SKILL.md'), `---
name: Deck Helper
description: Build decks.
---
# Deck Helper
Version two.`, 'utf8');
        const preview = await previewManagedSkillUpdate(workspaceRoot, 'deck-helper', sourceRoot);
        assert.equal(preview.ok, true);
        if (!preview.ok) return;
        assert.equal(preview.preview.baselineContent, undefined);
        assert.deepEqual(await updateManagedSkill(workspaceRoot, 'deck-helper', sourceRoot), {
          ok: false,
          reason: 'write_failed',
        });
        assert.equal(await readFile(join(outside, 'baseline', 'SKILL.md'), 'utf8'), 'outside baseline');
      } finally {
        await rm(sourceRoot, { recursive: true, force: true });
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  it('rejects a symlinked skills directory instead of writing through it', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const outside = await mkdtemp(join(tmpdir(), 'maka-skills-outside-'));
      try {
        await mkdir(join(outside, 'external'), { recursive: true });
        await writeFile(join(outside, 'external', 'SKILL.md'), `---
name: External
description: Exercise a symlinked skills directory.
---
# External`, 'utf8');
        await symlink(outside, join(workspaceRoot, 'skills'));
        assert.deepEqual(await createStarterSkill(workspaceRoot), { ok: false, reason: 'blocked_path' });
        assert.deepEqual(await ensureBundledOfficeSkills(workspaceRoot), {
          created: [],
          updated: [],
          skipped: [],
          failed: ['officecli-docx', 'officecli-xlsx', 'officecli-pptx'],
        });
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
description: Exercise workspace-contained open paths.
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
    const ui = await readFile(join(repoRoot, 'packages/ui/src/skills-panel.tsx'), 'utf8');
    const renderer = await readRendererShellCombinedSource();
    const preload = await readFile(join(repoRoot, 'apps/desktop/src/preload/preload.ts'), 'utf8');
    const main = await readMainProcessCombinedSource();

    assert.match(ui, /onRefreshSkills\?\(\): void \| Promise<void>/);
    assert.match(ui, /onCreateSkillTemplate\?\(\): void \| Promise<void>/);
    assert.match(ui, /onOpenSkillsFolder\?\(\): void \| Promise<void>/);
    assert.match(ui, /'创建示例技能'/);
    assert.match(ui, /'刷新技能'/);
    assert.match(ui, /'创建中…'/);
    assert.match(ui, /'刷新中…'/);
    assert.match(ui, />\s*打开目录\s*</);
    // The inert 技能示例 example cards were removed — 添加 seeds a real,
    // editable starter skill instead. No decorative example rows may return.
    assert.doesNotMatch(ui, /title: '文档处理流'/);
    assert.doesNotMatch(ui, /title: '演示资料流'/);
    assert.doesNotMatch(ui, /SKILL_EXAMPLE_CARDS/);
    assert.doesNotMatch(ui, /重启 Maka 后会出现在这里/);
    assert.match(renderer, /async function refreshSkills\(options: \{ shouldShowError\?: \(\) => boolean \} = \{\}\)/);
    assert.match(renderer, /async function createSkillTemplate\(\)/);
    assert.match(renderer, /onRefreshSkills=\{\(\) => refreshSkills\(\)\}/);
    assert.match(renderer, /onCreateSkillTemplate=\{\(\) => createSkillTemplate\(\)\}/);
    assert.match(renderer, /onOpenSkill=\{\(skillId\) => openSkill\(skillId\)\}/);
    assert.match(renderer, /onOpenSkillsFolder=\{\(\) => openSkillsFolder\(\)\}/);
    assert.match(renderer, /onPreviewManagedSkillUpdate=\{\(skillId\) => previewManagedSkillUpdate\(skillId\)\}/);
    assert.match(renderer, /onUpdateManagedSkill=\{\(skillId, options\) => updateManagedSkill\(skillId, options\)\}/);
    assert.match(renderer, /onSetSkillEnabled=\{\(skillId, enabled\) => setSkillEnabled\(skillId, enabled\)\}/);
    assert.match(renderer, /onDeleteSkill=\{\(skillId\) => deleteSkill\(skillId\)\}/);
    assert.match(preload, /createStarter\(\)/);
    assert.match(preload, /delete\(id: string\)/);
    assert.match(preload, /open\(id: string, target: 'file' \| 'directory' = 'file'\)/);
    assert.match(preload, /previewUpdate\(skillId: string\)/);
    assert.match(preload, /updateManaged\(skillId: string, options\?: \{ force\?: boolean; expectedCurrentSha256\?: string; expectedSourceSha256\?: string \}\)/);
    assert.match(preload, /setEnabled\(skillId: string, enabled: boolean\)/);
    assert.match(main, /ipcMain\.handle\('skills:createStarter'/);
    assert.match(main, /ipcMain\.handle\('skills:delete'/);
    assert.match(main, /ipcMain\.handle\('skills:open'/);
    assert.match(main, /ipcMain\.handle\('skills:details'/);
    assert.match(main, /ipcMain\.handle\('skills:previewUpdate'/);
    assert.match(main, /ipcMain\.handle\('skills:setEnabled'/);
  });

  it('gates Skills module actions while async work is pending', async () => {
    const repoRoot = process.cwd().endsWith('apps/desktop')
      ? join(process.cwd(), '..', '..')
      : process.cwd();
    const modulePagesSource = await readFile(join(repoRoot, 'packages/ui/src/module-pages.tsx'), 'utf8');
    const ui = await readFile(join(repoRoot, 'packages/ui/src/skills-panel.tsx'), 'utf8');
    const modulePanelTypes = await readFile(join(repoRoot, 'packages/ui/src/module-panel-types.ts'), 'utf8');
    const workspaceResourcesIpc = await readFile(join(repoRoot, 'apps/desktop/src/main/workspace-resources-ipc-main.ts'), 'utf8');
    const emptyStateSource = await readFile(join(repoRoot, 'packages/ui/src/empty-state.tsx'), 'utf8');
    const renderer = await readRendererShellCombinedSource();
    const skillsModuleMain = extractFunctionBlock(ui, 'SkillsModuleMain');
    const skillPanel = ui.match(/function SkillLibraryPanel[\s\S]*?function SkillsModuleMain/)?.[0] ?? '';
    const skillEntryContract = modulePanelTypes.match(/export interface SkillEntry[\s\S]*?\n}/)?.[0] ?? '';
    const emptyState = emptyStateSource;

    assert.match(modulePagesSource, /export function SkillsPage[\s\S]*<SkillsModuleMain/, 'SkillsPage must mount the skills main surface');
    assert.match(skillsModuleMain, /const \[pendingSkillAction, setPendingSkillAction\] = useState<string \| null>\(null\)/);
    assert.match(skillsModuleMain, /const skillActionMountedRef = useMountedRef\(\)/);
    assert.match(skillsModuleMain, /const pendingSkillActionRef = useRef<string \| null>\(null\)/);
    assert.match(
      skillsModuleMain,
      /useEffect\(\(\) => \{\s*return \(\) => \{\s*pendingSkillActionRef\.current = null;\s*\};\s*\}, \[\]\)/,
      'Skills actions must release pending ownership when the module unmounts',
    );
    assert.match(skillsModuleMain, /async function runSkillAction<Result>\(/);
    assert.match(skillsModuleMain, /if \(!action \|\| pendingSkillActionRef\.current !== null\) return undefined;/, 'Skills actions must reject duplicate clicks immediately');
    assert.match(skillsModuleMain, /pendingSkillActionRef\.current = actionKey[\s\S]*setPendingSkillAction\(actionKey\)[\s\S]*return await action\(\)/, 'Skills actions must show pending state while waiting for renderer IPC and preserve action results');
    assert.match(skillsModuleMain, /pendingSkillActionRef\.current = null[\s\S]*if \(skillActionMountedRef\.current\) setPendingSkillAction\(null\)/, 'Skills actions must not clear pending UI state after unmount');
    assert.match(skillsModuleMain, /className="maka-module-main-actions" role="group" aria-label="技能操作"/);
    assert.match(skillsModuleMain, /disabled=\{!props\.onOpenSkillsFolder \|\| skillActionBusy\}/, 'open folder button must be disabled while any Skills action is pending');
    assert.match(skillsModuleMain, /disabled=\{!props\.onRefreshSkills \|\| skillActionBusy\}/, 'top refresh button must be disabled while any Skills action is pending');
    assert.match(skillsModuleMain, /pendingSkillAction === 'refresh' \? '刷新中…' : '刷新'/);
    assert.match(skillsModuleMain, /pendingSkillAction === 'create' \? '创建中…' : '创建示例'/);
    assert.match(skillsModuleMain, /onClick=\{\(\) => void runSkillAction\('folder', props\.onOpenSkillsFolder\)\}/);
    assert.match(skillsModuleMain, /onCreateSkillTemplate=\{props\.onCreateSkillTemplate \? \(\) => runSkillAction\('create', props\.onCreateSkillTemplate\) : undefined\}/);
    assert.match(skillsModuleMain, /onOpenSkill=\{props\.onOpenSkill \? \(skillId\) => runSkillAction\(`open:\$\{skillId\}`, \(\) => props\.onOpenSkill\?\.\(skillId\)\) : undefined\}/);
    assert.match(skillsModuleMain, /onDeleteSkill=\{props\.onDeleteSkill \? \(skillId\) => runSkillAction\(`delete:\$\{skillId\}`, \(\) => props\.onDeleteSkill\?\.\(skillId\)\) : undefined\}/);

    assert.match(skillPanel, /actionBusy\?: boolean/);
    assert.match(skillPanel, /createPending\?: boolean/);
    assert.match(skillPanel, /openingSkillId\?: string \| null/);
    assert.match(skillPanel, /managedSkillSources\?: ManagedSkillSourceEntry\[]/);
    assert.match(skillPanel, /installingSourceId\?: string \| null/);
    assert.match(skillPanel, /updatingSkillId\?: string \| null/);
    assert.doesNotMatch(skillPanel, /maka-skill-workbench-rail/);
    assert.doesNotMatch(skillPanel, /maka-skill-workbench-summary/);
    // 技能示例 removed: no inert example section/grid/rows may render under the
    // installed list. 添加 seeds a real starter skill; there are no decorations.
    assert.doesNotMatch(skillPanel, /const templates = \(/);
    assert.doesNotMatch(skillPanel, /maka-skill-examples/);
    assert.doesNotMatch(skillPanel, /maka-skill-example-grid/);
    assert.doesNotMatch(skillPanel, /maka-skill-template-row/);
    assert.match(skillPanel, /<section className="maka-skill-installed" aria-label={label}>/);
    assert.match(skillPanel, /<div className="maka-skill-library" aria-busy=\{props\.actionBusy \? 'true' : undefined\}>/);
    assert.match(skillPanel, /<ul className="maka-skill-library-list" aria-label="技能列表">/);
    assert.match(skillPanel, /<span className="maka-skill-library-status" aria-hidden="true">/);
    assert.match(skillPanel, /const statusLabel = formatSkillStatusLabel\(skill\)/);
    assert.match(skillPanel, /const runtimeLabel = formatSkillRuntimeLabel\(skill\)/);
    assert.match(skillPanel, /来源状态：\$\{statusLabel\}/);
    assert.match(skillPanel, /运行状态：\$\{runtimeLabel\}/);
    // Detail round 6, exception-only: the runtime chip renders ONLY for
    // state_error — enabled/disabled is already expressed by the Switch.
    // Round 1 convergence (#520 follow-up): the two status labels now render
    // the squared Chip primitive (was a hand-rolled span). data-status is
    // preserved for tone derivation; the render condition is unchanged.
    assert.match(skillPanel, /\{skill\.runtimeStatus === 'state_error' && \([\s\S]*?<Chip[\s\S]*?className="maka-skill-library-runtime-label"[\s\S]*>\{runtimeLabel\}<\/Chip>/);
    assert.match(skillPanel, /<Chip[\s\S]*?className="maka-skill-library-status-label"[\s\S]*>\{statusLabel\}<\/Chip>/);
    assert.match(skillPanel, /function skillStatusChipTone\(skill: SkillEntry\)/, 'status-label tone derives from data-status via skillStatusChipTone');
    assert.match(ui, /function formatSkillStatusLabel\(skill: SkillEntry\): string/);
    assert.match(ui, /function formatSkillRuntimeLabel\(skill: SkillEntry\): string/);
    assert.match(ui, /runtimeStatus === 'state_error'[\s\S]*状态异常/);
    assert.match(ui, /skill\.enabled \? '已启用' : '已停用'/);
    assert.match(ui, /metadata_error[\s\S]*元数据异常/);
    assert.match(ui, /userModified[\s\S]*已修改/);
    assert.match(ui, /sourceType === 'bundled'[\s\S]*内置/);
    assert.match(ui, /sourceType === 'managed'[\s\S]*managedUpdateStatus[\s\S]*受管理/, 'Phase 2 can present verified managed state derived by main');
    assert.match(ui, /return '本地'/);
    assert.match(skillEntryContract, /sourceType\?: 'workspace' \| 'bundled' \| 'managed' \| 'unknown'/);
    assert.match(skillEntryContract, /managedUpdateStatus\?:/);
    assert.match(skillEntryContract, /enabled: boolean/);
    assert.match(skillEntryContract, /runtimeStatus: 'enabled' \| 'disabled' \| 'state_error'/);
    assert.doesNotMatch(skillEntryContract, /sourceName|sourceVersion|contentSha256|installedAt|validationCodes|validationMessages|write_failed/, 'renderer SkillEntry must not expose lock internals');
    assert.match(workspaceResourcesIpc, /toSkillEntry/, 'Skills IPC must scrub main-internal lock fields before crossing to renderer');
    assert.doesNotMatch(workspaceResourcesIpc, /ipcMain\.handle\('skills:list'[\s\S]*listInstalledSkills\(deps\.workspaceRoot\)/, 'Skills list IPC must not return InstalledSkill objects directly');
    // Marketplace redesign: managed sources ARE the 市场 tab now — the
    // separate 来源库 list under 已安装 was folded into a card grid. The
    // source cache is still surfaced (never runtime), just as a browse
    // grid keyed off props.managedSkillSources.
    assert.match(skillPanel, /const market = \(/, 'Phase 2 must surface the managed source cache without making it runtime');
    assert.match(skillPanel, /<section className="maka-skill-market" aria-label="技能市场">/);
    assert.match(skillPanel, /<div className="maka-skill-market-grid">/, '市场 tab renders managed sources as a card grid');
    assert.match(skillPanel, /const marketSources = useMemo\(/, '市场 grid is a pure client-side filter/sort over managedSkillSources');
    assert.match(skillPanel, /官方精选/, '市场 grid carries the 官方精选 section label');
    assert.match(skillPanel, /variant="secondary"\s+size="icon-sm"[\s\S]*aria-label=\{`安装 \$\{source\.name\}`\}/, 'only the governed install icon-button acts; the market card body stays inert');
    assert.match(skillPanel, /导入本地 Skill/);
    assert.doesNotMatch(skillPanel, /const managedSources = \(/, '来源库 list was replaced by the 市场 card grid');
    assert.match(skillPanel, /onInstallManagedSkill\?\(sourceId: string\): void \| Promise<void>/);
    assert.match(skillPanel, /onPreviewManagedSkillUpdate\?\(skillId: string\): Promise<ManagedSkillUpdatePreview \| null>/);
    assert.match(skillPanel, /onUpdateManagedSkill\?\(skillId: string, options\?: \{ force\?: boolean; expectedCurrentSha256\?: string; expectedSourceSha256\?: string \}\): boolean \| Promise<boolean>/);
    assert.match(skillPanel, /onSetSkillEnabled\?\(skillId: string, enabled: boolean\): void \| Promise<void>/);
    assert.match(skillPanel, /<Switch[\s\S]*checked=\{skill\.enabled\}[\s\S]*onCheckedChange=\{\(next\) => props\.onSetSkillEnabled\?\.\(skill\.id, next === true\)\}/);
    // Per-row delete: destructive two-step confirm (no dialog precedent here).
    // First click arms 确认删除; a second within the window fires onDeleteSkill.
    // aria-label names the skill and reflects the armed state (keyboard-safe).
    assert.match(skillPanel, /onDeleteSkill\?\(skillId: string\): void \| Promise<void>/);
    assert.match(skillPanel, /className="maka-skill-library-delete-button"/);
    assert.match(skillPanel, /function requestDeleteSkill\(skill: SkillEntry\)/);
    assert.match(skillPanel, /setConfirmingDeleteSkillId\(skill\.id\)[\s\S]*setTimeout\([\s\S]*setConfirmingDeleteSkillId\(null\)/, 'armed delete state must auto-revert so a stray first click cannot linger');
    assert.match(skillPanel, /void props\.onDeleteSkill\(skill\.id\)/);
    assert.match(skillPanel, /aria-label=\{confirmingDelete \? `确认删除 \$\{skill\.name\}` : `删除 \$\{skill\.name\}`\}/);
    assert.match(skillPanel, /confirmingDelete \? '确认删除' : '删除'/);
    assert.match(skillPanel, /<div[\s\S]*className="maka-skill-library-row"[\s\S]*<\/div>/, 'Skill row body must be information, not the open-file control');
    assert.match(skillPanel, /className="maka-skill-library-open-button"[\s\S]*aria-label=\{`打开 \$\{skill\.name\} 的 SKILL\.md`\}/);
    assert.match(skillPanel, /<\/UiButton>\s*<Switch/, 'per-skill enable switch must sit next to the explicit open-file icon button');
    assert.match(skillPanel, /const updated = await props\.onUpdateManagedSkill\(preview\.skill\.id/);
    assert.match(skillPanel, /expectedCurrentSha256: preview\.expectedCurrentSha256/);
    assert.match(skillPanel, /expectedSourceSha256: preview\.expectedSourceSha256/);
    assert.match(skillPanel, /if \(updated\) setUpdatePreview\(null\)/);
    assert.match(skillPanel, /skill\.managedUpdateStatus === 'update_available'/);
    assert.match(skillPanel, /skill\.managedUpdateStatus === 'local_modified'/);
    assert.match(skillPanel, /查看更新/);
    assert.match(skillPanel, /查看差异/);
    assert.match(skillPanel, /覆盖本地修改/);
    assert.doesNotMatch(skillPanel, /恢复|修复|合并/, 'Phase 3 still must not imply automatic merge or repair flows');
    assert.doesNotMatch(skillPanel, /const SKILL_GOVERNANCE_FILTERS/);
    assert.doesNotMatch(skillPanel, /aria-label="技能状态筛选"/);
    assert.match(skillPanel, /className="maka-skill-library-status-label"/);
    assert.match(skillPanel, /function previewText\(content: string\): string/);
    assert.doesNotMatch(skillPanel, /maka-skill-library-action/, 'Open must be an explicit file icon button, not a status-like text pill');
    assert.match(skillPanel, /label: props\.createPending \? '创建中…' : '创建示例技能'/);
    assert.match(skillPanel, /label: props\.refreshPending \? '刷新中…' : '刷新技能'/);
    assert.match(skillPanel, /disabled: props\.actionBusy/);
    assert.match(skillPanel, /aria-busy=\{props\.actionBusy \? 'true' : undefined\}/);
    assert.match(skillPanel, /disabled=\{props\.actionBusy \|\| !props\.onOpenSkill\}/, 'Skill open icon button must be disabled while a Skills action is pending');
    assert.match(skillPanel, /opening && <span>打开中…<\/span>/);
    assert.match(skillPanel, /updating && <span>更新中…<\/span>/);
    assert.match(emptyState, /disabled\?: boolean/);
    assert.match(emptyState, /disabled=\{props\.cta\.disabled\}/);
    assert.match(emptyState, /disabled=\{props\.secondaryCta\.disabled\}/);

    assert.doesNotMatch(renderer, /onRefreshSkills=\{\(\) => void refreshSkills\(\)\}/, 'renderer must return the refresh promise to the UI pending gate');
    assert.doesNotMatch(renderer, /onCreateSkillTemplate=\{\(\) => void createSkillTemplate\(\)\}/, 'renderer must return the create promise to the UI pending gate');
    assert.doesNotMatch(renderer, /onOpenSkill=\{\(skillId\) => void openSkill\(skillId\)\}/, 'renderer must return the open promise to the UI pending gate');
  });

  it('scopes Skills action feedback to the active Skills surface', async () => {
    const repoRoot = process.cwd().endsWith('apps/desktop')
      ? join(process.cwd(), '..', '..')
      : process.cwd();
    const renderer = await readRendererShellCombinedSource();
    const refreshBlock = renderer.match(/async function refreshSkills\([\s\S]*?\n  \}/)?.[0] ?? '';
    const createBlock = renderer.match(/async function createSkillTemplate\(\)[\s\S]*?async function openSkillsFolder/)?.[0] ?? '';
    const openBlock = renderer.match(/async function openSkill\(skillId: string\)[\s\S]*?\n  \}/)?.[0] ?? '';

    assert.match(
      renderer,
      /function isSkillsSurfaceActive\(\): boolean \{[\s\S]*return navSelectionRef\.current\.section === 'skills';[\s\S]*\}/,
      'Skills feedback must be owned by the current Skills surface',
    );
    assert.match(
      refreshBlock,
      /if \(options\.shouldShowError\?\.\(\) \?\? true\) \{[\s\S]*toastApi\.error\('刷新技能失败', generalizedErrorMessageChinese\(error, '刷新技能失败，请稍后重试。'\)\);[\s\S]*\}/,
      'startup/subscription Skills refresh failures must remain visible by default',
    );
    assert.match(
      createBlock,
      /await refreshSkills\(\{ shouldShowError: isSkillsSurfaceActive \}\)/,
      'create must still refresh the Skills list while gating refresh failure feedback to the active Skills surface',
    );
    assert.match(createBlock, /if \(!isSkillsSurfaceActive\(\)\) return;/, 'create must not auto-open a starter Skill after the user leaves Skills');
    assert.doesNotMatch(createBlock, /await refreshSkills\(\);\s*toastApi\.success/, 'create success feedback must not be unconditional after refresh');
    assert.match(createBlock, /if \(isSkillsSurfaceActive\(\)\) toastApi\.error\('无法创建示例技能'/);
    assert.match(createBlock, /if \(isSkillsSurfaceActive\(\)\) toastApi\.error\('无法打开示例技能'/);
    // Idempotent seeding: created:false reuses the existing 示例技能 and says so
    // rather than claiming a fresh create; created:true keeps the create copy.
    assert.match(createBlock, /if \(result\.created\) \{[\s\S]*'已创建示例技能'[\s\S]*\} else \{[\s\S]*'已打开现有示例技能', '示例技能已存在，直接打开了 SKILL\.md（不会重复创建）。'/);
    assert.match(openBlock, /if \(isSkillsSurfaceActive\(\)\) toastApi\.error\('无法打开 Skill'/);
    assert.doesNotMatch(openBlock, /if \(!result\.ok\) \{\s*toastApi\.error\('无法打开 Skill'/, 'open Skill structured failures must not toast unconditionally after leaving Skills');
    assert.doesNotMatch(openBlock, /catch \(error\) \{\s*toastApi\.error\('无法打开 Skill'/, 'open Skill thrown failures must not toast unconditionally after leaving Skills');
  });

  it('surfaces thrown Skills IPC failures as toasts', async () => {
    const repoRoot = process.cwd().endsWith('apps/desktop')
      ? join(process.cwd(), '..', '..')
      : process.cwd();
    const renderer = await readRendererShellCombinedSource();
    const createBlock = renderer.match(/async function createSkillTemplate\(\)[\s\S]*?async function openSkillsFolder/)?.[0] ?? '';
    const folderBlock = renderer.match(/async function openSkillsFolder\(\)[\s\S]*?async function openSkill/)?.[0] ?? '';
    const openBlock = renderer.match(/async function openSkill\(skillId: string\)[\s\S]*?\n  \}/)?.[0] ?? '';

    assert.match(createBlock, /try \{[\s\S]*window\.maka\.skills\.createStarter\(\)/);
    assert.match(
      createBlock,
      /catch \(error\) \{[\s\S]*if \(isSkillsSurfaceActive\(\)\) \{[\s\S]*toastApi\.error\('无法创建示例技能', generalizedErrorMessageChinese\(error, '无法创建示例技能，请稍后重试。'\)\);[\s\S]*\}/,
    );
    assert.doesNotMatch(createBlock, /toastApi\.error\('无法创建示例技能', cleanErrorMessage\(error\)\)/);
    assert.match(folderBlock, /try \{[\s\S]*window\.maka\.app\.openPath\('skills'\)/);
    assert.match(folderBlock, /catch \(error\) \{[\s\S]*toastApi\.error\(`无法打开\$\{openPathActionLabel\('skills'\)\}`, openPathActionErrorMessage\(error, 'skills'\)\)/);
    assert.doesNotMatch(folderBlock, /cleanErrorMessage\(error\)/, 'Skills folder thrown openPath failures must not expose raw IPC/path details');
    assert.match(openBlock, /try \{[\s\S]*window\.maka\.skills\.open\(skillId, 'file'\)/);
    assert.match(
      openBlock,
      /catch \(error\) \{[\s\S]*if \(isSkillsSurfaceActive\(\)\) \{[\s\S]*toastApi\.error\('无法打开 Skill', generalizedErrorMessageChinese\(error, '无法打开 Skill，请稍后重试。'\)\);[\s\S]*\}/,
    );
    assert.doesNotMatch(openBlock, /toastApi\.error\('无法打开 Skill', cleanErrorMessage\(error\)\)/);
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

function legacyOfficeCliDocxSkillTemplate(): string {
  return [
    '---',
    'name: OfficeCLI DOCX',
    'description: Use when a .docx, Word document, report, memo, proposal, letter, tracked changes, comments, header/footer, table of contents, or Word template is involved.',
    'allowed-tools:',
    '  - Bash',
    '  - Read',
    '---',
    '',
    '# OfficeCLI DOCX',
    '',
    "Use this skill for Word document work. It is adapted from an external OfficeCLI reference DOCX skill for Maka's permission model.",
    '',
    '## Boundary',
    '',
    '- Check `officecli --version` first. If missing, tell the user Office document automation is unavailable on this machine instead of parsing .docx as plain text.',
    '- Prefer `officecli help docx` and `officecli help docx <element>` before guessing flags. Installed help is authoritative.',
    '- Quote semantic paths: `"/body/p[1]"`, `"/footer[1]"`.',
    '- Read-only inspection commands are safe: `view`, `get`, `query`, `validate`, `help`.',
    '- Mutating commands such as `create`, `open`, `add`, `set`, `remove`, `batch`, and `close` require the normal shell permission flow.',
    '',
    '## Workflow',
    '',
    '1. Orient with `officecli view "$FILE" outline`, then `view text` or `get` the needed paths.',
    '2. For edits, use resident mode: `officecli open "$FILE"`, make small incremental changes, verify each structural step with `get`, then `officecli close "$FILE"`.',
    '3. For generated documents, build hierarchy first: Title, Heading 1, Heading 2, body; then tables/images/fields; then headers/footers.',
    '4. Use explicit typography. Body 11-12pt; H1 at least 18pt; H2 around 14pt; spacing via paragraph properties, not blank paragraphs.',
    '5. Add live page-number fields for documents longer than one page. Verify fields exist with `get "$FILE" "/footer[1]" --depth 3`.',
    '6. Final QA: `officecli validate "$FILE"` and `officecli view "$FILE" html`. Fix placeholder tokens, clipped tables, empty-paragraph spacing, static page numbers, and missing TOC on heading-heavy documents before reporting done.',
    '',
  ].join('\n');
}

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

function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
