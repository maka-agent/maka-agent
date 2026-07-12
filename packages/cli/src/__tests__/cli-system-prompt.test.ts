import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { buildCliSystemPrompt, buildCliTurnTailPrompt } from '../cli-system-prompt.js';
import type { HostCapabilities } from '@maka/runtime';

describe('CLI system prompt', () => {
  test('injects the skill catalog from workspaceRoot, gated by host capabilities (Office skills auto-filter on the CLI host)', async () => {
    await withCwdAndWorkspace(async ({ cwd, workspaceRoot }) => {
      await writeSkill(workspaceRoot, 'plain-helper', `---
name: Plain Helper
description: Plain work.
allowed-tools: [Read]
---
# Plain Helper
Plain work.`);
      await writeSkill(workspaceRoot, 'office-helper', `---
name: Office Helper
description: Office document work.
allowed-tools: [Read]
required-tools: [OfficeDocument]
---
# Office Helper
Use Office tools.`);

      // CLI host without OfficeDocument: office-helper is hard-hidden, plain-helper shown.
      // workspaceRoot is separate from cwd so the project directory is never scanned.
      const cliHost: HostCapabilities = { toolNames: new Set(['Read']) };
      const out = await buildCliSystemPrompt({
        settings: { personalization: {}, workspaceInstructions: { enabled: false } },
        cwd,
        workspaceRoot,
        host: cliHost,
      });
      assert.ok(out, 'prompt should include the plain skill catalog');
      assert.match(out, /<available-skill id="plain-helper"/);
      assert.doesNotMatch(out, /<available-skill id="office-helper"/);

      // Host with OfficeDocument: both skills shown.
      const fullHost: HostCapabilities = { toolNames: new Set(['Read', 'OfficeDocument']) };
      const full = await buildCliSystemPrompt({
        settings: { personalization: {}, workspaceInstructions: { enabled: false } },
        cwd,
        workspaceRoot,
        host: fullHost,
      });
      assert.ok(full);
      assert.match(full, /<available-skill id="plain-helper"/);
      assert.match(full, /<available-skill id="office-helper"/);
    });
  });

  test('includes AGENTS.md content when workspaceInstructions is enabled and the file is present', async () => {
    await withCwd(async (cwd) => {
      await writeFile(join(cwd, 'AGENTS.md'), '# Project rules\n- Use TDD always\n');
      const out = await buildCliSystemPrompt({
        settings: { personalization: {}, workspaceInstructions: { enabled: true } },
        cwd,
        workspaceRoot: cwd,
      });
      assert.ok(out, 'expected a prompt fragment when AGENTS.md is present and enabled');
      assert.match(out, /Use TDD always/);
      assert.match(out, /<workspace-instructions file="AGENTS\.md">/);
    });
  });

  test('suppresses workspace instructions when the setting is disabled, even if AGENTS.md exists', async () => {
    await withCwd(async (cwd) => {
      await writeFile(join(cwd, 'AGENTS.md'), '- secret project rule');
      const out = await buildCliSystemPrompt({
        settings: { personalization: {}, workspaceInstructions: { enabled: false } },
        cwd,
        workspaceRoot: cwd,
      });
      assert.equal(out, undefined, 'gate must suppress AGENTS.md when workspaceInstructions is disabled');
    });
  });

  test('includes the personalization addressing hint when a displayName is set', async () => {
    await withCwd(async (cwd) => {
      const out = await buildCliSystemPrompt({
        settings: { personalization: { displayName: 'Yuhan' }, workspaceInstructions: { enabled: false } },
        cwd,
        workspaceRoot: cwd,
      });
      assert.ok(out);
      assert.match(out, /addressed as "Yuhan"/);
    });
  });

  test('returns undefined when there is no personalization and no readable instruction file', async () => {
    await withCwd(async (cwd) => {
      const out = await buildCliSystemPrompt({
        settings: { personalization: {}, workspaceInstructions: { enabled: true } },
        cwd,
        workspaceRoot: cwd,
      });
      assert.equal(out, undefined);
    });
  });

  test('joins personalization and workspace instructions into one prompt', async () => {
    await withCwd(async (cwd) => {
      await writeFile(join(cwd, 'AGENTS.md'), '- commit one reason');
      const out = await buildCliSystemPrompt({
        settings: { personalization: { displayName: 'Alice' }, workspaceInstructions: { enabled: true } },
        cwd,
        workspaceRoot: cwd,
      });
      assert.ok(out);
      assert.match(out, /addressed as "Alice"/);
      assert.match(out, /commit one reason/);
    });
  });
});

describe('CLI turn-tail prompt', () => {
  test('renders the working directory, git repo status, platform, and date', async () => {
    await withCwd(async (cwd) => {
      const out = await buildCliTurnTailPrompt({ cwd });
      assert.ok(out.includes(cwd), 'tail should contain the cwd');
      assert.match(out, /Git repository:/);
      assert.match(out, /Platform:/);
      assert.match(out, /Today's date:/);
    });
  });
});

async function withCwd(fn: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), 'maka-cli-sysprompt-'));
  try {
    await fn(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

async function withCwdAndWorkspace(fn: (dirs: { cwd: string; workspaceRoot: string }) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), 'maka-cli-sysprompt-cwd-'));
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-cli-sysprompt-ws-'));
  try {
    await fn({ cwd, workspaceRoot });
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function writeSkill(workspaceRoot: string, id: string, content: string): Promise<void> {
  const dir = join(workspaceRoot, 'skills', id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), content, 'utf8');
}