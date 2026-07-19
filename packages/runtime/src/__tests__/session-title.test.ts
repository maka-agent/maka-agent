import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  fallbackSessionTitle,
  generateSessionTitle,
  sessionTitleSource,
} from '../session-title.js';

describe('session title helper', () => {
  test('uses display text, strips system reminders, and truncates input on a UTF-8 boundary', () => {
    const source = sessionTitleSource({
      text: 'model envelope',
      displayText: `<system-reminder>secret</system-reminder>\n${'🦊'.repeat(3_000)}`,
    });

    assert.equal(source.includes('secret'), false);
    assert.equal(new TextEncoder().encode(source).length <= 8 * 1024, true);
    assert.equal(source.endsWith('�'), false);
  });

  test('extracts the user message from a raw skill envelope', () => {
    assert.equal(
      sessionTitleSource({
        text: 'Skills loaded below.\n<invoked-skill id="research">\nSECRET INSTRUCTIONS\n</invoked-skill>\n<user-message>\nAnalyze this code\n</user-message>',
      }),
      'Analyze this code',
    );
  });

  test('builds fallback from the first non-empty line without splitting Unicode code points', () => {
    const line = `${'🦊'.repeat(42)}tail`;
    assert.equal(fallbackSessionTitle(`\n \n${line}\nignored`), '🦊'.repeat(42));
    assert.equal(fallbackSessionTitle(' \n\t'), undefined);
  });

  test('cleans model reasoning, prefixes, quotes, and extra lines', async () => {
    let request: Record<string, unknown> | undefined;
    const title = await generateSessionTitle({
      model: {} as never,
      sourceText: 'Analyze the production logs',
      providerOptions: { provider: { required: true } },
      generateText: async (options) => {
        request = options;
        return {
          text: '<think>reasoning</think>\nTitle: "Production log analysis"\nextra',
          finishReason: 'stop',
        };
      },
    });

    assert.equal(title, 'Production log analysis');
    assert.equal(request?.maxOutputTokens, 1024);
    assert.deepEqual(request?.providerOptions, { provider: { required: true } });
    assert.equal('tools' in (request ?? {}), false);
  });

  test('returns undefined for empty, truncated, invalid, or failed model output', async () => {
    const model = {} as never;
    assert.equal(
      await generateSessionTitle({
        model,
        sourceText: '',
        generateText: async () => ({ text: 'unused', finishReason: 'stop' }),
      }),
      undefined,
    );
    assert.equal(
      await generateSessionTitle({
        model,
        sourceText: 'hello',
        generateText: async () => ({ text: 'Title', finishReason: 'length' }),
      }),
      undefined,
    );
    assert.equal(
      await generateSessionTitle({
        model,
        sourceText: 'hello',
        generateText: async () => ({ text: '<think>x</think>', finishReason: 'stop' }),
      }),
      undefined,
    );
    assert.equal(
      await generateSessionTitle({
        model,
        sourceText: 'hello',
        generateText: async () => {
          throw new Error('offline');
        },
      }),
      undefined,
    );
  });

  test('aborts title generation when the provider exceeds its deadline', {
    timeout: 100,
  }, async () => {
    let signal: AbortSignal | undefined;
    const input = {
      model: {} as never,
      sourceText: 'hello',
      timeoutMs: 10,
      generateText: (options: Record<string, unknown>) =>
        new Promise<never>((_resolve, reject) => {
          signal = options.abortSignal as AbortSignal;
          signal?.addEventListener('abort', () => reject(signal?.reason), { once: true });
        }),
    };

    assert.equal(await generateSessionTitle(input), undefined);
    assert.equal(signal?.aborted, true);
  });
});
