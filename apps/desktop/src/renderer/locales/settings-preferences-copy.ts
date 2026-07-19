import type {
  ProviderAuthAction,
  ProviderAuthState,
  ThemePalette,
  ThemePreference,
  UiCatalog,
  UiLocale,
  UiLocalePreference,
} from '@maka/core';

type OptionCopy = { label: string; help: string };
type AuthActionCopy = { label: string; detail: string };

export type SettingsPreferencesCopy = {
  personalization: {
    saveFailed: string;
    displayName: string;
    displayNameHelp: string;
    displayNamePlaceholder: string;
    interfaceLanguage: string;
    interfaceLanguageHelp: string;
    localeOptions: ReadonlyArray<readonly [UiLocalePreference, string]>;
    assistantTone: string;
    assistantToneHelp: string;
    assistantTonePlaceholder: string;
  };
  appearance: {
    saveFailed: string;
    theme: string;
    palette: string;
    themeOptions: Record<ThemePreference, OptionCopy>;
    paletteLabels: Record<ThemePalette, string>;
    paletteHelp: Record<ThemePalette, string>;
    paletteGroups: { editor: string; product: string };
    persistenceHelp: string;
  };
  general: {
    incognito: string;
    incognitoHelp: string;
    enableIncognito: string;
    incognitoFailed: string;
    notifications: string;
    notificationsHelp: string;
    notificationsFailed: string;
    updateFailed: string;
    defaultModel: string;
    defaultModelHelp: string;
    notSet: string;
    saveDefaultModelFailed: string;
    defaultPermission: string;
    defaultPermissionHelp: string;
    saveDefaultPermissionFailed: string;
    proxy: string;
    proxyHelp: string;
    enableProxy: string;
    saveNetworkFailed: string;
    proxyProtocol: string;
    serverAddress: string;
    proxyServerAddress: string;
    port: string;
    proxyPort: string;
    proxyAuth: string;
    proxyAuthHelp: string;
    enableProxyAuth: string;
    username: string;
    proxyUsername: string;
    password: string;
    proxyPassword: string;
    bypassList: string;
    bypassHelp: string;
    autoBypass(count: number): string;
    testing: string;
    testCurrent: string;
    proxyReachable: string;
    proxyTestFailed: string;
    proxyTestError: string;
  };
  account: {
    testCopy: { auth: string; recheck: string };
    credentialReadFailed: string;
    verified: string;
    latency(ms: number | '?', model?: string): string;
    connectionTestFailed: string;
    testError: string;
    refreshFailed: string;
    defaultPermission: string;
    defaultPermissionDetail: string;
    askPermission: string;
    credentialProtection: string;
    credentialProtectionDetail: string;
    enabled: string;
    auditLog: string;
    auditLogDetail: string;
    local: string;
    modelConnections: string;
    credentialProbeNotice: string;
    empty: string;
    connectionList: string;
    summary(total: number, enabled: number): string;
    loadingCredential: string;
    unknownCredential: string;
    loadingCredentialDetail: string;
    unknownCredentialDetail: string;
    credentialStateLoading: string;
    credentialStateLoadingDetail: string;
    credentialStateErrorDetail: string;
    loading: string;
    readFailed: string;
    noDefaultModel: string;
    defaultConnection: string;
    defaultBadge: string;
    accountActions(name: string): string;
    testing: string;
  };
  auth: {
    stateLabels: Record<ProviderAuthState, string>;
    stateTitles: Record<ProviderAuthState, string>;
    stateDetails: Record<ProviderAuthState, string>;
    oauthValidated: string;
    oauthValidatedDetail: string;
    noCredentialTitle: string;
    noCredentialDetail: string;
    localProbe: AuthActionCopy;
    testOauth: AuthActionCopy;
    testCredentials: AuthActionCopy;
    saveSecret: AuthActionCopy;
    probeModels: string;
    fetchModels: string;
    fetchModelsDetail: string;
    signOut: string;
    replaceCredential: string;
    revokeDetail: string;
    loginOauth: AuthActionCopy;
    refreshOauth: AuthActionCopy;
    previewLabels: Record<ProviderAuthAction, string>;
    previewDetail: string;
  };
  about: {
    loadFailed: string;
    loading: string;
    unavailable: string;
    copied: string;
    pasteHint: string;
    copyFailed: string;
    clipboardUnavailable: string;
    devBuild: string;
    packagedBuild: string;
    subtitle: string;
    privacyLabel: string;
    privacyTitle: string;
    privacyPoints: readonly string[];
    runtime: string;
    runtimeDetail: string;
    platform: string;
    platformDetail: string;
    workspace: string;
    workspaceDetail: string;
    storage: string;
    storageDetail: string;
    local: string;
    copying: string;
    copyEnvironment: string;
    copyHelp: string;
  };
  password: {
    copyFailed: string;
    clipboardUnavailable: string;
    copying: string;
    copied: string;
    copy: string;
    hide: string;
    show: string;
  };
};

const SETTINGS_PREFERENCES_COPY_BY_LOCALE = {
  zh: {
    personalization: {
      saveFailed: '保存失败', displayName: '显示名称', displayNameHelp: 'Maka 在聊天里会以这个名字称呼你。留空就用默认的“你”。', displayNamePlaceholder: '例如：JK',
      interfaceLanguage: '界面语言', interfaceLanguageHelp: '选择 Maka 界面的显示语言。切换后立即生效，重启后保持。', localeOptions: [['auto', '跟随系统'], ['zh', '中文'], ['en', 'English']],
      assistantTone: '助手语气偏好', assistantToneHelp: '最多 500 字，只影响回答的语气和风格。权限确认与安全规则不受影响；改动会自动保存。', assistantTonePlaceholder: '例如：技术严谨、偏简洁、不要 emoji。',
    },
    appearance: {
      saveFailed: '保存外观设置失败', theme: '主题', palette: '调色板',
      themeOptions: { light: { label: '浅色', help: '始终使用浅色界面。' }, dark: { label: '深色', help: '始终使用深色界面。' }, auto: { label: '跟随系统', help: '匹配系统当前的浅色或深色偏好。' } },
      paletteLabels: { default: '默认', onedark: 'One Dark', 'catppuccin-mocha': 'Catppuccin Mocha', 'tokyo-night': 'Tokyo Night', nord: 'Nord', coral: '珊瑚', azure: '湖蓝', forest: '森林', dusk: '暮光', sand: '沙金', mono: '极简灰' },
      paletteHelp: { default: 'Maka 品牌蓝强调色', onedark: '编辑器经典深色', 'catppuccin-mocha': '紫调柔和深色', 'tokyo-night': '深蓝主题', nord: '北欧冷色', coral: '暖粉 / 珊瑚强调色', azure: '湖蓝强调色，干净冷静', forest: '深苔绿与暖蜂蜜强调色', dusk: '深紫罗兰与冷调画布', sand: '琥珀沙金与暖奶白', mono: '纯灰阶，无彩色干扰' },
      paletteGroups: { editor: '编辑器主题', product: '产品色调' }, persistenceHelp: '切换会立即生效，并保存在本地外观设置里供下次启动使用。',
    },
    general: {
      incognito: '隐身模式', incognitoHelp: '开启后暂停本地记忆读写、联网搜索和计划提醒触发。', enableIncognito: '启用隐身模式', incognitoFailed: '隐身模式切换失败', notifications: '完成时发送系统通知', notificationsHelp: '窗口不在前台时，在回答完成或出错后发送桌面通知。', notificationsFailed: '通知设置切换失败', updateFailed: '设置未生效，请稍后重试。',
      defaultModel: '默认模型', defaultModelHelp: '新对话默认使用的模型。', notSet: '未设置', saveDefaultModelFailed: '保存默认模型失败', defaultPermission: '默认权限模式', defaultPermissionHelp: '新对话默认使用的权限模式；可在对话内随时切换。', saveDefaultPermissionFailed: '保存默认权限模式失败',
      proxy: '代理服务器', proxyHelp: '为 AI 模型请求配置网络代理', enableProxy: '启用代理服务器', saveNetworkFailed: '保存网络设置失败', proxyProtocol: '代理协议', serverAddress: '服务器地址', proxyServerAddress: '代理服务器地址', port: '端口', proxyPort: '代理端口', proxyAuth: '代理认证', proxyAuthHelp: '需要用户名和密码时开启。', enableProxyAuth: '启用代理认证', username: '用户名', proxyUsername: '代理用户名', password: '密码', proxyPassword: '代理密码', bypassList: '代理白名单', bypassHelp: '这些域名将绕过代理直连，多个用逗号分隔。', autoBypass: (count) => `已自动添加 ${count} 个域名。代理仅作用于 AI 模型请求。`, testing: '测试中…', testCurrent: '测试当前配置', proxyReachable: '代理可达', proxyTestFailed: '代理测试失败', proxyTestError: '代理测试出错',
    },
    account: {
      testCopy: { auth: '鉴权失败，请检查模型密钥、订阅账号登录或凭据配置后重试。', recheck: '连接测试失败，请检查模型连接配置后重试。' }, credentialReadFailed: '读取模型凭据状态失败', verified: '连接已验证', latency: (ms, model) => `延迟 ${ms} ms${model ? ` · ${model}` : ''}`, connectionTestFailed: '连接测试失败', testError: '测试出错', refreshFailed: '刷新模型连接状态失败',
      defaultPermission: '默认权限模式', defaultPermissionDetail: '新会话默认从询问权限开始；可在输入框左下角切换。', askPermission: '询问权限', credentialProtection: '凭据保护', credentialProtectionDetail: '模型密钥保存在本机凭据文件内；订阅令牌使用系统安全存储。', enabled: '启用', auditLog: '审计日志', auditLogDetail: '每个会话都会在本机保留消息、工具调用、权限决策与模式变更记录。', local: '本地', modelConnections: '模型连接', credentialProbeNotice: '模型凭据状态暂时未能刷新，未知状态不会显示成待配置。', empty: '等待添加模型连接。可在“设置 · 模型”添加。', connectionList: '模型连接列表', summary: (total, enabled) => `共 ${total} 个连接 · ${enabled} 已启用。修改凭据或默认模型后需要重新测试。`,
      loadingCredential: '读取凭据状态…', unknownCredential: '凭据状态未知', loadingCredentialDetail: '正在读取本机凭据状态。', unknownCredentialDetail: '暂时无法读取本机凭据状态；请刷新或到模型设置查看。', credentialStateLoading: '凭据状态读取中', credentialStateLoadingDetail: '正在读取本机凭据和账号登录状态。', credentialStateErrorDetail: '读取本机凭据和账号登录状态失败。', loading: '读取中', readFailed: '读取失败', noDefaultModel: '未设默认模型', defaultConnection: '默认连接', defaultBadge: '默认', accountActions: (name) => `${name} 账号操作`, testing: '测试中…',
    },
    auth: {
      stateLabels: { disabled: '已关闭', not_configured: '待配置', configured: '待验证', validated: '凭据已验证', needs_reauth: '需重新授权', error: '测试失败', preview_only: '预览' }, oauthValidated: 'OAuth 已验证',
      stateTitles: { disabled: '连接已关闭', not_configured: '需要配置凭据', configured: '凭据等待验证', validated: '凭据已验证', needs_reauth: '需要重新授权', error: '凭据测试失败', preview_only: '登录能力预览' },
      stateDetails: { disabled: '启用连接后才能使用认证操作。', not_configured: '请在“设置 · 模型”中完成凭据配置。', configured: '凭据已保存；请执行测试以验证凭据和端点。', validated: '只代表凭据和端点验证通过，不代表消息发送、流式响应或中断恢复已经运行可用。', needs_reauth: '授权已失效，请替换凭据后重新测试。', error: '上次测试失败；这里只显示概括后的错误信息。', preview_only: '当前仅展示状态，不会启动远端登录流程。' },
      oauthValidatedDetail: 'OAuth 账号令牌和端点已验证；发送链路需独立检查。', noCredentialTitle: '无需凭据', noCredentialDetail: '本地服务和模型列表可直接探测，不需要保存凭据。',
      localProbe: { label: '探测本地服务', detail: '检查本地服务和默认模型是否可达；这不是凭据测试。' }, testOauth: { label: '测试 OAuth', detail: '只验证账号令牌和端点，不代表发送链路已完成健康检查。' }, testCredentials: { label: '测试凭据', detail: '只验证凭据和端点，不代表发送链路已完成健康检查。' }, saveSecret: { label: '保存密钥', detail: '账号页只展示状态；密钥输入仍在“设置 · 模型”。' }, probeModels: '探测模型', fetchModels: '拉取模型', fetchModelsDetail: '模型列表刷新由“设置 · 模型”的连接编辑器执行。', signOut: '退出登录', replaceCredential: '替换或移除凭据', revokeDetail: '凭据的替换与移除在“设置 · 模型”中执行。', loginOauth: { label: '登录 OAuth', detail: 'OAuth 登录入口位于“设置 · 模型 · OAuth”。' }, refreshOauth: { label: '刷新登录', detail: 'OAuth 账号状态刷新位于“设置 · 模型 · OAuth”。' }, previewLabels: { save_secret: '模型密钥管理', test_credentials: '凭据验证', fetch_models: '模型同步', start_oauth: '订阅账号预览', refresh_oauth: '订阅状态预览', revoke_auth: '订阅管理预览' }, previewDetail: '受控入口当前只展示状态，不会连接登录服务或远端登录流程。',
    },
    about: {
      loadFailed: '载入关于信息失败', loading: '正在加载关于页', unavailable: '无法载入关于信息', copied: '已复制环境信息', pasteHint: '可直接粘贴到问题报告', copyFailed: '复制失败', clipboardUnavailable: '剪贴板不可用或被系统拒绝。', devBuild: '本地开发版', packagedBuild: '正式版', subtitle: '本地优先的 AI 助手 · 桌面端运行环境', privacyLabel: '隐私与安全', privacyTitle: '本地优先 · 隐私默认', privacyPoints: ['所有会话、设置、凭据和 Skill 指令文件都保留在本机工作区。', '模型密钥保存在本机凭据文件内；订阅账号令牌使用系统安全存储。', 'Maka 不发送使用遥测；只在你显式启用时与所选模型供应商通信。', '高风险工具操作需要在对话内明示授权。', '每个会话都会在本机保留消息、工具调用、权限决策与模式变更记录。'], runtime: '运行时', runtimeDetail: '界面层、桌面运行时和本地 Node 版本号。', platform: '平台', platformDetail: '操作系统、版本和 CPU 架构。', workspace: '工作区', workspaceDetail: '会话、设置和凭据全部留在本地这条路径下。', storage: '存储', storageDetail: '会话、设置、使用统计、凭据文件和订阅账号安全存储。', local: '本地', copying: '复制中…', copyEnvironment: '复制环境信息', copyHelp: '复制以上版本与平台信息以便定位问题；内容不包含工作区路径。',
    },
    password: { copyFailed: '复制失败', clipboardUnavailable: '剪贴板不可用或被系统拒绝。', copying: '复制中', copied: '已复制', copy: '复制', hide: '隐藏', show: '显示' },
  },
  en: {
    personalization: {
      saveFailed: 'Could not save', displayName: 'Display name', displayNameHelp: 'Maka uses this name when addressing you. Leave it blank to use “you”.', displayNamePlaceholder: 'For example: JK', interfaceLanguage: 'Interface language', interfaceLanguageHelp: 'Choose the language used by Maka. Changes apply immediately and persist after restart.', localeOptions: [['auto', 'Follow system'], ['zh', '中文'], ['en', 'English']], assistantTone: 'Assistant tone', assistantToneHelp: 'Up to 500 characters. This changes response style only; permission and safety rules still apply. Changes save automatically.', assistantTonePlaceholder: 'For example: technically rigorous, concise, and no emoji.',
    },
    appearance: {
      saveFailed: 'Could not save appearance settings', theme: 'Theme', palette: 'Color palette', themeOptions: { light: { label: 'Light', help: 'Always use the light interface.' }, dark: { label: 'Dark', help: 'Always use the dark interface.' }, auto: { label: 'Follow system', help: 'Match the current system appearance.' } }, paletteLabels: { default: 'Default', onedark: 'One Dark', 'catppuccin-mocha': 'Catppuccin Mocha', 'tokyo-night': 'Tokyo Night', nord: 'Nord', coral: 'Coral', azure: 'Azure', forest: 'Forest', dusk: 'Dusk', sand: 'Sand', mono: 'Monochrome' }, paletteHelp: { default: 'Maka brand-blue accent', onedark: 'Classic dark editor theme', 'catppuccin-mocha': 'Soft purple dark theme', 'tokyo-night': 'Deep-blue editor theme', nord: 'Cool Nordic colors', coral: 'Warm pink and coral accent', azure: 'Clean, calm blue accent', forest: 'Deep moss and warm honey', dusk: 'Deep violet on a cool canvas', sand: 'Amber sand and warm ivory', mono: 'Pure grayscale without color distraction' }, paletteGroups: { editor: 'Editor themes', product: 'Product colors' }, persistenceHelp: 'Changes apply immediately and are saved locally for the next launch.',
    },
    general: {
      incognito: 'Incognito mode', incognitoHelp: 'Pause local memory, web search, and scheduled reminder triggers.', enableIncognito: 'Enable incognito mode', incognitoFailed: 'Could not change incognito mode', notifications: 'Send a system notification when finished', notificationsHelp: 'Notify when a response finishes or fails while the window is in the background.', notificationsFailed: 'Could not change notification settings', updateFailed: 'The setting was not applied. Try again later.', defaultModel: 'Default model', defaultModelHelp: 'Model used by new conversations.', notSet: 'Not set', saveDefaultModelFailed: 'Could not save the default model', defaultPermission: 'Default permission mode', defaultPermissionHelp: 'Initial permission mode for new conversations; it can be changed at any time.', saveDefaultPermissionFailed: 'Could not save the default permission mode', proxy: 'Proxy server', proxyHelp: 'Configure a network proxy for AI model requests', enableProxy: 'Enable proxy server', saveNetworkFailed: 'Could not save network settings', proxyProtocol: 'Proxy protocol', serverAddress: 'Server address', proxyServerAddress: 'Proxy server address', port: 'Port', proxyPort: 'Proxy port', proxyAuth: 'Proxy authentication', proxyAuthHelp: 'Enable this when a username and password are required.', enableProxyAuth: 'Enable proxy authentication', username: 'Username', proxyUsername: 'Proxy username', password: 'Password', proxyPassword: 'Proxy password', bypassList: 'Proxy bypass list', bypassHelp: 'These domains connect directly. Separate multiple domains with commas.', autoBypass: (count) => `${count} ${count === 1 ? 'domain was' : 'domains were'} added automatically. The proxy applies to AI model requests only.`, testing: 'Testing…', testCurrent: 'Test current configuration', proxyReachable: 'Proxy is reachable', proxyTestFailed: 'Proxy test failed', proxyTestError: 'Could not test proxy',
    },
    account: {
      testCopy: { auth: 'Authentication failed. Check the model key, subscription login, or credential configuration.', recheck: 'Connection test failed. Check the model connection configuration.' }, credentialReadFailed: 'Could not read model credential status', verified: 'Connection verified', latency: (ms, model) => `Latency ${ms} ms${model ? ` · ${model}` : ''}`, connectionTestFailed: 'Connection test failed', testError: 'Could not test connection', refreshFailed: 'Could not refresh model connection status', defaultPermission: 'Default permission mode', defaultPermissionDetail: 'New sessions start by asking for permission; the mode can be changed in the composer.', askPermission: 'Ask permission', credentialProtection: 'Credential protection', credentialProtectionDetail: 'Model keys stay in a local credential file; subscription tokens use secure system storage.', enabled: 'Enabled', auditLog: 'Audit log', auditLogDetail: 'Messages, tool calls, permission decisions, and mode changes are kept locally for each session.', local: 'Local', modelConnections: 'Model connections', credentialProbeNotice: 'Credential status could not be refreshed. Unknown states are not shown as needing setup.', empty: 'No model connections yet. Add one in Settings · Models.', connectionList: 'Model connections', summary: (total, enabled) => `${total} ${total === 1 ? 'connection' : 'connections'} · ${enabled} enabled. Test again after changing credentials or the default model.`, loadingCredential: 'Reading credential status…', unknownCredential: 'Credential status unknown', loadingCredentialDetail: 'Reading the local credential status.', unknownCredentialDetail: 'The local credential status is unavailable. Refresh or open Model settings.', credentialStateLoading: 'Reading credential status', credentialStateLoadingDetail: 'Reading local credentials and account login status.', credentialStateErrorDetail: 'Could not read local credentials and account login status.', loading: 'Loading', readFailed: 'Read failed', noDefaultModel: 'No default model', defaultConnection: 'Default connection', defaultBadge: 'Default', accountActions: (name) => `${name} account actions`, testing: 'Testing…',
    },
    auth: {
      stateLabels: { disabled: 'Disabled', not_configured: 'Setup required', configured: 'Ready to verify', validated: 'Credentials verified', needs_reauth: 'Authorization required', error: 'Test failed', preview_only: 'Preview' }, oauthValidated: 'OAuth verified', localProbe: { label: 'Probe local service', detail: 'Check whether the local service and default model are reachable; this is not a credential test.' }, testOauth: { label: 'Test OAuth', detail: 'Validate the account token and endpoint only; this is not a complete send-path health check.' }, testCredentials: { label: 'Test credentials', detail: 'Validate the credentials and endpoint only; this is not a complete send-path health check.' }, saveSecret: { label: 'Save key', detail: 'This page is status-only. Enter keys in Settings · Models.' }, probeModels: 'Probe models', fetchModels: 'Fetch models', fetchModelsDetail: 'Refresh the model list in the connection editor under Settings · Models.', signOut: 'Sign out', replaceCredential: 'Replace or remove credentials', revokeDetail: 'Replace or remove credentials under Settings · Models.', loginOauth: { label: 'Sign in with OAuth', detail: 'Open Settings · Models · OAuth to sign in.' }, refreshOauth: { label: 'Refresh login', detail: 'Refresh OAuth account status under Settings · Models · OAuth.' }, previewLabels: { save_secret: 'Model key management', test_credentials: 'Credential verification', fetch_models: 'Model sync', start_oauth: 'Subscription account preview', refresh_oauth: 'Subscription status preview', revoke_auth: 'Subscription management preview' }, previewDetail: 'This controlled entry shows status only and does not start a remote login flow.',
      stateTitles: { disabled: 'Connection disabled', not_configured: 'Credentials required', configured: 'Credentials awaiting verification', validated: 'Credentials verified', needs_reauth: 'Authorization required', error: 'Credential test failed', preview_only: 'Login capability preview' },
      stateDetails: { disabled: 'Enable the connection to use authentication actions.', not_configured: 'Complete credential setup under Settings · Models.', configured: 'Credentials are saved. Run a test to verify the credentials and endpoint.', validated: 'The credentials and endpoint passed validation. Message sending, streaming, and interruption recovery are verified separately.', needs_reauth: 'Authorization expired. Replace the credentials and test again.', error: 'The latest test failed. Only a summarized error is shown here.', preview_only: 'This status-only preview does not start a remote login flow.' },
      oauthValidatedDetail: 'The OAuth account token and endpoint passed validation. The send path is checked separately.', noCredentialTitle: 'No credentials required', noCredentialDetail: 'The local service and model list can be probed without saved credentials.',
    },
    about: {
      loadFailed: 'Could not load About information', loading: 'Loading About', unavailable: 'About information is unavailable', copied: 'Environment info copied', pasteHint: 'Paste it directly into an issue report', copyFailed: 'Copy failed', clipboardUnavailable: 'The clipboard is unavailable or access was denied.', devBuild: 'Local development build', packagedBuild: 'Release build', subtitle: 'A local-first AI assistant · Desktop runtime', privacyLabel: 'Privacy and security', privacyTitle: 'Local first · Private by default', privacyPoints: ['Conversations, settings, credentials, and Skill instructions stay in the local workspace.', 'Model keys stay in a local credential file; subscription tokens use secure system storage.', 'Maka sends no usage telemetry and contacts a model provider only when you enable it.', 'High-risk tool operations require explicit permission in the conversation.', 'Messages, tool calls, permission decisions, and mode changes are retained locally for each session.'], runtime: 'Runtime', runtimeDetail: 'Interface, desktop runtime, and local Node versions.', platform: 'Platform', platformDetail: 'Operating system, version, and CPU architecture.', workspace: 'Workspace', workspaceDetail: 'Conversations, settings, and credentials stay under this local path.', storage: 'Storage', storageDetail: 'Conversations, settings, usage statistics, credential files, and secure subscription storage.', local: 'Local', copying: 'Copying…', copyEnvironment: 'Copy environment info', copyHelp: 'Copy version and platform details to help diagnose an issue. The workspace path is excluded.',
    },
    password: { copyFailed: 'Copy failed', clipboardUnavailable: 'The clipboard is unavailable or access was denied.', copying: 'Copying', copied: 'Copied', copy: 'Copy', hide: 'Hide', show: 'Show' },
  },
} satisfies UiCatalog<SettingsPreferencesCopy>;

export function getSettingsPreferencesCopy(locale: UiLocale): SettingsPreferencesCopy {
  return SETTINGS_PREFERENCES_COPY_BY_LOCALE[locale];
}
