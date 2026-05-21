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
}
