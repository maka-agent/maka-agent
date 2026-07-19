import type { PermissionRequestEvent, ToolResultContent } from './events.js';
import type { SettingsSection } from './settings.js';
import type { UiLocale } from './ui-locale.js';

export type VisualSmokeScenario =
  | 'all'
  | 'first-run'
  | 'provider-workspace'
  | 'fallback-source'
  | 'fetched-empty'
  | 'connection-error'
  // OAuth re-login: seeds a openai-codex (OAuth) connection that last
  // tested needs_reauth and focuses its detail sheet, so the inline 登录 /
  // 重新登录 affordance the detail sheet gained is visible where an expired
  // OAuth login must be re-run — the surface that used to be dead prose.
  | 'oauth-relogin'
  | 'turn-narrative'
  | 'task-ledger'
  | 'artifact-pane'
  | 'artifact-errors'
  | 'streaming-sidebar'
  // PR-STREAM-TURN-CENTER: streaming-sidebar only shows the SIDEBAR dot (its
  // active session is a committed one). This seeds an ACTIVE session whose
  // main panel renders the live answer bubble below a committed turn, so the
  // screenshot locks streaming-vs-committed horizontal alignment — the gap
  // that let the "streaming markdown sits ~110px too far left" bug ship.
  | 'streaming-answer'
  // #646 real-time status language: a running session whose turn is armed with
  // nothing streaming yet — the "正在处理…" model-wait indicator rides the tail
  // turn and the composer shows Stop. Locks the connect-to-first-token state.
  | 'model-processing'
  | 'permission-destructive'
  | 'stale-sessions'
  | 'settings-data'
  // PR-SETTINGS-IA-CONSOLIDATE-0 + PR-SETTINGS-REVIEW-0: memory and
  // daily-review split back apart; appearance stays merged; network
  // folded into general. PR-VOICE-GATEWAY-SPLIT-0 (WAWQAQ msg
  // `d3ea9a33` 2026-06-26) further split voice + open-gateway into
  // their own nav items.
  | 'settings-appearance'
  | 'settings-bots'
  | 'settings-about'
  | 'settings-general'
  | 'settings-memory'
  | 'settings-daily-review'
  | 'settings-permissions'
  | 'settings-voice'
  | 'settings-gateway'
  | 'settings-search'
  | 'settings-usage'
  | 'settings-health'
  | 'module-skills'
  | 'module-mcp'
  | 'module-daily-review'
  | 'workstation-statuses'
  | 'plan-reminders'
  // PR109f (g): turn-control-history — seeds a primary session whose
  // turn list covers retried / regenerated / aborted / failed and two
  // branch sessions (one with visible parent showing the banner, one
  // with a missing parent that must NOT render a banner). The three
  // scenarios below share the same on-disk seed; they only differ in
  // which session is the active one so auto-capture produces three
  // deterministic screenshots covering both positive and negative
  // banner cases without requiring manual clicks.
  | 'turn-control-history'
  | 'turn-control-branch-visible'
  | 'turn-control-branch-orphan'
  // PR-UI-RENDER-3a-smoke: three artifact preview fixtures lock the
  // visual contract for the new registry-driven image path. Each
  // scenario writes a SINGLE artifact to ARTIFACT_SESSION_ID so the
  // ArtifactPane's default selection (records[0]) deterministically
  // shows the one we want to screenshot. @kenji review @msg
  // fc9753b9 holds visual-regression sign-off pending these three.
  //   - artifact-preview-image: real tiny PNG → registry resolves
  //     `image(mime_match)`, <img object-fit:contain> inside bounded
  //     container.
  //   - artifact-preview-unsupported: kind=image + mimeType=image/
  //     heic (disallowed by allowlist). Registry resolves L1
  //     `unsupported(mime_disallowed)`. Visual contract: no `<img>`,
  //     UnsupportedCard shows name + mime + size, NO relativePath
  //     leak.
  //   - artifact-preview-oversize: kind=image + mimeType=image/png
  //     + sizeBytes claim > 2MB (via skipFile + sizeBytesOverride).
  //     Registry resolves L1 `unsupported(oversize)` BEFORE
  //     readBinary. Finder button visible (ArtifactPane provides
  //     onShowInFolder).
  | 'artifact-preview-image'
  | 'artifact-preview-unsupported'
  | 'artifact-preview-oversize'
  // PR-SIDEBAR-IA-0 Phase 1 (xuan msg `dc790a54` + kenji `0f7bb872`):
  // sidebar-long-sessions seeds 60 active sessions so the sidebar
  // scroll container can be verified end-to-end: the list must scroll
  // independently, and the footer (Settings + Version info)
  // must stay visible at the bottom regardless of session count.
  // Auto-capture variant pairs (light + dark, narrow + wide) double
  // as the CI gate that scroll did not regress.
  | 'sidebar-long-sessions'
  // PR-SIDEBAR-IA-0 Phase 2 fixup v3 (xuan msg `dce5a6fb` #2 +
  // WAWQAQ msg `4259bf8c`): seed the same 60-session sidebar as
  // sidebar-long-sessions, then auto-open the Search modal at
  // mount so the screenshot pipeline captures the modal shell
  // without requiring an interaction. The opener uses
  // `VisualSmokeState.searchModalOpen=true`; real users never
  // receive a visual smoke state.
  | 'sidebar-search-modal-open'
  // PR-shared primitive-COMMAND-INPUT-0: reuse the long sidebar seed and
  // auto-open the command palette so screenshots can baseline the
  // shared primitive InputGroup command input shell without requiring a key
  // chord.
  | 'command-palette-open'
  // PR-SIDEBAR-IA-0 Phase 3 P0 fixup v4 (WAWQAQ msg `5dd1c348`,
  // kenji `b3d156e9`): seed the same 60-session sidebar and
  // programmatically focus the active row's button after mount
  // so the absolute-positioned `.maka-list-row-actions` overlay
  // becomes visible (via `:focus-within`). Verifies that the
  // time meta + unread dot do NOT leak through the action icons
  // — the bug WAWQAQ flagged.
  | 'sidebar-row-actions-visible'
  // Scroll-geometry contract: a 24-turn session whose turns are each ~1300px
  // tall, opened as the active session on boot. Off-screen turns mount as
  // 250px content-visibility placeholders, so this seed exercises the
  // warm-up + pinned-bottom geometry invariants (E2E scroll-geometry spec)
  // and gives screenshots a long-transcript surface.
  | 'long-transcript'
  // #819: BrowserPanel renderer-chrome fixture. Seeds `liveBrowserSessionIds`
  // with the active turn session so `BrowserPanel` mounts (app-shell gates
  // on `activeId && liveBrowserSessionIds.includes(activeId)`). In
  // visual-smoke mode there is no native `WebContentsView`, so
  // `browser.getState` resolves null and `BrowserPanel` renders `EMPTY_STATE`
  // — the empty-state chrome (toolbar with all nav buttons disabled + the
  // `<Empty>` strip) that the #818 narrow-layout defect regressed against.
  // Loaded / loading / nav chrome states are locked by the
  // `browser-panel-chrome` source contract (their wiring IS the behavior);
  // their screenshots add no layout value over this empty-state baseline.
  | 'browser-empty';

export interface VisualSmokeLiveTool {
  toolUseId: string;
  toolName: string;
  stepId?: string;
  displayName?: string;
  intent?: string;
  status: 'pending' | 'waiting_permission' | 'running' | 'completed' | 'errored' | 'interrupted';
  args: unknown;
  result?: ToolResultContent;
  durationMs?: number;
}

export interface VisualSmokeLiveTurnStep {
  stepId: string;
  thinking?: { text: string; truncated: boolean; complete: boolean };
  text?: { text: string; truncated: boolean; complete: boolean };
  tools: VisualSmokeLiveTool[];
}

export interface VisualSmokeLiveTurnProjection {
  turnId: string;
  phase: 'waiting' | 'streamed';
  terminal?: true;
  steps: VisualSmokeLiveTurnStep[];
}

export interface VisualSmokeState {
  enabled: true;
  scenario: VisualSmokeScenario;
  /**
   * Deterministic wall-clock timestamp for fixture rendering. The
   * renderer uses it to freeze `Date.now()` while visual smoke mode is
   * active so relative-time labels, fetched-at copy, and transient
   * permission timestamps do not drift between screenshot runs.
   */
  now?: number;
  activeSessionId?: string;
  /**
   * #819: session ids with a live embedded-browser view, mirrorring the
   * renderer's `liveBrowserSessionIds` state (app-shell gates `BrowserPanel`
   * mounting on `activeId && liveBrowserSessionIds.includes(activeId)`).
   * Seeded only by the `browser-empty` scenario so the renderer chrome can
   * be screenshot-captured. Real users never receive a visual smoke state, so
   * this never drives production `browser:live` wiring.
   */
  liveBrowserSessionIds?: string[];
  openSettingsSection?: SettingsSection;
  liveTurnBySession?: Record<string, VisualSmokeLiveTurnProjection>;
  permissionBySession?: Record<string, PermissionRequestEvent>;
  /**
   * PR-IR-04: force `prefers-reduced-motion: reduce` behavior regardless
   * of the host OS setting. Triggered by `MAKA_VISUAL_SMOKE_REDUCED_MOTION=1`
   * env var in the main process. The renderer applies
   * `data-maka-reduced-motion="true"` to `<html>` so the matching CSS
   * rule in `styles.css` collapses every animation/transition to
   * ~0.01ms.
   */
  reducedMotion?: boolean;
  /**
   * PR-IR-01: when set, the renderer waits for fixture state to settle
   * then auto-triggers `window.maka.visualSmoke.capture()` to dump a
   * screenshot, then the main process logs a deterministic line to
   * stdout so the driver script (`scripts/capture-screenshots.mjs`)
   * knows the capture finished. Driven by env var
   * `MAKA_VISUAL_SMOKE_AUTO_CAPTURE=<variant>` (variant matches the
   * regex `[a-zA-Z0-9._-]+`, e.g. `light-1280-motion`).
   */
  autoCaptureVariant?: string;
  /**
   * PR-IR-01b: theme override driven by `MAKA_VISUAL_SMOKE_THEME=light|dark|auto`.
   * Lets the screenshot pipeline capture each scenario in both light
   * and dark themes without requiring per-fixture seed updates. The
   * renderer applies this BEFORE the user's persisted theme so the
   * first paint already has the right palette.
   */
  theme?: 'light' | 'dark' | 'auto';
  /**
   * PR-UI-VISUAL-SMOKE-LOCALE: UI locale override driven by
   * `MAKA_VISUAL_SMOKE_LOCALE=zh|en`. The reactive locale provider
   * normally follows the persisted preference. When set, the renderer
   * records `data-maka-visual-smoke-locale="zh|en"` on `<html>` and
   * resolves that override before the persisted preference.
   * Unrecognized values fall back to undefined.
   */
  locale?: UiLocale;
  /**
   * PR-UI-VISUAL-SMOKE-TIMEZONE: IANA timezone override driven by
   * `MAKA_VISUAL_SMOKE_TIMEZONE=<IANA name>`. Mirrors the locale
   * override pattern: when set, the renderer applies
   * `data-maka-visual-smoke-tz="<IANA>"` to `<html>` so any date /
   * time formatting helper can read it BEFORE falling back to the
   * host system timezone.
   *
   * Validation is via `Intl.DateTimeFormat(undefined, { timeZone })`
   * (throws RangeError on invalid IANA names). Invalid timezone
   * values fall back to undefined (renderer uses host system
   * timezone as today). Same scope as locale: contract + attribute
   * write only; per-call timezone consumption is up to individual
   * formatters as they're added.
   *
   * Real users never receive a visual smoke state, so their Date
   * formatting remains untouched.
   */
  timezone?: string;
  /**
   * PR-SIDEBAR-IA-0 Phase 2 fixup v3 (xuan msg `dce5a6fb` #2): when
   * `true`, the renderer auto-opens the sidebar Search modal at
   * mount so the screenshot pipeline can capture the modal shell
   * deterministically (the modal is not the default state of any
   * scenario; opening it requires either user input or this hint).
   *
   * Currently set only by the `sidebar-search-modal-open` scenario.
   * Real users never receive a visual smoke state, so this never
   * affects the production app.
   */
  searchModalOpen?: boolean;
  /**
   * PR-shared primitive-COMMAND-INPUT-0: when `true`, the renderer auto-opens
   * the command palette at mount so the screenshot pipeline can
   * capture the command input shell deterministically. Currently set
   * only by `command-palette-open`.
   */
  paletteOpen?: boolean;
  /**
   * PR-SIDEBAR-IA-0 Phase 3 P0 fixup v4 (WAWQAQ msg `5dd1c348`,
   * kenji `b3d156e9`): when `true`, the renderer focuses the
   * active row's `.maka-list-row-main` button after mount so the
   * row's `:focus-within` triggers and the absolute-positioned
   * `.maka-list-row-actions` overlay becomes visible. The capture
   * then shows the actions cluster — without this hint, default
   * captures never have any focused row, so the overlap fix
   * (`.maka-list-row:focus-within .maka-list-row-meta {
   * visibility: hidden }`) can't be screenshot-verified.
   *
   * Currently set only by the `sidebar-row-actions-visible`
   * scenario.
   */
  focusActiveRow?: boolean;
  /**
   * Fixture-only sidebar module override. Used by scenarios that need
   * to screenshot non-session sidebar content without adding a real
   * router path.
   */
  sidebarSection?: 'sessions' | 'automations' | 'skills' | 'mcp' | 'daily-review';
  /**
   * Fixture-only sidebar collapsed override. Screenshot runs use a
   * fresh userData dir, while the real app defaults to the collapsed
   * target-layout like rail when no local preference exists. Sidebar
   * visual gates must opt into the expanded panel explicitly so their
   * captures prove the rows, counts, groups, and footer instead of
   * only the top-left icon rail.
   */
  sidebarCollapsed?: boolean;
  /** Fixture-only session workbar state for deterministic tab screenshots. */
  workbarCollapsed?: boolean;
  workbarTab?: 'tasks' | 'browser' | 'files';
}
