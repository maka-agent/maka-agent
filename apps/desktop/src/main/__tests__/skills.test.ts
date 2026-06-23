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
  ensureBundledOfficeSkills,
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

      const docxPath = join(workspaceRoot, 'skills', 'officecli-docx', 'SKILL.md');
      const before = await readFile(docxPath, 'utf8');
      assert.match(before, /Use `OfficeDocument` for read-only inspection/);
      assert.match(before, /Use `OfficeDocumentEdit` only for supported writes/);
      assert.doesNotMatch(before, /Check `officecli --version` first/);
      assert.doesNotMatch(before, /officecli open/);
      assert.doesNotMatch(before, /officecli close/);
      assert.doesNotMatch(before, /view "\$FILE" html/);
      assert.equal((await lstat(docxPath)).mode & 0o077, 0);

      await writeFile(docxPath, `${before}\n\n# User edit\n`, 'utf8');
      const second = await ensureBundledOfficeSkills(workspaceRoot);
      assert.deepEqual(second.created, []);
      assert.deepEqual(second.updated, []);
      assert.deepEqual(second.skipped.sort(), ['officecli-docx', 'officecli-pptx', 'officecli-xlsx']);
      assert.deepEqual(second.failed, []);
      assert.match(await readFile(docxPath, 'utf8'), /# User edit/);
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
    const ui = await readFile(join(repoRoot, 'packages/ui/src/components.tsx'), 'utf8');
    const renderer = await readFile(join(repoRoot, 'apps/desktop/src/renderer/main.tsx'), 'utf8');
    const preload = await readFile(join(repoRoot, 'apps/desktop/src/preload/preload.ts'), 'utf8');
    const main = await readFile(join(repoRoot, 'apps/desktop/src/main/main.ts'), 'utf8');

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
    const ui = await readFile(join(repoRoot, 'packages/ui/src/components.tsx'), 'utf8');
    const renderer = await readFile(join(repoRoot, 'apps/desktop/src/renderer/main.tsx'), 'utf8');
    const chatView = ui.match(/export function ChatView\([\s\S]*?if \(props\.mode === 'automations'\)/)?.[0] ?? '';
    const skillsModuleMain = ui.match(/function SkillsModuleMain\([\s\S]*?function DailyReviewPanel/)?.[0] ?? '';
    const skillPanel = ui.match(/function SkillLibraryPanel[\s\S]*?function formatSkillLibraryDescription/)?.[0] ?? '';
    const emptyState = ui.match(/export interface EmptyStateProps[\s\S]*?function SkillLibraryPanel/)?.[0] ?? '';

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
    const renderer = await readFile(join(repoRoot, 'apps/desktop/src/renderer/main.tsx'), 'utf8');
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
    const renderer = await readFile(join(repoRoot, 'apps/desktop/src/renderer/main.tsx'), 'utf8');
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
