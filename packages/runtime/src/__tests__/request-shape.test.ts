import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  canonicalizeToolSet,
  toolSchemaCharsForDiagnostics,
  computeRequestShapeDiagnostic,
} from '../request-shape.js';
import type { MakaTool } from '../tool-runtime.js';

function tool(name: string): MakaTool {
  return {
    name,
    description: name,
    parameters: {},
    impl: () => ({}),
  };
}

const invalid = tool('invalid');

describe('canonicalizeToolSet active allow-list', () => {
  test('a tool absent from the active set is withheld; the set drives visibility', () => {
    const { activeTools } = canonicalizeToolSet(
      [tool('Read'), tool('Rive'), tool('load_tools')],
      invalid,
      new Set(['Read', 'load_tools']),
    );
    assert.ok(activeTools.includes('Read'), 'Read is in the active set');
    assert.ok(activeTools.includes('load_tools'), 'load_tools is in the active set');
    assert.ok(!activeTools.includes('Rive'), 'Rive is absent from the active set, so hidden');
  });

  test('a tool becomes active once it is in the active set', () => {
    const { activeTools } = canonicalizeToolSet(
      [tool('Read'), tool('Rive')],
      invalid,
      new Set(['Read', 'Rive']),
    );
    assert.ok(activeTools.includes('Rive'), 'Rive is now in the active set');
  });

  test('providerTools keeps the full registry for dispatch; invalid present but not advertised', () => {
    const { providerTools, activeTools } = canonicalizeToolSet(
      [tool('Read'), tool('Rive')],
      invalid,
      new Set(['Read']),
    );
    const names = providerTools.map((t) => t.name);
    assert.ok(names.includes('Read'));
    assert.ok(names.includes('Rive'), 'a hidden tool stays dispatchable in providerTools');
    assert.ok(names.includes('invalid'), 'repair target present in providerTools');
    assert.ok(!activeTools.includes('invalid'), 'invalid is never advertised to the model');
  });

  test('omitting the active set advertises every visible tool (full surface), names sorted', () => {
    const { activeTools } = canonicalizeToolSet([tool('Write'), tool('Read')], invalid);
    assert.deepEqual(activeTools, ['Read', 'Write']);
  });
});

describe('diagnostics measure the provider-visible (active) tool subset', () => {
  const connection = { providerType: 'openai', slug: 'c' } as never;

  function rich(name: string, schema: unknown): MakaTool {
    return { name, description: name, parameters: schema, impl: () => ({}) };
  }

  function diag(
    providerTools: MakaTool[],
    activeTools: string[],
    prior?: ReturnType<typeof computeRequestShapeDiagnostic>,
  ) {
    return computeRequestShapeDiagnostic(
      {
        connection,
        modelId: 'm',
        systemPrompt: 's',
        providerOptions: {},
        providerTools,
        activeTools,
        priorMessages: [],
      },
      prior,
    );
  }

  test('char count excludes an inactive tool schema', () => {
    const tools = [rich('Read', { a: 1 }), rich('Rive', { big: 'x'.repeat(500) })];
    const withoutRive = toolSchemaCharsForDiagnostics(tools, ['Read']);
    const withRive = toolSchemaCharsForDiagnostics(tools, ['Read', 'Rive']);
    assert.ok(
      withRive > withoutRive + 400,
      'activating Rive should add its schema chars to the count',
    );
  });

  test('toolSchemaHash ignores an INACTIVE tool schema change', () => {
    const a = [rich('Read', { a: 1 }), rich('Rive', { v: 1 })];
    const b = [rich('Read', { a: 1 }), rich('Rive', { v: 2 })];
    assert.equal(
      diag(a, ['Read']).componentHashes.toolSchemaHash,
      diag(b, ['Read']).componentHashes.toolSchemaHash,
      'a change to an unadvertised schema must not move the hash',
    );
  });

  test('activating a hidden tool moves toolSchemaHash and reports tool_schema_changed', () => {
    const tools = [rich('Read', { a: 1 }), rich('Rive', { v: 1 })];
    const before = diag(tools, ['Read']);
    const after = diag(tools, ['Read', 'Rive'], before);
    assert.notEqual(after.componentHashes.toolSchemaHash, before.componentHashes.toolSchemaHash);
    assert.equal(after.prefixChangeReason, 'tool_schema_changed');
  });
});
