import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildResponseLanguagePromptFragment } from '../system-prompt/response-language-prompt.js';

describe('response language prompt', () => {
  test('follows the latest request for every user-visible model-authored stream', () => {
    const prompt = buildResponseLanguagePromptFragment();

    assert.match(prompt, /same predominant natural language as the user's latest request/);
    assert.match(
      prompt,
      /progress updates, visible reasoning summaries, questions, and the final answer/,
    );
    assert.match(prompt, /explicitly requests a different language/);
  });

  test('does not translate technical or externally produced content by default', () => {
    const prompt = buildResponseLanguagePromptFragment();

    assert.match(prompt, /code, commands, paths, identifiers, quotations, and raw tool output/);
    assert.match(prompt, /unless the user asks for translation/);
  });
});
