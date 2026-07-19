import { realpath, stat } from 'node:fs/promises';

import type { RuntimeContinuationSafetyObservation } from './runtime-resume.js';

export interface LocalContinuationSafetyInspectorDeps {
  readSessionCwd(sessionId: string): Promise<string>;
  listAvailableToolNames(sessionId: string): Promise<readonly string[]>;
  hasPendingBackgroundOperations(sessionId: string): Promise<boolean>;
  readWorkspaceCheckpoint?: (
    sessionId: string,
  ) => Promise<RuntimeContinuationSafetyObservation['workspaceCheckpoint']>;
  resolveWorkspacePath?: (cwd: string) => Promise<string>;
  readWorkspaceStat?: (path: string) => Promise<{ dev: number | bigint; ino: number | bigint }>;
}

export function createLocalContinuationSafetyInspector(
  deps: LocalContinuationSafetyInspectorDeps,
): (sessionId: string) => Promise<RuntimeContinuationSafetyObservation> {
  const resolveWorkspacePath = deps.resolveWorkspacePath ?? realpath;
  const readWorkspaceStat =
    deps.readWorkspaceStat ??
    (async (path: string) => {
      const value = await stat(path);
      return { dev: value.dev, ino: value.ino };
    });
  return async (sessionId) => {
    const cwd = await deps.readSessionCwd(sessionId);
    const resolvedPath = normalizeWorkspacePath(await resolveWorkspacePath(cwd));
    const workspaceStat = await readWorkspaceStat(resolvedPath);
    const [availableToolNames, hasPendingBackgroundOperations, workspaceCheckpoint] =
      await Promise.all([
        deps.listAvailableToolNames(sessionId),
        deps.hasPendingBackgroundOperations(sessionId),
        deps.readWorkspaceCheckpoint?.(sessionId),
      ]);
    return {
      workspaceIdentity: `fs:${String(workspaceStat.dev)}:${String(workspaceStat.ino)}:${resolvedPath}`,
      backgroundOperationsSettled: !hasPendingBackgroundOperations,
      availableToolNames: [...new Set(availableToolNames)].sort(),
      ...(workspaceCheckpoint ? { workspaceCheckpoint } : {}),
    };
  };
}

function normalizeWorkspacePath(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/\/+$/, '');
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
}
