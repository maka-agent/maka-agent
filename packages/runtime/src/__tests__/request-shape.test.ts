import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  canonicalizeToolSet,
  toolSchemaCharsForDiagnostics,
  computeRequestShapeDiagnostic,
} from '../request-shape.js';
import type { MakaTool } from '../tool-runtime.js';

function tool(name: string, exposure?: 'direct' | 'deferred'): MakaTool {
  return {
    name,
    description: name,
    parameters: {},
    impl: () => ({}),
    ...(exposure ? { exposure } : {}),
  };
}

const invalid = tool('invalid');

describe('canonicalizeToolSet exposure gating', () => {
  test('direct tools are active; a deferred tool is excluded when not loaded', () => {
    const { activeTools } = canonicalizeToolSet(
      [tool('Read'), tool('Rive', 'deferred'), tool('load_tool')],
      invalid,
    );
    assert.ok(activeTools.includes('Read'), 'direct Read should be active');
    assert.ok(activeTools.includes('load_tool'), 'load_tool should be active');
    assert.ok(!activeTools.includes('Rive'), 'unloaded deferred Rive should be hidden');
  });

  test('a deferred tool becomes active once it is in the loaded set', () => {
    const { activeTools } = canonicalizeToolSet(
      [tool('Read'), tool('Rive', 'deferred')],
      invalid,
      new Set(['Rive']),
    );
    assert.ok(activeTools.includes('Rive'), 'loaded deferred Rive should be active');
  });

  test('providerTools keeps the full registry for dispatch; invalid present but not advertised', () => {
    const { providerTools, activeTools } = canonicalizeToolSet(
      [tool('Read'), tool('Rive', 'deferred')],
      invalid,
    );
    const names = providerTools.map((t) => t.name);
    assert.ok(names.includes('Read'));
    assert.ok(names.includes('Rive'), 'deferred tool stays dispatchable in providerTools');
    assert.ok(names.includes('invalid'), 'repair target present in providerTools');
    assert.ok(!activeTools.includes('invalid'), 'invalid is never advertised to the model');
  });

  test('omitting exposure means direct (backward compatible), names sorted', () => {
    const { activeTools } = canonicalizeToolSet([tool('Write'), tool('Read')], invalid);
    assert.deepEqual(activeTools, ['Read', 'Write']);
  });
});

describe('diagnostics measure the provider-visible (active) tool subset', () => {
  const connection = { providerType: 'openai', slug: 'c' } as never;

  function rich(name: string, exposure: 'direct' | 'deferred', schema: unknown): MakaTool {
    return { name, description: name, parameters: schema, impl: () => ({}), exposure };
  }

  function diag(providerTools: MakaTool[], activeTools: string[], prior?: ReturnType<typeof computeRequestShapeDiagnostic>) {
    return computeRequestShapeDiagnostic(
      { connection, modelId: 'm', systemPrompt: 's', providerOptions: {}, providerTools, activeTools, priorMessages: [] },
      prior,
    );
  }

  test('char count excludes an inactive deferred tool schema', () => {
    const tools = [rich('Read', 'direct', { a: 1 }), rich('Rive', 'deferred', { big: 'x'.repeat(500) })];
    const withoutRive = toolSchemaCharsForDiagnostics(tools, ['Read']);
    const withRive = toolSchemaCharsForDiagnostics(tools, ['Read', 'Rive']);
    assert.ok(withRive > withoutRive + 400, 'activating Rive should add its schema chars to the count');
  });

  test('toolSchemaHash ignores an INACTIVE deferred tool schema change', () => {
    const a = [rich('Read', 'direct', { a: 1 }), rich('Rive', 'deferred', { v: 1 })];
    const b = [rich('Read', 'direct', { a: 1 }), rich('Rive', 'deferred', { v: 2 })];
    assert.equal(
      diag(a, ['Read']).componentHashes.toolSchemaHash,
      diag(b, ['Read']).componentHashes.toolSchemaHash,
      'a change to an unadvertised deferred schema must not move the hash',
    );
  });

  test('loading a deferred tool moves toolSchemaHash and reports tool_schema_changed', () => {
    const tools = [rich('Read', 'direct', { a: 1 }), rich('Rive', 'deferred', { v: 1 })];
    const before = diag(tools, ['Read']);
    const after = diag(tools, ['Read', 'Rive'], before);
    assert.notEqual(after.componentHashes.toolSchemaHash, before.componentHashes.toolSchemaHash);
    assert.equal(after.prefixChangeReason, 'tool_schema_changed');
  });
});
