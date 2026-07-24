import { useCallback, useEffect, useState } from 'react';
import type { SkillEntry } from '@maka/ui';
import type { InvocableSkillEntry } from '@maka/runtime';

/**
 * Owns the composer mention popup wiring so app-shell.tsx keeps no inline
 * `window.maka` state (app-shell-composer-attachment-owner-contract). Derives
 * the `/` popup's skill list from Runtime's authoritative invocable projection, and
 * exposes a fail-soft file-search callback backed by the `workspace:searchFiles`
 * IPC. Both return values are memoized so the Composer props keep stable
 * identities across renders.
 */
export function useComposerMentions(options: {
  skills: readonly SkillEntry[];
  sessionId?: string;
  projectPath?: string;
}): {
  mentionSkills: ReadonlyArray<{ ref?: string; id: string; name: string; description?: string }>;
  searchMentionFiles(query: string): Promise<ReadonlyArray<{ relativePath: string }>>;
} {
  const { projectPath, sessionId, skills } = options;
  const [mentionSkills, setMentionSkills] = useState<InvocableSkillEntry[]>([]);

  useEffect(() => {
    let cancelled = false;
    // Do not briefly advertise the previous session/project's Skills while the
    // authoritative projection is being refreshed.
    setMentionSkills([]);
    void window.maka.skills.listInvocable(sessionId).then(
      (next) => {
        if (!cancelled) setMentionSkills(next);
      },
      () => {
        // Fail soft: an unavailable projection leaves `/` with no suggestions.
        // Direct `/skill:<id>` input still reaches the same Runtime resolver.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [projectPath, sessionId, skills]);

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
