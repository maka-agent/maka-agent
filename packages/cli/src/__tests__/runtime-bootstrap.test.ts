import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { createConnectionStore } from '@maka/storage';
import {
  createMakaCliRuntimeContext,
  getOrCreateCliClaudeDeviceId,
  isMakaClaudeSubscriptionCloakEnabled,
} from '../runtime-bootstrap.js';

describe('Maka CLI runtime bootstrap', () => {
  test('loads the default connection and can create an ai-sdk session', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const connectionStore = createConnectionStore(workspaceRoot);
      await connectionStore.create({
        slug: 'local',
        name: 'Local Ollama',
        providerType: 'ollama',
        defaultModel: 'llama3.2',
      });

      const context = await createMakaCliRuntimeContext({
        workspaceRoot,
        cwd: '/repo',
      });
      const session = await context.runtime.createSession({
        cwd: context.cwd,
        backend: 'ai-sdk',
        llmConnectionSlug: context.target.connection.slug,
        model: context.target.model,
        permissionMode: 'bypass',
        name: 'hello',
      });

      assert.equal(context.target.connection.slug, 'local');
      assert.equal(context.target.model, 'llama3.2');
      assert.equal(session.backend, 'ai-sdk');
      assert.equal(session.llmConnectionSlug, 'local');
      assert.equal(session.permissionMode, 'bypass');
    });
  });

  test('registers Edit in the TUI runtime toolset and still requires permission', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const connectionStore = createConnectionStore(workspaceRoot);
      await connectionStore.create({
        slug: 'local',
        name: 'Local Ollama',
        providerType: 'ollama',
        defaultModel: 'llama3.2',
      });

      const context = await createMakaCliRuntimeContext({
        workspaceRoot,
        cwd: '/repo',
      });

      const edit = context.tools.find((tool) => tool.name === 'Edit');
      assert.ok(
        edit,
        'Edit must be registered (regression: it was once filtered out of the TUI runtime)',
      );
      assert.equal(edit?.permissionRequired, true);
    });
  });

  test('keeps Claude subscription cloaking enabled unless the emergency opt-out is set', () => {
    assert.equal(isMakaClaudeSubscriptionCloakEnabled({}), true);
    assert.equal(isMakaClaudeSubscriptionCloakEnabled({ MAKA_CLAUDE_SUBSCRIPTION_CLOAK: '1' }), true);
    assert.equal(isMakaClaudeSubscriptionCloakEnabled({ MAKA_CLAUDE_SUBSCRIPTION_CLOAK: '0' }), false);
  });

  test('persists a random Claude device id instead of deriving it from the workspace path', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const pathHash = createHash('sha256').update(workspaceRoot, 'utf8').digest('hex');
      const first = await getOrCreateCliClaudeDeviceId(workspaceRoot, {
        newId: () => '1'.repeat(64),
      });
      const second = await getOrCreateCliClaudeDeviceId(workspaceRoot, {
        newId: () => '2'.repeat(64),
      });

      assert.equal(first, '1'.repeat(64));
      assert.equal(second, first);
      assert.notEqual(first, pathHash);
    });
  });
});

async function withWorkspace(fn: (workspaceRoot: string) => Promise<void>): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-cli-runtime-'));
  try {
    await fn(workspaceRoot);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}
