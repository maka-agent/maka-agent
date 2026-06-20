import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';
import {
  AGENT_WORKSPACE_WORKTREE,
  buildChildAgentTools,
  IMPLEMENTATION_AGENT_ID,
  listBuiltinAgentDefinitions,
  LOAD_TOOLS_NAME,
  WEB_RESEARCH_AGENT_ID,
  ToolAvailabilityRuntime,
} from '@maka/runtime';
import { buildIsolatedBashTool, buildIsolatedHeadlessToolAvailability, buildIsolatedHeadlessTools } from '../tools.js';

describe('isolated headless tools', () => {
  test('Bash delegates execution to the isolated executor', async () => {
    const calls: unknown[] = [];
    const emitted: Array<{ stream: string; chunk: string }> = [];
    const bash = buildIsolatedBashTool({
      async exec(input) {
        calls.push(input);
        return { exitCode: 7, stdout: 'out\n', stderr: 'err\n' };
      },
    });

    const result = await bash.impl(
      { command: 'npm test', timeout_ms: 12_000 },
      {
        sessionId: 's',
        turnId: 't',
        cwd: '/workspace',
        toolCallId: 'tool-1',
        abortSignal: new AbortController().signal,
        emitOutput: (stream, chunk) => emitted.push({ stream, chunk }),
      },
    );

    assert.deepEqual(calls, [{ command: 'npm test', cwd: '/workspace', timeoutMs: 12_000 }]);
    assert.deepEqual(emitted, [
      { stream: 'stdout', chunk: 'out\n' },
      { stream: 'stderr', chunk: 'err\n' },
    ]);
    assert.deepEqual(result, {
      kind: 'terminal',
      cwd: '/workspace',
      cmd: 'npm test',
      exitCode: 7,
      stdout: 'out\n',
      stderr: 'err\n',
    });
  });

  test('standard isolated tool surface keeps local-read child tools shell-free', () => {
    const tools = buildIsolatedHeadlessTools({
      async exec() {
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    const names = tools.map((tool) => tool.name);
    assert.equal(names[0], 'Bash');
    assert.ok(names.includes('Read'));
    assert.ok(names.includes('Write'));
    assert.ok(names.includes('agent_spawn'));
    assert.ok(names.includes('agent_list'));
    assert.ok(names.includes('agent_output'));
    assert.equal(names.filter((name) => name === 'Bash').length, 1);
    assert.deepEqual(buildChildAgentTools(tools).map((tool) => tool.name), ['Read', 'Glob', 'Grep']);
    assert.ok(!buildChildAgentTools(tools).some((tool) => ['Bash', 'Write', 'Edit'].includes(tool.name)));
    const definitions = listBuiltinAgentDefinitions({
      parentPermissionMode: 'execute',
      tools: buildChildAgentTools(tools),
    });
    assert.deepEqual(definitions.find((definition) => definition.id === WEB_RESEARCH_AGENT_ID)?.availability, {
      status: 'unavailable',
      reason: 'missing_tools',
      missingTools: ['WebSearch'],
    });
    assert.deepEqual(definitions.find((definition) => definition.id === IMPLEMENTATION_AGENT_ID)?.availability, {
      status: 'unavailable',
      reason: 'workspace_isolation_unavailable',
      workspace: AGENT_WORKSPACE_WORKTREE,
      requiredRuntime: 'worktree_child_executor',
    });
  });

  test('standard isolated tool availability defers parent-facing agent tools', () => {
    const tools = buildIsolatedHeadlessTools({
      async exec() {
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    const plan = new ToolAvailabilityRuntime(
      tools,
      buildIsolatedHeadlessToolAvailability(),
      { name: 'invalid', description: 'invalid', parameters: {}, impl: () => ({}) },
    ).prepare([]);

    assert.ok(plan.activeTools.includes('Bash'));
    assert.ok(plan.activeTools.includes('Read'));
    assert.ok(plan.activeTools.includes(LOAD_TOOLS_NAME));
    assert.ok(!plan.activeTools.includes('agent_spawn'));
    assert.ok(!plan.activeTools.includes('agent_list'));
    assert.ok(!plan.activeTools.includes('agent_output'));

    const loaded = plan.prepareStep!({
      steps: [{ toolCalls: [{ toolName: LOAD_TOOLS_NAME, input: { group: 'agent' } }] }],
    }).activeTools;
    assert.ok(loaded.includes('agent_spawn'));
    assert.ok(loaded.includes('agent_list'));
    assert.ok(loaded.includes('agent_output'));
  });

  test('standard isolated tool availability does not reintroduce agent tools into local-read children', () => {
    const parentTools = buildIsolatedHeadlessTools({
      async exec() {
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    const childTools = buildChildAgentTools(parentTools);
    const plan = new ToolAvailabilityRuntime(
      childTools,
      buildIsolatedHeadlessToolAvailability(),
      { name: 'invalid', description: 'invalid', parameters: {}, impl: () => ({}) },
    ).prepare([]);

    assert.deepEqual([...plan.activeTools].sort(), ['Glob', 'Grep', 'Read']);
    assert.equal(plan.prepareStep, undefined);
    assert.ok(!plan.activeTools.includes(LOAD_TOOLS_NAME));
    assert.ok(!plan.activeTools.includes('agent_spawn'));
  });

  test('README real-backend sketch preserves child tool overrides', async () => {
    const readme = await readFile(new URL('../../README.md', import.meta.url), 'utf8');

    assert.ok(
      readme.includes('tools: [...(ctx.tools ?? buildIsolatedHeadlessTools(context.toolExecutor!))],'),
    );
  });
});
