import { useCallback, useMemo } from 'react';
import type { SkillEntry } from '@maka/ui';

/**
 * Owns the composer mention popup wiring so app-shell.tsx keeps no inline
 * `window.maka` state (app-shell-composer-attachment-owner-contract). Derives
 * the `/` popup's skill list (enabled only) from the shell's skills list, and
 * exposes a fail-soft file-search callback backed by the `workspace:searchFiles`
 * IPC. Both return values are memoized so the Composer props keep stable
 * identities across renders.
 */
export function useComposerMentions(options: { skills: readonly SkillEntry[]; sessionId?: string }): {
  mentionSkills: ReadonlyArray<{ id: string; name: string; description?: string }>;
  searchMentionFiles(query: string): Promise<ReadonlyArray<{ relativePath: string }>>;
} {
  const { skills, sessionId } = options;

  const mentionSkills = useMemo(
    () =>
      skills
        // Only skills the runtime will actually honor — mirrors how the skills
        // panel treats enabled + runtimeStatus.
        .filter((skill) => skill.enabled && skill.runtimeStatus === 'enabled')
        .map((skill) => ({ id: skill.id, name: skill.name, description: skill.description })),
    [skills],
  );

  const searchMentionFiles = useCallback(
    async (query: string): Promise<ReadonlyArray<{ relativePath: string }>> => {
      try {
        const result = await window.maka.workspace.searchFiles(query, { sessionId });
        return result.ok ? result.files : [];
      } catch {
        // Fail soft: a failed search just yields an empty list, so the popup
        // shows 未找到文件 rather than surfacing an error into the composer.
        return [];
      }
    },
    [sessionId],
  );

  return { mentionSkills, searchMentionFiles };
}
