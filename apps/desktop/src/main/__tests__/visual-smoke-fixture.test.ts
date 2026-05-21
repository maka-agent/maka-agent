import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { tmpdir } from 'node:os';
import {
  getVisualSmokeState,
  resolveVisualSmokeFixture,
  seedVisualSmokeFixture,
} from '../visual-smoke-fixture.js';

describe('visual smoke fixture mode', () => {
  it('stays fully disabled when MAKA_VISUAL_SMOKE_FIXTURE is unset', () => {
    const fixture = resolveVisualSmokeFixture(undefined, false);
    assert.equal(fixture, null);
    assert.equal(getVisualSmokeState(fixture), null);
  });

  it('rejects fixture mode in packaged builds', () => {
    assert.throws(
      () => resolveVisualSmokeFixture('all', true),
      /only available in dev\/test builds/,
    );
  });

  it('rejects unknown scenarios', () => {
    assert.throws(
      () => resolveVisualSmokeFixture('unknown-scenario', false),
      /Unknown MAKA_VISUAL_SMOKE_FIXTURE scenario/,
    );
  });

  it('resolves known scenarios into isolated workspaces', () => {
    const fixture = resolveVisualSmokeFixture('provider-workspace', false);
    assert.deepEqual(fixture, {
      scenario: 'provider-workspace',
      workspaceName: 'visual-smoke-provider-workspace',
    });
  });

  it('first-run fixture has no transient smoke-only UI state', () => {
    const fixture = resolveVisualSmokeFixture('first-run', false);
    const state = getVisualSmokeState(fixture);
    assert.equal(state?.enabled, true);
    assert.equal(state?.scenario, 'first-run');
    assert.equal(state?.activeSessionId, undefined);
    assert.equal(state?.streamingBySession, undefined);
    assert.equal(state?.permissionBySession, undefined);
    assert.equal(state?.liveToolsBySession, undefined);
  });

  it('all fixture exposes transient streaming and permission state without persistence', () => {
    const fixture = resolveVisualSmokeFixture('all', false);
    const state = getVisualSmokeState(fixture);
    assert.equal(state?.enabled, true);
    assert.equal(state?.scenario, 'all');
    assert.equal(state?.activeSessionId, 'visual-smoke-turn');
    assert.ok(state?.streamingBySession?.['visual-smoke-streaming']);
    assert.ok(state?.permissionBySession?.['visual-smoke-permission']);
    assert.equal(state?.liveToolsBySession?.['visual-smoke-streaming']?.[0]?.status, 'running');
    assert.equal(state?.liveToolsBySession?.['visual-smoke-permission']?.[0]?.status, 'waiting_permission');
  });

  it('first-run seed keeps the fixture workspace connection-free', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-visual-smoke-first-run-'));
    try {
      const fixture = resolveVisualSmokeFixture('first-run', false);
      assert.ok(fixture);
      await seedVisualSmokeFixture({
        workspaceRoot,
        fixture,
        credentialStore: fakeCredentialStore(),
        now: 1_700_000_000_000,
      });
      const settings = JSON.parse(await readFile(join(workspaceRoot, 'settings.json'), 'utf8')) as { personalization: { displayName: string } };
      assert.equal(settings.personalization.displayName, '建文');
      await assert.rejects(readFile(join(workspaceRoot, 'llm-connections.json'), 'utf8'), /ENOENT/);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('scenario seed focuses the relevant provider state for ModelTable screenshots', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-visual-smoke-provider-'));
    try {
      const fixture = resolveVisualSmokeFixture('fallback-source', false);
      assert.ok(fixture);
      const secrets: string[] = [];
      await seedVisualSmokeFixture({
        workspaceRoot,
        fixture,
        credentialStore: fakeCredentialStore(secrets),
        now: 1_700_000_000_000,
      });
      const payload = JSON.parse(await readFile(join(workspaceRoot, 'llm-connections.json'), 'utf8')) as {
        defaultSlug: string;
        connections: Array<{ slug: string; modelSource?: string; models?: Array<{ id: string }> }>;
      };
      assert.equal(payload.defaultSlug, 'relay-fallback');
      assert.equal(payload.connections[0]?.slug, 'relay-fallback');
      assert.equal(payload.connections[0]?.modelSource, 'fallback');
      const zai = payload.connections.find((connection) => connection.slug === 'zai-live');
      assert.deepEqual(zai?.models?.map((model) => model.id), [
        'glm-4.5',
        'glm-4.5-air',
        'glm-4.6',
        'glm-4.7',
        'glm-5',
        'glm-5-turbo',
        'glm-5.1',
      ]);
      assert.deepEqual(secrets.sort(), [
        'broken-provider:api_key',
        'empty-fetched:api_key',
        'needs-reauth:api_key',
        'relay-fallback:api_key',
        'zai-live:api_key',
      ]);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('artifact-pane seed creates file-backed artifact metadata without absolute paths', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-visual-smoke-artifact-'));
    try {
      const fixture = resolveVisualSmokeFixture('artifact-pane', false);
      assert.ok(fixture);
      await seedVisualSmokeFixture({
        workspaceRoot,
        fixture,
        credentialStore: fakeCredentialStore(),
        now: 1_700_000_000_000,
      });
      const state = getVisualSmokeState(fixture);
      assert.equal(state?.activeSessionId, 'visual-smoke-artifact');

      const metadata = (await readFile(join(workspaceRoot, 'artifacts', 'metadata.jsonl'), 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { name: string; relativePath: string; kind: string; status: string });
      assert.deepEqual(metadata.map((record) => record.name), ['report.html', 'patch.diff', 'notes.md']);
      assert.deepEqual(metadata.map((record) => record.kind), ['html', 'diff', 'file']);
      assert.equal(metadata.every((record) => !record.relativePath.startsWith('/')), true);
      assert.equal(metadata.every((record) => record.status === 'live'), true);
      const report = await readFile(join(workspaceRoot, 'artifacts', 'visual-smoke-artifact', 'artifact-report-report.html'), 'utf8');
      assert.match(report, /外部链接应被禁用/);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});

function fakeCredentialStore(secrets: string[] = []) {
  return {
    async setSecret(slug: string, field: string): Promise<void> {
      secrets.push(`${slug}:${field}`);
    },
  };
}
