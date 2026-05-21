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
      assert.equal(state?.now, Date.UTC(2026, 4, 22, 3, 0, 0));
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
    assert.equal(state?.now, Date.UTC(2026, 4, 22, 3, 0, 0));
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

  describe('settings sub-page scenarios (PR108j)', () => {
    // Each scenario opens a specific Settings section over the shared
    // connection/session seed. The seed file shape is identical to
    // `provider-workspace` — the only difference is `openSettingsSection`.
    const cases = [
      { scenario: 'settings-data', expectedSection: 'data' },
      { scenario: 'settings-personalization', expectedSection: 'personalization' },
      { scenario: 'settings-network', expectedSection: 'network' },
      { scenario: 'settings-bots', expectedSection: 'bot-chat' },
      { scenario: 'settings-about', expectedSection: 'about' },
      { scenario: 'settings-theme', expectedSection: 'theme' },
      { scenario: 'settings-coming-soon', expectedSection: 'daily-review' },
    ] as const;

    for (const { scenario, expectedSection } of cases) {
      it(`${scenario} opens Settings · ${expectedSection}`, () => {
        const fixture = resolveVisualSmokeFixture(scenario, false);
        assert.ok(fixture, `${scenario} should resolve`);
        const state = getVisualSmokeState(fixture);
        assert.equal(state?.scenario, scenario);
        assert.equal(state?.openSettingsSection, expectedSection);
        // Active session is the standard turn fixture so the chat
        // surface behind the modal renders meaningful context.
        assert.equal(state?.activeSessionId, 'visual-smoke-turn');
      });
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

  it('workstation-statuses seed creates one session per SessionStatus including aborted + 4 blocked variants', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-visual-smoke-ws-'));
    try {
      const fixture = resolveVisualSmokeFixture('workstation-statuses', false);
      assert.ok(fixture);
      await seedVisualSmokeFixture({
        workspaceRoot,
        fixture,
        credentialStore: fakeCredentialStore(),
        now: 1_700_000_000_000,
      });

      const state = getVisualSmokeState(fixture);
      assert.equal(state?.activeSessionId, 'visual-smoke-ws-running');

      const expectedSessions = [
        { id: 'visual-smoke-ws-running', status: 'running' },
        { id: 'visual-smoke-ws-waiting', status: 'waiting_for_user' },
        { id: 'visual-smoke-ws-blocked-auth', status: 'blocked', blockedReason: 'auth' },
        { id: 'visual-smoke-ws-blocked-perm', status: 'blocked', blockedReason: 'permission_required' },
        { id: 'visual-smoke-ws-blocked-tool', status: 'blocked', blockedReason: 'tool_failed' },
        { id: 'visual-smoke-ws-blocked-unknown', status: 'blocked', blockedReason: 'unknown' },
        { id: 'visual-smoke-ws-active', status: 'active' },
        { id: 'visual-smoke-ws-review', status: 'review' },
        { id: 'visual-smoke-ws-done', status: 'done' },
        { id: 'visual-smoke-ws-archived', status: 'archived' },
        { id: 'visual-smoke-ws-aborted', status: 'aborted' },
      ];

      for (const expected of expectedSessions) {
        const file = await readFile(join(workspaceRoot, 'sessions', expected.id, 'session.jsonl'), 'utf8');
        const header = JSON.parse(file.split('\n')[0]!) as {
          status: string;
          blockedReason?: string;
          isArchived: boolean;
        };
        assert.equal(header.status, expected.status, `${expected.id} should be ${expected.status}`);
        if ('blockedReason' in expected && expected.blockedReason !== undefined) {
          assert.equal(
            header.blockedReason,
            expected.blockedReason,
            `${expected.id} should have blockedReason=${expected.blockedReason}`,
          );
        }
        if (expected.status === 'archived') {
          assert.equal(header.isArchived, true, `${expected.id} should be archived`);
        }
      }
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

  describe('turn-control-history seed (PR109f g, smoke Path 15)', () => {
    it('seeds primary + visible-parent branch + orphan branch sharing one on-disk state', async () => {
      const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-visual-smoke-turn-control-'));
      try {
        const fixture = resolveVisualSmokeFixture('turn-control-history', false);
        assert.ok(fixture);
        await seedVisualSmokeFixture({
          workspaceRoot,
          fixture,
          credentialStore: fakeCredentialStore(),
          now: 1_700_000_000_000,
        });

        const state = getVisualSmokeState(fixture);
        assert.equal(state?.activeSessionId, 'visual-smoke-turn-control-primary');

        const primary = await readSessionHeader(workspaceRoot, 'visual-smoke-turn-control-primary');
        assert.equal(primary.parentSessionId, undefined, 'primary has no parent');

        const visible = await readSessionHeader(workspaceRoot, 'visual-smoke-turn-control-branch-visible');
        assert.equal(
          visible.parentSessionId,
          'visual-smoke-turn-control-primary',
          'visible branch points to seeded primary',
        );
        assert.equal(visible.branchOfTurnId, 'turn-retry-origin');

        const orphan = await readSessionHeader(workspaceRoot, 'visual-smoke-turn-control-branch-orphan');
        assert.equal(
          orphan.parentSessionId,
          'visual-smoke-turn-control-deleted-parent',
          'orphan branch points to NON-existent parent',
        );

        // Negative case: the orphan parent must NOT be written to disk.
        await assert.rejects(
          readFile(
            join(workspaceRoot, 'sessions', 'visual-smoke-turn-control-deleted-parent', 'session.jsonl'),
            'utf8',
          ),
          /ENOENT/,
        );
      } finally {
        await rm(workspaceRoot, { recursive: true, force: true });
      }
    });

    it('primary session log covers retry / regenerate / aborted / failed turns with TurnState messages', async () => {
      const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-visual-smoke-turn-control-turns-'));
      try {
        const fixture = resolveVisualSmokeFixture('turn-control-history', false);
        assert.ok(fixture);
        await seedVisualSmokeFixture({
          workspaceRoot,
          fixture,
          credentialStore: fakeCredentialStore(),
          now: 1_700_000_000_000,
        });

        const messages = await readSessionMessages(workspaceRoot, 'visual-smoke-turn-control-primary');
        const turnStates = messages.filter((m) => (m as { type?: string }).type === 'turn_state') as Array<{
          turnId: string;
          status: string;
          retriedFromTurnId?: string;
          regeneratedFromTurnId?: string;
          errorClass?: string;
          abortedAt?: number;
        }>;

        const byTurn = new Map(turnStates.map((s) => [s.turnId, s]));
        assert.equal(byTurn.get('turn-baseline')?.status, 'completed');
        assert.equal(byTurn.get('turn-aborted')?.status, 'aborted');
        assert.ok(byTurn.get('turn-aborted')?.abortedAt, 'aborted turn carries abortedAt timestamp');
        assert.equal(byTurn.get('turn-retry-origin')?.status, 'completed');
        // Forward lineage (retry-new is descendant of retry-origin)
        assert.equal(
          byTurn.get('turn-retry-new')?.retriedFromTurnId,
          'turn-retry-origin',
          'retry-new lineage points back to origin (drives forward badge)',
        );
        // Regenerate lineage
        assert.equal(byTurn.get('turn-regen-new')?.regeneratedFromTurnId, 'turn-regen-origin');
        // Failed turn carries an errorClass that maps to "请求超时" via
        // describeTurnErrorClass — locks the "no raw enum leak" gate
        // even at the seed level.
        assert.equal(byTurn.get('turn-failed')?.status, 'failed');
        assert.equal(byTurn.get('turn-failed')?.errorClass, 'timeout');
      } finally {
        await rm(workspaceRoot, { recursive: true, force: true });
      }
    });

    it('turn-control-branch-visible scenario flips active session to the visible-parent branch', () => {
      const fixture = resolveVisualSmokeFixture('turn-control-branch-visible', false);
      assert.ok(fixture);
      const state = getVisualSmokeState(fixture);
      assert.equal(state?.activeSessionId, 'visual-smoke-turn-control-branch-visible');
    });

    it('turn-control-branch-orphan scenario flips active session to the orphan branch', () => {
      const fixture = resolveVisualSmokeFixture('turn-control-branch-orphan', false);
      assert.ok(fixture);
      const state = getVisualSmokeState(fixture);
      assert.equal(state?.activeSessionId, 'visual-smoke-turn-control-branch-orphan');
    });

    it('all three turn-control-* scenarios write the same on-disk session set', async () => {
      // Locks the @kenji review note: the three scenarios are a single
      // state family that only differs in active-session selection. A
      // future change that diverges their on-disk seed must update
      // both this gate and the documentation in smoke.md Path 15.
      const expected = new Set([
        'visual-smoke-turn-control-primary',
        'visual-smoke-turn-control-branch-visible',
        'visual-smoke-turn-control-branch-orphan',
      ]);

      for (const scenario of ['turn-control-history', 'turn-control-branch-visible', 'turn-control-branch-orphan'] as const) {
        const workspaceRoot = await mkdtemp(join(tmpdir(), `maka-visual-smoke-tc-${scenario}-`));
        try {
          const fixture = resolveVisualSmokeFixture(scenario, false);
          assert.ok(fixture);
          await seedVisualSmokeFixture({
            workspaceRoot,
            fixture,
            credentialStore: fakeCredentialStore(),
            now: 1_700_000_000_000,
          });

          // Every fixture must seed exactly the three turn-control
          // sessions (the orphan parent stays unseeded by design).
          for (const id of expected) {
            const header = await readSessionHeader(workspaceRoot, id);
            assert.equal(header.id, id, `${scenario} should seed ${id}`);
          }
          await assert.rejects(
            readFile(
              join(workspaceRoot, 'sessions', 'visual-smoke-turn-control-deleted-parent', 'session.jsonl'),
              'utf8',
            ),
            /ENOENT/,
            `${scenario} must not seed the orphan parent`,
          );
        } finally {
          await rm(workspaceRoot, { recursive: true, force: true });
        }
      }
    });
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

async function readSessionHeader(workspaceRoot: string, sessionId: string): Promise<{
  id: string;
  parentSessionId?: string;
  branchOfTurnId?: string;
  status: string;
}> {
  const file = await readFile(join(workspaceRoot, 'sessions', sessionId, 'session.jsonl'), 'utf8');
  const firstLine = file.split('\n')[0];
  if (!firstLine) throw new Error(`session.jsonl for ${sessionId} is empty`);
  return JSON.parse(firstLine) as {
    id: string;
    parentSessionId?: string;
    branchOfTurnId?: string;
    status: string;
  };
}

async function readSessionMessages(workspaceRoot: string, sessionId: string): Promise<unknown[]> {
  const file = await readFile(join(workspaceRoot, 'sessions', sessionId, 'session.jsonl'), 'utf8');
  // Skip the first line (the SessionHeader); the rest are StoredMessages.
  return file
    .split('\n')
    .slice(1)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
}
