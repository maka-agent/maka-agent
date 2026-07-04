import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { createConnectionStore } from '@maka/storage';
import {
  createMakaCliRuntimeContext,
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

  test('keeps Claude subscription cloaking enabled unless the emergency opt-out is set', () => {
    assert.equal(isMakaClaudeSubscriptionCloakEnabled({}), true);
    assert.equal(isMakaClaudeSubscriptionCloakEnabled({ MAKA_CLAUDE_SUBSCRIPTION_CLOAK: '1' }), true);
    assert.equal(isMakaClaudeSubscriptionCloakEnabled({ MAKA_CLAUDE_SUBSCRIPTION_CLOAK: '0' }), false);
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
