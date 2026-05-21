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
      reducedMotion: false,
      autoCaptureVariant: null,
      theme: null,
    });
  });

  describe('theme override (PR-IR-01b)', () => {
    it('defaults to null when env var unset', () => {
      const fixture = resolveVisualSmokeFixture('all', false);
      assert.equal(fixture?.theme, null);
      const state = getVisualSmokeState(fixture);
      assert.equal(state?.theme, undefined);
    });

    it('accepts the closed enum light / dark / auto', () => {
      for (const raw of ['light', 'dark', 'auto', 'LIGHT', ' Dark ']) {
        const fixture = resolveVisualSmokeFixture('all', false, undefined, undefined, raw);
        assert.equal(typeof fixture?.theme, 'string', `raw=${JSON.stringify(raw)}`);
        const state = getVisualSmokeState(fixture);
        assert.ok(state?.theme && ['light', 'dark', 'auto'].includes(state.theme), `raw=${JSON.stringify(raw)}`);
      }
    });

    it('rejects unknown values (fail-closed)', () => {
      for (const raw of ['solar', '', 'oklch', 'high-contrast', 'monochrome']) {
        const fixture = resolveVisualSmokeFixture('all', false, undefined, undefined, raw);
        assert.equal(fixture?.theme, null, `raw=${JSON.stringify(raw)}`);
      }
    });
  });

  describe('auto-capture variant (PR-IR-01)', () => {
    it('defaults to null when env var unset', () => {
      const fixture = resolveVisualSmokeFixture('all', false);
      assert.equal(fixture?.autoCaptureVariant, null);
      const state = getVisualSmokeState(fixture);
      assert.equal(state?.autoCaptureVariant, undefined);
    });

    it('accepts well-formed variant names', () => {
      for (const raw of ['light-1280-motion', 'dark-990-reduced-motion', 'narrow_1024']) {
        const fixture = resolveVisualSmokeFixture('all', false, undefined, raw);
        assert.equal(fixture?.autoCaptureVariant, raw, `raw=${JSON.stringify(raw)}`);
        const state = getVisualSmokeState(fixture);
        assert.equal(state?.autoCaptureVariant, raw, `raw=${JSON.stringify(raw)}`);
      }
    });

    it('rejects path-traversal / unsafe variant names (fail-closed)', () => {
      for (const raw of ['../escape', '.', '..', 'with/slash', 'with space', 'a'.repeat(65), '']) {
        const fixture = resolveVisualSmokeFixture('all', false, undefined, raw);
        assert.equal(fixture?.autoCaptureVariant, null, `raw=${JSON.stringify(raw)} should fail-closed`);
      }
    });
  });

  describe('reduced-motion variant (PR-IR-04)', () => {
    it('defaults to reducedMotion: false when env var unset', () => {
      const fixture = resolveVisualSmokeFixture('all', false);
      assert.equal(fixture?.reducedMotion, false);
      const state = getVisualSmokeState(fixture);
      assert.equal(state?.reducedMotion, undefined);
    });

    it('accepts "1" / "true" / "yes" as truthy', () => {
      for (const raw of ['1', 'true', 'yes', 'TRUE', ' yes ']) {
        const fixture = resolveVisualSmokeFixture('all', false, raw);
        assert.equal(fixture?.reducedMotion, true, `raw=${JSON.stringify(raw)}`);
        const state = getVisualSmokeState(fixture);
        assert.equal(state?.reducedMotion, true, `raw=${JSON.stringify(raw)}`);
      }
    });

    it('treats unrecognized values as false (fail-closed)', () => {
      for (const raw of ['0', 'no', 'false', '', 'maybe']) {
        const fixture = resolveVisualSmokeFixture('all', false, raw);
        assert.equal(fixture?.reducedMotion, false, `raw=${JSON.stringify(raw)}`);
      }
    });

    it('reduced motion flag works across all known scenarios', () => {
      for (const scenario of ['first-run', 'turn-narrative', 'artifact-pane', 'stale-sessions']) {
        const fixture = resolveVisualSmokeFixture(scenario, false, '1');
        assert.equal(fixture?.reducedMotion, true, `scenario=${scenario}`);
        const state = getVisualSmokeState(fixture);
        assert.equal(state?.reducedMotion, true, `scenario=${scenario}`);
      }
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

  it('stale-sessions seed reproduces the P0 workspace with active stale session', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-visual-smoke-stale-'));
    try {
      const fixture = resolveVisualSmokeFixture('stale-sessions', false);
      assert.ok(fixture);
      await seedVisualSmokeFixture({
        workspaceRoot,
        fixture,
        credentialStore: fakeCredentialStore(),
        now: 1_700_000_000_000,
      });

      const state = getVisualSmokeState(fixture);
      // @kenji gate: active session intentionally one of the stale ones so
      // the screenshot proves "active + stale → pill still visible".
      assert.equal(state?.activeSessionId, 'visual-smoke-stale-fake');

      // Connection list MUST NOT contain `fake` / `fake-claude` slugs —
      // those are what makes the seeded sessions stale.
      const connections = JSON.parse(
        await readFile(join(workspaceRoot, 'llm-connections.json'), 'utf8'),
      ) as { defaultSlug: string; connections: Array<{ slug: string }> };
      const slugs = new Set(connections.connections.map((c) => c.slug));
      assert.equal(slugs.has('fake'), false, 'fake slug must not be a real connection');
      assert.equal(slugs.has('fake-claude'), false, 'fake-claude slug must not be a real connection');
      assert.equal(slugs.has('zai-live'), true, 'zai-live must be in the connection list (healthy session uses it)');

      // Three session.jsonl files: one for each session.
      const sessionDirs = await Promise.all(
        ['visual-smoke-stale-fake', 'visual-smoke-stale-legacy', 'visual-smoke-healthy'].map(async (id) => {
          const file = await readFile(join(workspaceRoot, 'sessions', id, 'session.jsonl'), 'utf8');
          return JSON.parse(file.split('\n')[0]!) as {
            backend: string;
            llmConnectionSlug: string;
            model: string;
          };
        }),
      );
      assert.equal(sessionDirs[0]?.backend, 'fake');
      assert.equal(sessionDirs[0]?.llmConnectionSlug, 'fake');
      assert.equal(sessionDirs[1]?.backend, 'claude');
      assert.equal(sessionDirs[1]?.llmConnectionSlug, 'fake-claude');
      assert.equal(sessionDirs[2]?.backend, 'ai-sdk');
      assert.equal(sessionDirs[2]?.llmConnectionSlug, 'zai-live');
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

  it('artifact-errors seed covers deleted, missing, and unsupported MIME preview states', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-visual-smoke-artifact-errors-'));
    try {
      const fixture = resolveVisualSmokeFixture('artifact-errors', false);
      assert.ok(fixture);
      await seedVisualSmokeFixture({
        workspaceRoot,
        fixture,
        credentialStore: fakeCredentialStore(),
        now: 1_700_000_000_000,
      });
      const state = getVisualSmokeState(fixture);
      assert.equal(state?.scenario, 'artifact-errors');
      assert.equal(state?.activeSessionId, 'visual-smoke-artifact');

      const metadata = (await readFile(join(workspaceRoot, 'artifacts', 'metadata.jsonl'), 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { id: string; name: string; relativePath: string; kind: string; status: string });
      assert.deepEqual(metadata.map((record) => record.id), [
        'artifact-report',
        'artifact-patch',
        'artifact-notes',
        'artifact-deleted',
        'artifact-unsupported',
        'artifact-missing',
      ]);
      assert.equal(metadata.find((record) => record.id === 'artifact-deleted')?.status, 'deleted');
      assert.equal(metadata.find((record) => record.id === 'artifact-unsupported')?.kind, 'image');
      await assert.rejects(
        readFile(join(workspaceRoot, 'artifacts', 'visual-smoke-artifact', 'artifact-missing-missing.md'), 'utf8'),
        /ENOENT/,
      );
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
