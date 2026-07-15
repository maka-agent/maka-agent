import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  MAX_SKILLS_PROMPT_TOKENS,
  MAX_SKILLS_PROMPT_CHARS,
  MIN_SKILLS_PROMPT_TOKENS,
  MAX_SKILL_TOOL_BODY_CHARS,
  buildSkillAgentTool,
  buildSkillsPromptFragment,
  gateSkillsByHostCapabilities,
  loadSkillInstructions,
  parseSkillFrontMatter,
  readSkillRuntimeState,
  resolveSkillsPromptCharBudget,
  resolveSkillDiscoveryPaths,
  scanSkills,
  scanSkillsWithDiagnostics,
  scanWorkspaceSkills,
  validateSkillMetadata,
  writeSkillRuntimeState,
  type HostCapabilities,
  type ScannedSkill,
} from '../skills.js';
import type { MakaToolContext } from '../tool-runtime.js';

describe('runtime skills', () => {
  it('validates typed SKILL.md metadata and accepts spec and Maka list forms', () => {
    const result = validateSkillMetadata(`---
name: writer
description: Draft polished prose when the user asks for writing help.
license: Apache-2.0
compatibility: Requires a local workspace.
metadata:
  author: maka
allowed-tools: Read Bash(git:*)
required-tools: [Write]
required-capabilities:
  - workspace
---
# Writer
Use concise prose.`);

    assert.equal(result.valid, true);
    assert.deepEqual(result.issues, []);
    assert.deepEqual(result.manifest, {
      name: 'writer',
      description: 'Draft polished prose when the user asks for writing help.',
      allowedTools: ['Read', 'Bash(git:*)'],
      requiredTools: ['Write'],
      requiredCapabilities: ['workspace'],
      license: 'Apache-2.0',
      compatibility: 'Requires a local workspace.',
      metadata: { author: 'maka' },
      category: undefined,
    });
    assert.equal(result.body, '# Writer\nUse concise prose.');
  });

  it('reports malformed and missing required metadata as structured errors', () => {
    const missingFrontmatter = validateSkillMetadata('# No metadata');
    assert.equal(missingFrontmatter.valid, false);
    assert.deepEqual(missingFrontmatter.issues.map((issue) => issue.code), ['missing_frontmatter']);

    const malformed = validateSkillMetadata(`---
name: [broken
description: invalid collection syntax
---
body`);
    assert.equal(malformed.valid, false);
    assert.deepEqual(malformed.issues.map((issue) => issue.code), ['malformed_frontmatter']);

    const missingRequired = validateSkillMetadata(`---
name: ''
required-tools:
  nested: invalid
required-capabilities: [workspace, 7]
---
body`);
    assert.equal(missingRequired.valid, false);
    assert.deepEqual(
      missingRequired.issues.map((issue) => issue.code),
      ['missing_name', 'missing_description', 'invalid_required_tools', 'invalid_required_capabilities'],
    );
  });

  it('recovers legacy scalar colons and tab-indented lists with an explicit warning', () => {
    const result = validateSkillMetadata(`---
name: Legacy Writer
description: Use when: the user asks for writing help.
allowed-tools: Read, Write
required-tools:
\t- Bash
---
# Legacy Writer`);

    assert.equal(result.valid, true);
    assert.equal(result.manifest.description, 'Use when: the user asks for writing help.');
    assert.deepEqual(result.manifest.allowedTools, ['Read', 'Write']);
    assert.deepEqual(result.manifest.requiredTools, ['Bash']);
    assert.deepEqual(result.issues.map((issue) => ({
      code: issue.code,
      severity: issue.severity,
    })), [{ code: 'malformed_frontmatter', severity: 'warning' }]);
  });

  it('keeps compatible skills loadable while reporting non-blocking metadata warnings', () => {
    const result = validateSkillMetadata(`---
name: ${'N'.repeat(65)}
description: ${'D'.repeat(1025)}
allowed-tools: [Read, Bad Tool, 7]
compatibility: ${'C'.repeat(501)}
metadata:
  author: maka
  revision: 3
category: 7
future-field: enabled
---
${'x'.repeat(MAX_SKILL_TOOL_BODY_CHARS + 1)}`);

    assert.equal(result.valid, true);
    assert.deepEqual(result.manifest.allowedTools, ['Read']);
    assert.deepEqual(result.manifest.metadata, { author: 'maka' });
    assert.deepEqual(
      result.issues.map((issue) => issue.code),
      [
        'unsupported_field',
        'name_too_long',
        'description_too_long',
        'invalid_allowed_tools',
        'compatibility_too_long',
        'invalid_metadata',
        'invalid_category',
        'body_too_large',
      ],
    );
    assert.ok(result.issues.every((issue) => issue.severity === 'warning'));
  });

  it('excludes invalid skills from the model catalog and preserves their diagnostics', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await writeSkill(workspaceRoot, 'valid', `---
name: Valid
description: A valid skill.
---
# Valid`);
      await writeSkill(workspaceRoot, 'missing-description', `---
name: Missing Description
---
# Missing`);
      await writeSkill(workspaceRoot, 'malformed', `---
name: Malformed
description: [invalid collection syntax
---
# Malformed`);

      const scanned = await scanSkillsWithDiagnostics(workspaceRoot);
      assert.deepEqual(scanned.skills.map((skill) => skill.id), ['valid']);
      assert.deepEqual(
        scanned.diagnostics.map((diagnostic) => ({
          id: diagnostic.id,
          codes: diagnostic.issues.map((issue) => issue.code),
        })),
        [
          { id: 'malformed', codes: ['malformed_frontmatter'] },
          { id: 'missing-description', codes: ['missing_description'] },
        ],
      );

      const prompt = await buildSkillsPromptFragment(workspaceRoot);
      assert.ok(prompt);
      assert.match(prompt, /id="valid"/);
      assert.doesNotMatch(prompt, /missing-description|malformed/);

      const missing = await loadSkillInstructions(workspaceRoot, 'missing-description');
      assert.equal(missing.ok, false);
      if (missing.ok) return;
      assert.equal(missing.reason, 'not_found');
      assert.deepEqual(missing.availableSkills.map((skill) => skill.id), ['valid']);
    });
  });

  it('reports deterministic duplicate id and display-name diagnostics', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const projectRoot = await mkdtemp(join(tmpdir(), 'maka-runtime-skill-duplicates-'));
      try {
        await mkdir(join(projectRoot, '.agents', 'skills', 'shared'), { recursive: true });
        await writeFile(join(projectRoot, '.agents', 'skills', 'shared', 'SKILL.md'), `---
name: Shared Name
description: Higher precedence.
---
# Shared`, 'utf8');
        await writeSkill(workspaceRoot, 'shared', `---
name: Shadowed
description: Lower precedence duplicate id.
---
# Shadowed`);
        await writeSkill(workspaceRoot, 'other', `---
name: Shared Name
description: Duplicate display name.
---
# Other`);

        const scanned = await scanSkillsWithDiagnostics({
          dirs: [join(projectRoot, '.agents', 'skills'), join(workspaceRoot, 'skills')],
          stateRoot: workspaceRoot,
        });
        assert.deepEqual(scanned.skills.map((skill) => skill.id), ['shared', 'other']);
        assert.deepEqual(
          scanned.diagnostics.map((diagnostic) => ({
            id: diagnostic.id,
            codes: diagnostic.issues.map((issue) => issue.code),
          })),
          [
            { id: 'shared', codes: ['duplicate_id'] },
            { id: 'shared', codes: ['duplicate_name'] },
            { id: 'other', codes: ['duplicate_name'] },
          ],
        );
      } finally {
        await rm(projectRoot, { recursive: true, force: true });
      }
    });
  });

  it('scales the prompt catalog budget from model context with bounded fallback', () => {
    assert.equal(resolveSkillsPromptCharBudget(), MAX_SKILLS_PROMPT_CHARS);
    assert.equal(resolveSkillsPromptCharBudget({ contextWindow: Number.NaN }), MAX_SKILLS_PROMPT_CHARS);
    assert.equal(resolveSkillsPromptCharBudget({ contextWindow: 128_000 }), MIN_SKILLS_PROMPT_TOKENS * 4);
    assert.equal(resolveSkillsPromptCharBudget({ contextWindow: 300_000 }), 6_000 * 4);
    assert.equal(resolveSkillsPromptCharBudget({ contextWindow: 1_000_000 }), MAX_SKILLS_PROMPT_TOKENS * 4);
  });
  it('scanWorkspaceSkills lists SKILL.md metadata with declared tools as declaration only', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const body = `---
name: Writer
description: Draft polished prose.
allowed-tools: [Read, Write]
---
# Writer
Use concise prose.`;
      await writeSkill(workspaceRoot, 'writer', body);

      const skills = await scanWorkspaceSkills(workspaceRoot);
      assert.equal(skills.length, 1);
      assert.equal(skills[0].id, 'writer');
      assert.equal(skills[0].name, 'Writer');
      assert.equal(skills[0].description, 'Draft polished prose.');
      assert.deepEqual(skills[0].declaredTools, ['Read', 'Write']);
      assert.equal(skills[0].enabled, true);
      assert.equal(skills[0].runtimeStatus, 'enabled');
      assert.match(skills[0].content, /Use concise prose\./);
      assert.equal(skills[0].contentSha256, `sha256:${createHash('sha256').update(Buffer.from(body, 'utf8')).digest('hex')}`);
    });
  });

  it('buildSkillsPromptFragment lists available skills and loadSkillInstructions loads them lazily', async () => {
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
      assert.match(loaded.skill.relativePath, /browser-helper\/SKILL\.md$/);
      assert.match(loaded.skill.instructions, /Open local targets carefully\./);
      assert.match(loaded.skill.instructions, /Do not ask permission for shell commands\./);
    });
  });

  it('writeSkillRuntimeState persists per-workspace enablement and scan excludes disabled skills', async () => {
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

      const written = await writeSkillRuntimeState(workspaceRoot, new Map([['browser-helper', false]]));
      assert.equal(written.ok, true);

      const skills = await scanWorkspaceSkills(workspaceRoot);
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

      const reEnabled = await writeSkillRuntimeState(workspaceRoot, new Map([['browser-helper', true]]));
      assert.equal(reEnabled.ok, true);
      const loaded = await loadSkillInstructions(workspaceRoot, 'browser-helper');
      assert.equal(loaded.ok, true);
    });
  });

  it('loadSkillInstructions loads an enabled duplicate-name skill before reporting a disabled duplicate', async () => {
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

      assert.equal((await writeSkillRuntimeState(workspaceRoot, new Map([['disabled-copy', false]]))).ok, true);

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

  it('readSkillRuntimeState fails closed when the state file is invalid', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await writeSkill(workspaceRoot, 'browser-helper', `---
name: Browser Helper
description: Use when the user asks for browser automation.
---
# Browser Helper
Open local targets carefully.`);
      await mkdir(join(workspaceRoot, '.maka'), { recursive: true });
      await writeFile(join(workspaceRoot, '.maka', 'skills-state.json'), '{not json', 'utf8');

      const state = await readSkillRuntimeState(workspaceRoot);
      assert.equal(state.ok, false);
      if (state.ok) return;
      assert.equal(state.reason, 'invalid_json');

      const skills = await scanWorkspaceSkills(workspaceRoot);
      assert.equal(skills.length, 1);
      assert.equal(skills[0].enabled, false);
      assert.equal(skills[0].runtimeStatus, 'state_error');
      assert.equal(await buildSkillsPromptFragment(workspaceRoot), undefined);

      const loaded = await loadSkillInstructions(workspaceRoot, 'browser-helper');
      assert.equal(loaded.ok, false);
      if (loaded.ok) return;
      assert.equal(loaded.reason, 'disabled');
      assert.deepEqual(loaded.availableSkills, []);

      // writeSkillRuntimeState is a low-level primitive: it does not read the
      // existing state, so a corrupted state file is repaired by overwrite.
      const repaired = await writeSkillRuntimeState(workspaceRoot, new Map([['browser-helper', true]]));
      assert.equal(repaired.ok, true);
      const skillsAfter = await scanWorkspaceSkills(workspaceRoot);
      assert.equal(skillsAfter[0].enabled, true);
      assert.equal(skillsAfter[0].runtimeStatus, 'enabled');
    });
  });

  it('writeSkillRuntimeState does not write through a symlinked workspace metadata directory', async () => {
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

        const written = await writeSkillRuntimeState(workspaceRoot, new Map([['browser-helper', false]]));
        assert.equal(written.ok, false);
        if (written.ok) return;
        assert.equal(written.reason, 'blocked_path');
        await assert.rejects(readFile(join(outside, 'skills-state.json'), 'utf8'), { code: 'ENOENT' });

        const skills = await scanWorkspaceSkills(workspaceRoot);
        assert.equal(skills.length, 1);
        assert.equal(skills[0].enabled, false);
        assert.equal(skills[0].runtimeStatus, 'state_error');
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  it('readSkillRuntimeState does not read through a symlinked state file', async () => {
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

        const state = await readSkillRuntimeState(workspaceRoot);
        assert.equal(state.ok, false);
        if (state.ok) return;
        assert.equal(state.reason, 'blocked_path');

        const skills = await scanWorkspaceSkills(workspaceRoot);
        assert.equal(skills.length, 1);
        assert.equal(skills[0].enabled, false);
        assert.equal(skills[0].runtimeStatus, 'state_error');
        assert.equal(await buildSkillsPromptFragment(workspaceRoot), undefined);
        assert.equal(await readFile(externalState, 'utf8'), 'outside state');
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  it('buildSkillAgentTool exposes a read-only Skill tool that loads a single matching local skill', async () => {
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

  it('buildSkillAgentTool resolves project skills from each tool call cwd', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const firstProject = join(workspaceRoot, 'first-project');
      const secondProject = join(workspaceRoot, 'second-project');
      await mkdir(join(firstProject, '.agents', 'skills', 'project-helper'), { recursive: true });
      await mkdir(join(secondProject, '.agents', 'skills', 'project-helper'), { recursive: true });
      await writeFile(join(firstProject, '.agents', 'skills', 'project-helper', 'SKILL.md'), `---
name: Project Helper
description: First project helper.
---
# First project`, 'utf8');
      await writeFile(join(secondProject, '.agents', 'skills', 'project-helper', 'SKILL.md'), `---
name: Project Helper
description: Second project helper.
---
# Second project`, 'utf8');

      const tool = buildSkillAgentTool((ctx) => resolveSkillDiscoveryPaths(ctx.cwd, workspaceRoot));
      const result = await tool.impl({ name: 'Project Helper' }, {
        sessionId: 's2', turnId: 't2', cwd: secondProject, toolCallId: 'tool-2',
        abortSignal: new AbortController().signal, emitOutput: () => {},
      });

      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.match(result.skill.instructions, /# Second project/);
      assert.doesNotMatch(result.skill.instructions, /# First project/);
    });
  });

  it('loadSkillInstructions bounds loaded instructions and returns available skills on miss', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await writeSkill(workspaceRoot, 'huge', `---
name: Huge
description: Exercise bounded instruction loading.
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
      assert.deepEqual(miss.availableSkills, [{
        id: 'huge',
        name: 'Huge',
        description: 'Exercise bounded instruction loading.',
      }]);
    });
  });

  it('buildSkillAgentTool honors the host capability gate when loading skills', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await writeSkill(workspaceRoot, 'office-helper', `---
name: Office Helper
description: Office document work.
allowed-tools: [Read]
required-tools: [OfficeDocument]
---
# Office Helper
Use Office tools.`);

      const tool = buildSkillAgentTool(workspaceRoot, { toolNames: new Set(['Read']) });
      const result = await tool.impl({ name: 'office-helper' }, {} as unknown as MakaToolContext);
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.reason, 'host_incompatible');

      // without host: legacy behavior, loads ok.
      const legacyTool = buildSkillAgentTool(workspaceRoot);
      const legacy = await legacyTool.impl({ name: 'office-helper' }, {} as unknown as MakaToolContext);
      assert.equal(legacy.ok, true);
    });
  });

  it('loadSkillInstructions rejects skills hidden by the host capability gate with host_incompatible', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await writeSkill(workspaceRoot, 'office-helper', `---
name: Office Helper
description: Office document work.
allowed-tools: [Read]
required-tools: [OfficeDocument]
---
# Office Helper
Use Office tools.`);

      // host without OfficeDocument: load returns host_incompatible, no available skills.
      const hidden = await loadSkillInstructions(workspaceRoot, 'office-helper', { toolNames: new Set(['Read']) });
      assert.equal(hidden.ok, false);
      if (hidden.ok) return;
      assert.equal(hidden.reason, 'host_incompatible');
      assert.deepEqual(hidden.availableSkills, []);

      // host with OfficeDocument: load ok.
      const ok = await loadSkillInstructions(workspaceRoot, 'office-helper', { toolNames: new Set(['Read', 'OfficeDocument']) });
      assert.equal(ok.ok, true);

      // no host: legacy behavior, load ok.
      const legacy = await loadSkillInstructions(workspaceRoot, 'office-helper');
      assert.equal(legacy.ok, true);
    });
  });

  it('buildSkillsPromptFragment filters out skills whose required tools are missing on the host', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await writeSkill(workspaceRoot, 'office-helper', `---
name: Office Helper
description: Office document work.
allowed-tools: [Read]
required-tools: [OfficeDocument]
---
# Office Helper
Use Office tools.`);
      await writeSkill(workspaceRoot, 'plain-helper', `---
name: Plain Helper
description: Plain work.
allowed-tools: [Read]
---
# Plain Helper
Plain work.`);

      // host without OfficeDocument: office-helper hard-hidden, plain-helper shown.
      const prompt = await buildSkillsPromptFragment(workspaceRoot, { toolNames: new Set(['Read']) });
      assert.ok(prompt);
      assert.match(prompt, /<available-skill id="plain-helper"/);
      assert.doesNotMatch(prompt, /<available-skill id="office-helper"/);

      // host with OfficeDocument: both shown.
      const full = await buildSkillsPromptFragment(workspaceRoot, { toolNames: new Set(['Read', 'OfficeDocument']) });
      assert.ok(full);
      assert.match(full, /<available-skill id="plain-helper"/);
      assert.match(full, /<available-skill id="office-helper"/);

      // no host (undefined): legacy behavior, both shown (no gating).
      const legacy = await buildSkillsPromptFragment(workspaceRoot);
      assert.ok(legacy);
      assert.match(legacy, /<available-skill id="plain-helper"/);
      assert.match(legacy, /<available-skill id="office-helper"/);
    });
  });

  it('gate hard-hides legacy v2 Office skills (no required-tools front matter) on a host without Office tools', async () => {
    await withWorkspace(async (workspaceRoot) => {
      // v2 OfficeCLI template: allowed-tools includes OfficeDocument, but no required-tools.
      await writeSkill(workspaceRoot, 'officecli-docx', `---
name: OfficeCLI DOCX
description: Legacy v2 Office skill without required-tools.
allowed-tools:
  - OfficeDocument
  - OfficeDocumentEdit
  - Read
---
# OfficeCLI DOCX
Legacy v2 body.`);
      const host: HostCapabilities = { toolNames: new Set(['Read', 'Bash']) };

      // Prompt hard-hides the legacy Office skill (fallback requiredTools for bundled officecli-*).
      const prompt = await buildSkillsPromptFragment(workspaceRoot, host);
      assert.ok(!prompt || !prompt.includes('id="officecli-docx"'));

      // Loader rejects it as host_incompatible.
      const loaded = await loadSkillInstructions(workspaceRoot, 'officecli-docx', host);
      assert.equal(loaded.ok, false);
      if (loaded.ok) return;
      assert.equal(loaded.reason, 'host_incompatible');
    });
  });

  it('gateSkillsByHostCapabilities hard-hides skills whose required tools are missing and only hints at missing declared tools', () => {
    const skills: ScannedSkill[] = [
      { id: 'office', name: 'Office', description: '', path: '/p', declaredTools: ['Read', 'OfficeDocument'], requiredTools: ['OfficeDocument'], requiredCapabilities: [], enabled: true, runtimeStatus: 'enabled', content: '', contentSha256: 'sha256:x', discoveryRoot: '/p' },
      { id: 'plain', name: 'Plain', description: '', path: '/p', declaredTools: ['Bash'], requiredTools: [], requiredCapabilities: [], enabled: true, runtimeStatus: 'enabled', content: '', contentSha256: 'sha256:y', discoveryRoot: '/p' },
    ];
    const host: HostCapabilities = { toolNames: new Set(['Read']) };
    const gated = gateSkillsByHostCapabilities(skills, host);
    const office = gated.find((g) => g.id === 'office')!;
    assert.equal(office.eligible, false);
    assert.equal(office.hiddenReason, 'required_tools_missing');
    assert.deepEqual(office.missingDeclaredTools, ['OfficeDocument']);
    const plain = gated.find((g) => g.id === 'plain')!;
    assert.equal(plain.eligible, true);
    assert.equal(plain.hiddenReason, undefined);
    assert.deepEqual(plain.missingDeclaredTools, ['Bash']);
  });

  it('gateSkillsByHostCapabilities hides skills whose required capabilities are missing', () => {
    const skills: ScannedSkill[] = [
      { id: 'cap', name: 'Cap', description: '', path: '/p', declaredTools: [], requiredTools: [], requiredCapabilities: ['office'], enabled: true, runtimeStatus: 'enabled', content: '', contentSha256: 'sha256:z', discoveryRoot: '/p' },
    ];
    const noCap = gateSkillsByHostCapabilities(skills, { toolNames: new Set(), capabilities: new Set() });
    assert.equal(noCap[0].eligible, false);
    assert.equal(noCap[0].hiddenReason, 'required_capabilities_missing');
    const withCap = gateSkillsByHostCapabilities(skills, { toolNames: new Set(), capabilities: new Set(['office']) });
    assert.equal(withCap[0].eligible, true);
    assert.equal(withCap[0].hiddenReason, undefined);
  });

  it('scanWorkspaceSkills surfaces required-tools and required-capabilities from front matter', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await writeSkill(workspaceRoot, 'office-helper', `---
name: Office Helper
description: Office document work.
allowed-tools: [Read]
required-tools: [OfficeDocument, OfficeDocumentEdit]
required-capabilities: [office]
---
# Office Helper
Route through Office tools.`);

      const skills = await scanWorkspaceSkills(workspaceRoot);
      assert.equal(skills.length, 1);
      assert.equal(skills[0].id, 'office-helper');
      assert.deepEqual(skills[0].declaredTools, ['Read']);
      assert.deepEqual(skills[0].requiredTools, ['OfficeDocument', 'OfficeDocumentEdit']);
      assert.deepEqual(skills[0].requiredCapabilities, ['office']);
    });
  });

  it('scanWorkspaceSkills returns empty when no skills directory exists', async () => {
    await withWorkspace(async (workspaceRoot) => {
      assert.deepEqual(await scanWorkspaceSkills(workspaceRoot), []);
      assert.equal(await buildSkillsPromptFragment(workspaceRoot), undefined);
    });
  });

  it('scanSkills discovers skills from multiple directories and dedupes by id (first-found wins)', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const projectRoot = await mkdtemp(join(tmpdir(), 'maka-runtime-skills-proj-'));
      try {
        // Write a skill in the project .agents/skills path
        await mkdir(join(projectRoot, '.agents', 'skills', 'shared'), { recursive: true });
        await writeFile(join(projectRoot, '.agents', 'skills', 'shared', 'SKILL.md'), `---
name: Shared
description: Project copy.
---
# Shared
Project body.`, 'utf8');

        // Write the same id in the workspace skills path
        await writeSkill(workspaceRoot, 'shared', `---
name: Shared
description: Workspace copy.
---
# Shared
Workspace body.`);

        // Write a unique skill in project .agents/skills
        await mkdir(join(projectRoot, '.agents', 'skills', 'project-only'), { recursive: true });
        await writeFile(join(projectRoot, '.agents', 'skills', 'project-only', 'SKILL.md'), `---
name: Project Only
description: Only in project.
---
# Project Only
Body.`, 'utf8');

        const source = { dirs: [join(projectRoot, '.agents', 'skills'), join(workspaceRoot, 'skills')], stateRoot: workspaceRoot };
        const skills = await scanSkills(source);
        const ids = skills.map((s) => s.id);
        assert.ok(ids.includes('shared'));
        assert.ok(ids.includes('project-only'));
        // Only one 'shared' despite two dirs
        assert.equal(ids.filter((id) => id === 'shared').length, 1);
        // First-found (project) wins
        const shared = skills.find((s) => s.id === 'shared')!;
        assert.equal(shared.description, 'Project copy.');
      } finally {
        await rm(projectRoot, { recursive: true, force: true });
      }
    });
  });

  it('resolveSkillDiscoveryPaths returns the five standard paths with containment roots in precedence order', () => {
    const { entries, dirs, stateRoot } = resolveSkillDiscoveryPaths('/repo', '/workspace', '/home/user');
    assert.deepEqual(entries, [
      { dir: '/repo/.maka/skills', containmentRoot: '/repo' },
      { dir: '/repo/.agents/skills', containmentRoot: '/repo' },
      { dir: '/workspace/skills', containmentRoot: '/workspace' },
      { dir: '/home/user/.maka/skills', containmentRoot: '/home/user' },
      { dir: '/home/user/.agents/skills', containmentRoot: '/home/user' },
    ]);
    assert.deepEqual(dirs, [
      '/repo/.maka/skills',
      '/repo/.agents/skills',
      '/workspace/skills',
      '/home/user/.maka/skills',
      '/home/user/.agents/skills',
    ]);
    assert.equal(stateRoot, '/workspace');
  });

  it('parseSkillFrontMatter parses inline and list-style allowed-tools', () => {
    assert.deepEqual(parseSkillFrontMatter('---\nname: A\ndescription: Desc one.\nallowed-tools: [Read, Write]\n---\nbody'), {
      name: 'A',
      description: 'Desc one.',
      allowedTools: ['Read', 'Write'],
      requiredTools: [],
      requiredCapabilities: [],
    });
    assert.deepEqual(parseSkillFrontMatter('---\nname: B\ndescription: Desc two.\nallowed-tools:\n  - Read\n  - Bash\n---\nbody'), {
      name: 'B',
      description: 'Desc two.',
      allowedTools: ['Read', 'Bash'],
      requiredTools: [],
      requiredCapabilities: [],
    });
  });

  it('parseSkillFrontMatter parses required-tools and required-capabilities alongside allowed-tools', () => {
    assert.deepEqual(parseSkillFrontMatter('---\nname: A\ndescription: Desc one.\nallowed-tools: [Read]\nrequired-tools: [OfficeDocument, OfficeDocumentEdit]\nrequired-capabilities: [office]\n---\nbody'), {
      name: 'A',
      description: 'Desc one.',
      allowedTools: ['Read'],
      requiredTools: ['OfficeDocument', 'OfficeDocumentEdit'],
      requiredCapabilities: ['office'],
    });
    assert.deepEqual(parseSkillFrontMatter('---\nname: B\ndescription: Desc two.\nallowed-tools:\n  - Read\nrequired-tools:\n  - OfficeDocument\n---\nbody'), {
      name: 'B',
      description: 'Desc two.',
      allowedTools: ['Read'],
      requiredTools: ['OfficeDocument'],
      requiredCapabilities: [],
    });
  });

  it('buildSkillsPromptFragment does not impose an arbitrary count limit', async () => {
    await withWorkspace(async (workspaceRoot) => {
      for (let index = 1; index <= 15; index += 1) {
        const id = `small-${String(index).padStart(2, '0')}`;
        await writeSkill(workspaceRoot, id, `---\nname: Small ${index}\ndescription: Short.\n---\n# Small ${index}`);
      }
      const prompt = await buildSkillsPromptFragment(workspaceRoot);
      assert.ok(prompt);
      for (let index = 1; index <= 15; index += 1) {
        const id = `small-${String(index).padStart(2, '0')}`;
        assert.match(prompt, new RegExp(`id="${id}"`));
      }
      assert.doesNotMatch(prompt, /omitted from this prompt/);
    });
  });

  it('buildSkillsPromptFragment truncates by char budget and lists omitted skills', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const longDescription = 'x'.repeat(1200);
      for (let index = 1; index <= 20; index += 1) {
        const id = `big-${String(index).padStart(2, '0')}`;
        await writeSkill(workspaceRoot, id, `---\nname: Big ${index}\ndescription: ${longDescription}\n---\n# Big ${index}`);
      }
      const prompt = await buildSkillsPromptFragment(workspaceRoot, undefined, { contextWindow: 128_000 });
      assert.ok(prompt);
      const promptCharBudget = resolveSkillsPromptCharBudget({ contextWindow: 128_000 });
      assert.ok(
        prompt.length <= promptCharBudget + 512,
        'prompt should stay close to the character budget',
      );
      assert.match(prompt, /omitted from this prompt due to the prompt budget/);

      const omittedMatch = prompt.match(/prompt budget: ([^.]+)\./);
      assert.ok(omittedMatch);
      const omittedIds = omittedMatch![1].split(', ').map((id) => id.trim());
      assert.ok(omittedIds.length > 0);
      for (const id of omittedIds) {
        const loaded = await loadSkillInstructions(workspaceRoot, id);
        assert.equal(loaded.ok, true, `omitted skill ${id} should still be loadable via the Skill tool`);
      }
    });
  });
});

async function withWorkspace(fn: (workspaceRoot: string) => Promise<void>): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-runtime-skills-'));
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
