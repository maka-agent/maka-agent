/**
 * Registry-driven provider conformance matrix — generative execution.
 *
 * This suite interprets {@link PROVIDER_CONTRACT_MATRIX_PLAN}: it does not carry
 * a hard-coded provider list. For every (provider, dimension) cell the plan
 * derives from the registry, one of three things happens here:
 *
 *   - `generated`      a parametric wire test is executed against a scripted
 *                      local HTTP server (discovery, exact-model-id, tool-loop,
 *                      reasoning-replay), driven entirely by the derived cell.
 *   - `override`       the cell is asserted to have a named entry in
 *                      {@link OVERRIDE_REGISTRY}, each pointing at the
 *                      hand-written test in `provider-conformance.test.ts` that
 *                      owns the provider-specific contract.
 *   - `not-applicable` the machine-readable reason is asserted, and any reverse
 *                      assertion (e.g. fallback discovery must not call /models)
 *                      is executed.
 *
 * The gap report (`test('no contract gaps ...')`) fails loudly, listing
 * provider + dimension + what is missing, whenever a ready provider's dimension
 * satisfies none of the three states — this is Phase 7's gap reporting.
 *
 * This file is purely additive. It does not modify or replace the hand-written
 * `provider-conformance.test.ts`; overlapping coverage is intentional.
 */

import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { after, describe, test } from 'node:test';
import type { LlmConnection } from '@maka/core';
import {
  PROVIDER_CONTRACT_MATRIX_PLAN,
  listProviderContractCells,
  type ProviderContractRow,
  type ProviderContractGeneratedCell,
  type ProviderContractWire,
} from '@maka/core';
import { generateText, stepCountIs, tool } from 'ai';
import { z } from 'zod';
import { fetchProviderModels } from '../model-fetcher.js';
import { getAIModel } from '../model-factory.js';

const REASONING_TEXT = 'I should call echo with the requested text.';
const FINAL_TEXT = 'Echoed hello.';
const API_KEY = 'contract-matrix-test-key';

const plan = PROVIDER_CONTRACT_MATRIX_PLAN;

const servers: Array<{ close(): Promise<void> }> = [];

after(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

/**
 * Named overrides. Each key is a plan `overrideKey` (`${providerType}:${dimension}`)
 * and each value points at the hand-written test in `provider-conformance.test.ts`
 * that owns the provider-specific contract the plan cannot generate. A missing
 * key here surfaces as a contract gap.
 */
const OVERRIDE_REGISTRY: Readonly<Record<string, string>> = {
  'cohere:discovery':
    'provider-conformance.test.ts — "Cohere paginates account models and completes its native V2 tool-call loop"',
  'fireworks-ai:discovery':
    'provider-conformance.test.ts — "Fireworks discovers exact serverless model paths and completes a two-stage tool-call loop"',
  'ollama:discovery':
    'provider-conformance.test.ts — "Ollama preserves an exact ... through local discovery and a no-secret tool-call loop"',
  'github-copilot:discovery':
    'provider-conformance.test.ts — "GitHub Copilot discovers the account model and completes a reasoning tool loop on its exact wire"',
  'github-copilot:exact-model-id':
    'provider-conformance.test.ts — "GitHub Copilot discovers the account model and completes a reasoning tool loop on its exact wire"',
  'github-copilot:tool-loop':
    'provider-conformance.test.ts — "GitHub Copilot discovers the account model and completes a reasoning tool loop on its exact wire"',
  'github-copilot:reasoning-replay':
    'provider-conformance.test.ts — "GitHub Copilot discovers the account model and completes a reasoning tool loop on its exact wire"',
  'zenmux:reasoning-replay':
    'provider-conformance.test.ts — "ZenMux replays signed reasoning details in the streamed runtime tool loop"',
};

const KNOWN_WIRES: ReadonlySet<ProviderContractWire> = new Set([
  'openai-chat',
  'anthropic-messages',
  'google-generate',
  'cohere-v2',
]);

describe('provider conformance matrix — gap report', () => {
  test('no contract gaps: every ready provider dimension is generated, overridden, or justified N/A', () => {
    const gaps: string[] = [];
    for (const { providerType, dimension, cell } of listProviderContractCells(plan)) {
      const where = `${providerType} · ${dimension}`;
      switch (cell.state) {
        case 'generated':
          if (dimension === 'discovery') {
            if (!cell.discovery) gaps.push(`${where}: generated discovery cell is missing its derived plan`);
          } else if (!cell.wire || !KNOWN_WIRES.has(cell.wire)) {
            gaps.push(`${where}: generated wire cell has no executable wire (${String(cell.wire)})`);
          }
          break;
        case 'override':
          if (!OVERRIDE_REGISTRY[cell.overrideKey]) {
            gaps.push(`${where}: no named override registered for key "${cell.overrideKey}"`);
          }
          break;
        case 'not-applicable':
          if (!cell.reason) gaps.push(`${where}: not-applicable cell is missing a machine-readable reason`);
          break;
        default:
          gaps.push(`${where}: unknown cell state`);
      }
    }
    assert.deepEqual(gaps, [], `provider contract gaps found:\n  ${gaps.join('\n  ')}`);
  });

  test('every registered override maps to a real override cell in the plan', () => {
    const overrideKeys = new Set(
      listProviderContractCells(plan)
        .filter((entry) => entry.cell.state === 'override')
        .map((entry) => (entry.cell.state === 'override' ? entry.cell.overrideKey : '')),
    );
    for (const key of Object.keys(OVERRIDE_REGISTRY)) {
      assert.ok(overrideKeys.has(key), `override registry key "${key}" has no matching override cell`);
    }
  });
});

describe('provider conformance matrix — override cells reference a named hand-written test', () => {
  for (const { providerType, dimension, cell } of listProviderContractCells(plan)) {
    if (cell.state !== 'override') continue;
    test(`${providerType} · ${dimension} · override → ${cell.overrideKey}`, () => {
      const reference = OVERRIDE_REGISTRY[cell.overrideKey];
      assert.ok(reference, `expected a named override for ${cell.overrideKey}`);
      assert.ok(reference.length > 0);
    });
  }
});

describe('provider conformance matrix — discovery', () => {
  for (const row of plan.rows) {
    const cell = row.cells.discovery;
    if (cell.state === 'generated' && cell.discovery) {
      test(`${row.providerType} · discovery · generated (${cell.discovery.protocol})`, async () => {
        await runGeneratedDiscovery(row, cell as ProviderContractGeneratedCell & { discovery: NonNullable<ProviderContractGeneratedCell['discovery']> });
      });
    } else if (cell.state === 'not-applicable' && cell.reverseAssertion === 'must-not-request-models-endpoint') {
      test(`${row.providerType} · discovery · N/A (${cell.reason}) does not call /models`, async () => {
        await assertFallbackDiscoveryMakesNoRequest(row);
      });
    }
  }
});

describe('provider conformance matrix — wire (exact-model-id + tool-loop + reasoning-replay)', () => {
  for (const row of plan.rows) {
    const wireDims = (['exact-model-id', 'tool-loop', 'reasoning-replay'] as const)
      .filter((dimension) => row.cells[dimension].state === 'generated');
    if (wireDims.length === 0) continue;
    const wire = wireOfRow(row);
    test(`${row.providerType} · ${wire} · ${wireDims.join(' + ')}`, async () => {
      await runGeneratedWire(row, wireDims);
    });
  }
});

// ---------------------------------------------------------------------------
// Generated discovery execution
// ---------------------------------------------------------------------------

async function runGeneratedDiscovery(
  row: ProviderContractRow,
  cell: ProviderContractGeneratedCell & { discovery: NonNullable<ProviderContractGeneratedCell['discovery']> },
): Promise<void> {
  const sample = row.sampleModelId;
  const { protocol, filter } = cell.discovery;
  let requestCount = 0;
  const server = await startJsonServer((request, response) => {
    requestCount += 1;
    assert.equal(request.method, 'GET', `${row.providerType} discovery must GET the model list`);
    respondJson(response, 200, discoveryPayload(protocol, sample, filter));
  });
  const connection = baseConnection(row, server.url);
  const models = await fetchProviderModels(connection, API_KEY);
  assert.ok(requestCount >= 1, `${row.providerType} discovery must request the model list`);
  assert.deepEqual(
    models.map((model) => model.id),
    [sample],
    `${row.providerType} discovery should return exactly the scripted exact id`,
  );
}

function discoveryPayload(
  protocol: string,
  sample: string,
  filter: string | undefined,
): unknown {
  if (protocol === 'anthropic') return { data: [{ id: sample }] };
  if (protocol === 'google') return { models: [{ name: `models/${sample}` }] };
  // openai protocol — shape the survivor + a decoy the filter must drop.
  if (filter === 'tool-capable') {
    return {
      object: 'list',
      data: [
        { id: sample, providers: [{ status: 'live', supports_tools: true }] },
        { id: 'contract-decoy-no-tools', providers: [{ status: 'live', supports_tools: false }] },
      ],
    };
  }
  if (filter === 'language-models') {
    return {
      object: 'list',
      data: [
        { id: sample, type: 'language' },
        { id: 'contract-decoy-embedding', type: 'embedding' },
      ],
    };
  }
  if (filter === 'fallback-models') {
    return {
      object: 'list',
      data: [
        { id: sample },
        { id: 'contract-decoy-not-in-fallback' },
      ],
    };
  }
  return { object: 'list', data: [{ id: sample }] };
}

async function assertFallbackDiscoveryMakesNoRequest(row: ProviderContractRow): Promise<void> {
  let requestCount = 0;
  const server = await startJsonServer((_request, response) => {
    requestCount += 1;
    respondJson(response, 500, { error: 'fallback discovery must not reach the network' });
  });
  const connection = baseConnection(row, server.url);
  const models = await fetchProviderModels(connection, API_KEY);
  assert.equal(requestCount, 0, `${row.providerType} fallback discovery must not request any endpoint`);
  assert.ok(models.length > 0, `${row.providerType} fallback discovery should return the static snapshot`);
  assert.ok(
    models.some((model) => model.id === row.sampleModelId),
    `${row.providerType} fallback snapshot should include its sample model`,
  );
}

// ---------------------------------------------------------------------------
// Generated wire execution
// ---------------------------------------------------------------------------

function wireOfRow(row: ProviderContractRow): ProviderContractWire {
  for (const dimension of ['tool-loop', 'exact-model-id', 'reasoning-replay'] as const) {
    const cell = row.cells[dimension];
    if (cell.state === 'generated' && cell.wire) return cell.wire;
  }
  throw new Error(`${row.providerType} has no generated wire cell`);
}

async function runGeneratedWire(
  row: ProviderContractRow,
  wireDims: ReadonlyArray<'exact-model-id' | 'tool-loop' | 'reasoning-replay'>,
): Promise<void> {
  const wire = wireOfRow(row);
  const wantsReasoning = wireDims.includes('reasoning-replay');
  const replayCell = row.cells['reasoning-replay'];
  const replayField = replayCell.state === 'generated' && replayCell.reasoningReplay
    ? replayCell.reasoningReplay.replayField
    : undefined;
  switch (wire) {
    case 'openai-chat':
      return runOpenAiChatWire(row, wantsReasoning, replayField);
    case 'anthropic-messages':
      return runAnthropicMessagesWire(row);
    case 'google-generate':
      return runGoogleGenerateWire(row);
    case 'cohere-v2':
      return runCohereV2Wire(row);
  }
}

const echoTool = tool({
  description: 'Echo text',
  inputSchema: z.object({ text: z.string() }),
  execute: async ({ text }) => ({ echoed: text }),
});

async function runOpenAiChatWire(
  row: ProviderContractRow,
  wantsReasoning: boolean,
  replayField: 'reasoning' | 'reasoning_content' | undefined,
): Promise<void> {
  const sample = row.sampleModelId;
  const requestBodies: Array<Record<string, unknown>> = [];
  const server = await startJsonServer(async (request, response) => {
    assert.equal(request.method, 'POST');
    const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
    requestBodies.push(body);
    if (requestBodies.length === 1) {
      respondJson(response, 200, {
        id: 'chatcmpl-tool',
        object: 'chat.completion',
        created: 1,
        model: sample,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            ...(wantsReasoning ? { reasoning_content: REASONING_TEXT } : {}),
            tool_calls: [{
              id: 'call_echo',
              type: 'function',
              function: { name: 'echo', arguments: '{"text":"hello"}' },
            }],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
      });
      return;
    }
    respondJson(response, 200, {
      id: 'chatcmpl-final',
      object: 'chat.completion',
      created: 2,
      model: sample,
      choices: [{ index: 0, message: { role: 'assistant', content: FINAL_TEXT }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
    });
  });
  const connection = baseConnection(row, server.url);
  const result = await generateText({
    model: getAIModel({ connection, apiKey: API_KEY, modelId: sample }),
    prompt: 'Call echo with hello.',
    stopWhen: stepCountIs(2),
    tools: { echo: echoTool },
  });

  assert.equal(requestBodies.length, 2, `${row.providerType} should make two chat requests`);
  assert.deepEqual(
    requestBodies.map((body) => body.model),
    [sample, sample],
    `${row.providerType} must send the exact model id on both requests`,
  );
  assert.deepEqual(
    (requestBodies[0]?.tools as Array<{ function: { name: string } }>).map((entry) => entry.function.name),
    ['echo'],
  );
  assert.deepEqual(
    (requestBodies[1]?.messages as Array<{ role: string; content: string }>).find(({ role }) => role === 'tool'),
    { role: 'tool', content: '{"echoed":"hello"}', tool_call_id: 'call_echo' },
    `${row.providerType} must replay the tool result`,
  );
  assert.deepEqual(result.steps[0]?.toolResults[0]?.output, { echoed: 'hello' });
  assert.equal(result.text, FINAL_TEXT);
  if (wantsReasoning && replayField) {
    assert.equal(result.steps[0]?.reasoningText, REASONING_TEXT, `${row.providerType} should surface reasoning`);
    const assistant = (requestBodies[1]?.messages as Array<Record<string, unknown>>).find(({ role }) => role === 'assistant');
    assert.ok(assistant, `${row.providerType} must replay the assistant turn`);
    assert.equal(
      assistant?.[replayField],
      REASONING_TEXT,
      `${row.providerType} must replay reasoning in the "${replayField}" field`,
    );
  }
}

async function runAnthropicMessagesWire(row: ProviderContractRow): Promise<void> {
  const sample = row.sampleModelId;
  const requestBodies: Array<Record<string, unknown>> = [];
  const server = await startJsonServer(async (request, response) => {
    assert.equal(request.method, 'POST');
    assert.ok(request.url?.endsWith('/messages'), `unexpected anthropic path ${request.url}`);
    const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
    requestBodies.push(body);
    if (requestBodies.length === 1) {
      respondJson(response, 200, {
        id: 'msg_tool',
        type: 'message',
        role: 'assistant',
        model: sample,
        content: [{ type: 'tool_use', id: 'toolu_echo', name: 'echo', input: { text: 'hello' } }],
        stop_reason: 'tool_use',
        stop_sequence: null,
        usage: { input_tokens: 8, output_tokens: 4 },
      });
      return;
    }
    respondJson(response, 200, {
      id: 'msg_final',
      type: 'message',
      role: 'assistant',
      model: sample,
      content: [{ type: 'text', text: FINAL_TEXT }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 12, output_tokens: 3 },
    });
  });
  const connection = baseConnection(row, server.url);
  const result = await generateText({
    model: getAIModel({ connection, apiKey: API_KEY, modelId: sample }),
    prompt: 'Call echo with hello.',
    stopWhen: stepCountIs(2),
    tools: { echo: echoTool },
  });

  assert.equal(requestBodies.length, 2, `${row.providerType} should make two messages requests`);
  assert.deepEqual(
    requestBodies.map((body) => body.model),
    [sample, sample],
    `${row.providerType} must send the exact model id on both requests`,
  );
  assert.deepEqual(
    (requestBodies[0]?.tools as Array<{ name: string }>).map((entry) => entry.name),
    ['echo'],
  );
  assert.equal(result.steps[0]?.toolCalls[0]?.toolName, 'echo');
  assert.deepEqual(result.steps[0]?.toolResults[0]?.output, { echoed: 'hello' });
  assert.equal(result.text, FINAL_TEXT);
}

async function runGoogleGenerateWire(row: ProviderContractRow): Promise<void> {
  const sample = row.sampleModelId;
  const requestUrls: string[] = [];
  const server = await startJsonServer(async (request, response) => {
    assert.equal(request.method, 'POST');
    requestUrls.push(request.url ?? '');
    await readBody(request);
    if (requestUrls.length === 1) {
      respondJson(response, 200, {
        candidates: [{
          index: 0,
          content: {
            role: 'model',
            parts: [{ functionCall: { name: 'echo', args: { text: 'hello' } } }],
          },
          finishReason: 'STOP',
        }],
        usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 4, totalTokenCount: 12 },
      });
      return;
    }
    respondJson(response, 200, {
      candidates: [{
        index: 0,
        content: { role: 'model', parts: [{ text: FINAL_TEXT }] },
        finishReason: 'STOP',
      }],
      usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 3, totalTokenCount: 15 },
    });
  });
  const connection = baseConnection(row, server.url);
  const result = await generateText({
    model: getAIModel({ connection, apiKey: API_KEY, modelId: sample }),
    prompt: 'Call echo with hello.',
    stopWhen: stepCountIs(2),
    tools: { echo: echoTool },
  });

  assert.ok(requestUrls.length >= 2, `${row.providerType} should make two generateContent requests`);
  assert.ok(
    requestUrls.every((url) => url.includes(`models/${sample}`)),
    `${row.providerType} must send the exact model id in the generateContent path`,
  );
  assert.equal(result.steps[0]?.toolCalls[0]?.toolName, 'echo');
  assert.deepEqual(result.steps[0]?.toolResults[0]?.output, { echoed: 'hello' });
  assert.equal(result.text, FINAL_TEXT);
}

async function runCohereV2Wire(row: ProviderContractRow): Promise<void> {
  const sample = row.sampleModelId;
  const requestBodies: Array<Record<string, unknown>> = [];
  const server = await startJsonServer(async (request, response) => {
    assert.equal(request.method, 'POST');
    assert.ok(request.url?.endsWith('/chat'), `unexpected cohere path ${request.url}`);
    const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
    requestBodies.push(body);
    if (requestBodies.length === 1) {
      respondJson(response, 200, {
        generation_id: 'cohere-tool-turn',
        finish_reason: 'TOOL_CALL',
        message: {
          role: 'assistant',
          content: [],
          tool_plan: 'Call echo.',
          tool_calls: [{ id: 'call_echo', type: 'function', function: { name: 'echo', arguments: '{"text":"hello"}' } }],
        },
        usage: { billed_units: { input_tokens: 8, output_tokens: 4 }, tokens: { input_tokens: 8, output_tokens: 4 } },
      });
      return;
    }
    respondJson(response, 200, {
      generation_id: 'cohere-final-turn',
      finish_reason: 'COMPLETE',
      message: { role: 'assistant', content: [{ type: 'text', text: FINAL_TEXT }] },
      usage: { billed_units: { input_tokens: 12, output_tokens: 3 }, tokens: { input_tokens: 12, output_tokens: 3 } },
    });
  });
  const connection = baseConnection(row, `${server.url}/v2`);
  const result = await generateText({
    model: getAIModel({ connection, apiKey: API_KEY, modelId: sample }),
    prompt: 'Call echo with hello.',
    stopWhen: stepCountIs(2),
    tools: { echo: echoTool },
  });

  assert.equal(requestBodies.length, 2, `${row.providerType} should make two chat requests`);
  assert.deepEqual(
    requestBodies.map((body) => body.model),
    [sample, sample],
    `${row.providerType} must send the exact model id on both requests`,
  );
  assert.equal(result.steps[0]?.toolCalls[0]?.toolName, 'echo');
  assert.deepEqual(result.steps[0]?.toolResults[0]?.output, { echoed: 'hello' });
  assert.equal(result.text, FINAL_TEXT);
}

// ---------------------------------------------------------------------------
// Shared infrastructure
// ---------------------------------------------------------------------------

function baseConnection(row: ProviderContractRow, baseUrl: string): LlmConnection {
  return {
    slug: `${row.providerType}-contract`,
    name: row.providerType,
    providerType: row.providerType,
    baseUrl,
    defaultModel: row.sampleModelId,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

async function startJsonServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((request, response) => {
    void Promise.resolve(handler(request, response)).catch((error) => {
      response.destroy(error as Error);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const control = {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
  servers.push(control);
  return control;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

function respondJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}
