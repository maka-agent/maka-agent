import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import type { ZodTypeAny } from 'zod';
import { getExpertTeam, materializeExpertAgentDefinition } from '../expert-catalog.js';
import {
  EXPERT_DISPATCH_TOOL_NAME,
  buildExpertDispatchTool,
  buildExpertDispatchToolForTeamId,
} from '../expert-tools.js';
import { expect } from '../test-helpers.js';

const CODE_REVIEW = getExpertTeam('code-review')!;

function fakeCtx(calls: unknown[], result?: Record<string, unknown>) {
  const abortController = new AbortController();
  return {
    sessionId: 'session-1',
    turnId: 'lead-turn',
    cwd: '/tmp/cwd',
    toolCallId: 'tool-1',
    abortSignal: abortController.signal,
    emitOutput: () => {},
    spawnChildAgent: async (input: unknown) => {
      calls.push(input);
      const spec = (input as { spec: { id: string; name: string } }).spec;
      return {
        agentId: spec.id,
        agentName: spec.name,
        turnId: 'child-turn',
        status: 'completed',
        permissionMode: 'explore',
        summary: 'reviewed',
        artifactIds: ['artifact-1'],
        ...result,
      };
    },
  };
}

describe('expert_dispatch tool', () => {
  test('exposes a member enum and roster description bound to the team', () => {
    const tool = buildExpertDispatchTool(CODE_REVIEW);
    expect(tool.name).toBe(EXPERT_DISPATCH_TOOL_NAME);
    expect(tool.permissionRequired).toBe(true);
    expect(tool.categoryHint).toBe('subagent');
    expect(tool.description).toContain('correctness-reviewer');
    expect(tool.description).toContain('Code Review Team');
    // The member param is a closed enum of the team's members.
    const parsed = (tool.parameters as ZodTypeAny).safeParse({ member: 'not-a-member', task: 'x' });
    expect(parsed.success).toBe(false);
  });

  test('dispatches a member through spawnChildAgent with the materialized spec', async () => {
    const tool = buildExpertDispatchTool(CODE_REVIEW);
    const calls: unknown[] = [];
    const member = CODE_REVIEW.members[0]!;
    const def = materializeExpertAgentDefinition(CODE_REVIEW, member);

    const result = await tool.impl(
      { member: member.id, task: 'Review the diff in src/foo.ts.' },
      fakeCtx(calls) as never,
    );

    expect(calls).toEqual([
      {
        spec: {
          id: 'expert:code-review:correctness-reviewer',
          name: def.name,
          systemPrompt: def.systemPrompt,
        },
        prompt: 'Review the diff in src/foo.ts.',
      },
    ]);
    expect(result).toMatchObject({
      kind: 'subagent',
      agentId: 'expert:code-review:correctness-reviewer',
      agentName: 'Correctness Reviewer',
      status: 'completed',
      summary: 'reviewed',
    });
    expect((result as { artifactIds: string[] }).artifactIds).toEqual(['artifact-1']);
  });

  test('supports concurrent dispatch of independent members', async () => {
    const tool = buildExpertDispatchTool(CODE_REVIEW);
    const calls: unknown[] = [];
    const ctx = fakeCtx(calls) as never;

    const results = await Promise.all([
      tool.impl({ member: 'correctness-reviewer', task: 'a' }, ctx),
      tool.impl({ member: 'simplification-reviewer', task: 'b' }, ctx),
      tool.impl({ member: 'test-coverage-reviewer', task: 'c' }, ctx),
    ]);

    expect(results).toHaveLength(3);
    expect(calls).toHaveLength(3);
    const dispatchedIds = calls.map((call) => (call as { spec: { id: string } }).spec.id);
    expect(dispatchedIds).toEqual([
      'expert:code-review:correctness-reviewer',
      'expert:code-review:simplification-reviewer',
      'expert:code-review:test-coverage-reviewer',
    ]);
  });

  test('fails clearly when the runtime lacks the spawnChildAgent capability', async () => {
    const tool = buildExpertDispatchTool(CODE_REVIEW);
    await assert.rejects(
      async () => {
        await tool.impl(
          { member: 'correctness-reviewer', task: 'x' },
          {
            sessionId: 's',
            turnId: 't',
            cwd: '/tmp',
            toolCallId: 'c',
            abortSignal: new AbortController().signal,
            emitOutput: () => {},
          } as never,
        );
      },
      /spawnChildAgent capability is unavailable/,
    );
  });

  test('builds a tool by team id and returns undefined for unknown teams', () => {
    expect(buildExpertDispatchToolForTeamId('code-review')?.name).toBe(EXPERT_DISPATCH_TOOL_NAME);
    expect(buildExpertDispatchToolForTeamId('no-such-team')).toBeUndefined();
  });
});
