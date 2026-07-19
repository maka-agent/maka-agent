import type { OnboardingState, UiCatalog, UiLocale } from '@maka/core';
import type { FirstRunTaskSuggestion, FirstRunTaskSuggestionId } from '../first-run-task-suggestions.js';
import type { OnboardingHeroCopy, OnboardingSetupStep } from '../onboarding-hero-copy.js';

type VisibleOnboardingKind = Exclude<OnboardingState['kind'], 'ready_with_history'>;

interface ReadyHeroCopy {
  ariaLabel: string;
  eyebrow: string;
  headline: string;
  intro: string;
  quickChatPlaceholder: string;
  quickChatAria: string;
  quickChatExample: string;
  submitIdleLabel: string;
  submitPendingLabel: string;
  importFolderPending: string;
  importFilesPending: string;
  dropFiles: string;
  deepResearchMode: string;
  suggestionsLabel: string;
}

interface ChecklistCopy {
  refreshFailedTitle: string;
  unavailableLabel: string;
  unavailableBody: string;
  partialFailureBody: string;
  retry: string;
  refreshing: string;
  title: string;
  remainingAria(remaining: number): string;
  remainingCount(remaining: number, total: number): string;
  errorFallback: string;
  items: Record<
    | 'personalization'
    | 'web-search'
    | 'plan-reminder'
    | 'daily-review'
    | 'workspace-instructions'
    | 'local-memory'
    | 'voice-smoke',
    { title: string; reason: string; unknownReason?: string }
  >;
}

export interface OnboardingCatalog {
  hero: Record<VisibleOnboardingKind, Omit<OnboardingHeroCopy, 'kind' | 'connectionSlug'>>;
  setupSteps: Record<Exclude<VisibleOnboardingKind, 'ready_empty'>, readonly OnboardingSetupStep[]>;
  setupProgressLabel: string;
  setupStatus: Record<OnboardingSetupStep['state'], string>;
  needsConnection: {
    subtitle: string;
    pickLabel: string;
    pickHint: string;
    browseProviders: string;
  };
  refresh: {
    pending: string;
    connection: string;
    credentials: string;
    model: string;
    blocked: string;
  };
  connectionLabel: string;
  skip: string;
  skipping: string;
  ready: ReadyHeroCopy;
  suggestions: Record<FirstRunTaskSuggestionId, Omit<FirstRunTaskSuggestion, 'id'>>;
  checklist: ChecklistCopy;
  snapshotErrorFallback: string;
}

const ONBOARDING_COPY_BY_LOCALE: UiCatalog<OnboardingCatalog> = {
  zh: {
    hero: {
      needs_connection: {
        eyebrow: '欢迎使用 Maka',
        title: '不只是聊天，搞定真事。',
        body: '本地运行、走你自己的 API key、对每一步可见可控。点常见接入卡片进入「设置 · 模型」添加它的 key。',
        cta: { label: '打开设置 · 模型', settingsSection: 'models' },
      },
      needs_default_connection: {
        eyebrow: '选择默认模型连接',
        title: '选一个连接作为默认。',
        body: '你已经配置了至少一个模型连接，但还没设为默认。请到「设置 · 模型」挑一个作为默认连接，再开始对话。',
        cta: { label: '打开设置 · 模型', settingsSection: 'models' },
      },
      needs_connection_credentials: {
        eyebrow: '补齐凭据',
        title: '为这个连接配置 API key。',
        body: '默认连接等待填写 API key。请到「设置 · 模型」打开该连接，补齐密钥后再开始对话。',
        cta: { label: '打开设置 · 模型', settingsSection: 'models' },
      },
      needs_default_model: {
        eyebrow: '选择默认模型',
        title: '为这个连接选一个可用模型。',
        body: '默认连接还没绑定可用模型。请到「设置 · 模型」给它选一个，再开始对话。',
        cta: { label: '打开设置 · 模型', settingsSection: 'models' },
      },
      ready_empty: {
        eyebrow: '准备就绪 · 开始对话',
        title: '你已经配置好了 —— 直接说说你想做什么。',
        body: '下面的输入框会用默认模型开新会话；空提交也会打开一个空会话，方便你之后再输入。',
        cta: { label: '开始对话', settingsSection: 'models' },
        showQuickChat: true,
      },
      blocked: {
        eyebrow: '等待恢复模型连接',
        title: '当前没有通过验证的模型连接。',
        body: '请到「设置 · 账号」查看每个连接的状态，重新测试或重新登录后再开始对话。',
        cta: { label: '打开设置 · 账号', settingsSection: 'account' },
        tone: 'destructive',
      },
    },
    setupSteps: {
      needs_connection: [
        { label: '选择 AI 接入', detail: '从 Claude、OpenAI、GLM、本地 Ollama 等连接开始。', state: 'active' },
        { label: '补齐认证', detail: '使用 API key 或已接入的 OAuth 登录，不写入聊天记录。', state: 'pending' },
        { label: '测试并设默认', detail: '拉取模型、通过测试，再回到这里开始第一条对话。', state: 'pending' },
      ],
      needs_default_connection: [
        { label: '已有可用连接', detail: '至少一个真实模型连接已经通过基础检查。', state: 'done' },
        { label: '设为默认', detail: '选择新会话默认使用的连接，避免发送时猜测。', state: 'active' },
        { label: '开始对话', detail: '默认连接生效后，首屏会切换到快速输入。', state: 'pending' },
      ],
      needs_connection_credentials: [
        { label: '连接已选定', detail: '默认连接已定位，接下来只处理认证。', state: 'done' },
        { label: '补齐认证', detail: '填写 API key 或完成对应账号登录。', state: 'active' },
        { label: '测试并设默认模型', detail: '测试通过后再选择可用于聊天的模型。', state: 'pending' },
      ],
      needs_default_model: [
        { label: '认证已就绪', detail: '连接已经能访问供应商，下一步是模型选择。', state: 'done' },
        { label: '选择聊天模型', detail: '从实时模型列表里选一个可发送对话的模型。', state: 'active' },
        { label: '刷新检测', detail: '保存后回到这里刷新，Maka 会切到快速输入。', state: 'pending' },
      ],
      blocked: [
        { label: '连接测试失败', detail: '现有真实连接都还不能稳定发送。', state: 'warning' },
        { label: '修复认证或网络', detail: '重新登录、更新 key，或检查代理 / 供应商状态。', state: 'active' },
        { label: '重新测试', detail: '测试通过后再继续首条对话。', state: 'pending' },
      ],
    },
    setupProgressLabel: '配置 AI 进度',
    setupStatus: { done: '已完成', active: '当前步骤', pending: '待完成', warning: '需要处理' },
    needsConnection: {
      subtitle: '本地运行 · 自带 key · 每一步可见可控',
      pickLabel: '选择你的 AI',
      pickHint: '点一个进入设置，填它的 key',
      browseProviders: '浏览全部服务商',
    },
    refresh: {
      pending: '刷新中…',
      connection: '已经设好了？刷新检测',
      credentials: '已经填好了？刷新检测',
      model: '已经选好了？刷新检测',
      blocked: '已经修好了？刷新检测',
    },
    connectionLabel: '连接',
    skip: '跳过，先逛逛',
    skipping: '跳过中…',
    ready: {
      ariaLabel: '开始对话',
      eyebrow: '准备就绪 · 开始对话',
      headline: '今天想让 Maka 帮你做什么？',
      intro: '下面这个输入框会用默认模型开新会话；空提交也会打开一个空会话，方便你之后再输入。',
      quickChatPlaceholder: '给 Maka 发消息…',
      quickChatAria: '快速对话输入框',
      quickChatExample: '例如：帮我读一下这个项目的目录结构，告诉我入口在哪里。',
      submitIdleLabel: '开始对话',
      submitPendingLabel: '正在创建…',
      importFolderPending: '正在导入文件夹目录…',
      importFilesPending: '正在导入文件内容…',
      dropFiles: '松开以导入文件内容',
      deepResearchMode: '深度研究 · 只读分析',
      suggestionsLabel: '试试这些任务',
    },
    suggestions: {
      'workspace-map': {
        label: '读一下这个项目',
        mode: 'deep_research',
        prompt: '进入深度研究模式，只读梳理这个项目的目录结构：先找出入口、核心模块和测试位置，再用简短列表告诉我如果要继续开发应该从哪里开始。不要修改文件。',
      },
      'deep-research': {
        label: '深度研究一个项目',
        mode: 'deep_research',
        prompt: '进入深度研究模式，只读分析当前项目：先用目录、配置、入口文件、测试和关键模块建立架构图，再列出可以直接改进的功能点。不要修改文件，输出 borrow / diverge / risk / gate。',
      },
      'file-organize': {
        label: '整理一个文件夹',
        prompt: '帮我整理当前工作区里的文件：先列出你看到的文件类型和建议的目录结构，不要直接移动或删除文件，等我确认后再执行。',
      },
      'web-research': {
        label: '联网研究一个主题',
        prompt: '帮我联网研究一个主题：先问我主题是什么，然后用已配置的联网搜索找资料，最后给我来源、关键结论和还需要核实的点。',
      },
    },
    checklist: {
      refreshFailedTitle: '刷新首次使用清单失败',
      unavailableLabel: '接下来可以探索暂时不可用',
      unavailableBody: '首次使用清单暂时没刷新成功。',
      partialFailureBody: '部分状态暂时没刷新成功，已避免把未知状态计成未完成。',
      retry: '重试',
      refreshing: '刷新中…',
      title: '接下来可以探索',
      remainingAria: (remaining) => `接下来可以探索（待完成 ${remaining} 项）`,
      remainingCount: (remaining, total) => `${remaining} / ${total} 待完成`,
      errorFallback: '状态服务暂时不可用，请稍后重试。',
      items: {
        personalization: { title: '告诉我们怎么称呼你', reason: '消息行就不会再把你显示成默认的「你」。' },
        'web-search': { title: '开通 Tavily 联网搜索', reason: '让你能直接在 Maka 里发一条搜索查询，看到真实结果。' },
        'plan-reminder': { title: '建一条本地计划提醒', reason: '能本地保存一条到点提醒，全程留在本机，不需要外部服务。', unknownReason: '计划提醒状态暂时没刷新成功，打开计划页可查看。' },
        'daily-review': { title: '看看每日回顾', reason: '聚合今天的对话、token 使用、Top 模型与工具。' },
        'workspace-instructions': { title: '创建项目指令文件', reason: '把这个工作区的约定写进 AGENTS.md / CLAUDE.md / GEMINI.md，之后可随时关闭。', unknownReason: '项目指令状态暂时没刷新成功，打开记忆设置可查看。' },
        'local-memory': { title: '写一条本地记忆', reason: '透明的 MEMORY.md，agent 默认看不到；想让它记住偏好就在设置里再开一个开关。' },
        'voice-smoke': { title: '跑一次语音录音自检', reason: '请求麦克风权限、录 2 秒本地样本，确认采集链路通；不上传、不保存、不写记忆。' },
      },
    },
    snapshotErrorFallback: '首次使用状态暂时不可用，请稍后重试。',
  },
  en: {
    hero: {
      needs_connection: {
        eyebrow: 'Welcome to Maka',
        title: 'Go beyond chat. Get real work done.',
        body: 'Run locally, bring your own API key, and keep every step visible and controllable. Choose a provider to add its key in Settings · Models.',
        cta: { label: 'Open Settings · Models', settingsSection: 'models' },
      },
      needs_default_connection: {
        eyebrow: 'Choose a default model connection',
        title: 'Choose a connection as the default.',
        body: 'At least one model connection is configured, but none is the default. Choose one in Settings · Models before starting a conversation.',
        cta: { label: 'Open Settings · Models', settingsSection: 'models' },
      },
      needs_connection_credentials: {
        eyebrow: 'Add credentials',
        title: 'This connection still needs an API key.',
        body: 'The default connection has no usable credentials. Open it in Settings · Models and add its API key before starting a conversation.',
        cta: { label: 'Open Settings · Models', settingsSection: 'models' },
      },
      needs_default_model: {
        eyebrow: 'Choose a default model',
        title: 'This connection has no default model.',
        body: 'The connection is ready, but it has no model selected for conversations. Choose one in Settings · Models.',
        cta: { label: 'Open Settings · Models', settingsSection: 'models' },
      },
      ready_empty: {
        eyebrow: 'READY · Start a conversation',
        title: 'Setup is complete — tell Maka what you want to do.',
        body: 'The box below opens a new session with your default model; an empty submit also opens a session so you can type later.',
        cta: { label: 'Start a conversation', settingsSection: 'models' },
        showQuickChat: true,
      },
      blocked: {
        eyebrow: 'Restore a model connection',
        title: 'No model connection is currently verified.',
        body: 'Open Settings · Account to inspect each connection, then retest or sign in again before starting a conversation.',
        cta: { label: 'Open Settings · Account', settingsSection: 'account' },
        tone: 'destructive',
      },
    },
    setupSteps: {
      needs_connection: [
        { label: 'Choose an AI provider', detail: 'Start with Claude, OpenAI, GLM, local Ollama, or another connection.', state: 'active' },
        { label: 'Add authentication', detail: 'Use an API key or supported OAuth login. Credentials are not written to chat history.', state: 'pending' },
        { label: 'Test and set default', detail: 'Load models, pass the connection test, then return for your first conversation.', state: 'pending' },
      ],
      needs_default_connection: [
        { label: 'Connection available', detail: 'At least one real model connection passed its basic checks.', state: 'done' },
        { label: 'Set as default', detail: 'Choose the connection new sessions use by default.', state: 'active' },
        { label: 'Start a conversation', detail: 'Once saved, this screen switches to Quick Chat.', state: 'pending' },
      ],
      needs_connection_credentials: [
        { label: 'Connection selected', detail: 'The default connection is known; only authentication remains.', state: 'done' },
        { label: 'Add authentication', detail: 'Enter an API key or finish the matching account login.', state: 'active' },
        { label: 'Test and choose a model', detail: 'After the test passes, choose a model that can handle chat.', state: 'pending' },
      ],
      needs_default_model: [
        { label: 'Authentication ready', detail: 'The provider is reachable; the next step is model selection.', state: 'done' },
        { label: 'Choose a chat model', detail: 'Select a conversation-capable model from the live model list.', state: 'active' },
        { label: 'Refresh status', detail: 'Save, return here, and Maka will switch to Quick Chat.', state: 'pending' },
      ],
      blocked: [
        { label: 'Connection tests failed', detail: 'None of the configured connections can send reliably yet.', state: 'warning' },
        { label: 'Fix authentication or network', detail: 'Sign in again, update the key, or check the proxy and provider status.', state: 'active' },
        { label: 'Test again', detail: 'Continue to the first conversation after a test passes.', state: 'pending' },
      ],
    },
    setupProgressLabel: 'AI setup progress',
    setupStatus: { done: 'Completed', active: 'Current step', pending: 'Pending', warning: 'Needs attention' },
    needsConnection: {
      subtitle: 'Local runtime · Your own key · Every step visible and controllable',
      pickLabel: 'Choose your AI',
      pickHint: 'Choose one to open Settings and add its key',
      browseProviders: 'Browse all providers',
    },
    refresh: {
      pending: 'Refreshing…',
      connection: 'Already set it? Refresh status',
      credentials: 'Already added it? Refresh status',
      model: 'Already selected one? Refresh status',
      blocked: 'Already fixed it? Refresh status',
    },
    connectionLabel: 'Connection',
    skip: 'Skip and explore',
    skipping: 'Skipping…',
    ready: {
      ariaLabel: 'Start a conversation',
      eyebrow: 'READY · Start a conversation',
      headline: 'What should Maka help with today?',
      intro: 'The box below opens a new session with your default model; an empty submit also opens a session so you can type later.',
      quickChatPlaceholder: 'Message Maka…',
      quickChatAria: 'Quick Chat input',
      quickChatExample: "Example: walk me through this project's directory layout and where the entry point lives.",
      submitIdleLabel: 'Start chat',
      submitPendingLabel: 'Creating…',
      importFolderPending: 'Importing folder listing…',
      importFilesPending: 'Importing file contents…',
      dropFiles: 'Drop to import file contents',
      deepResearchMode: 'Deep research · Read-only analysis',
      suggestionsLabel: 'Try one of these tasks',
    },
    suggestions: {
      'workspace-map': {
        label: 'Read this project',
        mode: 'deep_research',
        prompt: 'Enter deep research mode and inspect this project read-only. Find the entry points, core modules, and tests, then give me a short list of where to start for further development. Do not modify files.',
      },
      'deep-research': {
        label: 'Research a project deeply',
        mode: 'deep_research',
        prompt: 'Enter deep research mode and analyze the current project read-only. Build an architecture map from directories, configuration, entry files, tests, and key modules, then list concrete improvements. Do not modify files. Report borrow / diverge / risk / gate.',
      },
      'file-organize': {
        label: 'Organize a folder',
        prompt: 'Help organize files in the current workspace. First list the file types and a proposed directory structure. Do not move or delete anything until I confirm.',
      },
      'web-research': {
        label: 'Research a topic online',
        prompt: 'Help me research a topic online. First ask for the topic, then use the configured web search to gather sources and report key findings plus anything that still needs verification.',
      },
    },
    checklist: {
      refreshFailedTitle: 'Could not refresh the first-run checklist',
      unavailableLabel: 'Next steps are temporarily unavailable',
      unavailableBody: 'The first-run checklist could not be refreshed.',
      partialFailureBody: 'Some status checks failed. Unknown states were not counted as incomplete.',
      retry: 'Retry',
      refreshing: 'Refreshing…',
      title: 'Explore next',
      remainingAria: (remaining) => `Explore next (${remaining} remaining)`,
      remainingCount: (remaining, total) => `${remaining} / ${total} remaining`,
      errorFallback: 'The status service is temporarily unavailable. Try again later.',
      items: {
        personalization: { title: 'Tell us what to call you', reason: 'Message rows will use your name instead of the default “You”.' },
        'web-search': { title: 'Enable Tavily web search', reason: 'Send a search query in Maka and see real results.' },
        'plan-reminder': { title: 'Create a local plan reminder', reason: 'Save a scheduled reminder entirely on this device with no external service.', unknownReason: 'Plan reminder status could not be refreshed. Open Plans to inspect it.' },
        'daily-review': { title: 'View Daily Review', reason: "Summarize today's conversations, token use, top models, and tools." },
        'workspace-instructions': { title: 'Create a project instruction file', reason: 'Write workspace conventions to AGENTS.md, CLAUDE.md, or GEMINI.md and disable them at any time.', unknownReason: 'Project instruction status could not be refreshed. Open Memory settings to inspect it.' },
        'local-memory': { title: 'Write a local memory', reason: 'MEMORY.md is transparent and hidden from the agent by default; enable agent access in Settings when wanted.' },
        'voice-smoke': { title: 'Run a voice recording self-check', reason: 'Request microphone access and record a two-second local sample. Nothing is uploaded, saved, or written to memory.' },
      },
    },
    snapshotErrorFallback: 'First-run status is temporarily unavailable. Try again later.',
  },
};

export function getOnboardingCopy(locale: UiLocale): OnboardingCatalog {
  return ONBOARDING_COPY_BY_LOCALE[locale];
}
