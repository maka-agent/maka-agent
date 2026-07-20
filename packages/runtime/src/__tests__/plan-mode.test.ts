import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { selectCollaborationTools } from '../plan-mode.js';
import type { MakaTool } from '../tool-runtime.js';

describe('Plan Mode tool surface', () => {
  test('keeps read tools and plan controls while removing writes and subagents', () => {
    const selected = selectCollaborationTools({
      mode: 'plan',
      hasActiveExecution: false,
      tools: [
        tool('Read', 'read'),
        tool('WebSearch', 'web_read'),
        tool('Write', 'file_write'),
        tool('ExploreAgent', 'subagent'),
        tool('AskUserQuestion'),
        tool('SubmitPlan'),
        tool('update_plan'),
      ],
    });
    assert.deepEqual(
      selected.map((tool) => tool.name),
      ['Read', 'WebSearch', 'AskUserQuestion', 'SubmitPlan'],
    );
  });

  test('active execution exposes progress controls and removes subagents', () => {
    const selected = selectCollaborationTools({
      mode: 'agent',
      hasActiveExecution: true,
      tools: [
        tool('Write', 'file_write'),
        tool('ExploreAgent', 'subagent'),
        tool('SubmitPlan'),
        tool('update_plan'),
        tool('cancel_plan'),
      ],
    });
    assert.deepEqual(
      selected.map((tool) => tool.name),
      ['Write', 'update_plan', 'cancel_plan'],
    );
  });
});

function tool(name: string, categoryHint?: MakaTool['categoryHint']): MakaTool {
  return {
    name,
    description: name,
    parameters: {},
    ...(categoryHint ? { categoryHint } : {}),
    impl: () => null,
  };
}
