import { resolveSkillDiscoveryPaths } from '@maka/runtime';
import { isSessionWorkspaceUnavailableError } from './project-context-root.js';

interface DesktopSkillDiscoveryDeps {
  workspaceRoot: string;
  skillHomeRoot?: string;
  getProjectRoot(sessionId?: string): Promise<string>;
}

export async function resolveDesktopSkillDiscoverySource(
  deps: DesktopSkillDiscoveryDeps,
  sessionId?: string,
): Promise<ReturnType<typeof resolveSkillDiscoveryPaths>> {
  try {
    const cwd = await deps.getProjectRoot(sessionId);
    return resolveSkillDiscoveryPaths(cwd, deps.workspaceRoot, deps.skillHomeRoot);
  } catch (error) {
    if (!isSessionWorkspaceUnavailableError(error)) throw error;

    const globalSource = resolveSkillDiscoveryPaths(
      deps.workspaceRoot,
      deps.workspaceRoot,
      deps.skillHomeRoot,
    );
    const entries = globalSource.entries.filter(
      ({ origin }) => origin !== 'project_maka' && origin !== 'project_agents',
    );
    return {
      entries,
      dirs: entries.map(({ dir }) => dir),
      stateRoot: globalSource.stateRoot,
    };
  }
}
