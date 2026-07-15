/**
 * Workspace config types.
 */

import type { BackendKind } from './session.js';
import type { PermissionMode } from './permission.js';

export interface WorkspaceConfig {
  id: string;
  name: string;
  /** Absolute path: ~/.maka/workspaces/{id}/ */
  rootPath: string;
  createdAt: number;
  defaults: {
    permissionMode: PermissionMode;
    backend: BackendKind;
    llmConnectionSlug?: string;
    model?: string;
  };
}
