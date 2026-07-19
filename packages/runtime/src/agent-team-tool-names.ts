export const TEAM_MESSAGE_TOOL_NAME = 'team_message';
export const TEAM_INBOX_TOOL_NAME = 'team_inbox';
export const TEAM_TASK_LIST_TOOL_NAME = 'team_task_list';
export const TEAM_TASK_CLAIM_TOOL_NAME = 'team_task_claim';

export const AGENT_TEAM_LEAD_TOOL_NAMES = [TEAM_MESSAGE_TOOL_NAME, TEAM_INBOX_TOOL_NAME] as const;

export const AGENT_TEAM_CHILD_TOOL_NAMES = [
  ...AGENT_TEAM_LEAD_TOOL_NAMES,
  TEAM_TASK_LIST_TOOL_NAME,
  TEAM_TASK_CLAIM_TOOL_NAME,
] as const;
