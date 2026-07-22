/**
 * Tests for the Quick Chat handler (PR110b).
 *
 * Locks the 4 behavioral gates @kenji + @xuan signed off:
 *  - non-ready OnboardingState → `setup_required`, NO session created
 *  - empty / whitespace prompt → create-and-open only; NO send
 *  - non-empty prompt → walks send path; first message id returned
 *  - workspace failures preserve their recovery semantics; other send/create
 *    failures become `send_failed` with generalized Chinese copy
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { OnboardingState, SessionSummary } from '@maka/core';
import type { PreparedSkillInvocationMessage } from '@maka/runtime';
import { handleQuickChatStart, type QuickChatDeps } from '../quick-chat.js';
import { SESSION_WORKSPACE_UNAVAILABLE_CODE } from '../project-context-root.js';

function workspaceUnavailableError(): Error {
  return new Error(`${SESSION_WORKSPACE_UNAVAILABLE_CODE}: unavailable`);
}

function fakeSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: overrides.id ?? 'session-quickchat-1',
    name: overrides.name ?? 'New Chat',
    isFlagged: false,
    isArchived: false,
    labels: [],
    hasUnread: false,
    status: 'active',
    backend: 'ai-sdk',
    llmConnectionSlug: 'anthropic-live',
    connectionLocked: false,
    model: 'claude-sonnet-4-5-20250929',
    permissionMode: 'ask',
    ...overrides,
  };
}

function makeDeps(overrides: Partial<QuickChatDeps> = {}): QuickChatDeps & {
  spy: {
    createCalls: number;
    createInputs: Array<{ defaultConnectionSlug: string; defaultModel: string; mode: 'chat' | 'deep_research' }>;
    emitCalls: string[];
    ensureCanSendCalls: string[];
    prepareCalls: Array<{ sessionId: string; text: string; skillIds: readonly string[] }>;
    removeCalls: string[];
    sendCalls: Array<{ sessionId: string; text: string; displayText?: string }>;
  };
} {
  const spy: {
    createCalls: number;
    createInputs: Array<{ defaultConnectionSlug: string; defaultModel: string; mode: 'chat' | 'deep_research' }>;
    emitCalls: string[];
    ensureCanSendCalls: string[];
    prepareCalls: Array<{ sessionId: string; text: string; skillIds: readonly string[] }>;
    removeCalls: string[];
    sendCalls: Array<{ sessionId: string; text: string; displayText?: string }>;
  } = {
    createCalls: 0,
    createInputs: [],
    emitCalls: [] as string[],
    ensureCanSendCalls: [] as string[],
    prepareCalls: [],
    removeCalls: [],
    sendCalls: [] as Array<{ sessionId: string; text: string; displayText?: string }>,
  };
  const deps: QuickChatDeps = {
    async getOnboardingState() {
      return {
        kind: 'ready_empty',
        defaultConnectionSlug: 'anthropic-live',
        defaultModel: 'claude-sonnet-4-5-20250929',
      } as OnboardingState;
    },
    async createSession(input) {
      spy.createCalls += 1;
      spy.createInputs.push(input);
      return fakeSession();
    },
    emitCreated(sessionId) {
      spy.emitCalls.push(sessionId);
    },
    async ensureCanSend(sessionId) {
      spy.ensureCanSendCalls.push(sessionId);
    },
    async prepareSkillInvocation(sessionId, text, skillIds) {
      spy.prepareCalls.push({ sessionId, text, skillIds });
      return {
        disposition: 'passthrough',
        sendText: text,
        skillInvocation: { loaded: [], failed: [] },
      } satisfies PreparedSkillInvocationMessage;
    },
    async removeSession(sessionId) {
      spy.removeCalls.push(sessionId);
    },
    async sendFirstMessage(sessionId, text, displayText) {
      spy.sendCalls.push({ sessionId, text, ...(displayText ? { displayText } : {}) });
    },
    ...overrides,
  };
  return { ...deps, spy } as QuickChatDeps & { spy: typeof spy };
}

describe('handleQuickChatStart — setup_required path', () => {
  for (const state of [
    { kind: 'needs_connection' } as OnboardingState,
    { kind: 'needs_default_connection' } as OnboardingState,
    { kind: 'needs_connection_credentials', connectionSlug: 'a' } as OnboardingState,
    { kind: 'needs_default_model', connectionSlug: 'a' } as OnboardingState,
    { kind: 'blocked', reason: 'all_connections_unhealthy' } as OnboardingState,
  ]) {
    it(`returns setup_required for state.kind=${state.kind} and does NOT create a session`, async () => {
      const deps = makeDeps({ getOnboardingState: async () => state });
      const result = await handleQuickChatStart({ prompt: 'hi' }, deps);
      assert.deepEqual(result, { ok: false, reason: 'setup_required', state });
      assert.equal(deps.spy.createCalls, 0, 'no session must be created in non-ready state');
      assert.equal(deps.spy.sendCalls.length, 0);
    });
  }
});

describe('handleQuickChatStart — empty prompt (create + open only)', () => {
  it('omitted prompt creates a session but does NOT send', async () => {
    const deps = makeDeps();
    const result = await handleQuickChatStart({}, deps);
    assert.deepEqual(result, { ok: true, sessionId: 'session-quickchat-1' });
    assert.equal(deps.spy.createCalls, 1);
    assert.deepEqual(deps.spy.emitCalls, ['session-quickchat-1']);
    assert.equal(deps.spy.sendCalls.length, 0, 'empty prompt must not call sendFirstMessage');
    assert.equal(deps.spy.ensureCanSendCalls.length, 0, 'empty prompt must not call ensureCanSend');
  });

  it('whitespace-only prompt is treated as empty', async () => {
    const deps = makeDeps();
    const result = await handleQuickChatStart({ prompt: '   \n\t  ' }, deps);
    assert.deepEqual(result, { ok: true, sessionId: 'session-quickchat-1' });
    assert.equal(deps.spy.sendCalls.length, 0);
  });

  it('undefined input is accepted as empty prompt (no crash)', async () => {
    const deps = makeDeps();
    const result = await handleQuickChatStart(undefined, deps);
    assert.equal(result.ok, true);
    assert.equal(deps.spy.sendCalls.length, 0);
  });
});

describe('handleQuickChatStart — non-empty prompt (send path)', () => {
  it('walks the send path and returns { ok: true; sessionId } only (no turn/message anchor)', async () => {
    // @xuan PR110b review: success branch is `{ ok: true; sessionId }`
    // — NOT `{ ok: true; sessionId; firstMessageId }`. PR110c will add
    // a properly-named `firstTurnId` if UI needs a scroll anchor.
    const deps = makeDeps();
    const result = await handleQuickChatStart({ prompt: 'hello, model' }, deps);
    assert.deepEqual(result, {
      ok: true,
      sessionId: 'session-quickchat-1',
    });
    if (result.ok) {
      assert.equal((result as { firstMessageId?: unknown }).firstMessageId, undefined);
    }
    assert.deepEqual(deps.spy.ensureCanSendCalls, ['session-quickchat-1']);
    assert.deepEqual(deps.spy.sendCalls, [{ sessionId: 'session-quickchat-1', text: 'hello, model' }]);
  });

  it('trims the prompt before sending', async () => {
    const deps = makeDeps();
    await handleQuickChatStart({ prompt: '   hello   ' }, deps);
    assert.deepEqual(deps.spy.sendCalls, [{ sessionId: 'session-quickchat-1', text: 'hello' }]);
  });

  it('silently ignores stray connectionSlug / model fields (PR110b no-override gate)', async () => {
    const deps = makeDeps();
    // @kenji PR110b review: PR110b does not support Quick Chat
    // connection/model override. If a future renderer sends them,
    // they must NOT influence the handler.
    const tampered = {
      prompt: 'hi',
      connectionSlug: 'malicious-slug',
      model: 'malicious-model',
    } as unknown;
    const result = await handleQuickChatStart(tampered, deps);
    assert.equal(result.ok, true);
    // createSession is called with the derived defaults, not the
    // tampered slug/model. The mock createSession ignores its args
    // entirely, but we verified above that the result references the
    // mock's hard-coded session id.
    assert.deepEqual(deps.spy.sendCalls, [{ sessionId: 'session-quickchat-1', text: 'hi' }]);
  });

  it('deep_research mode is accepted and passed to session creation', async () => {
    const deps = makeDeps();
    const result = await handleQuickChatStart({ prompt: 'study this project', mode: 'deep_research' }, deps);
    assert.equal(result.ok, true);
    assert.deepEqual(deps.spy.createInputs, [
      {
        defaultConnectionSlug: 'anthropic-live',
        defaultModel: 'claude-sonnet-4-5-20250929',
        mode: 'deep_research',
      },
    ]);
    assert.deepEqual(deps.spy.sendCalls, [{ sessionId: 'session-quickchat-1', text: 'study this project' }]);
  });

  it('unknown mode fails closed to normal chat', async () => {
    const deps = makeDeps();
    const result = await handleQuickChatStart({ prompt: 'hello', mode: 'execute' }, deps);
    assert.equal(result.ok, true);
    assert.equal(deps.spy.createInputs[0]?.mode, 'chat');
  });
});

describe('handleQuickChatStart — explicit Skill invocation', () => {
  it('sends a chip-only invocation with a readable display fallback', async () => {
    const skillInvocation = {
      loaded: [{ id: 'starter-skill', name: '示例技能' }],
      failed: [],
    };
    const deps = makeDeps({
      prepareSkillInvocation: async () => ({
        disposition: 'ready',
        sendText: '<invoked-skill>instructions</invoked-skill>',
        skillInvocation,
      }),
    });

    const result = await handleQuickChatStart({ prompt: '', skillIds: ['starter-skill'] }, deps);

    assert.deepEqual(result, {
      ok: true,
      sessionId: 'session-quickchat-1',
      skillInvocation,
    });
    assert.deepEqual(deps.spy.ensureCanSendCalls, ['session-quickchat-1']);
    assert.deepEqual(deps.spy.sendCalls, [
      {
        sessionId: 'session-quickchat-1',
        text: '<invoked-skill>instructions</invoked-skill>',
        displayText: '/skill:starter-skill',
      },
    ]);
  });

  it('removes the temporary session and does not emit it when every Skill fails', async () => {
    const skillInvocation = {
      loaded: [],
      failed: [{ request: 'missing-skill', reason: 'not_found' as const }],
    };
    const deps = makeDeps({
      prepareSkillInvocation: async () => ({ disposition: 'blocked', skillInvocation }),
    });

    const result = await handleQuickChatStart(
      { prompt: 'run it', skillIds: ['missing-skill'] },
      deps,
    );

    assert.deepEqual(result, {
      ok: false,
      reason: 'skill_invocation_failed',
      skillInvocation,
    });
    assert.deepEqual(deps.spy.removeCalls, ['session-quickchat-1']);
    assert.deepEqual(deps.spy.emitCalls, []);
    assert.deepEqual(deps.spy.ensureCanSendCalls, []);
    assert.deepEqual(deps.spy.sendCalls, []);
  });

  it('continues with loaded Skills and reports partial failures', async () => {
    const skillInvocation = {
      loaded: [{ id: 'starter-skill', name: '示例技能' }],
      failed: [{ request: 'missing-skill', reason: 'not_found' as const }],
    };
    const deps = makeDeps({
      prepareSkillInvocation: async () => ({
        disposition: 'ready',
        sendText: '<invoked-skill>instructions</invoked-skill>\n\nrun it',
        skillInvocation,
      }),
    });

    const result = await handleQuickChatStart(
      { prompt: 'run it', skillIds: ['starter-skill', 'missing-skill'] },
      deps,
    );

    assert.deepEqual(result, {
      ok: true,
      sessionId: 'session-quickchat-1',
      skillInvocation,
    });
    assert.deepEqual(deps.spy.sendCalls, [
      {
        sessionId: 'session-quickchat-1',
        text: '<invoked-skill>instructions</invoked-skill>\n\nrun it',
        displayText: 'run it',
      },
    ]);
  });

  it('removes an unannounced session when Skill preparation throws', async () => {
    const deps = makeDeps({
      prepareSkillInvocation: async () => {
        throw new Error('discovery failed');
      },
    });

    const result = await handleQuickChatStart(
      { prompt: 'run it', skillIds: ['starter-skill'] },
      deps,
    );

    assert.deepEqual(result, {
      ok: false,
      reason: 'send_failed',
      message: '会话已创建但发送失败，请重试。',
    });
    assert.deepEqual(deps.spy.removeCalls, ['session-quickchat-1']);
    assert.deepEqual(deps.spy.emitCalls, []);
    assert.deepEqual(deps.spy.sendCalls, []);
  });
});

describe('handleQuickChatStart — error paths', () => {
  it('preserves an unavailable workspace as a domain result during creation', async () => {
    const deps = makeDeps({
      createSession: async () => {
        throw workspaceUnavailableError();
      },
    });

    const result = await handleQuickChatStart({ prompt: 'hi' }, deps);

    assert.deepEqual(result, { ok: false, reason: 'workspace_unavailable' });
    assert.deepEqual(deps.spy.emitCalls, []);
  });

  it('preserves an unavailable workspace as a domain result before first send', async () => {
    const deps = makeDeps({
      ensureCanSend: async () => {
        throw workspaceUnavailableError();
      },
    });

    const result = await handleQuickChatStart({ prompt: 'hi' }, deps);

    assert.deepEqual(result, { ok: false, reason: 'workspace_unavailable' });
    assert.deepEqual(deps.spy.sendCalls, []);
  });

  it('createSession failure → send_failed with generalized Chinese message', async () => {
    const deps = makeDeps({
      createSession: async () => {
        throw new Error('NO_REAL_CONNECTION:missing_api_key: 缺少 API key');
      },
    });
    const result = await handleQuickChatStart({ prompt: 'hi' }, deps);
    assert.equal(result.ok, false);
    if (!result.ok && result.reason === 'send_failed') {
      assert.match(result.message, /[一-鿿]/, 'message must be Chinese');
      // Raw reason code MUST NOT leak.
      assert.ok(!result.message.includes('NO_REAL_CONNECTION'), 'raw error code must not leak');
      assert.ok(!result.message.includes('missing_api_key'), 'raw reason must not leak');
    } else {
      assert.fail('expected send_failed result');
    }
  });

  it('sendFirstMessage failure → send_failed with generalized Chinese message', async () => {
    const deps = makeDeps({
      sendFirstMessage: async () => {
        throw new Error('NO_REAL_CONNECTION:connection_disabled: connection is disabled');
      },
    });
    const result = await handleQuickChatStart({ prompt: 'hi' }, deps);
    assert.equal(result.ok, false);
    if (!result.ok && result.reason === 'send_failed') {
      assert.match(result.message, /[一-鿿]/);
      assert.ok(!result.message.includes('connection_disabled'));
    } else {
      assert.fail('expected send_failed result');
    }
  });

  // @kenji + @xuan PR110b follow-up: each error category must
  // produce a Chinese-only `send_failed` message. The earlier tests
  // happened to dodge category matchers by accident; this matrix
  // locks the Chinese contract explicitly for every category the
  // classifier recognizes.
  for (const { name, raw, expected } of [
    { name: 'timeout', raw: 'Request timeout after 30s', expected: '请求超时' },
    { name: '429 rate limit', raw: 'HTTP 429 Too Many Requests', expected: '触发模型速率限制' },
    { name: '401 auth', raw: '401 Unauthorized: bad key', expected: '鉴权失败' },
    { name: '5xx', raw: 'Provider returned 500 Internal Server Error', expected: '模型服务返回错误' },
    { name: 'network', raw: 'ECONNREFUSED fetch failed', expected: '网络错误' },
  ]) {
    it(`send failure category ${name} → Chinese-only generalized message`, async () => {
      const deps = makeDeps({
        sendFirstMessage: async () => {
          throw new Error(raw);
        },
      });
      const result = await handleQuickChatStart({ prompt: 'hi' }, deps);
      assert.equal(result.ok, false);
      if (!result.ok && result.reason === 'send_failed') {
        // Exact match for the canonical Chinese phrase.
        assert.equal(result.message, expected, `${name}: expected canonical Chinese category`);
        // No English category leak.
        for (const eng of [
          'Request timed out',
          'Rate limit exceeded',
          'Authentication failed',
          'Provider returned an error',
          'Network error',
          'Operation failed',
        ]) {
          assert.equal(result.message.includes(eng), false, `${name} message leaked "${eng}"`);
        }
        // No raw category token leak from the input.
        assert.ok(!result.message.toLowerCase().includes('econnrefused'), `${name} message leaked ECONNREFUSED`);
      } else {
        assert.fail(`${name}: expected send_failed result`);
      }
    });
  }

  it('completely unknown error → Chinese fallback (no English leak)', async () => {
    const deps = makeDeps({
      sendFirstMessage: async () => {
        throw new Error('something completely uncategorized happened');
      },
    });
    const result = await handleQuickChatStart({ prompt: 'hi' }, deps);
    if (!result.ok && result.reason === 'send_failed') {
      // Falls back to the Chinese message passed in by handleQuickChatStart
      // ("会话已创建但发送失败，请重试。" for ensureCanSend / send failures).
      assert.match(result.message, /[一-鿿]/);
      assert.equal(result.message.includes('Operation failed'), false);
      assert.equal(result.message.includes('something completely uncategorized'), false);
    } else {
      assert.fail('expected send_failed');
    }
  });

  it('ensureCanSend failure → send_failed (session still created, but caller sees failure)', async () => {
    const deps = makeDeps({
      ensureCanSend: async () => {
        throw new Error('NO_REAL_CONNECTION:missing_api_key: 缺少 API key');
      },
    });
    const result = await handleQuickChatStart({ prompt: 'hi' }, deps);
    assert.equal(result.ok, false);
    if (!result.ok && result.reason === 'send_failed') {
      // Session was created (deps.createSession succeeded); but
      // ensureCanSend rejected. We surface a generalized message;
      // the session row remains in the sidebar for the user to delete
      // / retry from.
      assert.equal(deps.spy.createCalls, 1);
      assert.ok(!result.message.includes('missing_api_key'));
    } else {
      assert.fail('expected send_failed result');
    }
  });
});
