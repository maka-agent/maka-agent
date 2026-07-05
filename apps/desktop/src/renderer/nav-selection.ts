import type { SessionSummary } from '@maka/core';
import type { NavSelection } from '@maka/ui';
import { safeLocalStorageGet } from './browser-storage';

export function readNavSelection(): NavSelection {
  try {
    const raw = safeLocalStorageGet('maka-nav-selection-v1');
    if (!raw) return { section: 'sessions', filter: 'chats' };
    const parsed = JSON.parse(raw) as { section?: string; filter?: string };
    // PR-SIDEBAR-IA-0 Phase 2 fixup (xuan `94c7bf0f`): fail-closed.
    // `'search'` was briefly a `NavSelection.section` during the
    // Phase 2 initial commit; the fixup removes it because `搜索`
    // is now a modal trigger, not a section. An older localStorage
    // entry with `{section:'search'}` would otherwise leave the
    // app stuck on an invalid section. Reject anything that is not
    // in the current closed-enum.
    if (parsed.section === 'skills') return { section: 'skills' };
    if (parsed.section === 'automations') return { section: 'automations' };
    if (parsed.section === 'daily-review') return { section: 'daily-review' };
    if (
      parsed.section === 'sessions' &&
      (parsed.filter === 'chats' || parsed.filter === 'flagged' || parsed.filter === 'archived')
    ) {
      return parsed as NavSelection;
    }
  } catch {
    /* fall through */
  }
  return { section: 'sessions', filter: 'chats' };
}

export function filterSessions(sessions: SessionSummary[], selection: NavSelection): SessionSummary[] {
  const filter = selection.section === 'sessions' ? selection.filter : 'chats';
  switch (filter) {
    case 'flagged':
      return sessions.filter((session) => session.isFlagged && !session.isArchived && session.lastMessageAt);
    case 'archived':
      return sessions.filter((session) => session.isArchived);
    case 'chats':
      return sessions.filter((session) => !session.isArchived && session.lastMessageAt);
  }
}

