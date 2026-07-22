import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { createFileCredentialStore } from '@maka/storage';

import {
  OAUTH_LOGIN_MAX_RESPONSE_BYTES,
  OAUTH_LOGIN_MAX_TOKEN_CHARS,
  OAuthTokenEndpointError,
  isDeterministicOAuthCredentialRejection,
} from '../oauth-login.js';
import {
  createGitHubCopilotAccountTokens,
  parseOAuthSubscriptionTokens,
  refreshAndPersistOAuthSubscriptionTokens,
  refreshOAuthSubscriptionTokens,
  resolveAndPersistOAuthSubscriptionTokens,
  resolveOAuthSubscriptionTokens,
  serializeOAuthSubscriptionTokens,
  type OAuthSubscriptionTokens,
} from '../subscription-credentials.js';

describe('OAuth subscription token serialization', () => {
  const deviceId = 'ab'.repeat(32);

  test('uses one fixed field order regardless of input insertion order', () => {
    const first: OAuthSubscriptionTokens = {
      access_token: 'access',
      refresh_token: 'refresh',
      expires_at: 123_000,
      scope: 'scope',
      device_id: deviceId,
      account_id: 'account',
    };
    const second = {
      account_id: 'account',
      scope: 'scope',
      device_id: deviceId,
      expires_at: 123_000,
      refresh_token: 'refresh',
      access_token: 'access',
    } satisfies OAuthSubscriptionTokens;

    const expected =
      `{"access_token":"access","refresh_token":"refresh","expires_at":123000,"scope":"scope","device_id":"${deviceId}","account_id":"account"}`;
    assert.equal(serializeOAuthSubscriptionTokens(first), expected);
    assert.equal(serializeOAuthSubscriptionTokens(second), expected);
    assert.deepEqual(parseOAuthSubscriptionTokens(expected), first);
  });

  test('rejects runtime-only fields and invalid bounded values', () => {
    const base: OAuthSubscriptionTokens = {
      access_token: 'access',
      refresh_token: 'refresh',
      expires_at: 123_000,
    };
    assert.throws(
      () =>
        serializeOAuthSubscriptionTokens({
          ...base,
          runtimeOwner: 'desktop',
        } as OAuthSubscriptionTokens),
      OAuthTokenEndpointError,
    );
    assert.throws(
      () =>
        serializeOAuthSubscriptionTokens({
          ...base,
          id_token: 'x'.repeat(OAUTH_LOGIN_MAX_TOKEN_CHARS + 1),
        }),
      OAuthTokenEndpointError,
    );
    assert.throws(
      () =>
        serializeOAuthSubscriptionTokens({
          ...base,
          access_token: 'x'.repeat(OAUTH_LOGIN_MAX_TOKEN_CHARS + 1),
        }),
      OAuthTokenEndpointError,
    );
    assert.throws(
      () => serializeOAuthSubscriptionTokens({ ...base, scope: '' }),
      OAuthTokenEndpointError,
    );
    assert.throws(
      () => serializeOAuthSubscriptionTokens({ ...base, expires_at: Number.NaN }),
      OAuthTokenEndpointError,
    );
    for (const invalidDeviceId of ['a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64)]) {
      assert.throws(
        () => serializeOAuthSubscriptionTokens({ ...base, device_id: invalidDeviceId }),
        OAuthTokenEndpointError,
      );
      assert.equal(
        parseOAuthSubscriptionTokens(JSON.stringify({ ...base, device_id: invalidDeviceId })),
        null,
      );
    }
  });
});

describe('GitHub Copilot subscription credentials', () => {
  test('preserves the account-scoped API endpoint in the existing OAuth token record', () => {
    assert.deepEqual(
      parseOAuthSubscriptionTokens(
        JSON.stringify({
          access_token: 'copilot-token',
          refresh_token: 'github-account-token',
          expires_at: 123_000,
          base_url: 'https://api.business.githubcopilot.com',
        }),
      ),
      {
        access_token: 'copilot-token',
        refresh_token: 'github-account-token',
        expires_at: 123_000,
        base_url: 'https://api.business.githubcopilot.com',
      },
    );
  });

  test('stores one direct Copilot-capable GitHub token in the shared OAuth record', () => {
    const tokens = createGitHubCopilotAccountTokens('github-account-token');

    assert.deepEqual(tokens, {
      access_token: 'github-account-token',
      refresh_token: 'github-account-token',
      expires_at: Number.MAX_SAFE_INTEGER,
      token_type: 'Bearer',
      base_url: 'https://api.githubcopilot.com',
    });
  });

  test('resolves the durable direct token without calling the retired exchange endpoint', async () => {
    const stored = JSON.stringify({
      access_token: 'github-account-token',
      refresh_token: 'github-account-token',
      expires_at: Number.MAX_SAFE_INTEGER,
      base_url: 'https://api.githubcopilot.com',
    });
    const tokens = await resolveOAuthSubscriptionTokens({
      providerType: 'github-copilot',
      slug: 'github-copilot',
      credentialStore: {
        getSecret: async () => stored,
        setSecret: async () =>
          assert.fail('durable GitHub tokens do not refresh through a token exchange'),
      },
      now: () => 10_000,
      fetchFn: async () => assert.fail('the retired token exchange must not be called'),
    });

    assert.equal(tokens?.access_token, 'github-account-token');
    assert.equal(tokens?.refresh_token, 'github-account-token');
    assert.equal(tokens?.base_url, 'https://api.githubcopilot.com');
  });
});

describe('OAuth refresh response validation', () => {
  const nearExpiryStored = JSON.stringify({
    access_token: 'old-access',
    refresh_token: 'old-refresh',
    expires_at: 1_000, // already past `now` below → refresh path runs
    device_id: 'cd'.repeat(32),
  });

  const okResponse = (body: unknown): Response =>
    new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });

  test('preserves deterministic invalid_token classification for Host CAS handling', async () => {
    const writes: string[] = [];
    const result = await refreshAndPersistOAuthSubscriptionTokens({
      providerType: 'openai-codex',
      slug: 'openai-codex',
      credentialStore: {
        getSecret: async () => nearExpiryStored,
        setSecret: async (_slug, _kind, value) => {
          writes.push(value);
        },
      },
      fetchFn: async () =>
        new Response(JSON.stringify({ error: 'invalid_token' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }),
    });

    assert.equal(result.outcome, 'refresh-failed');
    assert.ok(result.outcome === 'refresh-failed');
    assert.ok(result.error instanceof OAuthTokenEndpointError);
    assert.equal(result.error.category, 'invalid_token');
    assert.equal(result.error.status, 401);
    assert.equal(isDeterministicOAuthCredentialRejection(result.error), true);
    assert.deepEqual(writes, []);
  });

  test('settles a stalled response body at the internal deadline without awaiting cancellation', {
    timeout: 1_000,
  }, async () => {
    let cancelCalls = 0;
    let markCancelStarted!: () => void;
    const cancelStarted = new Promise<void>((resolve) => {
      markCancelStarted = resolve;
    });
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelCalls += 1;
        markCancelStarted();
        return new Promise<void>(() => undefined);
      },
    });

    await assert.rejects(
      refreshOAuthSubscriptionTokens({
        providerType: 'claude-subscription',
        tokens: {
          access_token: 'old-access',
          refresh_token: 'old-refresh',
          expires_at: 1_000,
        },
        fetchFn: async () => new Response(stream),
        timeoutMs: 5,
      }),
      (error) => {
        assert.ok(error instanceof OAuthTokenEndpointError);
        assert.equal(error.category, 'outcome_unknown');
        assert.equal(error.status, 200);
        return true;
      },
    );
    await cancelStarted;
    assert.equal(cancelCalls, 1);
  });

  test('an oversized response body fails closed before a Store write', async () => {
    const writes: string[] = [];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(OAUTH_LOGIN_MAX_RESPONSE_BYTES + 1));
      },
    });
    const result = await refreshAndPersistOAuthSubscriptionTokens({
      providerType: 'openai-codex',
      slug: 'openai-codex',
      credentialStore: {
        getSecret: async () => nearExpiryStored,
        setSecret: async (_slug, _kind, value) => {
          writes.push(value);
        },
      },
      fetchFn: async () => new Response(stream),
    });

    assert.equal(result.outcome, 'refresh-failed');
    assert.ok(result.outcome === 'refresh-failed');
    assert.ok(result.error instanceof OAuthTokenEndpointError);
    assert.equal(result.error.category, 'response_too_large');
    assert.equal(result.error.status, 200);
    assert.deepEqual(writes, []);
  });

  test('malformed optional fields and unknown fields fail closed before Store writes', async () => {
    const cases = [
      {
        providerType: 'claude-subscription' as const,
        body: { access_token: 'new-access', expires_in: 3600, token_type: 42 },
      },
      {
        providerType: 'claude-subscription' as const,
        body: { access_token: 'new-access', expires_in: 3600, account: { uuid: 42 } },
      },
      {
        providerType: 'openai-codex' as const,
        body: { access_token: 'new-access', expires_in: 3600, id_token: 42 },
      },
      {
        providerType: 'openai-codex' as const,
        body: { access_token: 'new-access', expires_in: 3600, unexpected: true },
      },
    ];

    for (const fixture of cases) {
      const writes: string[] = [];
      const result = await refreshAndPersistOAuthSubscriptionTokens({
        providerType: fixture.providerType,
        slug: fixture.providerType,
        credentialStore: {
          getSecret: async () => nearExpiryStored,
          setSecret: async (_slug, _kind, value) => {
            writes.push(value);
          },
        },
        fetchFn: async () => okResponse(fixture.body),
      });

      assert.equal(result.outcome, 'refresh-failed');
      assert.ok(result.outcome === 'refresh-failed');
      assert.ok(result.error instanceof OAuthTokenEndpointError);
      assert.equal(result.error.category, 'invalid_response');
      assert.equal(result.error.status, 200);
      assert.deepEqual(writes, []);
    }
  });

  for (const [name, body] of [
    ['empty object', {}],
    ['empty access token', { access_token: '', expires_in: 3600 }],
    ['missing expiry', { access_token: 'new-access' }],
    ['non-numeric expiry', { access_token: 'new-access', expires_in: 'soon' }],
    ['non-positive expiry', { access_token: 'new-access', expires_in: 0 }],
    [
      'empty rotated refresh token',
      { access_token: 'new-access', refresh_token: '', expires_in: 3600 },
    ],
  ] as const) {
    test(`a 200 refresh with ${name} never replaces the stored token`, async () => {
      const writes: string[] = [];
      const tokens = await resolveOAuthSubscriptionTokens({
        providerType: 'claude-subscription',
        slug: 'claude-subscription',
        credentialStore: {
          getSecret: async () => nearExpiryStored,
          setSecret: async (_slug, _kind, value) => {
            writes.push(value);
          },
        },
        now: () => 10_000_000,
        fetchFn: async () => okResponse(body),
      });

      assert.equal(tokens, null, 'an invalid refresh payload must surface as a refresh failure');
      assert.deepEqual(
        writes,
        [],
        'the still-working stored record must not be overwritten with garbage',
      );
    });
  }

  test('a valid Claude response may omit rotation and preserves validated metadata', async () => {
    const writes: string[] = [];
    const tokens = await resolveOAuthSubscriptionTokens({
      providerType: 'claude-subscription',
      slug: 'claude-subscription',
      credentialStore: {
        getSecret: async () => nearExpiryStored,
        setSecret: async (_slug, _kind, value) => {
          writes.push(value);
        },
      },
      now: () => 10_000_000,
      fetchFn: async () =>
        okResponse({
          access_token: 'new-access',
          expires_in: 3600,
          token_type: 'Bearer',
          scope: 'user:sessions:claude_code',
          account: { uuid: 'account-uuid' },
        }),
    });

    assert.equal(tokens?.access_token, 'new-access');
    assert.equal(tokens?.refresh_token, 'old-refresh');
    assert.equal(tokens?.token_type, 'Bearer');
    assert.equal(tokens?.scope, 'user:sessions:claude_code');
    assert.equal(tokens?.account_uuid, 'account-uuid');
    assert.equal(tokens?.device_id, 'cd'.repeat(32));
    assert.equal(writes.length, 1);
    assert.deepEqual(parseOAuthSubscriptionTokens(writes[0] ?? ''), tokens);
  });

  test('a valid Codex response preserves account metadata and accepts bounded optional fields', async () => {
    const tokens = await refreshOAuthSubscriptionTokens({
      providerType: 'openai-codex',
      tokens: {
        access_token: 'old-access',
        refresh_token: 'old-refresh',
        expires_at: 1_000,
        account_id: 'account-id',
        token_type: 'Old-Type',
        scope: 'old-scope',
      },
      now: () => 10_000_000,
      fetchFn: async () =>
        okResponse({
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          id_token: 'new-id-token',
          expires_in: 3600,
          token_type: 'Bearer',
          scope: 'openid profile',
        }),
    });

    assert.deepEqual(tokens, {
      access_token: 'new-access',
      refresh_token: 'new-refresh',
      expires_at: 13_600_000,
      id_token: 'new-id-token',
      token_type: 'Bearer',
      scope: 'openid profile',
      account_id: 'account-id',
    });
  });
});

describe('OAuth refresh persistence transaction', () => {
  test('a read-only store fails before starting a remote refresh', async () => {
    const stored = JSON.stringify({
      access_token: 'old-access',
      refresh_token: 'old-refresh',
      expires_at: 1_000,
    });
    let refreshCalls = 0;

    const result = await refreshAndPersistOAuthSubscriptionTokens({
      slug: 'claude-subscription',
      credentialStore: { getSecret: async () => stored },
      refreshTokens: async () => {
        refreshCalls += 1;
        return {
          access_token: 'discarded-access',
          refresh_token: 'discarded-refresh',
          expires_at: 20_000_000,
        };
      },
    });

    assert.equal(result.outcome, 'storage-failed');
    assert.equal(refreshCalls, 0, 'a refresh must not rotate tokens that cannot be persisted');
  });

  test('strict serialization failures are refresh-failed and never reach Store', async () => {
    const stored = JSON.stringify({
      access_token: 'old-access',
      refresh_token: 'old-refresh',
      expires_at: 1_000,
    });
    const writes: string[] = [];
    const result = await refreshAndPersistOAuthSubscriptionTokens({
      slug: 'claude-subscription',
      credentialStore: {
        getSecret: async () => stored,
        setSecret: async (_slug, _kind, value) => {
          writes.push(value);
        },
      },
      refreshTokens: async () =>
        ({
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          expires_at: 20_000_000,
          runtimeOwner: 'host',
        }) as OAuthSubscriptionTokens,
    });

    assert.equal(result.outcome, 'refresh-failed');
    assert.ok(result.outcome === 'refresh-failed');
    assert.ok(result.error instanceof OAuthTokenEndpointError);
    assert.equal(result.error.category, 'invalid_response');
    assert.deepEqual(writes, []);
  });

  test('resolve accepts a store whose only write capability is compare-and-set', async () => {
    const stored = JSON.stringify({
      access_token: 'old-access',
      refresh_token: 'old-refresh',
      expires_at: 1_000,
    });
    let committed: string | null = null;
    const tokens = await resolveOAuthSubscriptionTokens({
      providerType: 'claude-subscription',
      slug: 'claude-subscription',
      credentialStore: {
        getSecret: async () => stored,
        compareAndSetSecret: async (_slug, _kind, expected, value) => {
          assert.equal(expected, stored);
          committed = value;
          return { committed: true };
        },
      },
      now: () => 10_000_000,
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            access_token: 'new-access',
            refresh_token: 'new-refresh',
            expires_in: 3600,
          }),
        ),
    });

    assert.equal(tokens?.access_token, 'new-access');
    assert.equal(parseOAuthSubscriptionTokens(committed ?? '')?.access_token, 'new-access');
  });

  test('near-expiry resolve keeps its first read as the refresh commit basis', async () => {
    const initial = JSON.stringify({
      access_token: 'old-access',
      refresh_token: 'old-refresh',
      expires_at: 1_000,
    });
    const winner = JSON.stringify({
      access_token: 'winner-access',
      refresh_token: 'winner-refresh',
      expires_at: 20_000_000,
    });
    let current = initial;
    let reads = 0;
    let commits = 0;
    const tokens = await resolveOAuthSubscriptionTokens({
      providerType: 'claude-subscription',
      slug: 'claude-subscription',
      credentialStore: {
        getSecret: async () => {
          reads += 1;
          if (reads === 2) current = winner;
          return current;
        },
        compareAndSetSecret: async (_slug, _kind, expected, value) => {
          if (expected !== current) return { committed: false, current };
          commits += 1;
          current = value;
          return { committed: true };
        },
      },
      now: () => 10_000_000,
      fetchFn: async () => {
        current = winner;
        return new Response(
          JSON.stringify({
            access_token: 'redundant-access',
            refresh_token: 'redundant-refresh',
            expires_in: 3600,
          }),
        );
      },
    });

    assert.equal(tokens?.access_token, 'winner-access');
    assert.equal(
      commits,
      0,
      'a resolve triggered by the old basis must not commit over the winner',
    );
    assert.equal(current, winner);
  });

  test('a custom automatic refresh keeps its expiry-decision read as the commit basis', async () => {
    const initial = JSON.stringify({
      access_token: 'old-access',
      refresh_token: 'old-refresh',
      expires_at: 1_000,
    });
    const winner = JSON.stringify({
      access_token: 'winner-access',
      refresh_token: 'winner-refresh',
      expires_at: 20_000_000,
    });
    let current = initial;
    let commits = 0;

    const result = await resolveAndPersistOAuthSubscriptionTokens({
      slug: 'cursor-subscription',
      credentialStore: {
        getSecret: async () => current,
        compareAndSetSecret: async (_slug, _kind, expected, value) => {
          if (expected !== current) return { committed: false, current };
          commits += 1;
          current = value;
          return { committed: true };
        },
      },
      now: () => 10_000_000,
      refreshSkewMs: 0,
      refreshTokens: async () => {
        current = winner;
        return {
          access_token: 'redundant-access',
          refresh_token: 'redundant-refresh',
          expires_at: 20_000_000,
        };
      },
    });

    assert.equal(result.outcome, 'superseded');
    assert.equal(
      result.outcome === 'superseded' ? result.tokens.access_token : null,
      'winner-access',
    );
    assert.equal(commits, 0, 'the old expiry-decision basis must not commit over the winner');
    assert.equal(current, winner);
  });

  test('a logout from another store stays terminal while refresh is in flight', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-oauth-refresh-'));
    try {
      const refreshingStore = createFileCredentialStore(dir);
      const logoutStore = createFileCredentialStore(dir);
      const stored = JSON.stringify({
        access_token: 'old-access',
        refresh_token: 'old-refresh',
        expires_at: 1_000,
      });
      await refreshingStore.setSecret('claude-subscription', 'oauth_token', stored);

      let releaseRefresh!: (response: Response) => void;
      let markRefreshStarted!: () => void;
      const refreshStarted = new Promise<void>((resolve) => {
        markRefreshStarted = resolve;
      });
      const refreshResponse = new Promise<Response>((resolve) => {
        releaseRefresh = resolve;
      });
      const resolving = resolveOAuthSubscriptionTokens({
        providerType: 'claude-subscription',
        slug: 'claude-subscription',
        credentialStore: refreshingStore,
        now: () => 10_000_000,
        fetchFn: async () => {
          markRefreshStarted();
          return refreshResponse;
        },
      });

      await refreshStarted;
      await logoutStore.deleteSecret('claude-subscription', 'oauth_token');
      releaseRefresh(
        new Response(
          JSON.stringify({
            access_token: 'new-access',
            refresh_token: 'new-refresh',
            expires_in: 3600,
          }),
        ),
      );

      assert.equal(await resolving, null);
      assert.equal(await logoutStore.getSecret('claude-subscription', 'oauth_token'), null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('two concurrent refreshes converge on the single committed token', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-oauth-refresh-'));
    try {
      const storeA = createFileCredentialStore(dir);
      const storeB = createFileCredentialStore(dir);
      const stored = JSON.stringify({
        access_token: 'old-access',
        refresh_token: 'old-refresh',
        expires_at: 1_000,
      });
      await storeA.setSecret('claude-subscription', 'oauth_token', stored);

      let started = 0;
      let markBothStarted!: () => void;
      const bothStarted = new Promise<void>((resolve) => {
        markBothStarted = resolve;
      });
      let releaseBoth!: () => void;
      const released = new Promise<void>((resolve) => {
        releaseBoth = resolve;
      });
      const run = (store: typeof storeA, suffix: string) =>
        refreshAndPersistOAuthSubscriptionTokens({
          slug: 'claude-subscription',
          credentialStore: store,
          refreshTokens: async () => {
            started += 1;
            if (started === 2) markBothStarted();
            await released;
            return {
              access_token: `access-${suffix}`,
              refresh_token: `refresh-${suffix}`,
              expires_at: 20_000_000,
            };
          },
        });

      const pendingA = run(storeA, 'A');
      const pendingB = run(storeB, 'B');
      await bothStarted;
      releaseBoth();
      const results = await Promise.all([pendingA, pendingB]);

      assert.deepEqual(results.map((result) => result.outcome).sort(), ['refreshed', 'superseded']);
      const winner = results.find((result) => result.outcome === 'refreshed');
      const loser = results.find((result) => result.outcome === 'superseded');
      assert.ok(winner?.outcome === 'refreshed');
      assert.ok(loser?.outcome === 'superseded');
      assert.deepEqual(loser.tokens, winner.tokens);
      assert.deepEqual(
        parseOAuthSubscriptionTokens(
          (await storeA.getSecret('claude-subscription', 'oauth_token')) ?? '',
        ),
        winner.tokens,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
