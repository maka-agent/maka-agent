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
  | 'stale-sessions';

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
  activeSessionId?: string;
  openSettingsSection?: SettingsSection;
  streamingBySession?: Record<string, string>;
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
}
