export type SessionFilter = 'chats' | 'flagged' | 'archived';

export type NavSelection =
  | { section: 'sessions'; filter: SessionFilter }
  | { section: 'automations' }
  | { section: 'daily-review' };
