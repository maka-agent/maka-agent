import type { PermissionRequestEvent, ToolResultContent } from './events.js';
import type { SettingsSection } from './settings.js';

export type VisualSmokeScenario =
  | 'all'
  | 'first-run'
  | 'provider-workspace'
  | 'fallback-source'
  | 'fetched-empty'
  | 'connection-error'
  | 'turn-narrative'
  | 'artifact-pane'
  | 'artifact-errors'
  | 'streaming-sidebar'
  | 'permission-destructive'
  | 'stale-sessions'
  | 'settings-data'
  | 'settings-personalization'
  | 'settings-network'
  | 'settings-bots'
  | 'settings-about'
  | 'settings-theme'
  | 'settings-coming-soon'
  | 'workstation-statuses'
  // PR109f (g): turn-control-history — seeds a primary session whose
  // turn list covers retried / regenerated / aborted / failed and two
  // branch sessions (one with visible parent showing the banner, one
  // with a missing parent that must NOT render a banner). The three
  // scenarios below share the same on-disk seed; they only differ in
  // which session is the active one so auto-capture produces three
  // deterministic screenshots covering both positive and negative
  // banner cases without requiring manual clicks. Smoke Path 15 reads
  // these fixtures.
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
  // independently, and the footer (Settings + Update placeholder)
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
  | 'sidebar-search-modal-open';

export interface VisualSmokeLiveTool {
  toolUseId: string;
  toolName: string;
  displayName?: string;
  intent?: string;
  status: 'pending' | 'waiting_permission' | 'running' | 'completed' | 'errored' | 'interrupted';
  args: unknown;
  result?: ToolResultContent;
  durationMs?: number;
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
  openSettingsSection?: SettingsSection;
  streamingBySession?: Record<string, string>;
  /**
   * PR-UI-LAYOUT-42: per-session thinking buffer for fixtures that
   * want to seed the ReasoningPanel mid-stream. Mirrors
   * `streamingBySession` shape. Empty string = no live thinking
   * (panel hidden). Set this in a fixture to capture the panel's
   * live-streaming visual state in a screenshot.
   */
  thinkingBySession?: Record<string, string>;
  permissionBySession?: Record<string, PermissionRequestEvent>;
  liveToolsBySession?: Record<string, VisualSmokeLiveTool[]>;
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
   * `MAKA_VISUAL_SMOKE_LOCALE=zh|en`. PR-UI-14's `detectUiLocale()`
   * reads `navigator.language` by default, which makes screenshot
   * baselines drift between hosts (e.g. a CI machine on en-US vs a
   * Mac mini on zh-CN renders different placeholder text in the
   * same fixture). When set, the renderer applies
   * `data-maka-visual-smoke-locale="zh|en"` to `<html>` and
   * `detectUiLocale()` reads that BEFORE `navigator.language`.
   * Unrecognized values fall back to undefined (renderer uses
   * navigator detection as today).
   */
  locale?: 'zh' | 'en';
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
}
