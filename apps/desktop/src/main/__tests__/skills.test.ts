import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readMainProcessCombinedSource } from './main-process-contract-source-helpers.js';
import {
  MAX_SKILLS_PROMPT_CHARS,
  MAX_SKILL_TOOL_BODY_CHARS,
  buildSkillAgentTool,
  buildSkillsPromptFragment,
  createStarterSkill,
  ensureBundledOfficeSkills,
  loadSkillInstructions,
  listInstalledSkills,
  parseSkillFrontMatter,
  resolveSkillOpenPath,
} from '../skills.js';
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

  it('rejects a symlinked skills directory instead of writing through it', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const outside = await mkdtemp(join(tmpdir(), 'maka-skills-outside-'));
      try {
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
    assert.match(ui, /title: '文档处理流'/);
    assert.match(ui, /title: '演示资料流'/);
    assert.doesNotMatch(ui, /重启 Maka 后会出现在这里/);
    assert.match(renderer, /async function refreshSkills\(options: \{ shouldShowError\?: \(\) => boolean \} = \{\}\)/);
    assert.match(renderer, /async function createSkillTemplate\(\)/);
    assert.match(renderer, /onRefreshSkills=\{\(\) => refreshSkills\(\)\}/);
    assert.match(renderer, /onCreateSkillTemplate=\{\(\) => createSkillTemplate\(\)\}/);
    assert.match(renderer, /onOpenSkill=\{\(skillId\) => openSkill\(skillId\)\}/);
    assert.match(renderer, /onOpenSkillsFolder=\{\(\) => openSkillsFolder\(\)\}/);
    assert.match(preload, /createStarter\(\)/);
    assert.match(preload, /open\(id: string, target: 'file' \| 'directory' = 'file'\)/);
    assert.match(main, /ipcMain\.handle\('skills:createStarter'/);
    assert.match(main, /ipcMain\.handle\('skills:open'/);
  });

  it('gates Skills module actions while async work is pending', async () => {
    const repoRoot = process.cwd().endsWith('apps/desktop')
      ? join(process.cwd(), '..', '..')
      : process.cwd();
    const chatViewSource = await readFile(join(repoRoot, 'packages/ui/src/chat-view.tsx'), 'utf8');
    const ui = await readFile(join(repoRoot, 'packages/ui/src/skills-panel.tsx'), 'utf8');
    const modulePanelTypes = await readFile(join(repoRoot, 'packages/ui/src/module-panel-types.ts'), 'utf8');
    const workspaceResourcesIpc = await readFile(join(repoRoot, 'apps/desktop/src/main/workspace-resources-ipc-main.ts'), 'utf8');
    const emptyStateSource = await readFile(join(repoRoot, 'packages/ui/src/empty-state.tsx'), 'utf8');
    const renderer = await readRendererShellCombinedSource();
    const chatView = chatViewSource.match(/export function ChatView\([\s\S]*?if \(props\.mode === 'automations'\)/)?.[0] ?? '';
    const skillsModuleMain = extractFunctionBlock(ui, 'SkillsModuleMain');
    const skillPanel = ui.match(/function SkillLibraryPanel[\s\S]*?function SkillsModuleMain/)?.[0] ?? '';
    const skillEntryContract = modulePanelTypes.match(/export interface SkillEntry[\s\S]*?\n}/)?.[0] ?? '';
    const emptyState = emptyStateSource;

    assert.match(chatView, /if \(props\.mode === 'skills'\) \{[\s\S]*<SkillsModuleMain/, 'Skills mode must mount its own main surface component');
    assert.match(skillsModuleMain, /const \[pendingSkillAction, setPendingSkillAction\] = useState<string \| null>\(null\)/);
    assert.match(skillsModuleMain, /const skillActionMountedRef = useRef\(true\)/);
    assert.match(skillsModuleMain, /const pendingSkillActionRef = useRef<string \| null>\(null\)/);
    assert.match(
      skillsModuleMain,
      /useEffect\(\(\) => \{\s*skillActionMountedRef\.current = true;[\s\S]*?return \(\) => \{\s*skillActionMountedRef\.current = false;\s*pendingSkillActionRef\.current = null;\s*\};\s*\}, \[\]\)/,
      'Skills actions must release pending ownership when the module unmounts',
    );
    assert.match(skillsModuleMain, /async function runSkillAction\(/);
    assert.match(skillsModuleMain, /if \(!action \|\| pendingSkillActionRef\.current !== null\) return;/, 'Skills actions must reject duplicate clicks immediately');
    assert.match(skillsModuleMain, /pendingSkillActionRef\.current = actionKey[\s\S]*setPendingSkillAction\(actionKey\)[\s\S]*await action\(\)/, 'Skills actions must show pending state while waiting for renderer IPC');
    assert.match(skillsModuleMain, /pendingSkillActionRef\.current = null[\s\S]*if \(skillActionMountedRef\.current\) setPendingSkillAction\(null\)/, 'Skills actions must not clear pending UI state after unmount');
    assert.match(skillsModuleMain, /className="maka-module-main-actions" role="group" aria-label="技能操作"/);
    assert.match(skillsModuleMain, /disabled=\{!props\.onOpenSkillsFolder \|\| skillActionBusy\}/, 'open folder button must be disabled while any Skills action is pending');
    assert.match(skillsModuleMain, /disabled=\{!props\.onRefreshSkills \|\| skillActionBusy\}/, 'top refresh button must be disabled while any Skills action is pending');
    assert.match(skillsModuleMain, /pendingSkillAction === 'refresh' \? '刷新中…' : '刷新'/);
    assert.match(skillsModuleMain, /pendingSkillAction === 'create' \? '创建中…' : '创建示例'/);
    assert.match(skillsModuleMain, /onClick=\{\(\) => void runSkillAction\('folder', props\.onOpenSkillsFolder\)\}/);
    assert.match(skillsModuleMain, /onCreateSkillTemplate=\{props\.onCreateSkillTemplate \? \(\) => runSkillAction\('create', props\.onCreateSkillTemplate\) : undefined\}/);
    assert.match(skillsModuleMain, /onOpenSkill=\{props\.onOpenSkill \? \(skillId\) => runSkillAction\(`open:\$\{skillId\}`, \(\) => props\.onOpenSkill\?\.\(skillId\)\) : undefined\}/);

    assert.match(skillPanel, /actionBusy\?: boolean/);
    assert.match(skillPanel, /createPending\?: boolean/);
    assert.match(skillPanel, /openingSkillId\?: string \| null/);
    assert.match(skillPanel, /const templates = \(/);
    assert.doesNotMatch(skillPanel, /maka-skill-workbench-rail/);
    assert.doesNotMatch(skillPanel, /maka-skill-workbench-summary/);
    assert.match(skillPanel, /<section className="maka-skill-examples" aria-label="技能示例">/);
    assert.match(skillPanel, /<ul className="maka-skill-example-grid" aria-label="技能模板示例">/);
    assert.match(skillPanel, /className="maka-skill-template-row"/);
    assert.match(skillPanel, /<section className="maka-skill-installed" aria-label="已安装技能">/);
    assert.match(skillPanel, /<div className="maka-skill-library" aria-busy=\{props\.actionBusy \? 'true' : undefined\}>/);
    assert.match(skillPanel, /<ul className="maka-skill-library-list" aria-label="技能列表">/);
    assert.match(skillPanel, /<span className="maka-skill-library-status" aria-hidden="true">/);
    assert.match(skillPanel, /const statusLabel = formatSkillStatusLabel\(skill\)/);
    assert.match(skillPanel, /来源状态：\$\{statusLabel\}/);
    assert.match(skillPanel, /<span>\{statusLabel\}<\/span>/);
    assert.match(ui, /function formatSkillStatusLabel\(skill: SkillEntry\): string/);
    assert.match(ui, /metadata_error[\s\S]*元数据异常/);
    assert.match(ui, /userModified[\s\S]*已修改/);
    assert.match(ui, /sourceType === 'bundled'[\s\S]*内置/);
    assert.doesNotMatch(ui, /sourceType === 'managed'[\s\S]*受管理/, 'Phase 1 must not present forged managed locks as trusted');
    assert.match(ui, /return '本地'/);
    assert.match(skillEntryContract, /sourceType\?: 'workspace' \| 'bundled' \| 'unknown'/);
    assert.doesNotMatch(skillEntryContract, /managed|sourceName|sourceVersion|contentSha256|installedAt|validationCodes|validationMessages|write_failed/, 'renderer SkillEntry must not expose Phase 1 lock internals');
    assert.match(workspaceResourcesIpc, /toSkillEntry/, 'Skills IPC must scrub main-internal lock fields before crossing to renderer');
    assert.doesNotMatch(workspaceResourcesIpc, /ipcMain\.handle\('skills:list'[\s\S]*listInstalledSkills\(deps\.workspaceRoot\)/, 'Skills list IPC must not return InstalledSkill objects directly');
    assert.doesNotMatch(skillPanel, /更新|恢复|修复|合并/, 'Phase 1 Skills status UI must stay informational only');
    assert.match(skillPanel, /<span className="maka-skill-library-action" aria-hidden="true">[\s\S]*打开[\s\S]*<\/span>/);
    assert.match(skillPanel, /label: props\.createPending \? '创建中…' : '创建示例技能'/);
    assert.match(skillPanel, /label: props\.refreshPending \? '刷新中…' : '刷新技能'/);
    assert.match(skillPanel, /disabled: props\.actionBusy/);
    assert.match(skillPanel, /aria-busy=\{props\.actionBusy \? 'true' : undefined\}/);
    assert.match(skillPanel, /disabled=\{props\.actionBusy\}/, 'Skill row open buttons must be disabled while a Skills action is pending');
    assert.match(skillPanel, /opening && <span>打开中…<\/span>/);
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
