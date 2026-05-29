/**
 * PawWork-inspired read-only deep research mode.
 *
 * V0.1 is deliberately not a hidden autonomous subagent runtime. It is a
 * session profile: create a normal chat session, pin permissionMode=explore,
 * tag it with a visible label, and inject a dedicated system prompt section.
 */

export const QUICK_CHAT_MODES = ['chat', 'deep_research'] as const;
export type QuickChatMode = typeof QUICK_CHAT_MODES[number];

export const DEEP_RESEARCH_SESSION_LABEL = 'mode:deep_research';

export const DEEP_RESEARCH_WORKFLOW_STEPS = [
  {
    title: '先定位入口',
    body: '读目录、配置、启动链路和测试入口，建立项目地图。',
  },
  {
    title: '再追数据流',
    body: '沿关键模块、IPC、存储、权限和运行时边界追到真实实现。',
  },
  {
    title: '然后对照参考',
    body: '把可借鉴点拆成 borrow / diverge / risk / gate。',
  },
  {
    title: '最后给可合入方案',
    body: '输出文件清单、风险边界和验证命令，不在只读模式里动手改。',
  },
] as const;

export function isQuickChatMode(value: unknown): value is QuickChatMode {
  return typeof value === 'string' && (QUICK_CHAT_MODES as readonly string[]).includes(value);
}

export function normalizeQuickChatMode(value: unknown): QuickChatMode {
  return value === 'deep_research' ? 'deep_research' : 'chat';
}

export function isDeepResearchSession(labels: readonly string[] | undefined): boolean {
  return Array.isArray(labels) && labels.includes(DEEP_RESEARCH_SESSION_LABEL);
}

export function buildDeepResearchSystemPromptFragment(): string {
  return [
    'Deep research mode is active for this session.',
    '',
    'Mode contract:',
    '- Inspect first. Prefer Read, Glob, Grep, and safe read-only shell commands.',
    '- Do not write, edit, delete, move, rename, install, run migrations, start services, or send network requests unless the user explicitly leaves research mode.',
    '- If implementation is needed, produce a concrete plan with files, risks, and verification commands instead of modifying files.',
    '- Keep findings source-grounded: name files, functions, configs, tests, and observed behavior.',
    '- Summarize borrow / diverge / risk / gate when comparing a reference project to Maka.',
    '',
    'Research workflow:',
    ...DEEP_RESEARCH_WORKFLOW_STEPS.map((step) => `- ${step.title}: ${step.body}`),
  ].join('\n');
}
