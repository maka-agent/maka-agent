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
 *                      hand-written test (in `provider-conformance.test.ts` by
 *                      default) that owns the provider-specific contract.
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
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { LlmConnection } from '@maka/core';
import {
  PROVIDER_CONTRACT_MATRIX_PLAN,
  listProviderContractCells,
  type ProviderContractDiscoveryPlan,
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

/** A named override binding a plan cell to a hand-written conformance test. */
interface OverrideBinding {
  /**
   * Exact test title as it appears verbatim in the bound test source (for
   * parametric tests, the literal template text including any `${...}`
   * placeholder). The binding test below asserts the source still contains an
   * enabled `test(` call whose complete quoted title equals this text, so
   * deleting, renaming (even by suffix), or skipping the hand-written test
   * breaks the matrix instead of leaving a silent gap.
   */
  test: string;
  /**
   * Source file (sibling of this suite) that owns the bound test.
   * Defaults to {@link DEFAULT_OVERRIDE_TEST_FILE}.
   */
  file?: string;
  /** Human-readable statement of the provider-specific contract the override owns. */
  contract: string;
}

const DEFAULT_OVERRIDE_TEST_FILE = 'provider-conformance.test.ts';

const GITHUB_COPILOT_OVERRIDE_TEST =
  'GitHub Copilot discovers the account model and completes a reasoning tool loop on its exact wire';

/**
 * Named overrides. Each key is a plan `overrideKey` (`${providerType}:${dimension}`)
 * and each value binds the hand-written test that owns the provider-specific
 * contract the plan cannot generate. A missing key here surfaces as a contract
 * gap; a stale or disabled `test` title fails the source binding test.
 */
const OVERRIDE_REGISTRY: Readonly<Record<string, OverrideBinding>> = {
  'cohere:discovery': {
    test: 'Cohere paginates account models and completes its native V2 tool-call loop',
    contract: 'Cohere native V2 paginated /v1/models discovery (endpoint=chat)',
  },
  'fireworks-ai:discovery': {
    test: 'Fireworks discovers exact serverless model paths and completes a two-stage tool-call loop',
    contract: 'Fireworks account pagination discovery over /v1/accounts + per-account /models',
  },
  'ollama:discovery': {
    // eslint-disable-next-line no-template-curly-in-string -- literal source text of a parametric title
    test: 'Ollama preserves an exact ${testCase.label} through local discovery and a no-secret tool-call loop',
    contract: 'Ollama native /api/tags discovery',
  },
  'github-copilot:discovery': {
    test: 'GitHub Copilot discovers only account-enabled tool models and preserves each exact endpoint wire',
    file: 'model-fetcher.test.ts',
    contract: 'GitHub Copilot subscription /models discovery (picker + endpoint gating)',
  },
  'github-copilot:exact-model-id': {
    test: GITHUB_COPILOT_OVERRIDE_TEST,
    contract: 'GitHub Copilot preserves the exact account model id on its subscription wire',
  },
  'github-copilot:tool-loop': {
    test: GITHUB_COPILOT_OVERRIDE_TEST,
    contract: 'GitHub Copilot completes a two-stage tool loop on its subscription wire',
  },
  'github-copilot:reasoning-replay': {
    test: GITHUB_COPILOT_OVERRIDE_TEST,
    contract: 'GitHub Copilot replays reasoning on its provider-specific per-model wire',
  },
  'zenmux:reasoning-replay': {
    test: 'ZenMux replays signed reasoning details in the streamed runtime tool loop',
    contract: 'Signed reasoning_details are replayed byte-for-byte, beyond a plain field rename',
  },
};

/**
 * The suite runs compiled from `dist/` (sibling `.js`) but can also run straight
 * from `src/` (sibling `.ts`). Test titles survive compilation verbatim, so read
 * whichever sibling exists, resolved relative to this test file.
 */
function readOverrideTestSource(file: string): string {
  const errors: string[] = [];
  for (const candidate of [`./${file}`, `./${file.replace(/\.ts$/, '.js')}`]) {
    try {
      return readFileSync(fileURLToPath(new URL(candidate, import.meta.url)), 'utf8');
    } catch (error) {
      errors.push(`${candidate}: ${(error as Error).message}`);
    }
  }
  throw new Error(`override test source "${file}" not found next to the matrix suite:\n${errors.join('\n')}`);
}

/**
 * True when the source contains an *enabled* `test(` call whose complete quoted
 * title equals the bound title — `test('title'`, `test("title"`, or
 * `` test(`title` `` (the backtick form covers parametric template-literal
 * titles, whose bound text includes the `${...}` placeholder verbatim).
 * Requiring the closing quote means renaming the test — even by appending a
 * suffix — breaks the binding. `test.skip(` / `test.todo(` never match because
 * their call prefix differs. Known residual: this is a textual check, so a
 * fully commented-out `test(...)` line still matches; the Phase 8 executable
 * override binding removes that class.
 */
function hasEnabledTestCall(source: string, title: string): boolean {
  return ["'", '"', '`'].some((quote) => source.includes(`test(${quote}${title}${quote}`));
}

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

  test('every registered override title is an enabled test call in its bound source file', () => {
    const sources = new Map<string, string>();
    for (const [key, binding] of Object.entries(OVERRIDE_REGISTRY)) {
      const file = binding.file ?? DEFAULT_OVERRIDE_TEST_FILE;
      let source = sources.get(file);
      if (source === undefined) {
        source = readOverrideTestSource(file);
        sources.set(file, source);
      }
      if (hasEnabledTestCall(source, binding.test)) continue;
      assert.fail(
        source.includes(binding.test)
          ? `override "${key}": the bound title exists in ${file} but is not an enabled test call `
            + `(is it test.skip/test.todo, or referenced outside a test(...)?): "${binding.test}" `
            + '— re-enable the hand-written test or update the binding'
          : `override "${key}" is bound to a test title that no longer exists in ${file}: `
            + `"${binding.test}" — update the binding or restore the hand-written test`,
      );
    }
  });
});

describe('provider conformance matrix — override cells reference a named hand-written test', () => {
  for (const { providerType, dimension, cell } of listProviderContractCells(plan)) {
    if (cell.state !== 'override') continue;
    test(`${providerType} · ${dimension} · override → ${cell.overrideKey}`, () => {
      const reference = OVERRIDE_REGISTRY[cell.overrideKey];
      assert.ok(reference, `expected a named override for ${cell.overrideKey}`);
      assert.ok(reference.test.length > 0, `override for ${cell.overrideKey} must name its hand-written test title`);
      assert.ok(reference.contract.length > 0, `override for ${cell.overrideKey} must describe its contract`);
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
  const discovery = cell.discovery;
  // `array-or-data` (mistral) means the same endpoint may answer either
  // `{data:[...]}` or a bare array; both fixtures must parse to the exact id.
  const payloadShapes: ReadonlyArray<'data-object' | 'bare-array'> =
    discovery.responseShape === 'array-or-data' ? ['data-object', 'bare-array'] : ['data-object'];
  for (const shape of payloadShapes) {
    const where = `${row.providerType} discovery (${shape} payload)`;
    // Handler assertion failures are recorded and rethrown after the fetch so
    // the test fails with the request-contract message instead of a generic
    // "failed to fetch models" wrapper.
    const handlerErrors: unknown[] = [];
    let requestCount = 0;
    const server = await startJsonServer((request, response) => {
      requestCount += 1;
      try {
        assertDiscoveryRequest(row, discovery, request);
      } catch (error) {
        handlerErrors.push(error);
      }
      respondJson(response, 200, discoveryPayload(discovery.protocol, sample, discovery.filter, shape));
    });
    const connection = baseConnection(row, server.url);
    const models = await fetchProviderModels(connection, API_KEY);
    if (handlerErrors.length > 0) throw handlerErrors[0];
    assert.ok(requestCount >= 1, `${where} must request the model list`);
    assert.deepEqual(
      models.map((model) => model.id),
      [sample],
      `${where} should return exactly the scripted exact id`,
    );
  }
}

/**
 * Assert the discovery request against the full derived cell — path, query, and
 * auth — mirroring `model-fetcher.ts`'s real URL/header construction:
 *
 *   - openai:    `{baseUrl}{path ?? '/models'}?{query}` with a Bearer credential
 *                when the cell declares provider auth *and* the provider's
 *                authKind actually supports an API key (lm-studio declares
 *                `authKind: 'none'`, so its wire carries no credential).
 *   - anthropic: `{baseUrl}/v1/models` with the `x-api-key` credential header.
 *   - google:    `{baseUrl}/v1beta/models?key={apiKey}` — the credential rides
 *                the `key` query parameter, never a header.
 */
function assertDiscoveryRequest(
  row: ProviderContractRow,
  discovery: ProviderContractDiscoveryPlan,
  request: IncomingMessage,
): void {
  const where = `${row.providerType} discovery`;
  assert.equal(request.method, 'GET', `${where} must GET the model list`);
  const url = new URL(request.url ?? '', 'http://contract.test');

  // Path: the declared path, or the protocol's default models path.
  assert.equal(
    url.pathname,
    expectedDiscoveryPathname(discovery),
    `${where} must request the declared models path`,
  );

  // Query: exactly the declared parameters (google adds its key-query credential).
  const expectedQuery: Record<string, string> = { ...(discovery.query ?? {}) };
  if (discovery.protocol === 'google' && discovery.auth !== 'none') expectedQuery.key = API_KEY;
  assert.deepEqual(
    Object.fromEntries(url.searchParams),
    expectedQuery,
    `${where} must send exactly the declared query parameters`,
  );

  // Auth: public cells must carry no credential; default cells must carry the
  // protocol's credential exactly as model-fetcher constructs it.
  const authorization = request.headers.authorization;
  const xApiKey = request.headers['x-api-key'];
  const xGoogApiKey = request.headers['x-goog-api-key'];
  if (discovery.auth === 'none') {
    assert.equal(authorization, undefined, `${where} is public: it must not send an Authorization header`);
    assert.equal(xApiKey, undefined, `${where} is public: it must not send an x-api-key header`);
    assert.equal(xGoogApiKey, undefined, `${where} is public: it must not send an x-goog-api-key header`);
    return;
  }
  switch (discovery.protocol) {
    case 'openai':
      assert.equal(authorization, `Bearer ${API_KEY}`, `${where} must send its Bearer credential`);
      break;
    case 'anthropic':
      assert.equal(xApiKey, API_KEY, `${where} must send its x-api-key credential`);
      break;
    case 'google':
      // Credential is the `key` query parameter asserted above; no auth header.
      assert.equal(authorization, undefined, `${where} must carry its credential in the key query, not a header`);
      break;
    case 'cohere':
      assert.fail(`${where}: cohere discovery is never generated`);
  }
}

function expectedDiscoveryPathname(discovery: ProviderContractDiscoveryPlan): string {
  switch (discovery.protocol) {
    case 'anthropic':
      return '/v1/models';
    case 'google':
      return '/v1beta/models';
    default: {
      const path = discovery.path ?? '/models';
      return path.startsWith('/') ? path : `/${path}`;
    }
  }
}

function discoveryPayload(
  protocol: string,
  sample: string,
  filter: string | undefined,
  shape: 'data-object' | 'bare-array',
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
  if (shape === 'bare-array') return [{ id: sample }];
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
  // Second-turn contract violations are asserted in the handler before the
  // final response, recorded, and rethrown after the call so the test fails
  // with the wire-contract message instead of a destroyed-socket error.
  const handlerErrors: unknown[] = [];
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
    // Turn two must replay the tool result, keyed to the first-turn tool_use id,
    // before the wire answers with the final text.
    try {
      const toolResults = (body.messages as Array<{ role: string; content: unknown }>)
        .flatMap((message) => (Array.isArray(message.content) ? message.content as Array<Record<string, unknown>> : []))
        .filter((block) => block.type === 'tool_result');
      assert.equal(
        toolResults.length,
        1,
        `${row.providerType} · tool-loop: turn two must replay exactly one tool_result block`,
      );
      assert.equal(
        toolResults[0]?.tool_use_id,
        'toolu_echo',
        `${row.providerType} · tool-loop: the tool_result must reference the first-turn tool_use id`,
      );
      const toolResultContent = JSON.stringify(toolResults[0]?.content);
      assert.ok(
        toolResultContent.includes('echoed') && toolResultContent.includes('hello'),
        `${row.providerType} · tool-loop: the tool_result must carry the echo output, got ${toolResultContent}`,
      );
    } catch (error) {
      handlerErrors.push(error);
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

  if (handlerErrors.length > 0) throw handlerErrors[0];
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
  // See runAnthropicMessagesWire for why second-turn violations are recorded.
  const handlerErrors: unknown[] = [];
  const server = await startJsonServer(async (request, response) => {
    assert.equal(request.method, 'POST');
    requestUrls.push(request.url ?? '');
    const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
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
    // Turn two must replay a functionResponse part for the first-turn `echo`
    // functionCall before the wire answers with the final text.
    try {
      const functionResponses = (body.contents as Array<{ parts?: Array<Record<string, unknown>> }>)
        .flatMap((content) => content.parts ?? [])
        .map((part) => part.functionResponse as { name?: string; response?: unknown } | undefined)
        .filter((part): part is { name?: string; response?: unknown } => part !== undefined);
      assert.equal(
        functionResponses.length,
        1,
        `${row.providerType} · tool-loop: turn two must replay exactly one functionResponse part`,
      );
      assert.equal(
        functionResponses[0]?.name,
        'echo',
        `${row.providerType} · tool-loop: the functionResponse must correspond to the first-turn echo functionCall`,
      );
      const functionResponseJson = JSON.stringify(functionResponses[0]?.response);
      assert.ok(
        functionResponseJson.includes('echoed') && functionResponseJson.includes('hello'),
        `${row.providerType} · tool-loop: the functionResponse must carry the echo output, got ${functionResponseJson}`,
      );
    } catch (error) {
      handlerErrors.push(error);
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

  if (handlerErrors.length > 0) throw handlerErrors[0];
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
  // See runAnthropicMessagesWire for why second-turn violations are recorded.
  const handlerErrors: unknown[] = [];
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
    // Turn two must replay the tool result message, keyed to the first-turn
    // call id, before the wire answers with the final text.
    try {
      const toolMessages = (body.messages as Array<Record<string, unknown>>)
        .filter((message) => message.role === 'tool');
      assert.equal(
        toolMessages.length,
        1,
        `${row.providerType} · tool-loop: turn two must replay exactly one tool message`,
      );
      assert.equal(
        toolMessages[0]?.tool_call_id,
        'call_echo',
        `${row.providerType} · tool-loop: the tool message must reference the first-turn call id`,
      );
      const toolMessageContent = JSON.stringify(toolMessages[0]?.content);
      assert.ok(
        toolMessageContent.includes('echoed') && toolMessageContent.includes('hello'),
        `${row.providerType} · tool-loop: the tool message must carry the echo output, got ${toolMessageContent}`,
      );
    } catch (error) {
      handlerErrors.push(error);
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

  if (handlerErrors.length > 0) throw handlerErrors[0];
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
