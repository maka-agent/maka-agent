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
  | 'streaming-sidebar'
  | 'permission-destructive';

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
}
