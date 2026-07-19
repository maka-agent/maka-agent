import { useState } from 'react';
import { readSessionListCollapsed, readSessionListWidth } from './session-list-layout';
import {
  readSessionWorkbarCollapsed,
  readSessionWorkbarTab,
  readSessionWorkbarWidth,
} from './session-workbar-layout';

/**
 * Owns the shell layout state (issue #1043): session-list and workbar widths,
 * collapse flags, and the active workbar tab. Each value is hydrated from
 * localStorage on first render and persisted by `useAppShellPersistenceEffects`.
 *
 * The resize pointer/keyboard handlers live in `createAppShellLayoutActions`
 * (app-shell-layout-actions.ts); this hook only owns the state and setters.
 */
export function useShellLayout() {
  const [sessionListWidth, setSessionListWidth] = useState(() => readSessionListWidth());
  const [sessionListCollapsed, setSessionListCollapsed] = useState(() => readSessionListCollapsed());
  const [workbarCollapsed, setWorkbarCollapsed] = useState(() => readSessionWorkbarCollapsed());
  const [workbarWidth, setWorkbarWidth] = useState(() => readSessionWorkbarWidth());
  const [workbarTab, setWorkbarTab] = useState(() => readSessionWorkbarTab());
  return {
    sessionListWidth,
    setSessionListWidth,
    sessionListCollapsed,
    setSessionListCollapsed,
    workbarCollapsed,
    setWorkbarCollapsed,
    workbarWidth,
    setWorkbarWidth,
    workbarTab,
    setWorkbarTab,
  };
}
