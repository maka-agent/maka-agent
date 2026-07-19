import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { createFileCredentialStore } from '@maka/storage';

import {
  createGitHubCopilotAccountTokens,
  parseOAuthSubscriptionTokens,
  refreshAndPersistOAuthSubscriptionTokens,
  resolveAndPersistOAuthSubscriptionTokens,
  resolveOAuthSubscriptionTokens,
} from '../subscription-credentials.js';

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
  });

  const okResponse = (body: unknown): Response =>
    ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

  for (const [name, body] of [
    ['empty object', {}],
    ['empty access token', { access_token: '', expires_in: 3600 }],
    ['missing expiry', { access_token: 'new-access' }],
    ['non-numeric expiry', { access_token: 'new-access', expires_in: 'soon' }],
    ['non-positive expiry', { access_token: 'new-access', expires_in: 0 }],
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

  test('a rotated refresh token that is an empty string keeps the previous refresh token', async () => {
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
        okResponse({ access_token: 'new-access', refresh_token: '', expires_in: 3600 }),
    });

    assert.equal(tokens?.access_token, 'new-access');
    assert.equal(tokens?.refresh_token, 'old-refresh');
    assert.equal(writes.length, 1);
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
        ({
          ok: true,
          status: 200,
          json: async () => ({
            access_token: 'new-access',
            refresh_token: 'new-refresh',
            expires_in: 3600,
          }),
        }) as unknown as Response,
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
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: 'redundant-access',
            refresh_token: 'redundant-refresh',
            expires_in: 3600,
          }),
        } as unknown as Response;
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
      releaseRefresh({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          expires_in: 3600,
        }),
      } as unknown as Response);

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
