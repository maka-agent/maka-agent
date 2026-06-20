import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { LlmConnection, SessionHeader } from '@maka/core';
import type { SessionEvent } from '@maka/core/events';
import { buildBuiltinTools } from '../builtin-tools.js';
import { PermissionEngine } from '../permission-engine.js';
import {
  AGENT_CONTEXT_ISOLATED,
  AGENT_INVOCATION_FOREGROUND,
  AGENT_WORKSPACE_SAME_WORKSPACE,
  AGENT_WORKSPACE_WORKTREE,
  AGENT_WRITE_BACK_PATCH,
  AGENT_WRITE_BACK_SUMMARY,
  IMPLEMENTATION_AGENT_ID,
  IMPLEMENTATION_AGENT_DEFINITION,
  IMPLEMENTATION_AGENT_PROFILE,
  LOCAL_READ_AGENT_ID,
  LOCAL_READ_AGENT_DEFINITION,
  LOCAL_READ_AGENT_PROFILE,
  WEB_RESEARCH_AGENT_ID,
  WEB_RESEARCH_AGENT_DEFINITION,
  WEB_RESEARCH_AGENT_PROFILE,
  assertAgentDefinitionRunnable,
  evaluateAgentDefinitionAvailability,
  evaluateAgentDefinitionToolAccess,
  listBuiltinAgentDefinitions,
} from '../agent-catalog.js';
import {
  AGENT_TOOL_GROUP_ID,
  AGENT_TOOL_NAMES,
  AGENT_LIST_TOOL_NAME,
  AGENT_OUTPUT_TOOL_NAME,
  AGENT_SPAWN_TOOL_NAME,
  CHILD_AGENT_TOOL_NAMES,
  buildChildAgentTools,
  buildSubagentListTool,
  buildSubagentOutputTool,
  buildSubagentSpawnTool,
  buildSubagentToolGroup,
} from '../subagent-tools.js';
import { ToolRuntime, type MakaTool } from '../tool-runtime.js';
import { expect } from '../test-helpers.js';

describe('subagent tools', () => {
  test('agent deferred group declares the parent-facing agent tools only', () => {
    const group = buildSubagentToolGroup();

    expect(group.id).toBe(AGENT_TOOL_GROUP_ID);
    expect(group.label).toBe('Agent');
    expect([...group.toolNames]).toEqual([...AGENT_TOOL_NAMES]);
    expect([...group.toolNames]).toEqual([
      AGENT_SPAWN_TOOL_NAME,
      AGENT_LIST_TOOL_NAME,
      AGENT_OUTPUT_TOOL_NAME,
    ]);
    expect(group.description).toMatch(/Spawn and inspect/);

    const spawnTool = buildSubagentSpawnTool();
    expect(spawnTool.permissionRequired).toBe(true);
    expect(spawnTool.categoryHint).toBe('subagent');
    expect(buildSubagentListTool().permissionRequired).toBe(false);
    expect(buildSubagentOutputTool().permissionRequired).toBe(false);
  });

  test('built-in catalog exposes local-read without shell, web, nested, or write tools', () => {
    expect(LOCAL_READ_AGENT_DEFINITION.id).toBe(LOCAL_READ_AGENT_ID);
    expect(LOCAL_READ_AGENT_DEFINITION.profile).toBe(LOCAL_READ_AGENT_PROFILE);
    expect(LOCAL_READ_AGENT_DEFINITION.contract).toEqual({
      capability: 'local_read',
      invocation: AGENT_INVOCATION_FOREGROUND,
      context: AGENT_CONTEXT_ISOLATED,
      workspace: AGENT_WORKSPACE_SAME_WORKSPACE,
      defaultWriteBack: AGENT_WRITE_BACK_SUMMARY,
      supportedWriteBack: [AGENT_WRITE_BACK_SUMMARY],
    });
    expect(LOCAL_READ_AGENT_DEFINITION.permissionMode).toBe('explore');
    expect([...LOCAL_READ_AGENT_DEFINITION.tools]).toEqual(['Read', 'Glob', 'Grep']);
    expect(LOCAL_READ_AGENT_DEFINITION.tools.includes('Bash')).toBe(false);
    expect(LOCAL_READ_AGENT_DEFINITION.tools.includes('WebSearch')).toBe(false);
    expect(LOCAL_READ_AGENT_DEFINITION.tools.includes('WebFetch')).toBe(false);
    expect(LOCAL_READ_AGENT_DEFINITION.tools.includes('ExploreAgent')).toBe(false);

    const definitions = listBuiltinAgentDefinitions({
      parentPermissionMode: 'ask',
      tools: [
        testCatalogTool('Read', 'read'),
        testCatalogTool('Glob', 'read'),
        testCatalogTool('Grep', 'read'),
        testCatalogTool('WebSearch', 'web_read'),
      ],
    });
    expect(definitions.find((definition) => definition.id === LOCAL_READ_AGENT_ID)).toEqual({
      id: LOCAL_READ_AGENT_ID,
      profile: LOCAL_READ_AGENT_PROFILE,
      name: 'Local Read',
      description: 'Read-only repository exploration with file and text search tools only.',
      permissionMode: 'explore',
      tools: ['Read', 'Glob', 'Grep'],
      contract: LOCAL_READ_AGENT_DEFINITION.contract,
      availability: { status: 'available' },
    });
  });

  test('built-in catalog exposes web-research with only WebSearch and no local or write tools', () => {
    expect(WEB_RESEARCH_AGENT_DEFINITION.id).toBe(WEB_RESEARCH_AGENT_ID);
    expect(WEB_RESEARCH_AGENT_DEFINITION.profile).toBe(WEB_RESEARCH_AGENT_PROFILE);
    expect(WEB_RESEARCH_AGENT_DEFINITION.contract).toEqual({
      capability: 'web_research',
      invocation: AGENT_INVOCATION_FOREGROUND,
      context: AGENT_CONTEXT_ISOLATED,
      workspace: AGENT_WORKSPACE_SAME_WORKSPACE,
      defaultWriteBack: AGENT_WRITE_BACK_SUMMARY,
      supportedWriteBack: [AGENT_WRITE_BACK_SUMMARY],
    });
    expect(WEB_RESEARCH_AGENT_DEFINITION.permissionMode).toBe('execute');
    expect([...WEB_RESEARCH_AGENT_DEFINITION.tools]).toEqual(['WebSearch']);
    expect(WEB_RESEARCH_AGENT_DEFINITION.tools.includes('Read')).toBe(false);
    expect(WEB_RESEARCH_AGENT_DEFINITION.tools.includes('Bash')).toBe(false);
    expect(WEB_RESEARCH_AGENT_DEFINITION.tools.includes('Write')).toBe(false);
    expect(WEB_RESEARCH_AGENT_DEFINITION.tools.includes('ExploreAgent')).toBe(false);

    const withWebSearch = listBuiltinAgentDefinitions({
      parentPermissionMode: 'execute',
      tools: [
        testCatalogTool('Read', 'read'),
        testCatalogTool('Glob', 'read'),
        testCatalogTool('Grep', 'read'),
        testCatalogTool('WebSearch', undefined),
      ],
    });
    expect(withWebSearch.map((definition) => definition.profile)).toEqual([
      LOCAL_READ_AGENT_PROFILE,
      WEB_RESEARCH_AGENT_PROFILE,
      IMPLEMENTATION_AGENT_PROFILE,
    ]);
    expect(withWebSearch.find((definition) => definition.id === WEB_RESEARCH_AGENT_ID)).toEqual({
      id: WEB_RESEARCH_AGENT_ID,
      profile: WEB_RESEARCH_AGENT_PROFILE,
      name: 'Web Research',
      description: 'Network-backed web research with WebSearch only.',
      permissionMode: 'execute',
      tools: ['WebSearch'],
      contract: WEB_RESEARCH_AGENT_DEFINITION.contract,
      availability: { status: 'available' },
    });

    expect(listBuiltinAgentDefinitions({
      parentPermissionMode: 'execute',
      tools: [
        testCatalogTool('Read', 'read'),
        testCatalogTool('Glob', 'read'),
        testCatalogTool('Grep', 'read'),
      ],
    }).find((definition) => definition.id === WEB_RESEARCH_AGENT_ID)?.availability).toEqual({
      status: 'unavailable',
      reason: 'missing_tools',
      missingTools: ['WebSearch'],
    });
    expect(listBuiltinAgentDefinitions({
      parentPermissionMode: 'ask',
      tools: [
        testCatalogTool('Read', 'read'),
        testCatalogTool('Glob', 'read'),
        testCatalogTool('Grep', 'read'),
        testCatalogTool('WebSearch', 'web_read'),
      ],
    }).find((definition) => definition.id === WEB_RESEARCH_AGENT_ID)?.availability).toEqual({
      status: 'unavailable',
      reason: 'parent_permission_mode',
      parentPermissionMode: 'ask',
      requiredPermissionMode: 'execute',
    });
  });

  test('built-in catalog exposes implementation as a worktree-only fail-closed contract', async () => {
    expect(IMPLEMENTATION_AGENT_DEFINITION.id).toBe(IMPLEMENTATION_AGENT_ID);
    expect(IMPLEMENTATION_AGENT_DEFINITION.profile).toBe(IMPLEMENTATION_AGENT_PROFILE);
    expect(IMPLEMENTATION_AGENT_DEFINITION.contract).toEqual({
      capability: 'implementation',
      invocation: AGENT_INVOCATION_FOREGROUND,
      context: AGENT_CONTEXT_ISOLATED,
      workspace: AGENT_WORKSPACE_WORKTREE,
      defaultWriteBack: AGENT_WRITE_BACK_PATCH,
      supportedWriteBack: [AGENT_WRITE_BACK_PATCH],
    });
    expect(IMPLEMENTATION_AGENT_DEFINITION.permissionMode).toBe('execute');
    expect([...IMPLEMENTATION_AGENT_DEFINITION.tools]).toEqual(['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash']);
    expect(IMPLEMENTATION_AGENT_DEFINITION.tools.includes('WebSearch')).toBe(false);
    expect(IMPLEMENTATION_AGENT_DEFINITION.tools.includes('ExploreAgent')).toBe(false);

    const availability = listBuiltinAgentDefinitions({
      parentPermissionMode: 'execute',
      tools: [
        testCatalogTool('Read', 'read'),
        testCatalogTool('Glob', 'read'),
        testCatalogTool('Grep', 'read'),
        testCatalogTool('Write', 'file_write'),
        testCatalogTool('Edit', 'file_write'),
        testCatalogTool('Bash', 'shell_unsafe'),
      ],
    }).find((definition) => definition.id === IMPLEMENTATION_AGENT_ID)?.availability;
    expect(availability).toEqual({
      status: 'unavailable',
      reason: 'workspace_isolation_unavailable',
      workspace: AGENT_WORKSPACE_WORKTREE,
      requiredRuntime: 'worktree_child_executor',
    });

    await expectRejects(
      Promise.resolve().then(() => assertAgentDefinitionRunnable({
        parentPermissionMode: 'execute',
        definition: IMPLEMENTATION_AGENT_DEFINITION,
        tools: [
          testCatalogTool('Read', 'read'),
          testCatalogTool('Glob', 'read'),
          testCatalogTool('Grep', 'read'),
          testCatalogTool('Write', 'file_write'),
          testCatalogTool('Edit', 'file_write'),
          testCatalogTool('Bash', 'shell_unsafe'),
        ],
      })),
      /worktree child executor/,
    );
  });

  test('agent definition availability reports missing tools and parent permission mismatches without running', () => {
    expect(evaluateAgentDefinitionAvailability({
      parentPermissionMode: 'ask',
      definition: LOCAL_READ_AGENT_DEFINITION,
      tools: [testCatalogTool('Read', 'read')],
    })).toEqual({
      status: 'unavailable',
      reason: 'missing_tools',
      missingTools: ['Glob', 'Grep'],
    });

    expect(evaluateAgentDefinitionAvailability({
      parentPermissionMode: 'explore',
      definition: {
        ...LOCAL_READ_AGENT_DEFINITION,
        id: 'writer',
        permissionMode: 'execute',
      },
      tools: [
        testCatalogTool('Read', 'read'),
        testCatalogTool('Glob', 'read'),
        testCatalogTool('Grep', 'read'),
      ],
    })).toEqual({
      status: 'unavailable',
      reason: 'parent_permission_mode',
      parentPermissionMode: 'explore',
      requiredPermissionMode: 'execute',
    });
  });

  test('agent definition policy evaluates each tool through allowlist and category policy', () => {
    expect(evaluateAgentDefinitionToolAccess(LOCAL_READ_AGENT_DEFINITION, testCatalogTool('Read', 'read'))).toEqual({
      category: 'read',
      decision: 'allow',
    });
    expect(evaluateAgentDefinitionToolAccess(LOCAL_READ_AGENT_DEFINITION, testCatalogTool('Write', 'file_write'))).toEqual({
      category: 'file_write',
      decision: 'block',
    });
    expect(evaluateAgentDefinitionToolAccess({
      ...LOCAL_READ_AGENT_DEFINITION,
      id: 'web-review',
      tools: ['WebSearch'],
      categoryPolicy: { web_read: 'prompt' },
    }, testCatalogTool('WebSearch', 'web_read'))).toEqual({
      category: 'web_read',
      decision: 'prompt',
    });
  });

  test('agent definition cannot require broader permissions than the parent turn', async () => {
    await expectRejects(
      Promise.resolve().then(() => assertAgentDefinitionRunnable({
        parentPermissionMode: 'explore',
        definition: {
          ...LOCAL_READ_AGENT_DEFINITION,
          id: 'writer',
          permissionMode: 'execute',
        },
        tools: [
          testCatalogTool('Read', 'read'),
          testCatalogTool('Glob', 'read'),
          testCatalogTool('Grep', 'read'),
        ],
      })),
      /cannot run in parent permission mode "explore" because it requires "execute"/,
    );
  });

  test('child agent toolset keeps only built-in profile allowlisted tools', () => {
    const tools = buildChildAgentTools([
      ...buildBuiltinTools(),
      {
        name: AGENT_SPAWN_TOOL_NAME,
        description: 'spawn',
        parameters: {},
        categoryHint: 'subagent',
        impl: async () => ({}),
      },
      {
        name: 'WebSearch',
        description: 'web',
        parameters: {},
        categoryHint: 'web_read',
        impl: async () => ({}),
      },
      {
        name: 'ExploreAgent',
        description: 'deterministic exploration',
        parameters: {},
        categoryHint: 'subagent',
        impl: async () => ({}),
      },
    ]);

    expect(tools.map((tool) => tool.name)).toEqual(['Read', 'Glob', 'Grep', 'WebSearch']);
    expect([...CHILD_AGENT_TOOL_NAMES]).toEqual(['Read', 'Glob', 'Grep', 'WebSearch']);
    expect(tools.some((tool) => tool.name === 'Bash')).toBe(false);
    expect(tools.some((tool) => tool.name === 'Write')).toBe(false);
    expect(tools.some((tool) => tool.name === 'Edit')).toBe(false);
  });

  test('child agent toolset enforces explore-mode read-only behavior without prompting', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-child-tools-'));
    try {
      await writeFile(join(cwd, 'notes.txt'), 'SUBAGENT_CHILD_TOOL_MARKER\n', 'utf8');
      const events: SessionEvent[] = [];
      const runtime = makeChildToolRuntime(cwd);
      const tools = new Map(buildChildAgentTools(buildBuiltinTools()).map((tool) => [tool.name, tool]));

      await runTool(runtime, tools, 'Read', { path: 'notes.txt' }, events);
      await runTool(runtime, tools, 'Glob', { pattern: '*.txt' }, events);
      await runTool(runtime, tools, 'Grep', { pattern: 'SUBAGENT_CHILD_TOOL_MARKER' }, events);

      expect(events.some((event) => event.type === 'permission_request')).toBe(false);
      expect(tools.has('Bash')).toBe(false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test('agent_spawn delegates an explicit profile and task through the narrow context capability', async () => {
    const tool = buildSubagentSpawnTool();
    const abortController = new AbortController();
    const calls: unknown[] = [];

    const result = await tool.impl({
      profile: LOCAL_READ_AGENT_PROFILE,
      task: 'Inspect the runtime tests.',
    }, {
      sessionId: 'session-1',
      turnId: 'parent-turn',
      cwd: '/tmp/cwd',
      toolCallId: 'tool-1',
      abortSignal: abortController.signal,
      emitOutput: () => {},
      spawnChildAgent: async (input) => {
        calls.push(input);
        return {
          agentId: input.spec.id,
          agentName: input.spec.name,
          turnId: 'child-turn',
          status: 'completed',
          permissionMode: 'explore',
          summary: 'done',
          artifactIds: [],
        };
      },
    });

    expect(tool.name).toBe(AGENT_SPAWN_TOOL_NAME);
    expect(tool.categoryHint).toBe('subagent');
    expect(tool.permissionRequired).toBe(true);
    expect(calls).toEqual([{
      spec: {
        id: LOCAL_READ_AGENT_ID,
        name: 'Local Read',
        systemPrompt: LOCAL_READ_AGENT_DEFINITION.systemPrompt,
      },
      prompt: 'Inspect the runtime tests.',
    }]);
    expect(result).toEqual({
      kind: 'subagent',
      agentId: LOCAL_READ_AGENT_ID,
      agentName: 'Local Read',
      turnId: 'child-turn',
      status: 'completed',
      permissionMode: 'explore',
      summary: 'done',
      artifactIds: [],
    });
  });

  test('agent_spawn delegates web_research through the catalog definition', async () => {
    const tool = buildSubagentSpawnTool();
    const calls: unknown[] = [];

    const result = await tool.impl({
      profile: WEB_RESEARCH_AGENT_PROFILE,
      task: 'Find current sources.',
      write_back: AGENT_WRITE_BACK_SUMMARY,
      isolation: AGENT_WORKSPACE_SAME_WORKSPACE,
    }, {
      sessionId: 'session-1',
      turnId: 'parent-turn',
      cwd: '/tmp/cwd',
      toolCallId: 'tool-1',
      abortSignal: new AbortController().signal,
      emitOutput: () => {},
      spawnChildAgent: async (input) => {
        calls.push(input);
        return {
          agentId: input.spec.id,
          agentName: input.spec.name,
          turnId: 'child-turn',
          status: 'completed',
          permissionMode: 'execute',
          summary: 'done',
          artifactIds: [],
        };
      },
    });

    expect(calls).toEqual([{
      spec: {
        id: WEB_RESEARCH_AGENT_ID,
        name: 'Web Research',
        systemPrompt: WEB_RESEARCH_AGENT_DEFINITION.systemPrompt,
      },
      prompt: 'Find current sources.',
    }]);
    expect(result).toMatchObject({
      kind: 'subagent',
      agentId: WEB_RESEARCH_AGENT_ID,
      agentName: 'Web Research',
      permissionMode: 'execute',
    });
  });

  test('agent_spawn validates profile contracts and rejects unavailable worktree agents before spawning', async () => {
    const tool = buildSubagentSpawnTool();
    const schema = tool.parameters as {
      safeParse(input: unknown): { success: boolean; data?: unknown };
    };

    expect(schema.safeParse({ profile: LOCAL_READ_AGENT_PROFILE, task: 'Inspect the repo.' }).success).toBe(true);
    expect(schema.safeParse({ profile: WEB_RESEARCH_AGENT_PROFILE, task: 'Find current sources.' }).success).toBe(true);
    expect(schema.safeParse({
      profile: IMPLEMENTATION_AGENT_PROFILE,
      task: 'Edit the repo.',
      write_back: AGENT_WRITE_BACK_PATCH,
      isolation: AGENT_WORKSPACE_WORKTREE,
    })).toEqual({
      success: true,
      data: {
        profile: IMPLEMENTATION_AGENT_PROFILE,
        task: 'Edit the repo.',
        write_back: AGENT_WRITE_BACK_PATCH,
        isolation: AGENT_WORKSPACE_WORKTREE,
      },
    });
    expect(schema.safeParse({
      profile: LOCAL_READ_AGENT_PROFILE,
      task: 'Inspect the repo.',
      write_back: AGENT_WRITE_BACK_SUMMARY,
      isolation: AGENT_WORKSPACE_SAME_WORKSPACE,
    })).toEqual({
      success: true,
      data: {
        profile: LOCAL_READ_AGENT_PROFILE,
        task: 'Inspect the repo.',
        write_back: AGENT_WRITE_BACK_SUMMARY,
        isolation: AGENT_WORKSPACE_SAME_WORKSPACE,
      },
    });
    expect(schema.safeParse({
      profile: LOCAL_READ_AGENT_PROFILE,
      task: 'Inspect the repo.',
      write_back: 'patch',
    }).success).toBe(false);
    expect(schema.safeParse({
      profile: LOCAL_READ_AGENT_PROFILE,
      task: 'Inspect the repo.',
      isolation: 'worktree',
    }).success).toBe(false);
    expect(schema.safeParse({
      profile: IMPLEMENTATION_AGENT_PROFILE,
      task: 'Edit the repo.',
      write_back: AGENT_WRITE_BACK_SUMMARY,
      isolation: AGENT_WORKSPACE_WORKTREE,
    }).success).toBe(false);
    expect(schema.safeParse({
      profile: IMPLEMENTATION_AGENT_PROFILE,
      task: 'Edit the repo.',
      write_back: AGENT_WRITE_BACK_PATCH,
      isolation: AGENT_WORKSPACE_SAME_WORKSPACE,
    }).success).toBe(false);
    expect(schema.safeParse({ agent: LOCAL_READ_AGENT_ID, task: 'Inspect the repo.' }).success).toBe(false);
    expect(schema.safeParse({ profile: LOCAL_READ_AGENT_ID, task: 'Inspect the repo.' }).success).toBe(false);
    expect(schema.safeParse({ profile: WEB_RESEARCH_AGENT_ID, task: 'Find current sources.' }).success).toBe(false);
    expect(schema.safeParse({ agent_name: 'Researcher', instructions: 'Read only.', prompt: 'Inspect.' }).success).toBe(false);

    await expectRejects(
      Promise.resolve(tool.impl({
        profile: IMPLEMENTATION_AGENT_PROFILE,
        task: 'Edit files.',
        write_back: AGENT_WRITE_BACK_PATCH,
        isolation: AGENT_WORKSPACE_WORKTREE,
      }, {
        sessionId: 'session-1',
        turnId: 'parent-turn',
        cwd: '/tmp/cwd',
        toolCallId: 'tool-1',
        abortSignal: new AbortController().signal,
        emitOutput: () => {},
        spawnChildAgent: async () => {
          throw new Error('spawn should not be called');
        },
      })),
      /worktree child executor/,
    );
  });

  test('agent projection tools delegate through read-only context capabilities', async () => {
    const listTool = buildSubagentListTool();
    const outputTool = buildSubagentOutputTool();

    const list = await listTool.impl({}, {
      sessionId: 'session-1',
      turnId: 'parent-turn',
      cwd: '/tmp/cwd',
      toolCallId: 'tool-list',
      abortSignal: new AbortController().signal,
      emitOutput: () => {},
      listChildAgents: async () => ({
        definitions: [{ id: LOCAL_READ_AGENT_ID }],
        runs: [{ runId: 'child-run', turnId: 'child-turn' }],
      }),
    });
    const output = await outputTool.impl({ run_id: 'child-run' }, {
      sessionId: 'session-1',
      turnId: 'parent-turn',
      cwd: '/tmp/cwd',
      toolCallId: 'tool-output',
      abortSignal: new AbortController().signal,
      emitOutput: () => {},
      readChildAgentOutput: async (input) => ({ requested: input }),
    });

    expect(listTool.name).toBe(AGENT_LIST_TOOL_NAME);
    expect(outputTool.name).toBe(AGENT_OUTPUT_TOOL_NAME);
    expect(listTool.permissionRequired).toBe(false);
    expect(outputTool.permissionRequired).toBe(false);
    expect(list).toEqual({
      definitions: [{ id: LOCAL_READ_AGENT_ID }],
      runs: [{ runId: 'child-run', turnId: 'child-turn' }],
    });
    expect(output).toEqual({ requested: { runId: 'child-run' } });
  });

  test('agent_output requires exactly one run locator', () => {
    const outputTool = buildSubagentOutputTool();
    const schema = outputTool.parameters as { safeParse(input: unknown): { success: boolean } };

    expect(schema.safeParse({ run_id: 'child-run' }).success).toBe(true);
    expect(schema.safeParse({ turn_id: 'child-turn' }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ run_id: 'child-run', turn_id: 'child-turn' }).success).toBe(false);
  });
});

function makeChildToolRuntime(cwd: string): ToolRuntime {
  const permissionEngine = new PermissionEngine({ newId: nextId(), now: () => 1 });
  permissionEngine.beginTurn('child-turn');
  return new ToolRuntime({
    sessionId: 'session-1',
    header: childHeader(cwd),
    connection: testConnection(),
    modelId: 'mock-model',
    appendMessage: async () => {},
    permissionEngine,
    newId: nextId(),
    now: () => 1,
    getPermissionPauseTarget: () => null,
  });
}

async function runTool(
  runtime: ToolRuntime,
  tools: Map<string, MakaTool>,
  name: string,
  args: unknown,
  events: SessionEvent[],
): Promise<unknown> {
  const tool = tools.get(name);
  if (!tool) throw new Error(`Missing child tool ${name}`);
  return await runtime.wrapToolExecute(tool, 'child-turn', {
    push: (event) => events.push(event),
  })(args, {
    toolCallId: `tool-${name}-${typeof args === 'object' && args && 'command' in args ? (args as { command: string }).command : 'read'}`,
    abortSignal: new AbortController().signal,
  });
}

function testCatalogTool(name: string, categoryHint: MakaTool['categoryHint']): MakaTool {
  return {
    name,
    description: name,
    parameters: {},
    categoryHint,
    impl: async () => ({}),
  };
}

async function expectRejects(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error instanceof Error ? error.message : String(error)).toMatch(pattern);
    return;
  }
  throw new Error('Expected promise to reject');
}

function childHeader(cwd: string): SessionHeader {
  return {
    id: 'session-1',
    workspaceRoot: cwd,
    cwd,
    createdAt: 1,
    lastUsedAt: 1,
    name: 'Test',
    isFlagged: false,
    labels: [],
    isArchived: false,
    status: 'active',
    statusUpdatedAt: 1,
    hasUnread: false,
    backend: 'ai-sdk',
    llmConnectionSlug: 'anthropic-main',
    connectionLocked: true,
    model: 'mock-model',
    permissionMode: 'explore',
    schemaVersion: 1,
  };
}

function testConnection(): LlmConnection {
  return {
    slug: 'anthropic-main',
    name: 'Anthropic',
    providerType: 'anthropic',
    defaultModel: 'mock-model',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

function nextId(): () => string {
  let id = 0;
  return () => `id-${++id}`;
}
