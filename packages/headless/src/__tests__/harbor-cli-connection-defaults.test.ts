import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test, afterEach } from 'node:test';
import { applyConnectionDefaults } from '../harbor-cli.js';

/**
 * Tests for applyConnectionDefaults — the function that reads
 * llm-connections.json and injects MAKA_MODEL, MAKA_LLM_CONNECTION_SLUG,
 * and MAKA_BASE_URL into the env when no explicit model is set.
 */

let cleanupDirs: string[] = [];

function makeTempConnections(content: object): string {
  const dir = mkdtempSync(join(tmpdir(), 'maka-conn-test-'));
  cleanupDirs.push(dir);
  const filePath = join(dir, 'llm-connections.json');
  writeFileSync(filePath, JSON.stringify(content), 'utf8');
  return filePath;
}

afterEach(() => {
  for (const dir of cleanupDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch { /* ignore */ }
  }
  cleanupDirs = [];
});

describe('applyConnectionDefaults', () => {
  test('happy path: injects env vars from default connection', () => {
    const connectionsPath = makeTempConnections({
      defaultSlug: 'harbor-anthropic',
      connections: [
        {
          slug: 'harbor-anthropic',
          providerType: 'anthropic',
          defaultModel: 'claude-sonnet-4-20250514',
          baseUrl: 'http://127.0.0.1:8537',
          enabled: true,
        },
      ],
    });

    const env: Record<string, string | undefined> = { MAKA_CONNECTIONS_PATH: connectionsPath };
    applyConnectionDefaults(env);

    assert.equal(env.MAKA_MODEL, 'anthropic/claude-sonnet-4-20250514');
    assert.equal(env.MAKA_LLM_CONNECTION_SLUG, 'harbor-anthropic');
    assert.equal(env.MAKA_BASE_URL, 'http://127.0.0.1:8537');
  });

  test('MAKA_MODEL already set → no override', () => {
    const connectionsPath = makeTempConnections({
      defaultSlug: 'harbor-anthropic',
      connections: [
        {
          slug: 'harbor-anthropic',
          providerType: 'anthropic',
          defaultModel: 'claude-sonnet-4-20250514',
          baseUrl: 'http://127.0.0.1:8537',
          enabled: true,
        },
      ],
    });

    const env: Record<string, string | undefined> = {
      MAKA_CONNECTIONS_PATH: connectionsPath,
      MAKA_MODEL: 'deepseek/deepseek-v4-flash',
    };
    applyConnectionDefaults(env);

    assert.equal(env.MAKA_MODEL, 'deepseek/deepseek-v4-flash');
    assert.equal(env.MAKA_LLM_CONNECTION_SLUG, undefined);
    assert.equal(env.MAKA_BASE_URL, undefined);
  });

  test('HARBOR_MODEL already set → no override', () => {
    const connectionsPath = makeTempConnections({
      defaultSlug: 'harbor-anthropic',
      connections: [
        {
          slug: 'harbor-anthropic',
          providerType: 'anthropic',
          defaultModel: 'claude-sonnet-4-20250514',
          baseUrl: 'http://127.0.0.1:8537',
          enabled: true,
        },
      ],
    });

    const env: Record<string, string | undefined> = {
      MAKA_CONNECTIONS_PATH: connectionsPath,
      HARBOR_MODEL: 'some-model',
    };
    applyConnectionDefaults(env);

    assert.equal(env.MAKA_MODEL, undefined);
    assert.equal(env.MAKA_LLM_CONNECTION_SLUG, undefined);
    assert.equal(env.MAKA_BASE_URL, undefined);
  });

  test('file missing → no error, no env vars set', () => {
    const env: Record<string, string | undefined> = {
      MAKA_CONNECTIONS_PATH: '/tmp/nonexistent-path-abc123/llm-connections.json',
    };
    applyConnectionDefaults(env);

    assert.equal(env.MAKA_MODEL, undefined);
    assert.equal(env.MAKA_LLM_CONNECTION_SLUG, undefined);
    assert.equal(env.MAKA_BASE_URL, undefined);
  });

  test('defaultSlug connection has enabled:false → skipped', () => {
    const connectionsPath = makeTempConnections({
      defaultSlug: 'harbor-anthropic',
      connections: [
        {
          slug: 'harbor-anthropic',
          providerType: 'anthropic',
          defaultModel: 'claude-sonnet-4-20250514',
          baseUrl: 'http://127.0.0.1:8537',
          enabled: false,
        },
      ],
    });

    const env: Record<string, string | undefined> = { MAKA_CONNECTIONS_PATH: connectionsPath };
    applyConnectionDefaults(env);

    assert.equal(env.MAKA_MODEL, undefined);
    assert.equal(env.MAKA_LLM_CONNECTION_SLUG, undefined);
    assert.equal(env.MAKA_BASE_URL, undefined);
  });

  test('connection has no baseUrl → MAKA_BASE_URL not set', () => {
    const connectionsPath = makeTempConnections({
      defaultSlug: 'deepseek-default',
      connections: [
        {
          slug: 'deepseek-default',
          providerType: 'deepseek',
          defaultModel: 'deepseek-v4-flash',
          enabled: true,
        },
      ],
    });

    const env: Record<string, string | undefined> = { MAKA_CONNECTIONS_PATH: connectionsPath };
    applyConnectionDefaults(env);

    assert.equal(env.MAKA_MODEL, 'deepseek/deepseek-v4-flash');
    assert.equal(env.MAKA_LLM_CONNECTION_SLUG, 'deepseek-default');
    assert.equal(env.MAKA_BASE_URL, undefined);
  });

  test('MAKA_CONNECTIONS_PATH override works', () => {
    const connectionsPath = makeTempConnections({
      defaultSlug: 'custom-conn',
      connections: [
        {
          slug: 'custom-conn',
          providerType: 'moonshot',
          defaultModel: 'moonshot-v1-8k',
          baseUrl: 'https://api.moonshot.cn/v1',
          enabled: true,
        },
      ],
    });

    const env: Record<string, string | undefined> = { MAKA_CONNECTIONS_PATH: connectionsPath };
    applyConnectionDefaults(env);

    assert.equal(env.MAKA_MODEL, 'moonshot/moonshot-v1-8k');
    assert.equal(env.MAKA_LLM_CONNECTION_SLUG, 'custom-conn');
    assert.equal(env.MAKA_BASE_URL, 'https://api.moonshot.cn/v1');
  });

  test('malformed JSON → no error, no env vars set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'maka-conn-test-'));
    cleanupDirs.push(dir);
    const filePath = join(dir, 'llm-connections.json');
    writeFileSync(filePath, '{ not valid json!!!', 'utf8');

    const env: Record<string, string | undefined> = { MAKA_CONNECTIONS_PATH: filePath };
    applyConnectionDefaults(env);

    assert.equal(env.MAKA_MODEL, undefined);
    assert.equal(env.MAKA_LLM_CONNECTION_SLUG, undefined);
    assert.equal(env.MAKA_BASE_URL, undefined);
  });

  test('no defaultSlug in file → no env vars set', () => {
    const connectionsPath = makeTempConnections({
      connections: [
        {
          slug: 'some-conn',
          providerType: 'anthropic',
          defaultModel: 'claude-sonnet-4',
          enabled: true,
        },
      ],
    });

    const env: Record<string, string | undefined> = { MAKA_CONNECTIONS_PATH: connectionsPath };
    applyConnectionDefaults(env);

    assert.equal(env.MAKA_MODEL, undefined);
    assert.equal(env.MAKA_LLM_CONNECTION_SLUG, undefined);
  });

  test('defaultSlug points to non-existent connection → no env vars set', () => {
    const connectionsPath = makeTempConnections({
      defaultSlug: 'missing-slug',
      connections: [
        {
          slug: 'other-conn',
          providerType: 'anthropic',
          defaultModel: 'claude-sonnet-4',
          enabled: true,
        },
      ],
    });

    const env: Record<string, string | undefined> = { MAKA_CONNECTIONS_PATH: connectionsPath };
    applyConnectionDefaults(env);

    assert.equal(env.MAKA_MODEL, undefined);
    assert.equal(env.MAKA_LLM_CONNECTION_SLUG, undefined);
  });

  test('MAKA_PROVIDER set without MAKA_MODEL → no override (respects explicit provider)', () => {
    const connectionsPath = makeTempConnections({
      defaultSlug: 'harbor-anthropic',
      connections: [
        {
          slug: 'harbor-anthropic',
          providerType: 'anthropic',
          defaultModel: 'claude-sonnet-4-20250514',
          baseUrl: 'http://127.0.0.1:8537',
          enabled: true,
        },
      ],
    });

    const env: Record<string, string | undefined> = {
      MAKA_CONNECTIONS_PATH: connectionsPath,
      MAKA_PROVIDER: 'deepseek',
    };
    applyConnectionDefaults(env);

    assert.equal(env.MAKA_MODEL, undefined);
    assert.equal(env.MAKA_LLM_CONNECTION_SLUG, undefined);
    assert.equal(env.MAKA_BASE_URL, undefined);
  });

  test('MAKA_BASE_URL set without MAKA_MODEL → base-url not overwritten', () => {
    const connectionsPath = makeTempConnections({
      defaultSlug: 'harbor-anthropic',
      connections: [
        {
          slug: 'harbor-anthropic',
          providerType: 'anthropic',
          defaultModel: 'claude-sonnet-4-20250514',
          baseUrl: 'http://127.0.0.1:8537',
          enabled: true,
        },
      ],
    });

    const env: Record<string, string | undefined> = {
      MAKA_CONNECTIONS_PATH: connectionsPath,
      MAKA_BASE_URL: 'http://custom-url:9999',
    };
    applyConnectionDefaults(env);

    // Model gets set since no MAKA_MODEL/HARBOR_MODEL/MAKA_PROVIDER/MAKA_LLM_CONNECTION_SLUG guard triggered
    assert.equal(env.MAKA_MODEL, 'anthropic/claude-sonnet-4-20250514');
    // But MAKA_BASE_URL is NOT overwritten (per-field respect)
    assert.equal(env.MAKA_BASE_URL, 'http://custom-url:9999');
  });

  test('MAKA_LLM_CONNECTION_SLUG set without MAKA_MODEL → no override (respects explicit slug)', () => {
    const connectionsPath = makeTempConnections({
      defaultSlug: 'harbor-anthropic',
      connections: [
        {
          slug: 'harbor-anthropic',
          providerType: 'anthropic',
          defaultModel: 'claude-sonnet-4-20250514',
          baseUrl: 'http://127.0.0.1:8537',
          enabled: true,
        },
      ],
    });

    const env: Record<string, string | undefined> = {
      MAKA_CONNECTIONS_PATH: connectionsPath,
      MAKA_LLM_CONNECTION_SLUG: 'my-custom-slug',
    };
    applyConnectionDefaults(env);

    assert.equal(env.MAKA_MODEL, undefined);
    assert.equal(env.MAKA_LLM_CONNECTION_SLUG, 'my-custom-slug');
    assert.equal(env.MAKA_BASE_URL, undefined);
  });

  test('MAKA_BACKEND=fake → no defaults applied', () => {
    const connectionsPath = makeTempConnections({
      defaultSlug: 'harbor-anthropic',
      connections: [
        {
          slug: 'harbor-anthropic',
          providerType: 'anthropic',
          defaultModel: 'claude-sonnet-4-20250514',
          baseUrl: 'http://127.0.0.1:8537',
          enabled: true,
        },
      ],
    });

    const env: Record<string, string | undefined> = {
      MAKA_CONNECTIONS_PATH: connectionsPath,
      MAKA_BACKEND: 'fake',
    };
    applyConnectionDefaults(env);

    assert.equal(env.MAKA_MODEL, undefined);
    assert.equal(env.MAKA_LLM_CONNECTION_SLUG, undefined);
    assert.equal(env.MAKA_BASE_URL, undefined);
  });

  test('MAKA_BACKEND=pi-agent → no defaults applied', () => {
    const connectionsPath = makeTempConnections({
      defaultSlug: 'harbor-anthropic',
      connections: [
        {
          slug: 'harbor-anthropic',
          providerType: 'anthropic',
          defaultModel: 'claude-sonnet-4-20250514',
          baseUrl: 'http://127.0.0.1:8537',
          enabled: true,
        },
      ],
    });

    const env: Record<string, string | undefined> = {
      MAKA_CONNECTIONS_PATH: connectionsPath,
      MAKA_BACKEND: 'pi-agent',
    };
    applyConnectionDefaults(env);

    assert.equal(env.MAKA_MODEL, undefined);
    assert.equal(env.MAKA_LLM_CONNECTION_SLUG, undefined);
    assert.equal(env.MAKA_BASE_URL, undefined);
  });

  test('invalid providerType in connections file → no-op', () => {
    const connectionsPath = makeTempConnections({
      defaultSlug: 'harbor-invalid',
      connections: [
        {
          slug: 'harbor-invalid',
          providerType: 'totally-unknown-provider',
          defaultModel: 'some-model',
          baseUrl: 'http://127.0.0.1:8537',
          enabled: true,
        },
      ],
    });

    const env: Record<string, string | undefined> = { MAKA_CONNECTIONS_PATH: connectionsPath };
    applyConnectionDefaults(env);

    assert.equal(env.MAKA_MODEL, undefined);
    assert.equal(env.MAKA_LLM_CONNECTION_SLUG, undefined);
    assert.equal(env.MAKA_BASE_URL, undefined);
  });
});
