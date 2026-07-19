import { useEffect, useState } from 'react';

/**
 * Built-in expert teams for the Composer "+" menu (issue #1043).
 *
 * The catalog is static, so it is loaded once on mount; a load failure just
 * leaves the 专家团 entry hidden - no toast, no retry.
 */
export function useShellExpertTeams(): readonly {
  id: string;
  name: string;
  description?: string;
}[] {
  const [expertTeams, setExpertTeams] = useState<
    readonly { id: string; name: string; description?: string }[]
  >([]);
  useEffect(() => {
    let cancelled = false;
    void window.maka.expertTeam
      .list()
      .then((result) => {
        if (!cancelled) setExpertTeams(result.teams);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return expertTeams;
}
