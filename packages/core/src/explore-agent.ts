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

export const DEEP_RESEARCH_REPORT_SECTIONS = [
  {
    title: '结论先行',
    body: '用 3-5 条讲清楚真实现状、主要差距和优先建议。',
  },
  {
    title: '源码证据',
    body: '列出文件、函数、配置、测试和运行时路径，避免只给印象判断。',
  },
  {
    title: '借鉴拆解',
    body: '每个可借鉴点都写 borrow / diverge / risk / gate。',
  },
  {
    title: '落地改进',
    body: '给出按小步改进拆分的文件清单、边界和验证命令。',
  },
] as const;

export const DEEP_RESEARCH_SCOPE_OPTIONS = [
  {
    label: '快速',
    body: '只扫入口、关键文件和最可能的数据流，适合已知范围的小问题。',
  },
  {
    label: '标准',
    body: '默认深度：梳理核心链路、相关测试和主要风险，再给落地建议。',
  },
  {
    label: '深挖',
    body: '跨模块、参考项目和边界条件多轮追踪；只在用户明确要求时使用。',
  },
] as const;

export const DEEP_RESEARCH_EVIDENCE_CHECKLIST = [
  {
    title: '项目入口',
    body: '先看 README、package/config、启动脚本和目录分层，确认真实运行方式。',
  },
  {
    title: '核心链路',
    body: '追 UI 入口、IPC/服务、存储、运行时调用和错误处理，不只看表面组件。',
  },
  {
    title: '边界条件',
    body: '检查权限、隐身模式、token/路径暴露、失败重试和用户可见反馈。',
  },
  {
    title: '验证证据',
    body: '找对应测试、fixture、smoke 文档和可复现命令；缺口要明确标出来。',
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
    '',
    'Research scope budget:',
    ...DEEP_RESEARCH_SCOPE_OPTIONS.map((option) => `- ${option.label}: ${option.body}`),
    '- If the user does not specify a scope, use 标准. Use 深挖 only when the user explicitly asks for deep / exhaustive / full-project research.',
    '',
    'Evidence checklist:',
    ...DEEP_RESEARCH_EVIDENCE_CHECKLIST.map((item) => `- ${item.title}: ${item.body}`),
    '- If any checklist area cannot be verified from available files or runtime context, call that out explicitly instead of guessing.',
    '',
    'Final report contract:',
    ...DEEP_RESEARCH_REPORT_SECTIONS.map((section) => `- ${section.title}: ${section.body}`),
  ].join('\n');
}
