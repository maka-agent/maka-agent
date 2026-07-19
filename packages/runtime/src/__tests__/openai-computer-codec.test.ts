import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  createOpenAIComputerContinuationRequest,
  createOpenAIComputerInitialRequest,
  decodeOpenAIComputerResponse,
} from '../openai-computer-codec.js';
import { OPENAI_COMPUTER_INSTRUCTIONS } from '../openai-computer-policy.js';

const common = {
  type: 'computer_call',
  id: 'item_1',
  call_id: 'call_1',
  status: 'completed',
  pending_safety_checks: [],
} as const;
const responseBase = { status: 'completed', error: null } as const;

describe('OpenAI computer codec', () => {
  test('decodes strict GA actions[] and strict preview action shapes', () => {
    const ga = decodeOpenAIComputerResponse(
      {
        id: 'resp_1',
        ...responseBase,
        output: [{ ...common, actions: [{ type: 'screenshot' }] }],
      },
      'ga',
    );
    assert.deepEqual(ga.calls[0].actions, [{ type: 'screenshot' }]);

    const preview = decodeOpenAIComputerResponse(
      {
        id: 'resp_2',
        ...responseBase,
        output: [{ ...common, action: { type: 'wait' } }],
      },
      'preview',
    );
    assert.deepEqual(preview.calls[0].actions, [{ type: 'wait' }]);

    const omittedSafety = decodeOpenAIComputerResponse(
      {
        id: 'resp_3',
        ...responseBase,
        output: [
          {
            type: 'computer_call',
            id: 'item_3',
            call_id: 'call_3',
            status: 'completed',
            actions: [{ type: 'screenshot' }],
          },
        ],
      },
      'ga',
    );
    assert.deepEqual(omittedSafety.calls[0].pendingSafetyChecks, []);

    const terminalText = decodeOpenAIComputerResponse(
      {
        id: 'resp_4',
        ...responseBase,
        output: [
          {
            type: 'message',
            content: [
              { type: 'output_text', text: 'final ' },
              { type: 'output_text', text: 'answer' },
            ],
          },
        ],
      },
      'ga',
    );
    assert.equal(terminalText.text, 'final answer');
  });

  test('rejects mixed dialects and unknown action fields', () => {
    assert.throws(() =>
      decodeOpenAIComputerResponse(
        {
          id: 'resp_1',
          ...responseBase,
          output: [{ ...common, action: { type: 'wait' } }],
        },
        'ga',
      ),
    );
    assert.throws(() =>
      decodeOpenAIComputerResponse(
        {
          id: 'resp_1',
          ...responseBase,
          output: [
            {
              ...common,
              actions: [{ type: 'click', button: 'left', x: 1, y: 2, keys: null, ignored: true }],
            },
          ],
        },
        'ga',
      ),
    );
  });

  test('encodes GA and preview requests without conflating tool contracts', () => {
    assert.deepEqual(
      createOpenAIComputerInitialRequest({
        dialect: 'ga',
        model: 'gpt',
        prompt: 'go',
      }),
      {
        model: 'gpt',
        instructions: OPENAI_COMPUTER_INSTRUCTIONS,
        tools: [{ type: 'computer' }],
        input: 'go',
        parallel_tool_calls: false,
        store: false,
      },
    );
    assert.deepEqual(
      createOpenAIComputerInitialRequest({
        dialect: 'preview',
        model: 'computer-use-preview',
        prompt: 'go',
        display: { widthPx: 1024, heightPx: 768, environment: 'browser' },
      }),
      {
        model: 'computer-use-preview',
        instructions: OPENAI_COMPUTER_INSTRUCTIONS,
        tools: [
          {
            type: 'computer_use_preview',
            display_width: 1024,
            display_height: 768,
            environment: 'browser',
          },
        ],
        input: 'go',
        truncation: 'auto',
        parallel_tool_calls: false,
        store: false,
      },
    );
  });

  test('rejects empty GA actions and preserves terminal response failures', () => {
    assert.throws(() =>
      decodeOpenAIComputerResponse(
        {
          id: 'resp_empty',
          ...responseBase,
          output: [{ ...common, actions: [] }],
        },
        'ga',
      ),
    );
    const failed = decodeOpenAIComputerResponse(
      {
        id: 'resp_failed',
        status: 'failed',
        error: { type: 'server_error', code: 'capacity', message: 'No capacity' },
        output: [],
      },
      'ga',
    );
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error?.code, 'capacity');
  });

  test('encodes screenshot continuation and explicit safety acknowledgements', () => {
    const request = createOpenAIComputerContinuationRequest({
      dialect: 'ga',
      model: 'gpt',
      previousResponseId: 'resp_1',
      callId: 'call_1',
      screenshot: { base64: 'AA==', mimeType: 'image/png' },
      acknowledgedSafetyChecks: [{ id: 'safe_1', code: 'x', message: 'confirm' }],
    });
    assert.deepEqual(request.input, [
      {
        type: 'computer_call_output',
        call_id: 'call_1',
        output: {
          type: 'computer_screenshot',
          image_url: 'data:image/png;base64,AA==',
          detail: 'original',
        },
        acknowledged_safety_checks: [{ id: 'safe_1', code: 'x', message: 'confirm' }],
      },
    ]);
  });
});
