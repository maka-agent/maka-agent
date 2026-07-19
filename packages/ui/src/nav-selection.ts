export type SessionFilter = 'chats' | 'flagged' | 'archived';

export type NavSelection =
  | { section: 'sessions'; filter: SessionFilter }
  | { section: 'automations' }
  | { section: 'skills' }
  | { section: 'mcp' }
  | { section: 'daily-review' };
