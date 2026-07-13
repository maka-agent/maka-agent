import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  ArtifactRecord,
  DailyReviewArchive,
  LlmConnection,
  PermissionRequestEvent,
  PlanReminder,
  SessionHeader,
  StoredMessage,
  VisualSmokeScenario,
  VisualSmokeState,
} from '@maka/core';
import { createDefaultSettings } from '@maka/core/settings';
import type { CredentialStore } from './credential-store.js';

const VISUAL_SMOKE_SCENARIOS = new Set<VisualSmokeScenario>([
  'all',
  'first-run',
  'provider-workspace',
  'fallback-source',
  'fetched-empty',
  'connection-error',
  // OAuth re-login affordance: a codex-subscription connection with a stored
  // but expired OAuth token (hasSecret===true), focused so its detail sheet's
  // 重新登录 button is visible.
  'oauth-relogin',
  'turn-narrative',
  'artifact-pane',
  'artifact-errors',
  'streaming-sidebar',
  // PR-STREAM-TURN-CENTER: active session renders the live answer bubble in
  // the main panel (below a committed turn) so the screenshot locks
  // streaming-vs-committed horizontal alignment.
  'streaming-answer',
  // #646: a running session with an armed turn but nothing streaming yet —
  // captures the "正在处理…" model-wait indicator + composer Stop.
  'model-processing',
  'permission-destructive',
  'stale-sessions',
  // PR108j: per-Settings-section fixtures so the screenshot pipeline
  // can capture each Settings sub-page in light + dark + narrow +
  // reduced-motion variants. Each scenario reuses the standard
  // connection / session seed and only differs in
  // `openSettingsSection`. (Per-page state — displayName,
  // assistantTone, network proxy, etc. — already comes from the
  // default settings.json seed.)
  'settings-data',
  // PR-SETTINGS-IA-CONSOLIDATE-0 + PR-SETTINGS-REVIEW-0: memory and
  // daily-review split back apart per WAWQAQ msg `886f6406`.
  'settings-appearance',
  'settings-bots',
  'settings-about',
  'settings-general',
  'settings-memory',
  'settings-daily-review',
  'settings-permissions',
  'settings-voice',
  'settings-gateway',
  'settings-search',
  'settings-usage',
  'settings-health',
  'module-skills',
  'module-daily-review',
  // PR109b: workstation-statuses — seed one session per SessionStatus
  // (running / waiting_for_user / blocked × 4 reasons / active / review
  // / done / archived) so the sidebar grouping screenshot covers every
  // status badge + group header in one fixture.
  'workstation-statuses',
  // PR-PLAN-REMINDER-MVP-0: screenshot the first real Automations
  // surface. Seeds scheduled / paused / completed local reminders and
  // opens the 计划 module so reviewers can verify this is real product
  // UI rather than a passive placeholder.
  'plan-reminders',
  // PR109f (g): turn-control-history — seeds a primary session whose
  // turn list covers the four TurnStatus values plus retry + regenerate
  // lineage, alongside two branch sessions (visible-parent vs missing-
  // parent) so deterministic screenshots cover the banner contract end-to-end.
  // Three variants share the same on-disk seed and only differ in
  // active session selection, so auto-capture produces three
  // deterministic screenshots:
  //   - turn-control-history          → primary active (lineage / aborted / failed)
  //   - turn-control-branch-visible   → visible-parent branch active (banner)
  //   - turn-control-branch-orphan    → orphan branch active (NO banner)
  'turn-control-history',
  'turn-control-branch-visible',
  'turn-control-branch-orphan',
  // PR-UI-RENDER-3a-smoke: registry-driven artifact preview fixtures.
  // Each shares the standard chat seed + same ARTIFACT_SESSION_ID but
  // writes a different single artifact so the ArtifactPane default
  // selection deterministically shows the artifact we want.
  'artifact-preview-image',
  'artifact-preview-unsupported',
  'artifact-preview-oversize',
  // PR-SIDEBAR-IA-0 Phase 1: seed 60 active sessions so the sidebar
  // scroll fix is verifiable end-to-end. Footer (Settings + Update
  // placeholder) must stay visible in narrow / wide / light / dark
  // variants. See `seedLongSidebarSessions()`.
  'sidebar-long-sessions',
  // PR-SIDEBAR-IA-0 Phase 2 fixup v3 (xuan msg `dce5a6fb` #2):
  // shares the sidebar-long-sessions on-disk seed (60 sessions) so
  // the sidebar behind the modal looks identical to the
  // sidebar-long-sessions screenshot; differs only in
  // `searchModalOpen: true`, which auto-opens the sidebar Search
  // modal at mount. Captures the SearchModal shell deterministically
  // so xuan's Phase 2 modal gate has a baseline.
  'sidebar-search-modal-open',
  // PR-shared primitive-COMMAND-INPUT-0: same 60-session seed; differs only in
  // `paletteOpen: true`, which auto-opens CommandPalette so shared primitive
  // InputGroup changes to the command input shell have a baseline.
  'command-palette-open',
  // PR-SIDEBAR-IA-0 Phase 3 P0 fixup v4 (WAWQAQ msg `5dd1c348`,
  // kenji `b3d156e9`): same 60-session seed; differs in
  // `focusActiveRow: true`, which programmatically focuses the
  // active row's button after mount so `:focus-within` triggers
  // and the `.maka-list-row-menu-trigger` becomes visible.
  // Captures the overflow-trigger state so reviewers can verify
  // the time meta + unread dot are hidden underneath (no overlap).
  'sidebar-row-actions-visible',
  // Scroll-geometry contract seed: 24 tall turns opened as the active
  // session on boot, so off-screen turns mount as content-visibility
  // placeholders (see e2e/scroll-geometry.spec.ts).
  'long-transcript',
  // #819: BrowserPanel renderer-chrome fixture. Seeds `liveBrowserSessionIds`
  // with the active turn session so `BrowserPanel` mounts; with no native
  // `WebContentsView` in visual-smoke mode, `browser.getState` resolves null
  // → `EMPTY_STATE` → the empty-state chrome (toolbar all-nav-disabled +
  // `<Empty>` strip) the #818 narrow-layout defect regressed against.
  'browser-empty',
]);

// Fixed clock for screenshot fixtures. All seeded timestamps and
// transient smoke state derive from this value unless tests explicitly
// pass `now`, so two baseline runs produce identical visible time copy.
const VISUAL_SMOKE_NOW = Date.UTC(2026, 4, 22, 3, 0, 0);

export interface VisualSmokeFixture {
  scenario: VisualSmokeScenario;
  workspaceName: string;
  /**
   * PR-IR-04: when `MAKA_VISUAL_SMOKE_REDUCED_MOTION=1` is set alongside
   * the scenario var, the renderer collapses all animations to ~0.01ms
   * via the `[data-maka-reduced-motion="true"]` CSS path. Lets the
   * screenshot pipeline capture a "reduced motion" variant for every
   * surface without depending on the host OS accessibility setting.
   */
  reducedMotion: boolean;
  /**
   * PR-IR-01: when set, the renderer auto-captures a screenshot after
   * the fixture settles. The variant name becomes the filename under
   * `<scenario>/<variant>.png`. Validated against `[a-zA-Z0-9._-]+`
   * — anything else fails closed.
   */
  autoCaptureVariant: string | null;
  /**
   * PR-IR-01b: theme override (light | dark | auto). null means "use
   * the user's persisted theme preference". Unknown values fail closed
   * to null.
   */
  theme: 'light' | 'dark' | 'auto' | null;
  /**
   * PR-UI-VISUAL-SMOKE-LOCALE: UI locale override (zh | en). null
   * means "let `detectUiLocale()` read `navigator.language`". When set,
   * the renderer applies `data-maka-visual-smoke-locale=<value>` to
   * `<html>` so `detectUiLocale()` returns the locked value
   * deterministically — same fixture, same locale, same screenshot
   * across hosts. Driven by env var
   * `MAKA_VISUAL_SMOKE_LOCALE=zh|en`. Unknown values fail closed.
   */
  locale: 'zh' | 'en' | null;
  /**
   * PR-UI-VISUAL-SMOKE-TIMEZONE: IANA timezone override. null means
   * "use the host system timezone" (current behavior). When set, the
   * renderer applies `data-maka-visual-smoke-tz=<IANA>` to `<html>`
   * so any date/time formatting helper that opts in can read the
   * locked value deterministically — same fixture, same timezone,
   * same screenshot across hosts. Driven by env var
   * `MAKA_VISUAL_SMOKE_TIMEZONE=<IANA name>`. Validation via
   * `Intl.DateTimeFormat(undefined, { timeZone })`; invalid values
   * fail closed to null.
   */
  timezone: string | null;
}

export function resolveVisualSmokeFixture(
  rawScenario: string | undefined,
  isPackaged: boolean,
  rawReducedMotion: string | undefined = undefined,
  rawAutoCaptureVariant: string | undefined = undefined,
  rawTheme: string | undefined = undefined,
  rawLocale: string | undefined = undefined,
  rawTimezone: string | undefined = undefined,
): VisualSmokeFixture | null {
  if (!rawScenario) return null;
  if (isPackaged) {
    throw new Error('MAKA_VISUAL_SMOKE_FIXTURE is only available in dev/test builds.');
  }
  if (!VISUAL_SMOKE_SCENARIOS.has(rawScenario as VisualSmokeScenario)) {
    throw new Error(`Unknown MAKA_VISUAL_SMOKE_FIXTURE scenario: ${rawScenario}`);
  }
  const scenario = rawScenario as VisualSmokeScenario;
  const reducedMotion = parseReducedMotionFlag(rawReducedMotion);
  const autoCaptureVariant = parseAutoCaptureVariant(rawAutoCaptureVariant);
  const theme = parseThemeFlag(rawTheme);
  const locale = parseLocaleFlag(rawLocale);
  const timezone = parseTimezoneFlag(rawTimezone);
  return {
    scenario,
    workspaceName: `visual-smoke-${scenario}`,
    reducedMotion,
    autoCaptureVariant,
    theme,
    locale,
    timezone,
  };
}

/**
 * Validate the theme override. Accepts only the closed enum
 * `light | dark | auto`; everything else fails closed to null
 * (renderer falls back to the user's persisted preference).
 */
function parseThemeFlag(raw: string | undefined): 'light' | 'dark' | 'auto' | null {
  if (raw === undefined) return null;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'light' || normalized === 'dark' || normalized === 'auto') return normalized;
  return null;
}

/**
 * Validate the UI locale override. Accepts only the closed enum
 * `zh | en`; everything else fails closed to null (renderer falls
 * back to `navigator.language` detection). PR-UI-VISUAL-SMOKE-LOCALE.
 */
function parseLocaleFlag(raw: string | undefined): 'zh' | 'en' | null {
  if (raw === undefined) return null;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'zh' || normalized === 'en') return normalized;
  return null;
}

/**
 * Validate the IANA timezone override.
 * PR-UI-VISUAL-SMOKE-TIMEZONE (@kenji msg 45486cdf).
 *
 * Unlike locale, timezone has no finite enum — there are hundreds
 * of IANA timezone names plus aliases. The validation gate is the
 * Intl.DateTimeFormat constructor: passing an unknown `timeZone`
 * throws RangeError, so we try / catch and fall back to null on
 * any failure. This catches:
 *   - undefined / empty string
 *   - malformed strings (`Asia/Imaginary`, `Foo`)
 *   - case-mismatch IANA aliases (some platforms accept
 *     `america/new_york` lowercase, some don't — we keep the
 *     raw input; if `Intl.DateTimeFormat` accepts it, that's the
 *     answer for THIS runtime)
 *   - any future input shape we don't anticipate
 *
 * Length cap (128 chars) defends against pathological inputs;
 * real IANA names are < 40 chars.
 *
 * Trim-only normalization (no toLowerCase): IANA names are
 * mixed-case (`America/New_York`, `Asia/Shanghai`); lowering
 * them breaks the lookup on strict platforms.
 */
function parseTimezoneFlag(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 128) return null;
  try {
    // Construct a formatter purely to validate the timeZone option;
    // throws RangeError on invalid IANA names.
    new Intl.DateTimeFormat(undefined, { timeZone: trimmed });
  } catch {
    return null;
  }
  return trimmed;
}

function parseReducedMotionFlag(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

/**
 * Validate the auto-capture variant name. Must be `[a-zA-Z0-9._-]+` (no
 * slashes, no `..`, no whitespace). Fail-closed for invalid input.
 */
function parseAutoCaptureVariant(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 64) return null;
  if (!/^[a-zA-Z0-9._-]+$/.test(trimmed)) return null;
  if (trimmed === '.' || trimmed === '..') return null;
  return trimmed;
}

export function getVisualSmokeState(fixture: VisualSmokeFixture | null): VisualSmokeState | null {
  if (!fixture) return null;
  const state: VisualSmokeState = {
    enabled: true,
    scenario: fixture.scenario,
    now: VISUAL_SMOKE_NOW,
    ...(fixture.reducedMotion ? { reducedMotion: true } : {}),
    ...(fixture.autoCaptureVariant ? { autoCaptureVariant: fixture.autoCaptureVariant } : {}),
    ...(fixture.theme ? { theme: fixture.theme } : {}),
    ...(fixture.locale ? { locale: fixture.locale } : {}),
    ...(fixture.timezone ? { timezone: fixture.timezone } : {}),
  };
  switch (fixture.scenario) {
    case 'first-run':
      return state;
    case 'provider-workspace':
      return { ...state, activeSessionId: TURN_SESSION_ID, openSettingsSection: 'models' };
    case 'fallback-source':
    case 'fetched-empty':
    case 'oauth-relogin':
      return { ...state, activeSessionId: TURN_SESSION_ID, openSettingsSection: 'models' };
    case 'connection-error':
      return { ...state, activeSessionId: ERROR_SESSION_ID, openSettingsSection: 'account' };
    case 'artifact-pane':
    case 'artifact-errors':
    // PR-UI-RENDER-3a-smoke: each preview scenario shares the same
    // chat session as `artifact-pane`; only the on-disk artifact
    // varies. The ArtifactPane selects records[0] by default so the
    // single seeded artifact is what gets screenshotted.
    case 'artifact-preview-image':
    case 'artifact-preview-unsupported':
    case 'artifact-preview-oversize':
      return { ...state, activeSessionId: ARTIFACT_SESSION_ID };
    case 'turn-narrative':
      return { ...state, activeSessionId: TURN_SESSION_ID };
    case 'browser-empty':
      // #819: the active turn session is also seeded as a live browser
      // session so BrowserPanel mounts over the chat. No native
      // WebContentsView exists in visual-smoke mode, so browser.getState
      // resolves null → BrowserPanel renders EMPTY_STATE → the empty-state
      // chrome is what screenshots capture (the #818 defect surface).
      // Loaded / loading / nav chrome states are locked by the
      // `browser-panel-chrome` source contract; their screenshots add no
      // layout value over this empty-state baseline.
      return { ...state, activeSessionId: TURN_SESSION_ID, liveBrowserSessionIds: [TURN_SESSION_ID] };
    case 'streaming-sidebar':
      return {
        ...state,
        activeSessionId: TURN_SESSION_ID,
        liveTurnBySession: streamingLiveTurns(),
      };
    case 'streaming-answer':
      // Active session = the committed turn-narrative session, PLUS a live
      // answer streaming into it. The main panel then shows a settled turn
      // and the in-flight bubble together, so the screenshot proves they
      // share the same centered column (the streaming-turn-center fix).
      return {
        ...state,
        activeSessionId: TURN_SESSION_ID,
        liveTurnBySession: streamingAnswerLiveTurns(),
      };
    case 'model-processing':
      // #646: a running session whose live projection is armed with
      // NO streaming / thinking / tool seeded, so the derivation fires and the
      // "正在处理…" indicator rides the tail user turn while the composer shows
      // Stop. The session's on-disk status is `running` so the status gate self-
      // heals like the real backgrounded-session path.
      return {
        ...state,
        activeSessionId: PROCESSING_SESSION_ID,
        liveTurnBySession: processingLiveTurns(),
      };
    case 'permission-destructive':
      return {
        ...state,
        activeSessionId: PERMISSION_SESSION_ID,
        permissionBySession: permissionState(),
        liveTurnBySession: permissionLiveTurns(),
      };
    case 'stale-sessions':
      // Active session intentionally a stale one — verifies the @kenji
      // gate that an active+stale row still shows the "已过期" pill
      // (active highlight must not erase the warning signal).
      return { ...state, activeSessionId: STALE_FAKE_SESSION_ID };
    // PR108j: Settings sub-page scenarios. Each just opens the relevant
    // Settings section over the standard seed; per-page state lives in
    // the shared settings.json defaults (already includes displayName
    // = '' so the chat surface falls back to '你', etc.). Active session stays TURN_SESSION_ID so the chat
    // surface behind the modal shows a realistic context.
    case 'settings-data':
      return { ...state, activeSessionId: TURN_SESSION_ID, openSettingsSection: 'data' };
    case 'settings-appearance':
      return { ...state, activeSessionId: TURN_SESSION_ID, openSettingsSection: 'appearance' };
    case 'settings-bots':
      return { ...state, activeSessionId: TURN_SESSION_ID, openSettingsSection: 'bot-chat' };
    case 'settings-about':
      return { ...state, activeSessionId: TURN_SESSION_ID, openSettingsSection: 'about' };
    case 'settings-general':
      // PR-SETTINGS-IA-CONSOLIDATE-0: 通用 now also hosts the proxy
      // block that used to live on its own 网络 page.
      return { ...state, activeSessionId: TURN_SESSION_ID, openSettingsSection: 'general' };
    case 'settings-memory':
      return { ...state, activeSessionId: TURN_SESSION_ID, openSettingsSection: 'memory' };
    case 'settings-daily-review':
      return { ...state, activeSessionId: TURN_SESSION_ID, openSettingsSection: 'daily-review' };
    case 'settings-permissions':
      return { ...state, activeSessionId: TURN_SESSION_ID, openSettingsSection: 'permissions' };
    case 'settings-voice':
      return { ...state, activeSessionId: TURN_SESSION_ID, openSettingsSection: 'voice' };
    case 'settings-gateway':
      return { ...state, activeSessionId: TURN_SESSION_ID, openSettingsSection: 'open-gateway' };
    case 'settings-search':
      return { ...state, activeSessionId: TURN_SESSION_ID, openSettingsSection: 'search' };
    case 'settings-usage':
      return { ...state, activeSessionId: TURN_SESSION_ID, openSettingsSection: 'usage' };
    case 'settings-health':
      return { ...state, activeSessionId: TURN_SESSION_ID, openSettingsSection: 'health' };
    case 'module-skills':
      return { ...state, activeSessionId: TURN_SESSION_ID, sidebarSection: 'skills', sidebarCollapsed: false };
    case 'module-daily-review':
      return { ...state, activeSessionId: TURN_SESSION_ID, sidebarSection: 'daily-review', sidebarCollapsed: false };
    case 'workstation-statuses':
      // Active session is the running one so the chat header status
      // badge ("进行中") is visible in the screenshot alongside the
      // sidebar grouping. Each session in the seed maps to one
      // SessionStatus enum value (running / waiting_for_user / blocked
      // × 4 reasons / review / done / archived / aborted (filtered)).
      return { ...state, activeSessionId: WORKSTATION_RUNNING_SESSION_ID };
    case 'plan-reminders':
      // Open the 计划 module directly so the visual-smoke baseline
      // captures the real local reminder MVP: create form + persisted
      // scheduled / paused / completed reminders.
      return { ...state, activeSessionId: TURN_SESSION_ID, sidebarSection: 'automations', sidebarCollapsed: false };
    case 'turn-control-history':
      // Active = primary so the chat surface shows every turn control
      // variant in one screenshot: completed baseline, retried pair
      // (forward + reverse badges), regenerated pair, aborted marker,
      // failed banner with generalized Chinese copy. The two branch
      // sessions sit in the sidebar but are not the active surface
      // here — banner positive/negative cases each get their own
      // scenario below so auto-capture covers both deterministically.
      return { ...state, activeSessionId: TURN_CONTROL_PRIMARY_SESSION_ID };
    case 'turn-control-branch-visible':
      // Active = visible-parent branch session. Chat header should
      // render the branch banner with copy "分自 ${primary.name}". The
      // primary session in the sidebar is the parent.
      return { ...state, activeSessionId: TURN_CONTROL_BRANCH_VISIBLE_SESSION_ID };
    case 'turn-control-branch-orphan':
      // Active = orphan branch session (parentSessionId points to a
      // session that is intentionally NOT seeded on disk). Chat header
      // must render NO branch banner and NO dead-link button.
      return { ...state, activeSessionId: TURN_CONTROL_BRANCH_ORPHAN_SESSION_ID };
    case 'sidebar-long-sessions':
      // PR-SIDEBAR-IA-0 Phase 1: active = the FIRST session in the seed
      // (newest by lastMessageAt). The 60-session list scrolls below
      // the active row; the screenshot captures the scroll affordance
      // plus the visible footer (Settings + Version info) at the
      // bottom of the sidebar. If the scroll fix regresses, the footer
      // gets pushed off-screen and the regression is obvious in
      // baseline diff.
      return { ...state, activeSessionId: LONG_SIDEBAR_SESSION_PREFIX + '00', sidebarCollapsed: false };
    case 'sidebar-search-modal-open':
      // PR-SIDEBAR-IA-0 Phase 2 fixup v3 (xuan msg `dce5a6fb` #2):
      // shares the sidebar-long-sessions seed (60 sessions) so the
      // sidebar behind the modal is identical to the long-sessions
      // baseline; `searchModalOpen: true` is the only differentiator.
      // The renderer reads the flag in `applyVisualSmokeFixture()` and
      // calls `setSearchModalOpen(true)` BEFORE auto-capture settles,
      // so the SearchModal shell is on screen for the screenshot.
      return {
        ...state,
        activeSessionId: LONG_SIDEBAR_SESSION_PREFIX + '00',
        sidebarCollapsed: false,
        searchModalOpen: true,
      };
    case 'command-palette-open':
      // PR-shared primitive-COMMAND-INPUT-0: same 60-session seed as the sidebar
      // baselines; `paletteOpen: true` is the only differentiator so
      // the command palette shell is visible for screenshot review.
      return {
        ...state,
        activeSessionId: LONG_SIDEBAR_SESSION_PREFIX + '00',
        sidebarCollapsed: false,
        paletteOpen: true,
      };
    case 'sidebar-row-actions-visible':
      // PR-SIDEBAR-IA-0 Phase 3 P0 fixup v4 (WAWQAQ msg `5dd1c348`):
      // same 60-session seed; `focusActiveRow: true` makes the
      // renderer focus the active row's button after mount so
      // `:focus-within` triggers and the overflow action appears.
      // Captures the overflow-trigger state for the overlap gate.
      return {
        ...state,
        activeSessionId: LONG_SIDEBAR_SESSION_PREFIX + '00',
        sidebarCollapsed: false,
        focusActiveRow: true,
      };
    case 'long-transcript':
      // Scroll-geometry contract: boot straight into the 24-turn session so
      // above-viewport turns mount render-skipped (never rendered), the
      // exact state the warm-up + pinned-bottom invariants protect.
      return { ...state, activeSessionId: LONG_TRANSCRIPT_SESSION_ID };
    case 'all':
      return {
        ...state,
        activeSessionId: TURN_SESSION_ID,
        permissionBySession: permissionState(),
        liveTurnBySession: {
          ...streamingLiveTurns(),
          ...permissionLiveTurns(),
        },
      };
  }
  // Fallback so the function is total over the scenario union (TS2366); the
  // base state is the safe default for any scenario without a bespoke mapping.
  return state;
}

export async function seedVisualSmokeFixture(input: {
  workspaceRoot: string;
  fixture: VisualSmokeFixture;
  credentialStore: Pick<CredentialStore, 'setSecret'>;
  now?: number;
}): Promise<void> {
  const now = input.now ?? VISUAL_SMOKE_NOW;
  await rm(input.workspaceRoot, { recursive: true, force: true });
  await mkdir(input.workspaceRoot, { recursive: true });
  await writeSettings(input.workspaceRoot);
  if (input.fixture.scenario === 'first-run') return;
  await writeConnections(input.workspaceRoot, now, input.fixture.scenario);
  for (const slug of ['zai-live', 'relay-fallback', 'empty-fetched', 'needs-reauth', 'broken-provider']) {
    await input.credentialStore.setSecret(slug, 'api_key', `fixture-key-${slug}`);
  }
  await writeSession(input.workspaceRoot, turnSession(now), turnMessages(now));
  await writeSession(input.workspaceRoot, processingSession(now), processingMessages(now));
  await writeSession(input.workspaceRoot, streamingSession(now), streamingMessages(now));
  await writeSession(input.workspaceRoot, permissionSession(now), permissionMessages(now));
  await writeSession(input.workspaceRoot, errorSession(now), errorMessages(now));
  await writeSession(input.workspaceRoot, artifactSession(now), artifactMessages(now));
  await writeArtifacts(input.workspaceRoot, now, input.fixture.scenario);
  // Stale-session fixture seeds three sessions reproducing the @WAWQAQ
  // workspace state that triggered the P0:
  //   - one healthy ai-sdk session (zai-live, correct slug)
  //   - one fake backend session (FakeBackend)
  //   - one legacy backend kind ('claude' with slug 'fake-claude')
  // Together with the connection list (no `fake-claude` slug present),
  // the renderer must mark the bottom two as stale + leave the first
  // alone.
  if (input.fixture.scenario === 'stale-sessions') {
    await writeSession(input.workspaceRoot, staleFakeSession(now), staleFakeMessages(now));
    await writeSession(input.workspaceRoot, staleLegacySession(now), staleLegacyMessages(now));
    await writeSession(input.workspaceRoot, healthySession(now), healthyMessages(now));
  }
  if (input.fixture.scenario === 'workstation-statuses') {
    for (const seed of workstationStatusSessions(now)) {
      await writeSession(input.workspaceRoot, seed.header, seed.messages);
    }
  }
  // Scroll-geometry contract (e2e/scroll-geometry.spec.ts): a session tall
  // enough that most turns mount as render-skipped content-visibility
  // placeholders — the state the warm-up and pinned-bottom invariants cover.
  if (input.fixture.scenario === 'long-transcript') {
    await writeSession(input.workspaceRoot, longTranscriptSession(now), longTranscriptMessages(now));
  }
  // PR109f (g): all three turn-control-* scenarios share the same
  // on-disk seed; only the active session selection differs. Seeding
  // the same trio for any of them keeps the fixtures interchangeable
  // for reviewers and lets the `branch-orphan` variant prove the
  // banner stays absent when the parent SessionSummary is missing.
  if (TURN_CONTROL_SCENARIOS.has(input.fixture.scenario)) {
    for (const seed of turnControlSessions(now)) {
      await writeSession(input.workspaceRoot, seed.header, seed.messages);
    }
  }
  // PR-SIDEBAR-IA-0 Phase 1 (xuan msg `dc790a54` + kenji `0f7bb872`):
  // sidebar-long-sessions seeds 60 active sessions so the sidebar
  // scroll fix is verifiable end-to-end. Each row reuses the standard
  // text content; only the name + timestamp differ so screenshots are
  // deterministic. The hard gate: with 60 rows in a narrow window, the
  // footer (Settings + Version info) must remain visible without
  // page-level scroll, and the inner list scroll container must work.
  //
  // Phase 2 fixup v3: `sidebar-search-modal-open` shares the same
  // 60-session seed so the sidebar behind the modal matches the
  // long-sessions baseline exactly. The modal-open state itself is a
  // transient renderer flag (`VisualSmokeState.searchModalOpen`); no
  // additional on-disk seeding required.
  if (LONG_SIDEBAR_SCENARIOS.has(input.fixture.scenario)) {
    for (const seed of longSidebarSessions(now)) {
      await writeSession(input.workspaceRoot, seed.header, seed.messages);
    }
  }
  if (input.fixture.scenario === 'plan-reminders') {
    await writePlanReminders(input.workspaceRoot, now);
  }
  if (input.fixture.scenario === 'module-daily-review' || input.fixture.scenario === 'settings-daily-review') {
    await writeDailyReviewArchives(input.workspaceRoot, now);
  }
  if (input.fixture.scenario === 'module-skills') {
    await seedSkillsMarketFixture(input.workspaceRoot);
  }
}

/**
 * Marketplace fixture: seeds a managed-source catalog (≥6 entries across
 * categories with varied recency) plus a couple of workspace skills so the
 * 市场 grid, category filter, sort, and the 内置/已安装 rows all render
 * meaningfully in the CDP capture. Managed sources normally live in
 * ~/.maka/skill-sources; the dev-gated MAKA_SKILL_SOURCES_ROOT override
 * (resolveManagedSkillSourcesRoot) points both the seeder and the runtime
 * IPC at a fixture-local dir so nothing touches the real home catalog.
 */
async function seedSkillsMarketFixture(workspaceRoot: string): Promise<void> {
  const sourcesRoot = join(workspaceRoot, '.maka', 'skill-sources');
  process.env.MAKA_SKILL_SOURCES_ROOT = sourcesRoot;
  await mkdir(sourcesRoot, { recursive: true });

  const sources: ReadonlyArray<{ id: string; name: string; description: string; category: string }> = [
    { id: 'research-brief', name: '研究简报', category: '研究与分析', description: '把网页资料、引用和结论整理成结构化 brief，适合快速进入陌生领域。' },
    { id: 'doc-review', name: '文档审阅', category: '文档与写作', description: '检查 DOCX / Markdown 的结构、语气和遗漏项，并输出可执行修改建议。' },
    { id: 'meeting-followup', name: '会议跟进', category: '效率工具', description: '从会议记录里抽取决定、风险和 owner，生成下一步任务清单。' },
    { id: 'release-checklist', name: '发布检查', category: 'DevOps与部署', description: '按发布前 checklist 扫描 diff、测试和文档，减少临门一脚的遗漏。' },
    { id: 'data-analyst', name: '数据分析助手', category: '数据与AI', description: '读取 CSV / 表格，做透视、异常检测和趋势总结，产出可复述的结论。' },
    { id: 'ui-audit', name: 'UI 走查', category: '设计与UI', description: '对照设计规范逐项走查间距、层级和状态色，列出需要修的细节。' },
    { id: 'blog-outline', name: '博客提纲', category: '内容创作', description: '把零散想法整理成有节奏的文章提纲，附上每段的论据方向。' },
  ];

  // Stagger mtimes so 排序：最近 has a meaningful order (the last-written
  // source is the most recent). Written newest-last on purpose.
  for (const source of sources) {
    const dir = join(sourcesRoot, source.id);
    await mkdir(dir, { recursive: true });
    const content = [
      '---',
      `name: ${source.name}`,
      `description: ${source.description}`,
      `category: ${source.category}`,
      '---',
      '',
      `# ${source.name}`,
      '',
      source.description,
      '',
    ].join('\n');
    await writeFile(join(dir, 'SKILL.md'), content, { encoding: 'utf8', mode: 0o600 });
  }

  // A couple of workspace skills so 已安装 is not empty and one managed
  // source shows as installed in the grid. The bundled OfficeCLI skills
  // (seeded separately after the fixture) populate the 内置 tab.
  const workspaceSkills: ReadonlyArray<{ id: string; name: string; description: string }> = [
    { id: 'meeting-followup', name: '会议跟进', description: '从会议记录里抽取决定、风险和 owner，生成下一步任务清单。' },
    { id: 'daily-standup', name: '每日站会', description: '汇总昨日进展、今日计划和阻塞，生成简短的站会同步。' },
  ];
  for (const skill of workspaceSkills) {
    const dir = join(workspaceRoot, 'skills', skill.id);
    await mkdir(dir, { recursive: true });
    const content = [
      '---',
      `name: ${skill.name}`,
      `description: ${skill.description}`,
      '---',
      '',
      `# ${skill.name}`,
      '',
      skill.description,
      '',
    ].join('\n');
    await writeFile(join(dir, 'SKILL.md'), content, { encoding: 'utf8', mode: 0o600 });
  }
}

/**
 * Scenarios that share the long-sidebar (60-session) on-disk seed.
 * Kept as a Set so future scenarios reusing the same seed can be
 * registered in one place. Mirrors `TURN_CONTROL_SCENARIOS`.
 */
const LONG_SIDEBAR_SCENARIOS = new Set<VisualSmokeScenario>([
  'module-skills',
  'module-daily-review',
  'plan-reminders',
  'sidebar-long-sessions',
  'sidebar-search-modal-open',
  'command-palette-open',
  'sidebar-row-actions-visible',
]);

/**
 * PR109f (g): scenarios that share the turn-control-history on-disk
 * seed. Keeps the trio listed in one place so a reviewer can confirm
 * they're variants of the same state family (active session differs,
 * everything else identical).
 */
const TURN_CONTROL_SCENARIOS = new Set<VisualSmokeScenario>([
  'turn-control-history',
  'turn-control-branch-visible',
  'turn-control-branch-orphan',
]);

const TURN_SESSION_ID = 'visual-smoke-turn';
const LONG_TRANSCRIPT_SESSION_ID = 'visual-smoke-long-transcript';
const PROCESSING_SESSION_ID = 'visual-smoke-processing';
const STREAMING_SESSION_ID = 'visual-smoke-streaming';
// PR-STREAM-TURN-CENTER: realistic multi-block markdown (heading + paragraph +
// list) for the `streaming-answer` scenario, so the captured streaming bubble
// exercises the same prose layout a real answer does and its left edge is
// unambiguous to compare against the committed turn above it.
const STREAMING_ANSWER_MARKDOWN = [
  '## Maka Desktop 项目概况',
  '',
  '这里是当前项目的快速概览：',
  '',
  '- 框架：Electron + React 19 + Vite 7',
  '- 语言：TypeScript',
  '- 构建：tsc（main / preload）+ Vite（renderer）',
  '',
  '正在整理目录结构，稍等……',
].join('\n');
const PERMISSION_SESSION_ID = 'visual-smoke-permission';
const WORKSTATION_RUNNING_SESSION_ID = 'visual-smoke-ws-running';
const WORKSTATION_WAITING_SESSION_ID = 'visual-smoke-ws-waiting';
const WORKSTATION_BLOCKED_AUTH_SESSION_ID = 'visual-smoke-ws-blocked-auth';
const WORKSTATION_BLOCKED_PERM_SESSION_ID = 'visual-smoke-ws-blocked-perm';
const WORKSTATION_BLOCKED_TOOL_SESSION_ID = 'visual-smoke-ws-blocked-tool';
const WORKSTATION_BLOCKED_UNKNOWN_SESSION_ID = 'visual-smoke-ws-blocked-unknown';
const WORKSTATION_ACTIVE_SESSION_ID = 'visual-smoke-ws-active';
const WORKSTATION_REVIEW_SESSION_ID = 'visual-smoke-ws-review';
const WORKSTATION_DONE_SESSION_ID = 'visual-smoke-ws-done';
const WORKSTATION_ARCHIVED_SESSION_ID = 'visual-smoke-ws-archived';
const WORKSTATION_ABORTED_SESSION_ID = 'visual-smoke-ws-aborted';
const ERROR_SESSION_ID = 'visual-smoke-error';
const ARTIFACT_SESSION_ID = 'visual-smoke-artifact';
const STALE_FAKE_SESSION_ID = 'visual-smoke-stale-fake';
const STALE_LEGACY_SESSION_ID = 'visual-smoke-stale-legacy';
const HEALTHY_SESSION_ID = 'visual-smoke-healthy';
// PR109f (g): turn-control-history primary + branch sessions. The
// `BRANCH_ORPHAN` session's `parentSessionId` intentionally references
// a session id that is NEVER written to disk so the renderer's
// `deriveBranchBanner()` resolves the parent as missing and renders no
// banner in the negative screenshot case.
const TURN_CONTROL_PRIMARY_SESSION_ID = 'visual-smoke-turn-control-primary';
const TURN_CONTROL_BRANCH_VISIBLE_SESSION_ID = 'visual-smoke-turn-control-branch-visible';
const TURN_CONTROL_BRANCH_ORPHAN_SESSION_ID = 'visual-smoke-turn-control-branch-orphan';
const TURN_CONTROL_ORPHAN_PARENT_ID = 'visual-smoke-turn-control-deleted-parent';

/**
 * PR-SIDEBAR-IA-0 Phase 1: sidebar-long-sessions scenario seeds many
 * sessions with this prefix. Two digits → 60 distinct IDs (00..59).
 * Active session is always `${LONG_SIDEBAR_SESSION_PREFIX}00` (newest by
 * lastMessageAt). Path is short so it stays stable in screenshot
 * baselines.
 */
const LONG_SIDEBAR_SESSION_PREFIX = 'visual-smoke-sidebar-long-';
const LONG_SIDEBAR_SESSION_COUNT = 60;

async function writePlanReminders(workspaceRoot: string, now: number): Promise<void> {
  const scheduledRunAt = Date.UTC(2026, 11, 18, 3, 0, 0);
  const pausedRunAt = Date.UTC(2026, 11, 20, 3, 0, 0);
  const reminders: PlanReminder[] = [
    {
      id: 'visual-plan-reminder-standup',
      title: '同步项目风险',
      note: '提醒我整理 Sidebar gate、搜索接入和计划任务剩余风险。',
      schedule: { kind: 'once', runAt: scheduledRunAt },
      delivery: { channel: 'local' },
      status: 'scheduled',
      enabled: true,
      createdAt: now - 2 * 60 * 60_000,
      updatedAt: now - 2 * 60 * 60_000,
      nextRunAt: scheduledRunAt,
      runs: [],
      runCount: 0,
    },
    {
      id: 'visual-plan-reminder-paused',
      title: '暂停的发布检查',
      note: '用户可以先暂停提醒，恢复后继续按原时间触发。',
      schedule: { kind: 'once', runAt: pausedRunAt },
      delivery: { channel: 'local' },
      status: 'paused',
      enabled: false,
      createdAt: now - 3 * 60 * 60_000,
      updatedAt: now - 30 * 60_000,
      runs: [],
      runCount: 0,
    },
    {
      id: 'visual-plan-reminder-weekly-review',
      title: '每周竞品动态追踪',
      note: '汇总同类 AI 工具的近期产品变化，提醒我复盘可对标的交互。',
      schedule: { kind: 'cron', expression: '0 10 * * 1', startAt: now - 3.5 * 60 * 60_000 },
      delivery: { channel: 'local' },
      status: 'scheduled',
      enabled: true,
      createdAt: now - 3.5 * 60 * 60_000,
      updatedAt: now - 35 * 60_000,
      nextRunAt: Date.UTC(2026, 11, 21, 2, 0, 0),
      runs: [],
      runCount: 0,
    },
    {
      id: 'visual-plan-reminder-completed',
      title: '已触发的本地提醒',
      note: '',
      schedule: { kind: 'once', runAt: now - 45 * 60_000 },
      delivery: { channel: 'local' },
      status: 'completed',
      enabled: false,
      createdAt: now - 4 * 60 * 60_000,
      updatedAt: now - 45 * 60_000,
      lastRun: {
        id: 'visual-plan-run-completed',
        at: now - 45 * 60_000,
        status: 'triggered',
        message: '计划提醒已触发',
      },
      runs: [
        {
          id: 'visual-plan-run-completed',
          at: now - 45 * 60_000,
          status: 'triggered',
          message: '计划提醒已触发',
        },
      ],
      runCount: 1,
    },
  ];
  await writeJson(join(workspaceRoot, 'plan-reminders.json'), reminders);
}

async function writeDailyReviewArchives(workspaceRoot: string, now: number): Promise<void> {
  const dayFromMs = Date.UTC(2026, 4, 21, 0, 0, 0);
  const dayToMs = Date.UTC(2026, 4, 22, 0, 0, 0);
  const daily: DailyReviewArchive = {
    id: '2026-05-21-daily',
    day: { fromMs: dayFromMs, toMs: dayToMs },
    mode: 'daily',
    status: 'ok',
    generatedAt: now - 10 * 60_000,
    trigger: 'manual',
    modelKey: 'zai-live::glm-4.5',
    totals: {
      sessionCount: 8,
      requestCount: 34,
      totalTokens: 128_640,
      costUsd: 1.82,
      errorCount: 1,
    },
    sections: {
      summary: '今天主要围绕 Maka 桌面端的侧边栏、权限中心和每日回顾展开，重点是把入口、报告保存和设置项接到真实运行链路。',
      gaps: '权限中心按钮已经接入系统设置跳转；每日回顾外部通知仍缺少报告自动推送运行时，需要保持不可用状态而不是展示假开关。',
      usage: '模型请求集中在 UI 逆向与合约验证，工具调用以文件检索、构建和截图 smoke 为主。',
      code: '建议继续收敛 Settings 与模块页的 shared page shell，减少同类 surface 在 styles.css 里的重复规则。',
    },
  };
  const deep: DailyReviewArchive = {
    ...daily,
    id: '2026-05-21-deep',
    mode: 'deep',
    generatedAt: now - 5 * 60_000,
    trigger: 'cron',
    totals: {
      ...daily.totals,
      sessionCount: 12,
      requestCount: 58,
      totalTokens: 211_300,
      costUsd: 3.94,
      errorCount: 1,
    },
    sections: {
      summary: '深度分析覆盖最近一轮 Maka UI 打磨：参考布局学习、权限中心重画、Daily Review 从聚合面板走向可保存报告。',
      gaps: '第一性原理层面需要把“模块页 shell / Settings row / 状态 pill / 操作按钮”抽成真实组件，否则后续仍会在 CSS 中继续堆叠局部规则。',
      usage: '高频动作是读取源码、运行 contract、构建 renderer、生成 visual-smoke 截图。失败成本主要来自多处页面壳层行为不统一。',
      code: '下一步优先建立模块页 PageShell、SettingsActionRow 和 StatusPill primitives，再迁移 Daily Review、权限中心、计划任务和技能页。',
    },
  };
  const archiveDir = join(workspaceRoot, 'daily-reviews', 'archive');
  await mkdir(archiveDir, { recursive: true });
  await writeJson(join(archiveDir, `${daily.id}.json`), daily);
  await writeJson(join(archiveDir, `${deep.id}.json`), deep);
}

async function writeSettings(workspaceRoot: string): Promise<void> {
  // PR-SIDEBAR-IA-0 Phase 3 P0 fixup v2 (kenji `08be08d8` + WAWQAQ
  // `1886c41b`): the fixture previously seeded a placeholder
  // Chinese personal name for screenshot baselines, but a real
  // user reading the chat surface can't tell who that placeholder
  // is. Worse, if a demo workspace was ever opened on top of a
  // real user's workspace, the placeholder would persist and
  // confuse them about who set it.
  //
  // Phase 3 fixup v2 leaves `displayName` empty so screenshots and
  // Settings match a new, unconfigured user. Settings test
  // (`visual-smoke-fixture.test.ts`) asserts the empty-string value
  // so a future patch that re-adds a demo name lands as an explicit
  // copy decision, not silent drift.
  const settings = createDefaultSettings();
  settings.personalization.displayName = '';
  settings.appearance.theme = 'auto';
  await writeJson(join(workspaceRoot, 'settings.json'), settings);
}

async function writeConnections(workspaceRoot: string, now: number, scenario: VisualSmokeScenario): Promise<void> {
  const connections: LlmConnection[] = [
    {
      slug: 'zai-live',
      name: 'Z.ai Live Fixture',
      providerType: 'zai-coding-plan',
      baseUrl: 'https://api.z.ai/api/coding/paas/v4',
      defaultModel: 'glm-5.1',
      enabled: true,
      models: [
        model('glm-4.5', { functionCalling: true }, 128_000),
        model('glm-4.5-air', { functionCalling: true }, 128_000),
        model('glm-4.6', { reasoning: true, functionCalling: true }, 200_000),
        model('glm-4.7', { reasoning: true, functionCalling: true }, 200_000),
        model('glm-5', { reasoning: true, functionCalling: true }, 200_000),
        model('glm-5-turbo', { reasoning: true, functionCalling: true }, 200_000),
        model('glm-5.1', { vision: true, reasoning: true, functionCalling: true }, 1_000_000),
      ],
      modelSource: 'fetched',
      modelsFetchedAt: now - 5 * 60_000,
      lastTestStatus: 'verified',
      lastTestAt: new Date(now - 4 * 60_000).toISOString(),
      lastTestMessage: '连接已验证',
      createdAt: now - 3_600_000,
      updatedAt: now - 4 * 60_000,
    },
    {
      slug: 'relay-fallback',
      name: 'Fallback Relay Fixture',
      providerType: 'openai-compatible',
      baseUrl: 'https://relay.example.test/v1',
      defaultModel: 'relay-static-model',
      enabled: true,
      modelSource: 'fallback',
      createdAt: now - 3_500_000,
      updatedAt: now - 3_500_000,
    },
    {
      slug: 'empty-fetched',
      name: 'Fetched Empty Fixture',
      providerType: 'openai-compatible',
      baseUrl: 'https://empty.example.test/v1',
      defaultModel: 'empty-placeholder',
      enabled: true,
      models: [],
      modelSource: 'fetched',
      modelsFetchedAt: now - 15 * 60_000,
      lastTestStatus: 'verified',
      lastTestAt: new Date(now - 15 * 60_000).toISOString(),
      lastTestMessage: '连接已验证',
      createdAt: now - 3_400_000,
      updatedAt: now - 15 * 60_000,
    },
    {
      slug: 'needs-reauth',
      name: 'Needs Reauth Fixture',
      providerType: 'anthropic',
      defaultModel: 'claude-sonnet-4-5-20250929',
      enabled: true,
      models: [model('claude-sonnet-4-5-20250929', { vision: true, reasoning: true, functionCalling: true }, 200_000)],
      modelSource: 'fetched',
      modelsFetchedAt: now - 3 * 3_600_000,
      lastTestStatus: 'needs_reauth',
      lastTestAt: new Date(now - 10 * 60_000).toISOString(),
      lastTestMessage: '鉴权失败',
      createdAt: now - 3_300_000,
      updatedAt: now - 10 * 60_000,
    },
    {
      slug: 'broken-provider',
      name: 'Broken Provider Fixture',
      providerType: 'openai',
      defaultModel: 'gpt-4o-mini',
      enabled: true,
      models: [model('gpt-4o-mini', { vision: true, functionCalling: true }, 128_000)],
      modelSource: 'fetched',
      modelsFetchedAt: now - 4 * 3_600_000,
      lastTestStatus: 'error',
      lastTestAt: new Date(now - 8 * 60_000).toISOString(),
      lastTestMessage: '模型服务返回错误',
      createdAt: now - 3_200_000,
      updatedAt: now - 8 * 60_000,
    },
  ];
  if (scenario === 'oauth-relogin') {
    // A codex-subscription (OAuth) connection whose last test came back
    // needs_reauth. Its detail sheet must offer an inline 登录 / 重新登录
    // button (driven by the shared OAuth login flow) instead of the old dead
    // prose. Credential presence for OAuth connections is resolved through the
    // subscription token store (empty here), so the button reads 登录; the
    // hasSecret===true → 重新登录 label is pinned by the detail-sheet contract.
    connections.push({
      slug: 'codex-oauth',
      name: 'OpenAI Codex Fixture',
      providerType: 'codex-subscription',
      defaultModel: 'gpt-5.5',
      enabled: true,
      models: [model('gpt-5.5', { reasoning: true, functionCalling: true }, 200_000)],
      modelSource: 'fetched',
      modelsFetchedAt: now - 6 * 60_000,
      lastTestStatus: 'needs_reauth',
      lastTestAt: new Date(now - 6 * 60_000).toISOString(),
      lastTestMessage: '需要重新登录',
      createdAt: now - 3_100_000,
      updatedAt: now - 6 * 60_000,
    });
  }
  const focusSlug = connectionFocusSlug(scenario);
  const ordered = focusSlug
    ? [
        ...connections.filter((connection) => connection.slug === focusSlug),
        ...connections.filter((connection) => connection.slug !== focusSlug),
      ]
    : connections;
  await writeJson(join(workspaceRoot, 'llm-connections.json'), {
    defaultSlug: focusSlug ?? 'zai-live',
    connections: ordered,
  });
}

function connectionFocusSlug(scenario: VisualSmokeScenario): string | null {
  switch (scenario) {
    case 'fallback-source':
      return 'relay-fallback';
    case 'fetched-empty':
      return 'empty-fetched';
    case 'oauth-relogin':
      return 'codex-oauth';
    case 'connection-error':
      return 'broken-provider';
    default:
      return null;
  }
}

function model(
  id: string,
  capabilities: NonNullable<LlmConnection['models']>[number]['capabilities'],
  contextWindow: number,
): NonNullable<LlmConnection['models']>[number] {
  return { id, capabilities, contextWindow };
}

function turnSession(now: number): SessionHeader {
  return header({
    id: TURN_SESSION_ID,
    name: '模型管理与工具调用示例',
    connection: 'zai-live',
    model: 'glm-5.1',
    now,
    lastMessageAt: now - 9 * 60_000,
  });
}

function longTranscriptSession(now: number): SessionHeader {
  return header({
    id: LONG_TRANSCRIPT_SESSION_ID,
    name: '超长会话滚动几何',
    connection: 'zai-live',
    model: 'glm-5.1',
    now,
    lastMessageAt: now - 5 * 60_000,
  });
}

/**
 * 24 turns, each ~1300px tall once rendered, so the transcript is ~25x the
 * 250px contain-intrinsic-size placeholder per turn and dozens of viewports
 * tall overall. Plain text on purpose: the contract under test is scroll
 * geometry, not markdown rendering.
 */
function longTranscriptMessages(now: number): StoredMessage[] {
  const filler = Array.from(
    { length: 60 },
    (_, line) => `第 ${line + 1} 行 — 用于撑高单个 turn 的占位正文内容。`,
  ).join('  \n');
  const messages: StoredMessage[] = [];
  const base = now - 60 * 60_000;
  for (let turn = 0; turn < 24; turn++) {
    const turnId = `long-transcript-turn-${turn}`;
    messages.push({
      type: 'user',
      id: `long-transcript-user-${turn}`,
      turnId,
      ts: base + turn * 60_000,
      text: `长会话问题 ${turn + 1}`,
    });
    messages.push({
      type: 'assistant',
      id: `long-transcript-assistant-${turn}`,
      turnId,
      ts: base + turn * 60_000 + 30_000,
      text: `长会话回答 ${turn + 1}\n\n${filler}`,
      modelId: 'glm-5.1',
    });
  }
  return messages;
}

function turnMessages(now: number): StoredMessage[] {
  const turnId = 'turn-fixture-1';
  return [
    { type: 'user', id: 'msg-user-1', turnId, ts: now - 10 * 60_000, text: '检查项目状态，列出需要我优先处理的风险。' },
    {
      type: 'tool_call',
      id: 'tool-status',
      turnId,
      ts: now - 9 * 60_000 - 50_000,
      toolName: 'Bash',
      displayName: '检查测试状态',
      intent: '运行测试摘要并读取失败输出',
      args: { cmd: 'npm test --workspaces --if-present', cwd: '/workspace/maka' },
    },
    {
      type: 'tool_result',
      id: 'tool-status-result',
      turnId,
      ts: now - 9 * 60_000 - 42_000,
      toolUseId: 'tool-status',
      isError: false,
      durationMs: 8_240,
      content: {
        kind: 'terminal',
        cwd: '/workspace/maka',
        cmd: 'npm test --workspaces --if-present',
        status: 'completed',
        exitCode: 0,
        output: {
          mode: 'pipes',
          stdout: 'core 41 passing\nstorage 17 passing\nruntime 70 passing\ndesktop 74 passing\n',
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false,
          redacted: false,
        },
      },
    },
    {
      type: 'tool_call',
      id: 'tool-diff',
      turnId,
      ts: now - 9 * 60_000 - 38_000,
      toolName: 'Read',
      displayName: '查看关键 diff',
      intent: '确认模型列表键盘行为是否有测试覆盖',
      args: { path: 'apps/desktop/src/renderer/settings/model-table-keyboard.ts' },
    },
    {
      type: 'tool_result',
      id: 'tool-diff-result',
      turnId,
      ts: now - 9 * 60_000 - 34_000,
      toolUseId: 'tool-diff',
      isError: false,
      durationMs: 1_120,
      content: {
        kind: 'file_diff',
        paths: ['apps/desktop/src/renderer/settings/model-table-keyboard.ts'],
        diff: [
          'diff --git a/model-table-keyboard.ts b/model-table-keyboard.ts',
          '+export function nextRadioId(currentId, visibleIds, key) {',
          '+  if (visibleIds.length === 0) return null;',
          '+  if (key === "Home") return visibleIds[0] ?? null;',
          '-// focus-only behavior',
        ].join('\n'),
      },
    },
    {
      type: 'assistant',
      id: 'msg-assistant-1',
      turnId,
      ts: now - 9 * 60_000,
      text: '当前需要重点观察截图基线是否稳定、模型能力数据是否完整，以及模型列表的键盘操作是否顺手。这些状态会作为下一轮界面验收的基线。',
      thinking: {
        text: '这段是 fixture 用的模型推理草稿。它应默认折叠，并且不会进入默认复制答案路径。',
      },
      modelId: 'glm-5.1',
    },
    {
      type: 'token_usage',
      id: 'usage-1',
      turnId,
      ts: now - 9 * 60_000 + 100,
      input: 1250,
      output: 320,
      cacheRead: 180,
      costUsd: 0.0042,
    },
    // Streaming UI rework: a second, MULTI-STEP turn. Each step persists its own
    // assistant row (thinking + text) plus tool_calls tagged with that row's id
    // as `stepId`, so the turn timeline reconstructs the real per-step order —
    // 深度思考 → answer text → tool trow — instead of one trailing tool group.
    // Locks the capture for the new timeline (contrast the legacy stepless turn
    // above, which renders tools-before-text).
    ...multiStepTurnMessages(now),
  ];
}

// #646: a running session whose latest turn is a lone user prompt with no
// assistant reply yet — the on-disk shape of "just sent, awaiting first token".
// Paired with a waiting live projection + status `running`, the renderer derives the
// "正在处理…" model-wait indicator on the tail turn and the composer shows Stop.
function processingSession(now: number): SessionHeader {
  return header({
    id: PROCESSING_SESSION_ID,
    name: '正在处理请求',
    connection: 'zai-live',
    model: 'glm-5.1',
    now,
    lastMessageAt: now - 2_000,
    status: 'running',
  });
}

function processingMessages(now: number): StoredMessage[] {
  const turnId = 'turn-processing-1';
  return [
    { type: 'user', id: 'msg-processing-user', turnId, ts: now - 2_000, text: '把刚才那批改动整理成一份可交接的变更说明，并指出还需我确认的点。' },
  ];
}

function multiStepTurnMessages(now: number): StoredMessage[] {
  const turnId = 'turn-fixture-2';
  const step1 = 'msg-assistant-2a';
  const step2 = 'msg-assistant-2b';
  return [
    { type: 'user', id: 'msg-user-2', turnId, ts: now - 6 * 60_000, text: '确认 stream-fade 的环逻辑没有边界问题，然后跑一下单测。', origin: { kind: 'automation', automationId: 'auto-fixture-demo' } },
    {
      type: 'tool_call',
      id: 'tool-read-fade',
      turnId,
      ts: now - 6 * 60_000 + 4_000,
      toolName: 'Read',
      displayName: '读取 stream-fade.ts',
      intent: '读取淡入环实现，确认窗口滑动与上限',
      stepId: step1,
      args: { file_path: 'packages/ui/src/stream-fade.ts' },
    },
    {
      type: 'tool_result',
      id: 'tool-read-fade-result',
      turnId,
      ts: now - 6 * 60_000 + 4_600,
      toolUseId: 'tool-read-fade',
      isError: false,
      durationMs: 560,
      content: { kind: 'text', text: 'export function updateFadeRing(...) { /* prune + cap */ }' },
    },
    {
      type: 'assistant',
      id: step1,
      turnId,
      ts: now - 5 * 60_000,
      text: '环逻辑没问题：增长记录批次、超窗剪枝、按上限截断，收缩时整体重置。接下来跑单测确认。',
      thinking: { text: 'boundary 取最老存活批次的 start，age 用 now 减去覆盖该 offset 的批次时间，窗口滑动和上限都覆盖了，值得跑一遍测试坐实。' },
      modelId: 'glm-5.1',
    },
    {
      type: 'tool_call',
      id: 'tool-run-fade-tests',
      turnId,
      ts: now - 5 * 60_000 + 3_000,
      toolName: 'Bash',
      displayName: '运行 stream-fade 单测',
      intent: '执行 node --test 跑淡入环与 tokenizer 单测',
      stepId: step2,
      args: { cmd: 'node --test dist/main/__tests__/stream-fade.test.js', cwd: '/workspace/maka' },
    },
    {
      type: 'tool_result',
      id: 'tool-run-fade-tests-result',
      turnId,
      ts: now - 5 * 60_000 + 5_200,
      toolUseId: 'tool-run-fade-tests',
      isError: false,
      durationMs: 1_930,
      content: {
        kind: 'terminal',
        cwd: '/workspace/maka',
        cmd: 'node --test dist/main/__tests__/stream-fade.test.js',
        status: 'completed',
        exitCode: 0,
        output: {
          mode: 'pipes',
          stdout: 'tests 13\npass 13\nfail 0\n',
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false,
          redacted: false,
        },
      },
    },
    {
      type: 'assistant',
      id: step2,
      turnId,
      ts: now - 4 * 60_000,
      text: '13 个单测全绿，窗口滑动、乱序快照取龄和上限都被覆盖。边界没有问题。',
      thinking: { text: '测试覆盖窗口滑动、乱序 age 查询与上限三类，全过说明剪枝和 cap 的顺序对，可以收尾。' },
      modelId: 'glm-5.1',
    },
  ];
}

function streamingSession(now: number): SessionHeader {
  return header({
    id: STREAMING_SESSION_ID,
    name: '后台流式任务',
    connection: 'zai-live',
    model: 'glm-5',
    now,
    hasUnread: true,
    lastMessageAt: now - 2 * 60_000,
  });
}

function streamingMessages(now: number): StoredMessage[] {
  return [
    {
      type: 'user',
      id: 'stream-user',
      turnId: 'turn-streaming',
      ts: now - 2 * 60_000,
      text: '后台继续跑一轮诊断，完成后告诉我。',
    },
  ];
}

function permissionSession(now: number): SessionHeader {
  return header({
    id: PERMISSION_SESSION_ID,
    name: '危险权限确认',
    connection: 'zai-live',
    model: 'glm-5.1',
    now,
    lastMessageAt: now - 4 * 60_000,
  });
}

function permissionMessages(now: number): StoredMessage[] {
  return [
    {
      type: 'user',
      id: 'permission-user',
      turnId: 'turn-permission',
      ts: now - 4 * 60_000,
      text: '模拟一个需要 destructive 权限确认的操作，但不要真的执行。',
    },
    {
      type: 'tool_call',
      id: 'permission-tool',
      turnId: 'turn-permission',
      ts: now - 4 * 60_000 + 1_000,
      toolName: 'Bash',
      displayName: '模拟删除命令',
      intent: '触发 PermissionDialog destructive UI',
      args: { cmd: 'rm -rf ./dist', cwd: '/workspace/maka' },
    },
  ];
}

function errorSession(now: number): SessionHeader {
  return header({
    id: ERROR_SESSION_ID,
    name: '连接失败提示',
    connection: 'broken-provider',
    model: 'gpt-4o-mini',
    now,
    lastMessageAt: now - 20 * 60_000,
  });
}

function errorMessages(now: number): StoredMessage[] {
  return [
    {
      type: 'user',
      id: 'error-user',
      turnId: 'turn-error',
      ts: now - 20 * 60_000,
      text: '这条会话用于验证 chat header 的连接失败提示。',
    },
  ];
}

function artifactSession(now: number): SessionHeader {
  return header({
    id: ARTIFACT_SESSION_ID,
    name: '生成文件验收',
    connection: 'zai-live',
    model: 'glm-5.1',
    now,
    lastMessageAt: now - 6 * 60_000,
  });
}

function artifactMessages(now: number): StoredMessage[] {
  const turnId = 'turn-artifact';
  return [
    {
      type: 'user',
      id: 'artifact-user',
      turnId,
      ts: now - 7 * 60_000,
      text: '生成一个 HTML 报告、一个 diff 和一份 Markdown 说明，放到右侧生成文件面板里检查。',
    },
    {
      type: 'tool_call',
      id: 'artifact-tool',
      turnId,
      ts: now - 7 * 60_000 + 1_000,
      toolName: 'Write',
      displayName: '写入生成文件',
      intent: '生成 report.html / patch.diff / notes.md 三个生成文件',
      args: { path: 'artifacts/visual-smoke' },
    },
    {
      type: 'assistant',
      id: 'artifact-assistant',
      turnId,
      ts: now - 6 * 60_000,
      text: '已生成 3 个生成文件：HTML 报告、补丁 diff 和 Markdown 说明。请在右侧生成文件面板验证预览、大小限制与 HTML 沙箱边界。',
      modelId: 'glm-5.1',
    },
  ];
}

/**
 * PR109b workstation-statuses fixture seed. Returns one session per
 * SessionStatus group + 4 blocked sub-rows (one per
 * SessionBlockedReason), pre-staged with a brief 2-message history so
 * the sidebar `lastMessagePreview` renders something realistic.
 *
 * Order in the array doesn't matter — the renderer's grouping helper
 * places them in the locked group order regardless. The active
 * session (`WORKSTATION_RUNNING_SESSION_ID`) is chosen as the running
 * one so the chat header status badge ("进行中") shows in the
 * screenshot alongside the sidebar grouping.
 */
function workstationStatusSessions(now: number): Array<{ header: SessionHeader; messages: StoredMessage[] }> {
  const baseLastMessage = now - 2 * 60 * 1000;
  const make = (input: {
    id: string;
    name: string;
    status: SessionHeader['status'];
    blockedReason?: SessionHeader['blockedReason'];
    isArchived?: boolean;
    isFlagged?: boolean;
    lastMessageOffset: number;
  }): { header: SessionHeader; messages: StoredMessage[] } => ({
    header: header({
      id: input.id,
      name: input.name,
      connection: 'zai-live',
      model: 'glm-5.1',
      now,
      lastMessageAt: baseLastMessage - input.lastMessageOffset,
      status: input.status,
      ...(input.blockedReason ? { blockedReason: input.blockedReason } : {}),
      ...(input.isArchived !== undefined ? { isArchived: input.isArchived } : {}),
      ...(input.isFlagged !== undefined ? { isFlagged: input.isFlagged } : {}),
    }),
    messages: [
      {
        type: 'user',
        id: `${input.id}-user`,
        turnId: `${input.id}-turn`,
        ts: baseLastMessage - input.lastMessageOffset - 10_000,
        text: `请把「${input.name}」这条工作流的当前状态整理成可交接摘要。`,
      },
      {
        type: 'assistant',
        id: `${input.id}-assistant`,
        turnId: `${input.id}-turn`,
        ts: baseLastMessage - input.lastMessageOffset,
        text: '已记录关键状态、下一步动作和需要人工确认的风险点。',
        modelId: 'glm-5.1',
      },
    ],
  });
  return [
    make({ id: WORKSTATION_RUNNING_SESSION_ID, name: '正在生成报告', status: 'running', lastMessageOffset: 1_000 }),
    make({ id: WORKSTATION_WAITING_SESSION_ID, name: '等你确认权限', status: 'waiting_for_user', lastMessageOffset: 60_000 }),
    make({
      id: WORKSTATION_BLOCKED_AUTH_SESSION_ID,
      name: 'GPT-5 鉴权失败',
      status: 'blocked',
      blockedReason: 'auth',
      lastMessageOffset: 120_000,
    }),
    make({
      id: WORKSTATION_BLOCKED_PERM_SESSION_ID,
      name: '等待权限批准',
      status: 'blocked',
      blockedReason: 'permission_required',
      lastMessageOffset: 180_000,
    }),
    make({
      id: WORKSTATION_BLOCKED_TOOL_SESSION_ID,
      name: '工具调用失败',
      status: 'blocked',
      blockedReason: 'tool_failed',
      lastMessageOffset: 240_000,
    }),
    make({
      id: WORKSTATION_BLOCKED_UNKNOWN_SESSION_ID,
      name: '运行中断',
      status: 'blocked',
      blockedReason: 'unknown',
      lastMessageOffset: 300_000,
    }),
    make({ id: WORKSTATION_ACTIVE_SESSION_ID, name: '可继续的会话', status: 'active', lastMessageOffset: 360_000 }),
    make({ id: WORKSTATION_REVIEW_SESSION_ID, name: '待审核的长任务输出', status: 'review', lastMessageOffset: 420_000 }),
    make({ id: WORKSTATION_DONE_SESSION_ID, name: '完成并已审核', status: 'done', lastMessageOffset: 480_000 }),
    make({
      id: WORKSTATION_ARCHIVED_SESSION_ID,
      name: '归档的旧会话',
      status: 'archived',
      isArchived: true,
      lastMessageOffset: 7 * 24 * 60 * 60 * 1000,
    }),
    // @kenji PR109b review: aborted must be visible (collapsed group).
    // Seed one so the fixture covers the dormant-but-visible state.
    make({
      id: WORKSTATION_ABORTED_SESSION_ID,
      name: '已中止的会话',
      status: 'aborted',
      lastMessageOffset: 14 * 24 * 60 * 60 * 1000,
    }),
  ];
}

/**
 * PR109f (g) turn-control-history fixture seed. Returns three sessions
 * sharing the same on-disk state:
 *
 *  - `primary` — full turn list covering completed / aborted / failed +
 *    retry pair + regenerate pair. Used to verify the lineage badges
 *    (forward + reverse), aborted "(已中断)" marker, and failed-turn
 *    generalized Chinese banner copy.
 *  - `branch-visible` — parentSessionId points to primary, so the chat
 *    header should render "分自 ${primary.name}" when this session is
 *    active.
 *  - `branch-orphan` — parentSessionId points to a session id that is
 *    NOT seeded; renderer's `deriveBranchBanner()` returns undefined
 *    and no banner is rendered (negative screenshot case).
 *
 * The three are interchangeable for screenshot purposes — only the
 * active session selection in `applyScenarioOverrides` decides which
 * one is rendered in the chat surface.
 */
function turnControlSessions(now: number): Array<{ header: SessionHeader; messages: StoredMessage[] }> {
  const primaryHeader = header({
    id: TURN_CONTROL_PRIMARY_SESSION_ID,
    name: '回合控制示例（原会话）',
    connection: 'zai-live',
    model: 'glm-5.1',
    now,
    lastMessageAt: now - 2 * 60_000,
    status: 'active',
  });

  const branchVisibleHeader = header({
    id: TURN_CONTROL_BRANCH_VISIBLE_SESSION_ID,
    name: '从原会话分出的探索',
    connection: 'zai-live',
    model: 'glm-5.1',
    now,
    lastMessageAt: now - 60_000,
    status: 'active',
  });
  branchVisibleHeader.parentSessionId = TURN_CONTROL_PRIMARY_SESSION_ID;
  branchVisibleHeader.branchOfTurnId = 'turn-retry-origin';

  const branchOrphanHeader = header({
    id: TURN_CONTROL_BRANCH_ORPHAN_SESSION_ID,
    name: '父会话已删除的分支',
    connection: 'zai-live',
    model: 'glm-5.1',
    now,
    lastMessageAt: now - 30_000,
    status: 'active',
  });
  // Intentionally references a session id never written to disk so the
  // renderer must render no banner (negative screenshot case).
  branchOrphanHeader.parentSessionId = TURN_CONTROL_ORPHAN_PARENT_ID;
  branchOrphanHeader.branchOfTurnId = 'turn-deleted-origin';

  return [
    { header: primaryHeader, messages: turnControlPrimaryMessages(now) },
    { header: branchVisibleHeader, messages: turnControlBranchMessages(now, 'visible') },
    { header: branchOrphanHeader, messages: turnControlBranchMessages(now, 'orphan') },
  ];
}

/**
 * Primary-session message log covering every turn-control surface in
 * one fixture. The turn IDs are short, human-readable strings so the
 * lineage-badge copy (e.g. "重新生成自 turn turn-ret") stays stable across
 * regenerations.
 *
 * Turns:
 *  1. `turn-baseline`         — user+assistant, completed
 *  2. `turn-aborted`          — user+assistant (partial)+turn_state(aborted)
 *  3. `turn-retry-origin`     — user+assistant, completed (origin of retry)
 *  4. `turn-retry-new`        — user+assistant, completed; retriedFromTurnId = origin
 *  5. `turn-regen-origin`     — user+assistant, completed (origin of regenerate)
 *  6. `turn-regen-new`        — user+assistant, completed; regeneratedFromTurnId = origin
 *  7. `turn-failed`           — user+assistant (partial)+turn_state(failed, errorClass='timeout')
 *
 * Note: turn_state messages are appended last in each turn bucket so
 * `deriveTurnRecords()` reads the final status correctly.
 */
function turnControlPrimaryMessages(now: number): StoredMessage[] {
  const messages: StoredMessage[] = [];
  let cursor = now - 60 * 60_000; // start an hour ago, walk forward

  const tickUser = 10_000;
  const tickAssistant = 15_000;
  const tickState = 1_000;

  // 1. completed baseline
  cursor += tickUser;
  messages.push({
    type: 'user',
    id: 'msg-baseline-user',
    turnId: 'turn-baseline',
    ts: cursor,
    text: '帮我看一下当前回合状态截图覆盖了哪些情况。',
  });
  cursor += tickAssistant;
  messages.push({
    type: 'assistant',
    id: 'msg-baseline-assistant',
    turnId: 'turn-baseline',
    ts: cursor,
    text: '当前展示的是已完成的基础回合，可作为截图基线。',
    modelId: 'glm-5.1',
  });
  cursor += tickState;
  messages.push({
    type: 'turn_state',
    id: 'state-baseline',
    turnId: 'turn-baseline',
    ts: cursor,
    status: 'completed',
    partialOutputRetained: true,
  });

  // 2. aborted (partial assistant text + turn_state=aborted)
  cursor += tickUser;
  messages.push({
    type: 'user',
    id: 'msg-aborted-user',
    turnId: 'turn-aborted',
    ts: cursor,
    text: '执行一个长任务但提前中止。',
  });
  cursor += tickAssistant;
  messages.push({
    type: 'assistant',
    id: 'msg-aborted-assistant',
    turnId: 'turn-aborted',
    ts: cursor,
    text: '正在分析项目结构……',
    modelId: 'glm-5.1',
  });
  cursor += tickState;
  messages.push({
    type: 'turn_state',
    id: 'state-aborted',
    turnId: 'turn-aborted',
    ts: cursor,
    status: 'aborted',
    abortedAt: cursor,
    partialOutputRetained: true,
  });

  // 3. retry origin
  cursor += tickUser;
  messages.push({
    type: 'user',
    id: 'msg-retry-origin-user',
    turnId: 'turn-retry-origin',
    ts: cursor,
    text: '生成一份初稿。',
  });
  cursor += tickAssistant;
  messages.push({
    type: 'assistant',
    id: 'msg-retry-origin-assistant',
    turnId: 'turn-retry-origin',
    ts: cursor,
    text: '初稿 v1。',
    modelId: 'glm-5.1',
  });
  cursor += tickState;
  messages.push({
    type: 'turn_state',
    id: 'state-retry-origin',
    turnId: 'turn-retry-origin',
    ts: cursor,
    status: 'completed',
    partialOutputRetained: true,
  });

  // 4. retry new (forward "重新生成自 turn-retry-origin" + reverse "已重新生成 → turn-retry-new")
  cursor += tickUser;
  messages.push({
    type: 'user',
    id: 'msg-retry-new-user',
    turnId: 'turn-retry-new',
    ts: cursor,
    text: '再生成一遍。',
  });
  cursor += tickAssistant;
  messages.push({
    type: 'assistant',
    id: 'msg-retry-new-assistant',
    turnId: 'turn-retry-new',
    ts: cursor,
    text: '初稿 v2，包含修订建议。',
    modelId: 'glm-5.1',
  });
  cursor += tickState;
  messages.push({
    type: 'turn_state',
    id: 'state-retry-new',
    turnId: 'turn-retry-new',
    ts: cursor,
    status: 'completed',
    retriedFromTurnId: 'turn-retry-origin',
    partialOutputRetained: true,
  });

  // 5. regenerate origin
  cursor += tickUser;
  messages.push({
    type: 'user',
    id: 'msg-regen-origin-user',
    turnId: 'turn-regen-origin',
    ts: cursor,
    text: '换个角度回答。',
  });
  cursor += tickAssistant;
  messages.push({
    type: 'assistant',
    id: 'msg-regen-origin-assistant',
    turnId: 'turn-regen-origin',
    ts: cursor,
    text: '答案 A（保留供对比）。',
    modelId: 'glm-5.1',
  });
  cursor += tickState;
  messages.push({
    type: 'turn_state',
    id: 'state-regen-origin',
    turnId: 'turn-regen-origin',
    ts: cursor,
    status: 'completed',
    partialOutputRetained: true,
  });

  // 6. regenerate new
  cursor += tickUser;
  messages.push({
    type: 'user',
    id: 'msg-regen-new-user',
    turnId: 'turn-regen-new',
    ts: cursor,
    text: '再生成一个并行回答。',
  });
  cursor += tickAssistant;
  messages.push({
    type: 'assistant',
    id: 'msg-regen-new-assistant',
    turnId: 'turn-regen-new',
    ts: cursor,
    text: '答案 B（与答案 A 并列）。',
    modelId: 'glm-5.1',
  });
  cursor += tickState;
  messages.push({
    type: 'turn_state',
    id: 'state-regen-new',
    turnId: 'turn-regen-new',
    ts: cursor,
    status: 'completed',
    regeneratedFromTurnId: 'turn-regen-origin',
    partialOutputRetained: true,
  });

  // 7. failed (errorClass='timeout' → generalized copy "请求超时")
  cursor += tickUser;
  messages.push({
    type: 'user',
    id: 'msg-failed-user',
    turnId: 'turn-failed',
    ts: cursor,
    text: '运行一个长查询。',
  });
  cursor += tickAssistant;
  messages.push({
    type: 'assistant',
    id: 'msg-failed-assistant',
    turnId: 'turn-failed',
    ts: cursor,
    text: '开始查询数据……',
    modelId: 'glm-5.1',
  });
  cursor += tickState;
  messages.push({
    type: 'turn_state',
    id: 'state-failed',
    turnId: 'turn-failed',
    ts: cursor,
    status: 'failed',
    errorClass: 'timeout',
    partialOutputRetained: true,
  });

  return messages;
}

/**
 * Minimal message log for branch sessions. Branches start with a
 * single completed turn so the chat surface has visible content, but
 * we don't reproduce every parent turn (that would defeat the point of
 * the screenshot — banner-vs-no-banner is the contract under test).
 */
function turnControlBranchMessages(now: number, kind: 'visible' | 'orphan'): StoredMessage[] {
  const turnId = `turn-${kind}-branch`;
  const userText = kind === 'visible'
    ? '在分支会话里继续这条思路。'
    : '父会话已经被删除，但分支自身还在。';
  const assistantText = kind === 'visible'
    ? '已切到分支会话。点击顶部 banner 可以跳回原会话。'
    : '分支保留了本地内容，但跳回链接已失效。';
  return [
    {
      type: 'user',
      id: `msg-${kind}-user`,
      turnId,
      ts: now - 2 * 60_000,
      text: userText,
    },
    {
      type: 'assistant',
      id: `msg-${kind}-assistant`,
      turnId,
      ts: now - 90_000,
      text: assistantText,
      modelId: 'glm-5.1',
    },
    {
      type: 'turn_state',
      id: `state-${kind}-branch`,
      turnId,
      ts: now - 89_000,
      status: 'completed',
      partialOutputRetained: true,
    },
  ];
}

/**
 * PR-SIDEBAR-IA-0 Phase 1: long sidebar fixture.
 *
 * Seeds `LONG_SIDEBAR_SESSION_COUNT` (60) sessions so the sidebar
 * scroll fix is verifiable end-to-end:
 *
 *   - In a narrow window, the list must scroll without pushing the
 *     footer (Settings + Version info) off-screen.
 *   - The inner `.maka-list-stack` scroll container must engage.
 *   - The fixture is deterministic: titles only differ by index;
 *     timestamps walk backwards from `now` so the FIRST session
 *     (`...-00`) is the newest and gets sorted to the top.
 *
 * Each session contains a single short user/assistant exchange so
 * the message file is well-formed but visually inert. The screenshot
 * baseline focuses on the sidebar, not the chat surface.
 */
function longSidebarSessions(now: number): Array<{ header: SessionHeader; messages: StoredMessage[] }> {
  const seeds: Array<{ header: SessionHeader; messages: StoredMessage[] }> = [];
  for (let i = 0; i < LONG_SIDEBAR_SESSION_COUNT; i++) {
    const idSuffix = String(i).padStart(2, '0');
    const sessionId = LONG_SIDEBAR_SESSION_PREFIX + idSuffix;
    // First session is newest; subsequent walk backwards in 5-minute
    // increments so the sort is stable and predictable.
    const lastMessageAt = now - i * 5 * 60_000;
    const sessionHeader = header({
      id: sessionId,
      name: '会话 ' + idSuffix,
      connection: 'zai-live',
      model: 'glm-5.1',
      now,
      lastMessageAt,
      status: 'active',
    });
    const userTs = lastMessageAt - 30_000;
    const assistantTs = lastMessageAt;
    const messages: StoredMessage[] = [
      {
        type: 'user',
        id: 'msg-long-user-' + idSuffix,
        turnId: 'turn-long-' + idSuffix,
        ts: userTs,
        text: '示例对话 ' + idSuffix,
      },
      {
        type: 'assistant',
        id: 'msg-long-assistant-' + idSuffix,
        turnId: 'turn-long-' + idSuffix,
        ts: assistantTs,
        text: '已把第 ' + idSuffix + ' 条研究记录归档到当前工作流，侧边栏应保持稳定滚动位置。',
        modelId: 'glm-5.1',
      },
    ];
    seeds.push({ header: sessionHeader, messages });
  }
  return seeds;
}

function header(input: {
  id: string;
  name: string;
  connection: string;
  model: string;
  now: number;
  lastMessageAt: number;
  hasUnread?: boolean;
  /**
   * Override default `backend: 'ai-sdk'`. Used by stale-sessions fixture
   * to seed FakeBackend + legacy backend kinds. SessionHeader's BackendKind
   * union allows widening via `as unknown` for legacy values like
   * 'claude' that no longer exist in the type.
   */
  backend?: SessionHeader['backend'] | 'claude';
  connectionLocked?: boolean;
  /**
   * PR109b workstation-statuses fixture: override default
   * `status: 'active'` so seeded sessions land in every status group.
   */
  status?: SessionHeader['status'];
  blockedReason?: SessionHeader['blockedReason'];
  isArchived?: boolean;
  isFlagged?: boolean;
}): SessionHeader {
  return {
    id: input.id,
    workspaceRoot: 'visual-smoke',
    cwd: '/workspace/maka',
    createdAt: input.now - 3_600_000,
    lastUsedAt: input.lastMessageAt,
    lastMessageAt: input.lastMessageAt,
    name: input.name,
    isFlagged: input.isFlagged ?? false,
    labels: [],
    isArchived: input.isArchived ?? false,
    status: input.status ?? 'active',
    ...(input.blockedReason ? { blockedReason: input.blockedReason } : {}),
    statusUpdatedAt: input.lastMessageAt,
    hasUnread: input.hasUnread ?? false,
    // Legacy backend kinds like 'claude' aren't in the current BackendKind
    // union but are needed for the stale-sessions reproduction. Forward
    // the value verbatim into the JSONL so the renderer sees exactly what
    // a real legacy workspace would have on disk.
    backend: (input.backend ?? 'ai-sdk') as SessionHeader['backend'],
    llmConnectionSlug: input.connection,
    connectionLocked: input.connectionLocked ?? true,
    model: input.model,
    permissionMode: 'ask',
    schemaVersion: 1,
  };
}

// Stale-sessions fixture seeds three sessions reproducing the on-disk
// state that triggered the P0 (WAWQAQ workspace had `fake-claude` +
// `backend=fake` sessions sitting next to a healthy `zai-coding-plan`
// one). Locks the @kenji active-stale pill gate (active session is
// intentionally one of the stale ones).
function staleFakeSession(now: number): SessionHeader {
  return header({
    id: STALE_FAKE_SESSION_ID,
    name: '旧的本地模拟会话',
    connection: 'fake',
    model: 'fake-model',
    now,
    lastMessageAt: now - 4 * 24 * 3_600_000,
    backend: 'fake',
    connectionLocked: false,
  });
}

function staleLegacySession(now: number): SessionHeader {
  return header({
    id: STALE_LEGACY_SESSION_ID,
    name: '旧的 Claude 连接会话',
    connection: 'fake-claude',
    model: 'claude-3-sonnet',
    now,
    lastMessageAt: now - 7 * 24 * 3_600_000,
    backend: 'claude' as SessionHeader['backend'],
    connectionLocked: true,
  });
}

function healthySession(now: number): SessionHeader {
  return header({
    id: HEALTHY_SESSION_ID,
    name: '正常会话（Z.ai Live）',
    connection: 'zai-live',
    model: 'glm-5.1',
    now,
    lastMessageAt: now - 12 * 60_000,
    backend: 'ai-sdk',
  });
}

function staleFakeMessages(now: number): StoredMessage[] {
  const turnId = 'stale-fake-turn-1';
  return [
    {
      type: 'user',
      id: 'stale-fake-msg-1',
      turnId,
      ts: now - 4 * 24 * 3_600_000,
      text: '这是旧的本地模拟会话，发送时应该会切换到当前默认连接。',
    },
    {
      type: 'assistant',
      id: 'stale-fake-msg-2',
      turnId,
      ts: now - 4 * 24 * 3_600_000 + 2_000,
      text: '这是旧的本地模拟会话留下的回复文本。',
      modelId: 'fake-model',
    },
  ];
}

function staleLegacyMessages(now: number): StoredMessage[] {
  const turnId = 'stale-legacy-turn-1';
  return [
    {
      type: 'user',
      id: 'stale-legacy-msg-1',
      turnId,
      ts: now - 7 * 24 * 3_600_000,
      text: '这是历史 Claude 连接留下的会话。原连接 fake-claude 已不在连接列表里。',
    },
    {
      type: 'assistant',
      id: 'stale-legacy-msg-2',
      turnId,
      ts: now - 7 * 24 * 3_600_000 + 3_000,
      text: '这条历史会话需要切换到当前可用模型后才能继续发送。',
      modelId: 'claude-3-sonnet',
    },
  ];
}

function healthyMessages(now: number): StoredMessage[] {
  const turnId = 'healthy-turn-1';
  return [
    {
      type: 'user',
      id: 'healthy-msg-1',
      turnId,
      ts: now - 12 * 60_000,
      text: '这是正常的 ai-sdk + zai-live 会话，sidebar 应该没有 "已过期" pill。',
    },
    {
      type: 'assistant',
      id: 'healthy-msg-2',
      turnId,
      ts: now - 12 * 60_000 + 1_500,
      text: '当前连接健康，后续发送会继续使用这个会话固定的 GLM 模型。',
      modelId: 'glm-5.1',
    },
  ];
}

async function writeSession(workspaceRoot: string, session: SessionHeader, messages: StoredMessage[]): Promise<void> {
  const dir = join(workspaceRoot, 'sessions', session.id);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'session.jsonl'),
    [session, ...messages].map((entry) => JSON.stringify(entry)).join('\n') + '\n',
    'utf8',
  );
}

async function writeArtifacts(workspaceRoot: string, now: number, scenario: VisualSmokeScenario): Promise<void> {
  const root = join(workspaceRoot, 'artifacts');
  // PR-UI-RENDER-3a-smoke: dedicated preview scenarios get their
  // own short artifact list (single artifact each) so the
  // ArtifactPane default selection deterministically picks the one
  // the screenshot is meant to capture. The `sizeBytesOverride`
  // field bypasses the post-write `stat().size` overwrite so we
  // can claim 3MB in metadata without writing 3MB to disk.
  type ArtifactSpec = {
    id: string;
    name: string;
    kind: ArtifactRecord['kind'];
    mimeType?: string;
    content: string | Uint8Array;
    status?: ArtifactRecord['status'];
    skipFile?: boolean;
    /**
     * @kenji review @msg fc9753b9 oversize fixture: when this is
     * set, the post-write `stat().size` is NOT used to overwrite
     * the recorded `sizeBytes`. Lets us seed a 3MB-claim artifact
     * without consuming 3MB of disk in the test workspace.
     * Only valid alongside `skipFile: true` to avoid metadata/file
     * drift.
     */
    sizeBytesOverride?: number;
  };
  // 1x1 transparent PNG (67 bytes). Smallest valid PNG that
  // `readBinary` will sniff back as `image/png`. Used by
  // `artifact-preview-image` to exercise the registry's happy path.
  const tinyPngBytes = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41,
    0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
    0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
    0x42, 0x60, 0x82,
  ]);

  // PR-UI-RENDER-3a-smoke: dedicated single-artifact specs per
  // scenario. Returning early keeps these scenarios from inheriting
  // the standard html/diff/notes list (which would shuffle the
  // default selection).
  if (scenario === 'artifact-preview-image') {
    await writeArtifactSpecs(root, now, [
      {
        id: 'artifact-preview-image',
        name: 'screenshot.png',
        kind: 'image',
        mimeType: 'image/png',
        content: tinyPngBytes,
      },
    ]);
    return;
  }
  if (scenario === 'artifact-preview-unsupported') {
    await writeArtifactSpecs(root, now, [
      {
        id: 'artifact-preview-unsupported',
        name: 'portrait.heic',
        // kind: 'image' makes the resolver enter the image branch;
        // image/heic is NOT in the allowlist so L1 returns
        // `unsupported(mime_disallowed)`. readBinary is NEVER called
        // for this scenario.
        kind: 'image',
        mimeType: 'image/heic',
        content: Uint8Array.from([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70]),
      },
    ]);
    return;
  }
  if (scenario === 'artifact-preview-oversize') {
    await writeArtifactSpecs(root, now, [
      {
        id: 'artifact-preview-oversize',
        name: 'huge.png',
        kind: 'image',
        mimeType: 'image/png',
        // 3MB claim — past the 2MB cap. L1 resolver rejects via
        // sizeBytes before readBinary is even attempted; the
        // <UnsupportedArtifactPreview reason="oversize"> is what
        // renders. We skip the file so the test workspace stays
        // small (and so a stat overwrite doesn't undo our claim).
        content: Uint8Array.from([]),
        skipFile: true,
        sizeBytesOverride: 3 * 1024 * 1024,
      },
    ]);
    return;
  }
  const specs: Array<ArtifactSpec> = [
    {
      id: 'artifact-report',
      name: 'report.html',
      kind: 'html' as const,
      mimeType: 'text/html',
      content: [
        '<!doctype html>',
        '<html lang="zh-CN">',
        '<meta charset="utf-8">',
        '<title>Maka 生成文件自检报告</title>',
        '<style>body{font-family:system-ui;margin:24px;line-height:1.5}code{background:#eee;padding:2px 4px}</style>',
        '<h1>生成文件面板自检报告</h1>',
        '<p>这个 HTML 生成文件用于验证 sandboxed iframe view-only 预览。</p>',
        '<p><a href="https://example.com">外部链接应被禁用</a></p>',
        '<script>document.body.dataset.scriptRan = "true";</script>',
        '</html>',
      ].join('\n'),
    },
    {
      id: 'artifact-patch',
      name: 'patch.diff',
      kind: 'diff' as const,
      mimeType: 'text/x-diff',
      content: [
        'diff --git a/apps/desktop/src/renderer/ArtifactPane.tsx b/apps/desktop/src/renderer/ArtifactPane.tsx',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/apps/desktop/src/renderer/ArtifactPane.tsx',
        '@@ -0,0 +1,4 @@',
        '+export function ArtifactPane() {',
        '+  return <aside className="maka-artifact-pane" />;',
        '+}',
      ].join('\n'),
    },
    {
      id: 'artifact-notes',
      name: 'notes.md',
      kind: 'file' as const,
      mimeType: 'text/markdown',
      content: [
        '# 生成文件面板说明',
        '',
        '- HTML preview is view-only.',
        '- Deleted tombstones must block reads.',
        '- Binary preview requires MIME sniff allow-list.',
      ].join('\n'),
    },
  ];
  if (scenario === 'artifact-errors') {
    specs.push(
      {
        id: 'artifact-deleted',
        name: 'deleted.md',
        kind: 'file',
        mimeType: 'text/markdown',
        content: '# Deleted artifact\n\nThis file remains on disk but reads must be blocked by tombstone.',
        status: 'deleted',
      },
      {
        id: 'artifact-unsupported',
        name: 'unsupported.bin',
        kind: 'image',
        mimeType: 'image/png',
        content: Uint8Array.from([0x00, 0x01, 0x02, 0x03]),
      },
      {
        id: 'artifact-missing',
        name: 'missing.md',
        kind: 'file',
        mimeType: 'text/markdown',
        content: '# Missing artifact',
        skipFile: true,
      },
    );
  }

  await writeArtifactSpecs(root, now, specs);
}

/**
 * Shared writer for an arbitrary artifact spec list. Writes each
 * spec to disk (unless `skipFile`), captures the real `sizeBytes`
 * via `stat` (unless `sizeBytesOverride`), and emits the
 * `metadata.jsonl` index. Used by both the canonical
 * `artifact-pane` / `artifact-errors` scenarios and the
 * PR-UI-RENDER-3a-smoke preview scenarios.
 */
async function writeArtifactSpecs(
  root: string,
  now: number,
  specs: Array<{
    id: string;
    name: string;
    kind: ArtifactRecord['kind'];
    mimeType?: string;
    content: string | Uint8Array;
    status?: ArtifactRecord['status'];
    skipFile?: boolean;
    sizeBytesOverride?: number;
  }>,
): Promise<void> {
  const records: ArtifactRecord[] = [];
  for (const spec of specs) {
    const relativePath = `${ARTIFACT_SESSION_ID}/${spec.id}-${spec.name}`;
    const path = join(root, relativePath);
    let sizeBytes = spec.content instanceof Uint8Array ? spec.content.byteLength : Buffer.byteLength(spec.content);
    if (!spec.skipFile) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, spec.content);
      sizeBytes = (await stat(path)).size;
    }
    // PR-UI-RENDER-3a-smoke: oversize fixture passes
    // `sizeBytesOverride` so the metadata can claim 3MB without
    // writing 3MB. The override must come AFTER the stat overwrite
    // above so it isn't undone.
    if (spec.sizeBytesOverride !== undefined) {
      sizeBytes = spec.sizeBytesOverride;
    }
    records.push({
      id: spec.id,
      sessionId: ARTIFACT_SESSION_ID,
      turnId: 'turn-artifact',
      createdAt: now - 6 * 60_000 + records.length * 1_000,
      name: spec.name,
      kind: spec.kind,
      relativePath,
      sizeBytes,
      ...(spec.mimeType ? { mimeType: spec.mimeType } : {}),
      source: 'fixture',
      status: spec.status ?? 'live',
    });
  }

  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, 'metadata.jsonl'),
    records.map((record) => JSON.stringify(record)).join('\n') + '\n',
    'utf8',
  );
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function streamingLiveTurns(): NonNullable<VisualSmokeState['liveTurnBySession']> {
  return {
    [STREAMING_SESSION_ID]: {
      turnId: 'turn-streaming',
      phase: 'streamed',
      steps: [{
        stepId: 'stream-live-step',
        text: {
          text: '正在检查日志、模型配置和最近的工具输出…',
          truncated: false,
          complete: false,
        },
        tools: [{
          toolUseId: 'stream-live-tool',
          toolName: 'Bash',
          stepId: 'stream-live-step',
          displayName: '运行中的诊断',
          intent: '模拟后台 stream 中的 tool activity',
          status: 'running',
          args: { cmd: 'npm run visual-smoke:fixture' },
        }],
      }],
    },
  };
}

function streamingAnswerLiveTurns(): NonNullable<VisualSmokeState['liveTurnBySession']> {
  return {
    [TURN_SESSION_ID]: {
      turnId: 'turn-fixture-2',
      phase: 'streamed',
      steps: [{
        stepId: 'msg-assistant-2c',
        text: { text: STREAMING_ANSWER_MARKDOWN, truncated: false, complete: false },
        tools: [],
      }],
    },
  };
}

function processingLiveTurns(): NonNullable<VisualSmokeState['liveTurnBySession']> {
  return {
    [PROCESSING_SESSION_ID]: {
      turnId: 'turn-processing-1',
      phase: 'waiting',
      steps: [],
    },
  };
}

function permissionState(): NonNullable<VisualSmokeState['permissionBySession']> {
  return {
    [PERMISSION_SESSION_ID]: permissionRequest(VISUAL_SMOKE_NOW),
  };
}

function permissionLiveTurns(): NonNullable<VisualSmokeState['liveTurnBySession']> {
  const request = permissionRequest(VISUAL_SMOKE_NOW);
  return {
    [PERMISSION_SESSION_ID]: {
      turnId: 'turn-permission',
      phase: 'streamed',
      steps: [{
        stepId: 'tool:permission-tool',
        tools: [{
          toolUseId: request.toolUseId,
          toolName: request.toolName,
          displayName: '模拟删除命令',
          intent: request.hint,
          status: 'waiting_permission',
          args: request.args,
        }],
      }],
    },
  };
}

function permissionRequest(now: number): PermissionRequestEvent {
  return {
    type: 'permission_request',
    id: 'visual-smoke-permission-event',
    turnId: 'turn-permission',
    ts: now,
    requestId: 'visual-smoke-permission-request',
    toolUseId: 'permission-tool',
    toolName: 'Bash',
    category: 'fs_destructive',
    reason: 'fs_destructive',
    args: { cmd: 'rm -rf ./dist', cwd: '/workspace/maka' },
    hint: '模拟/拦截 permission request：不要实际执行 rm。',
  };
}
