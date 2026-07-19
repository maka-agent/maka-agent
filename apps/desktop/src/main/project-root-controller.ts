import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolveProjectRoot } from '@maka/runtime';

/**
 * Owns the "current project root" selection shared across the app/window,
 * git, workspace-search, workspace-instructions, and session-entry IPC
 * surfaces. The selection is a single mutable authority: the app IPC module
 * updates it through `setSelected` when the user picks a directory, and every
 * other surface reads it through `current`.
 *
 * Extracted verbatim from the former `registerIpc()` closures so the state has
 * one owner once the handlers are split across modules; behavior is unchanged.
 */
export interface ProjectRootController {
  /** Resolve the effective project root (selected → persisted → fallback). */
  current(): Promise<string>;
  /** Validate + resolve an explicit renderer-supplied path without selecting it. */
  resolveExplicit(
    projectPath: unknown,
  ): Promise<
    | { ok: true; projectPath: string }
    | { ok: false; reason: 'invalid-path' | 'not-found' }
  >;
  /** Adopt a resolved project root as the active selection and persist it. */
  setSelected(projectPath: string): void;
}

export interface ProjectRootControllerDeps {
  /** Absolute path of the JSON file that persists the last selected project. */
  lastProjectPathFile: string;
  /** Roots probed (in order) when nothing is selected or persisted. */
  fallbackRoots: () => string[];
}

export function createProjectRootController(
  deps: ProjectRootControllerDeps,
): ProjectRootController {
  let selectedProjectRoot: string | null = null;

  async function loadPersistedProjectRoot(): Promise<string | null> {
    try {
      const raw = await readFile(deps.lastProjectPathFile, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (typeof parsed.projectPath === 'string' && parsed.projectPath) {
        await stat(parsed.projectPath);
        return await resolveProjectRoot([parsed.projectPath]);
      }
    } catch {
      // File missing, invalid, or points at a deleted directory.
    }
    return null;
  }
  const persistedProjectRootPromise = loadPersistedProjectRoot();

  async function saveLastProjectPath(projectPath: string): Promise<void> {
    try {
      await writeFile(deps.lastProjectPathFile, JSON.stringify({ projectPath }), 'utf8');
    } catch {
      // Best-effort; failure should not block the selection.
    }
  }

  async function current(): Promise<string> {
    if (selectedProjectRoot) return selectedProjectRoot;
    const persistedProjectRoot = await persistedProjectRootPromise;
    if (persistedProjectRoot) {
      selectedProjectRoot = persistedProjectRoot;
      return persistedProjectRoot;
    }
    return resolveProjectRoot(deps.fallbackRoots());
  }

  async function resolveExplicit(projectPath: unknown): Promise<
    | { ok: true; projectPath: string }
    | { ok: false; reason: 'invalid-path' | 'not-found' }
  > {
    if (typeof projectPath !== 'string' || !projectPath) {
      return { ok: false, reason: 'invalid-path' };
    }
    try {
      await stat(projectPath);
    } catch {
      return { ok: false, reason: 'not-found' };
    }
    return { ok: true, projectPath: await resolveProjectRoot([projectPath]) };
  }

  function setSelected(projectPath: string): void {
    selectedProjectRoot = projectPath;
    void saveLastProjectPath(projectPath);
  }

  return { current, resolveExplicit, setSelected };
}
