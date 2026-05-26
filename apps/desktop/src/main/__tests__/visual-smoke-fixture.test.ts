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
      locale: null,
      timezone: null,
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

  describe('UI locale override (PR-UI-VISUAL-SMOKE-LOCALE)', () => {
    it('defaults to null when MAKA_VISUAL_SMOKE_LOCALE unset', () => {
      const fixture = resolveVisualSmokeFixture('all', false);
      assert.equal(fixture?.locale, null);
      const state = getVisualSmokeState(fixture);
      assert.equal(state?.locale, undefined);
    });

    it('accepts the closed enum zh / en (case + whitespace tolerant)', () => {
      for (const raw of ['zh', 'en', 'ZH', ' En ', 'EN']) {
        const fixture = resolveVisualSmokeFixture('all', false, undefined, undefined, undefined, raw);
        assert.ok(fixture?.locale, `raw=${JSON.stringify(raw)}`);
        assert.ok(['zh', 'en'].includes(fixture!.locale!), `raw=${JSON.stringify(raw)}`);
        const state = getVisualSmokeState(fixture);
        assert.ok(state?.locale && ['zh', 'en'].includes(state.locale), `raw=${JSON.stringify(raw)}`);
      }
    });

    it('rejects unknown locale values (fail-closed to navigator detection)', () => {
      // Cover regional variants too — we deliberately only accept the
      // bare `zh` / `en` short codes. `zh-CN` etc. fail closed so the
      // override is unambiguous; users wanting CN locale set `zh`.
      for (const raw of ['', 'es', 'ja', 'zh-CN', 'en-US', 'auto', 'system']) {
        const fixture = resolveVisualSmokeFixture('all', false, undefined, undefined, undefined, raw);
        assert.equal(fixture?.locale, null, `raw=${JSON.stringify(raw)}`);
      }
    });

    it('locale flag carries through into VisualSmokeState across all known scenarios', () => {
      for (const scenario of ['first-run', 'turn-narrative', 'artifact-pane', 'stale-sessions']) {
        const fixture = resolveVisualSmokeFixture(scenario, false, undefined, undefined, undefined, 'zh');
        assert.equal(fixture?.locale, 'zh', `scenario=${scenario}`);
        const state = getVisualSmokeState(fixture);
        assert.equal(state?.locale, 'zh', `scenario=${scenario}`);
      }
    });

    it('locale is independent from theme / reduced-motion / auto-capture', () => {
      const fixture = resolveVisualSmokeFixture('all', false, '1', 'light-1280-motion', 'dark', 'en');
      assert.equal(fixture?.locale, 'en');
      assert.equal(fixture?.theme, 'dark');
      assert.equal(fixture?.reducedMotion, true);
      assert.equal(fixture?.autoCaptureVariant, 'light-1280-motion');
      const state = getVisualSmokeState(fixture);
      assert.equal(state?.locale, 'en');
      assert.equal(state?.theme, 'dark');
      assert.equal(state?.reducedMotion, true);
      assert.equal(state?.autoCaptureVariant, 'light-1280-motion');
    });
  });

  describe('IANA timezone override (PR-UI-VISUAL-SMOKE-TIMEZONE, @kenji msg 45486cdf)', () => {
    it('defaults to null when MAKA_VISUAL_SMOKE_TIMEZONE unset', () => {
      const fixture = resolveVisualSmokeFixture('all', false);
      assert.equal(fixture?.timezone, null);
      const state = getVisualSmokeState(fixture);
      assert.equal(state?.timezone, undefined);
    });

    it('accepts well-formed IANA timezone names', () => {
      // Bound the test surface to tz names every modern JavaScript
      // runtime ships with (ICU CLDR canonical zones).
      const valid = [
        'UTC',
        'America/New_York',
        'America/Los_Angeles',
        'Europe/London',
        'Europe/Paris',
        'Asia/Shanghai',
        'Asia/Tokyo',
        'Pacific/Auckland',
      ];
      for (const tz of valid) {
        const fixture = resolveVisualSmokeFixture('all', false, undefined, undefined, undefined, undefined, tz);
        assert.equal(fixture?.timezone, tz, `tz=${tz}`);
        const state = getVisualSmokeState(fixture);
        assert.equal(state?.timezone, tz, `tz=${tz}`);
      }
    });

    it('trims surrounding whitespace but keeps mixed-case IANA names', () => {
      // IANA names are case-sensitive on strict platforms
      // (`America/New_York`, not `america/new_york`). The parser
      // trim-onlys; it does not lowercase, so the canonical form
      // survives.
      const fixture = resolveVisualSmokeFixture('all', false, undefined, undefined, undefined, undefined, '  Asia/Shanghai  ');
      assert.equal(fixture?.timezone, 'Asia/Shanghai');
    });

    it('rejects unknown / malformed IANA names (fail-closed via Intl.DateTimeFormat)', () => {
      const invalid = [
        '',
        '   ',
        'Asia/Imaginary',
        'Pacific/Mu',
        'Foo/Bar',
        'America/Made_Up',
        'Not_A_TZ',
        '!!!',
        'utc/zulu',
      ];
      for (const tz of invalid) {
        const fixture = resolveVisualSmokeFixture('all', false, undefined, undefined, undefined, undefined, tz);
        assert.equal(fixture?.timezone, null, `tz=${JSON.stringify(tz)}`);
      }
    });

    it('rejects oversize inputs (>128 chars) without invoking Intl.DateTimeFormat', () => {
      const oversize = 'A'.repeat(129);
      const fixture = resolveVisualSmokeFixture('all', false, undefined, undefined, undefined, undefined, oversize);
      assert.equal(fixture?.timezone, null);
    });

    it('does NOT freeze the renderer Date — only sets the contract', () => {
      // Defense-in-depth note: this test pins the scope kenji
      // approved (msg 45486cdf): the parser only validates +
      // surfaces the IANA name. It does NOT mutate `Date.prototype`,
      // global `Intl.DateTimeFormat`, or `state.now`. `state.now`
      // is still the canonical clock-freeze for visual smoke.
      const fixture = resolveVisualSmokeFixture('all', false, undefined, undefined, undefined, undefined, 'Asia/Shanghai');
      const state = getVisualSmokeState(fixture);
      assert.equal(state?.timezone, 'Asia/Shanghai');
      assert.equal(state?.now, Date.UTC(2026, 4, 22, 3, 0, 0));
      // No global mutation: Date.now / new Date() / Intl.DateTimeFormat
      // are untouched by parse-time.
      const before = Date.now();
      const now1 = Date.now();
      assert.ok(now1 >= before);
      const formatter = new Intl.DateTimeFormat(undefined);
      assert.equal(typeof formatter.resolvedOptions().timeZone, 'string');
    });

    it('timezone flag carries through into VisualSmokeState across all known scenarios', () => {
      for (const scenario of ['first-run', 'turn-narrative', 'artifact-pane', 'stale-sessions']) {
        const fixture = resolveVisualSmokeFixture(scenario, false, undefined, undefined, undefined, undefined, 'Europe/London');
        assert.equal(fixture?.timezone, 'Europe/London', `scenario=${scenario}`);
        const state = getVisualSmokeState(fixture);
        assert.equal(state?.timezone, 'Europe/London', `scenario=${scenario}`);
      }
    });

    it('timezone is independent from theme / locale / reduced-motion / auto-capture', () => {
      const fixture = resolveVisualSmokeFixture('all', false, '1', 'light-1280-motion', 'dark', 'en', 'Asia/Tokyo');
      assert.equal(fixture?.timezone, 'Asia/Tokyo');
      assert.equal(fixture?.locale, 'en');
      assert.equal(fixture?.theme, 'dark');
      assert.equal(fixture?.reducedMotion, true);
      assert.equal(fixture?.autoCaptureVariant, 'light-1280-motion');
      const state = getVisualSmokeState(fixture);
      assert.equal(state?.timezone, 'Asia/Tokyo');
      assert.equal(state?.locale, 'en');
      assert.equal(state?.theme, 'dark');
      assert.equal(state?.reducedMotion, true);
      assert.equal(state?.autoCaptureVariant, 'light-1280-motion');
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

  it('sidebar-search-modal-open shares the 60-session seed and sets searchModalOpen for auto-open (PR-SIDEBAR-IA-0 Phase 2 fixup v3)', async () => {
    // PR-SIDEBAR-IA-0 Phase 2 fixup v3 (xuan msg `dce5a6fb` #2): the
    // sidebar-search-modal-open scenario reuses the 60-session seed
    // so the sidebar behind the modal matches the long-sessions
    // baseline exactly. The only differentiator from `sidebar-long-
    // sessions` is `VisualSmokeState.searchModalOpen=true`, which
    // the renderer reads to call `setSearchModalOpen(true)` before
    // auto-capture settles, so the SearchModal shell is on screen
    // in the captured PNG.
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-visual-smoke-search-modal-'));
    try {
      const fixture = resolveVisualSmokeFixture('sidebar-search-modal-open', false);
      assert.ok(fixture);
      await seedVisualSmokeFixture({
        workspaceRoot,
        fixture,
        credentialStore: fakeCredentialStore(),
        now: 1_700_000_000_000,
      });

      const state = getVisualSmokeState(fixture);
      // Modal-open hint is the contract the renderer reads.
      assert.equal(state?.searchModalOpen, true, 'searchModalOpen must be true so the renderer auto-opens the modal');
      // Same active session as the long-sessions scenario so the
      // sidebar behind the modal looks identical to that baseline.
      assert.equal(state?.activeSessionId, 'visual-smoke-sidebar-long-00');

      // Same 60-session seed actually lands on disk so the sidebar
      // is fully populated behind the modal.
      const file = await readFile(
        join(workspaceRoot, 'sessions', 'visual-smoke-sidebar-long-00', 'session.jsonl'),
        'utf8',
      );
      const header = JSON.parse(file.split('\n')[0]!) as { id: string; status: string };
      assert.equal(header.id, 'visual-smoke-sidebar-long-00');
      assert.equal(header.status, 'active');
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('sidebar-long-sessions seed creates 60 sessions for the scroll-fix gate (PR-SIDEBAR-IA-0 Phase 1)', async () => {
    // PR-SIDEBAR-IA-0 Phase 1 (xuan msg `dc790a54`, kenji `0f7bb872`):
    // hard gate fixture for sidebar scroll fix. The CSS contract is
    // verified by screenshot baselines; the fixture itself only needs
    // to (a) actually seed 60 sessions, (b) make the newest one the
    // active selection, and (c) keep IDs deterministic.
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-visual-smoke-long-'));
    try {
      const fixture = resolveVisualSmokeFixture('sidebar-long-sessions', false);
      assert.ok(fixture);
      await seedVisualSmokeFixture({
        workspaceRoot,
        fixture,
        credentialStore: fakeCredentialStore(),
        now: 1_700_000_000_000,
      });

      const state = getVisualSmokeState(fixture);
      // Active session is the first (newest by lastMessageAt).
      assert.equal(state?.activeSessionId, 'visual-smoke-sidebar-long-00');

      // Verify all 60 sessions exist on disk with deterministic IDs +
      // monotonically decreasing lastMessageAt (newest first).
      let previousLastMessageAt = Infinity;
      for (let i = 0; i < 60; i++) {
        const idSuffix = String(i).padStart(2, '0');
        const sessionId = 'visual-smoke-sidebar-long-' + idSuffix;
        const file = await readFile(join(workspaceRoot, 'sessions', sessionId, 'session.jsonl'), 'utf8');
        const header = JSON.parse(file.split('\n')[0]!) as {
          id: string;
          name: string;
          status: string;
          lastMessageAt: number;
        };
        assert.equal(header.id, sessionId);
        assert.equal(header.name, '会话 ' + idSuffix);
        assert.equal(header.status, 'active');
        assert.ok(
          header.lastMessageAt < previousLastMessageAt,
          'sessions must be in descending lastMessageAt order so the newest sorts to the top of the sidebar',
        );
        previousLastMessageAt = header.lastMessageAt;
      }
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  describe('PR-UI-RENDER-3a-smoke — registry-driven artifact preview fixtures (@kenji msg fc9753b9)', () => {
    /**
     * Helper: assert NO renderer-visible field of any artifact
     * record contains an absolute-path leak. The `relativePath`
     * field intentionally contains a workspace-relative path (the
     * registry uses it to read the file), but the UI must NEVER
     * surface it. We check the *fixture* metadata here, which is
     * the source of truth the renderer consumes. The smoke
     * pipeline's PNG diff covers the rendered DOM separately;
     * here we lock the input.
     */
    function assertNoAbsolutePathInMetadata(line: string) {
      assert.equal(line.includes('/Users/'), false, `metadata leak: /Users/ in ${line}`);
      assert.equal(line.includes('/private/'), false, `metadata leak: /private/ in ${line}`);
      // Workspace relativePath fragment in the metadata is fine —
      // it's the registry input — but it must always be
      // session-prefixed and never start with `/`.
      const record = JSON.parse(line) as { relativePath: string };
      assert.equal(record.relativePath.startsWith('/'), false);
      assert.equal(record.relativePath.startsWith(`visual-smoke-artifact/`), true);
    }

    it('artifact-preview-image: single PNG seeded → registry will resolve image(mime_match)', async () => {
      const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-visual-smoke-preview-image-'));
      try {
        const fixture = resolveVisualSmokeFixture('artifact-preview-image', false);
        assert.ok(fixture);
        await seedVisualSmokeFixture({
          workspaceRoot,
          fixture,
          credentialStore: fakeCredentialStore(),
          now: 1_700_000_000_000,
        });
        const state = getVisualSmokeState(fixture);
        assert.equal(state?.activeSessionId, 'visual-smoke-artifact');

        const lines = (await readFile(join(workspaceRoot, 'artifacts', 'metadata.jsonl'), 'utf8'))
          .split('\n')
          .filter(Boolean);
        assert.equal(lines.length, 1, 'preview-image fixture must seed exactly one artifact');
        for (const line of lines) assertNoAbsolutePathInMetadata(line);

        const record = JSON.parse(lines[0]!) as {
          name: string;
          kind: string;
          mimeType?: string;
          sizeBytes: number;
        };
        assert.equal(record.name, 'screenshot.png');
        assert.equal(record.kind, 'image');
        assert.equal(record.mimeType, 'image/png');
        // Real PNG bytes were written; stat returns the real size
        // (67 bytes for our 1x1 transparent fixture PNG).
        assert.equal(record.sizeBytes > 0 && record.sizeBytes < 200, true);

        // File must actually exist (sniff-able by readBinary at
        // runtime). The fixture path is reproducible.
        const filePath = join(
          workspaceRoot,
          'artifacts',
          'visual-smoke-artifact',
          'artifact-preview-image-screenshot.png',
        );
        const bytes = await readFile(filePath);
        // PNG magic number
        assert.equal(bytes[0], 0x89);
        assert.equal(bytes[1], 0x50); // 'P'
        assert.equal(bytes[2], 0x4e); // 'N'
        assert.equal(bytes[3], 0x47); // 'G'
      } finally {
        await rm(workspaceRoot, { recursive: true, force: true });
      }
    });

    it('artifact-preview-unsupported: image/heic disallowed mime → L1 unsupported(mime_disallowed), readBinary never called', async () => {
      const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-visual-smoke-preview-unsupported-'));
      try {
        const fixture = resolveVisualSmokeFixture('artifact-preview-unsupported', false);
        assert.ok(fixture);
        await seedVisualSmokeFixture({
          workspaceRoot,
          fixture,
          credentialStore: fakeCredentialStore(),
          now: 1_700_000_000_000,
        });

        const lines = (await readFile(join(workspaceRoot, 'artifacts', 'metadata.jsonl'), 'utf8'))
          .split('\n')
          .filter(Boolean);
        assert.equal(lines.length, 1);
        for (const line of lines) assertNoAbsolutePathInMetadata(line);

        const record = JSON.parse(lines[0]!) as {
          name: string;
          kind: string;
          mimeType: string;
        };
        assert.equal(record.name, 'portrait.heic');
        assert.equal(record.kind, 'image');
        // mimeType MUST be the disallowed one — otherwise the
        // resolver wouldn't take the unsupported(mime_disallowed)
        // branch we want to capture.
        assert.equal(record.mimeType, 'image/heic');
      } finally {
        await rm(workspaceRoot, { recursive: true, force: true });
      }
    });

    it('artifact-preview-oversize: 3MB sizeBytes claim with skipFile → L1 unsupported(oversize)', async () => {
      const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-visual-smoke-preview-oversize-'));
      try {
        const fixture = resolveVisualSmokeFixture('artifact-preview-oversize', false);
        assert.ok(fixture);
        await seedVisualSmokeFixture({
          workspaceRoot,
          fixture,
          credentialStore: fakeCredentialStore(),
          now: 1_700_000_000_000,
        });

        const lines = (await readFile(join(workspaceRoot, 'artifacts', 'metadata.jsonl'), 'utf8'))
          .split('\n')
          .filter(Boolean);
        assert.equal(lines.length, 1);
        for (const line of lines) assertNoAbsolutePathInMetadata(line);

        const record = JSON.parse(lines[0]!) as {
          name: string;
          kind: string;
          mimeType: string;
          sizeBytes: number;
        };
        assert.equal(record.name, 'huge.png');
        assert.equal(record.kind, 'image');
        assert.equal(record.mimeType, 'image/png');
        // sizeBytesOverride wins. The fixture claims 3MB so the
        // L1 resolver rejects via the oversize gate before any
        // readBinary attempt. Asserts the override actually
        // survived through writeArtifactSpecs.
        assert.equal(record.sizeBytes, 3 * 1024 * 1024);

        // File must NOT exist (skipFile: true). If it does, the
        // override would have been overwritten by stat() — which
        // would defeat the entire scenario.
        await assert.rejects(
          readFile(
            join(
              workspaceRoot,
              'artifacts',
              'visual-smoke-artifact',
              'artifact-preview-oversize-huge.png',
            ),
            'utf8',
          ),
          /ENOENT/,
        );
      } finally {
        await rm(workspaceRoot, { recursive: true, force: true });
      }
    });

    it('all three preview scenarios point activeSessionId at the standard ARTIFACT_SESSION_ID', () => {
      for (const scenario of [
        'artifact-preview-image',
        'artifact-preview-unsupported',
        'artifact-preview-oversize',
      ] as const) {
        const fixture = resolveVisualSmokeFixture(scenario, false);
        assert.ok(fixture, `scenario=${scenario}`);
        const state = getVisualSmokeState(fixture);
        assert.equal(state?.activeSessionId, 'visual-smoke-artifact', `scenario=${scenario}`);
      }
    });
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
