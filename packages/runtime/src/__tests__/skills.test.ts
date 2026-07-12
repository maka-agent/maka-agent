import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  MAX_SKILLS_PROMPT_CHARS,
  MAX_SKILL_TOOL_BODY_CHARS,
  buildSkillAgentTool,
  buildSkillsPromptFragment,
  gateSkillsByHostCapabilities,
  loadSkillInstructions,
  parseSkillFrontMatter,
  readSkillRuntimeState,
  scanWorkspaceSkills,
  writeSkillRuntimeState,
  type HostCapabilities,
  type ScannedSkill,
} from '../skills.js';
import type { MakaToolContext } from '../tool-runtime.js';

describe('runtime skills', () => {
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
      assert.equal(loaded.skill.relativePath, 'skills/browser-helper/SKILL.md');
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

  it('loadSkillInstructions bounds loaded instructions and returns available skills on miss', async () => {
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

  it('gateSkillsByHostCapabilities hard-hides skills whose required tools are missing and only hints at missing declared tools', () => {
    const skills: ScannedSkill[] = [
      { id: 'office', name: 'Office', description: '', path: '/p', declaredTools: ['Read', 'OfficeDocument'], requiredTools: ['OfficeDocument'], requiredCapabilities: [], enabled: true, runtimeStatus: 'enabled', content: '', contentSha256: 'sha256:x' },
      { id: 'plain', name: 'Plain', description: '', path: '/p', declaredTools: ['Bash'], requiredTools: [], requiredCapabilities: [], enabled: true, runtimeStatus: 'enabled', content: '', contentSha256: 'sha256:y' },
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
      { id: 'cap', name: 'Cap', description: '', path: '/p', declaredTools: [], requiredTools: [], requiredCapabilities: ['office'], enabled: true, runtimeStatus: 'enabled', content: '', contentSha256: 'sha256:z' },
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