import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createOpenAIComputerContinuationRequest,
  createOpenAIComputerInitialRequest,
} from '../openai-computer-codec.js';
import { OPENAI_COMPUTER_INSTRUCTIONS } from '../openai-computer-policy.js';

test('OpenAI computer policy is separate from user input and stable across continuation', () => {
  const initial = createOpenAIComputerInitialRequest({
    dialect: 'ga',
    model: 'gpt-test',
    prompt: 'user task',
  });
  const continuation = createOpenAIComputerContinuationRequest({
    dialect: 'ga',
    model: 'gpt-test',
    previousResponseId: 'resp-1',
    callId: 'call-1',
    screenshot: { base64: 'AA==', mimeType: 'image/png' },
  });

  assert.equal(initial.input, 'user task');
  assert.equal(initial.instructions, OPENAI_COMPUTER_INSTRUCTIONS);
  assert.equal(continuation.instructions, OPENAI_COMPUTER_INSTRUCTIONS);
  assert.match(initial.instructions, /untrusted data/);
  assert.match(initial.instructions, /verify the requested effect/);
});
