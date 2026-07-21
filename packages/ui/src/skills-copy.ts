import type { UiCatalog, UiLocale } from '@maka/core';
import type { ManagedSkillCategory, SkillEntry } from './module-panel-types.js';

type ManagedUpdateStatus = NonNullable<SkillEntry['managedUpdateStatus']>;

export interface SkillsCopy {
  categories: Record<ManagedSkillCategory, string>;
  tabs: { ariaLabel: string; builtin: string; installed: string };
  activation: {
    action: (name: string) => string;
    enable: string;
    activeTitle: string;
    active: string;
    attention: string;
    available: string;
    scopeHelp: string;
    review: string;
    details: string;
    confirm: string;
    confirmTitle: string;
    confirmDescription: string;
    cancel: string;
    close: string;
    target: string;
    requestedTools: string;
    requiredTools: string;
    requiredCapabilities: string;
    none: string;
    permissionNotice: string;
    noOverwriteNotice: string;
    activeHelp: string;
    attentionHelp: string;
  };
  builtin: {
    ariaLabel: string;
    title: string;
    emptyTitle: string;
    emptyBody: string;
    noMatchTitle: string;
    noMatchBody: string;
    fallback: string;
  };
  installed: {
    emptySearchTitle: string;
    emptyTitle: string;
    emptySearchBody: string;
    emptyBodyBeforeCode: string;
    emptyBodyAfterCode: string;
    createPending: string;
    createExample: string;
    refreshPending: string;
    refresh: string;
    count: (count: number) => string;
    listAriaLabel: string;
    sectionLabel: string;
    projectSection: string;
    workspaceSection: string;
    userSection: string;
    compatibilityBasis: Record<'session' | 'desktop_default', string>;
    globalScope: string;
    filterHelp: string;
    summary: (skills: number, tools: number) => string;
    filters: {
      ariaLabel: string;
      all: string;
      usable: string;
      attention: string;
      unavailable: string;
    };
  };
  row: {
    hoverWithTools: (id: string, runtime: string, status: string, tools: string) => string;
    hover: (id: string, runtime: string, status: string) => string;
    opening: string;
    updating: string;
    toggling: string;
    reviewing: string;
    useAriaLabel: (name: string) => string;
    use: string;
    openAriaLabel: (name: string) => string;
    openRepairAriaLabel: (name: string) => string;
    openTitle: string;
    openRepairTitle: string;
    disableAriaLabel: (name: string) => string;
    enableAriaLabel: (name: string) => string;
    stateErrorTitle: string;
    enabledTitle: string;
    disabledTitle: string;
    enableGlobalTitle: string;
    disableGlobalTitle: string;
    viewDiff: string;
    viewUpdate: string;
    confirmDeleteAriaLabel: (name: string) => string;
    deleteAriaLabel: (name: string) => string;
    confirmDelete: string;
    delete: string;
  };
  details: {
    action: string;
    title: string;
    status: string;
    source: string;
    path: string;
    effective: string;
    yes: string;
    no: string;
    issues: string;
    requirements: string;
    shadowedBy: string;
    none: string;
    declaredNotice: string;
    close: string;
  };
  review: {
    ariaLabel: string;
    title: string;
    source: (id: string) => string;
    managedSource: string;
    hasBaseline: string;
    missingBaseline: string;
    lineTransition: (current: number, source: number) => string;
    changedLines: (count: number) => string;
    warning: string;
    workspace: string;
    sourceVersion: string;
    cancel: string;
    overwrite: string;
    update: string;
  };
  description: {
    document: string;
    presentation: string;
    spreadsheet: string;
    image: string;
    browser: string;
    macos: string;
    fallback: string;
  };
  status: {
    metadataError: string;
    managed: Record<ManagedUpdateStatus, string>;
    modified: string;
    bundled: string;
    local: string;
    stateError: string;
    enabled: string;
    disabled: string;
    operational: Record<SkillEntry['operationalStatus'], string>;
    origin: Record<SkillEntry['discoveryOrigin'], string>;
    missingTools: (tools: string) => string;
    missingCapabilities: (capabilities: string) => string;
    shadowed: string;
    stateFileError: string;
    blockedPath: string;
    unreadableSkill: string;
    invalidMetadata: (detail: string) => string;
    metadataWarning: (detail: string) => string;
  };
  page: {
    title: string;
    subtitle: string;
    actions: string;
    search: string;
    openFolder: string;
    creating: string;
    createExample: string;
    add: string;
    refreshing: string;
    refresh: string;
  };
}

const SKILLS_COPY = {
  zh: {
    categories: { '内容创作': '内容创作', '数据与AI': '数据与 AI', '设计与UI': '设计与 UI', 'DevOps与部署': 'DevOps 与部署', '文档与写作': '文档与写作', '效率工具': '效率工具', '研究与分析': '研究与分析' },
    tabs: { ariaLabel: '技能视图', builtin: '可启用', installed: '已发现' },
    activation: { action: (name) => `查看 ${name} 详情`, enable: '启用到 Maka', activeTitle: '已启用到 Maka 工作区', active: '已启用', attention: '需要处理', available: '可启用', scopeHelp: '启用后会创建 Maka 全局工作区副本，对所有项目生效；项目级同名 Skill 仍可覆盖它。', review: '模板详情', details: '详情', confirm: '确认启用', confirmTitle: '启用到 Maka？', confirmDescription: 'Maka 将把此模板复制到全局工作区。完成后，它会从“可启用”移至“已发现”。', cancel: '取消', close: '关闭', target: '目标位置', requestedTools: '声明工具', requiredTools: '必需工具', requiredCapabilities: '必需能力', none: '无', permissionNotice: '此操作不会授予任何工具权限；实际权限仍由当前会话策略决定。', noOverwriteNotice: '如果目标文件已经存在，Maka 会停止操作，不会覆盖已有文件。', activeHelp: '该模板已经在 Maka 工作区中存在。', attentionHelp: 'Maka 工作区副本存在配置或状态问题，请到“已发现”查看诊断。' },
    builtin: { ariaLabel: '可启用技能', title: '随应用提供的模板', emptyTitle: '暂无可启用技能', emptyBody: '随应用提供的 Skill 模板会出现在这里。', noMatchTitle: '没有匹配的模板', noMatchBody: '换一个关键词，或清空搜索查看全部模板。', fallback: '随 Maka 提供的 Skill 模板。' },
    installed: { emptySearchTitle: '没有匹配的 Skill', emptyTitle: '尚未发现 Skill', emptySearchBody: '换一个关键词、清空搜索或切换状态筛选。', emptyBodyBeforeCode: '把一个含', emptyBodyAfterCode: '的文件夹放到支持的 Skill 目录下，刷新后会出现在这里。', createPending: '创建中…', createExample: '创建示例技能', refreshPending: '刷新中…', refresh: '刷新技能', count: (count) => `${count} 个`, listAriaLabel: '技能列表', sectionLabel: '已发现技能', projectSection: '项目级 Skill', workspaceSection: 'Maka 工作区 Skill', userSection: '用户级 Skill', compatibilityBasis: { session: '诊断依据：当前会话能力', desktop_default: '诊断依据：Desktop 默认能力（尚未选择会话）' }, globalScope: '启停按 Skill ID 全局生效，影响 Maka 的所有项目。正在运行的任务不受影响。', filterHelp: '“需处理”表示元数据或状态文件异常；“当前不可用”表示已停用、被覆盖或当前环境缺少依赖。', summary: (skills, tools) => `${skills} 个 Skill · ${tools} 类工具`, filters: { ariaLabel: 'Skill 状态筛选', all: '全部', usable: '可用', attention: '需处理', unavailable: '当前不可用' } },
    row: { hoverWithTools: (id, runtime, status, tools) => `技能：${id}\n\n运行状态：${runtime}\n来源状态：${status}\n声明工具：${tools}\n权限仍按当前会话策略判断；这里不是授权。`, hover: (id, runtime, status) => `技能：${id}\n\n运行状态：${runtime}\n来源状态：${status}`, opening: '打开中…', updating: '更新中…', toggling: '切换中…', reviewing: '审查中…', useAriaLabel: (name) => `在对话中使用 ${name}`, use: '使用', openAriaLabel: (name) => `查看 ${name} 的 SKILL.md`, openRepairAriaLabel: (name) => `打开并修复 ${name}`, openTitle: '查看 SKILL.md', openRepairTitle: '打开相关文件修复', disableAriaLabel: (name) => `全局停用 ${name}`, enableAriaLabel: (name) => `全局启用 ${name}`, stateErrorTitle: 'Maka 全局 Skill 状态文件异常', enabledTitle: 'Maka 的所有项目都可以使用此技能', disabledTitle: 'Maka 的所有项目都不会看到或加载此技能', enableGlobalTitle: '从下一次 Skill 扫描起，对所有项目启用', disableGlobalTitle: '从下一次 Skill 扫描起，对所有项目停用', viewDiff: '查看差异', viewUpdate: '查看更新', confirmDeleteAriaLabel: (name) => `确认删除 ${name}`, deleteAriaLabel: (name) => `删除 ${name}`, confirmDelete: '确认删除', delete: '删除' },
    details: { action: '查看详情', title: 'Skill 诊断', status: '当前状态', source: '来源', path: '路径', effective: '当前生效', yes: '是', no: '否', issues: '诊断问题', requirements: '工具与能力要求', shadowedBy: '实际生效项', none: '无', declaredNotice: '声明工具仅表示请求，不代表已经获得权限。', close: '关闭' },
    review: { ariaLabel: 'Skill 更新审查', title: '更新审查', source: (id) => `来源 ${id}`, managedSource: '受管理来源', hasBaseline: '已有基线', missingBaseline: '缺少基线', lineTransition: (current, source) => `${current} → ${source} 行`, changedLines: (count) => `${count} 行不同`, warning: '工作区副本已有本地修改。继续更新会用来源库版本覆盖当前 SKILL.md。', workspace: '当前工作区', sourceVersion: '来源库版本', cancel: '取消', overwrite: '覆盖本地修改', update: '更新到来源版本' },
    description: { document: '创建、编辑、检查文档内容。', presentation: '创建、编辑、检查演示文稿。', spreadsheet: '创建、编辑、分析表格数据。', image: '生成或编辑图片素材。', browser: '打开、检查、操作网页界面。', macos: '辅助构建和调试 macOS 应用。', fallback: '打开技能文件查看适用场景。' },
    status: { metadataError: '元数据异常', managed: { source_missing: '来源缺失', update_available: '可更新', local_modified: '本地已修改', metadata_error: '元数据异常', up_to_date: '受管理', not_managed: '受管理' }, modified: '已修改', bundled: '内置', local: '本地', stateError: '状态异常', enabled: '已启用', disabled: '已停用', operational: { invalid: '配置无效', shadowed: '已被覆盖', state_error: '状态异常', disabled: '已停用', host_incompatible: '当前环境不可用', eligible: '可使用' }, origin: { project_maka: '项目 · Maka', project_agents: '项目 · 通用', workspace: '工作区', user_maka: '用户 · Maka', user_agents: '用户 · 通用' }, missingTools: (tools) => `缺少必需工具：${tools}`, missingCapabilities: (capabilities) => `缺少能力：${capabilities}`, shadowed: '同名 id 已由更高优先级来源提供。', stateFileError: '当前工作区的 Skill 状态文件无法读取。', blockedPath: 'Skill 路径已被安全策略阻止。', unreadableSkill: '无法安全读取 SKILL.md。', invalidMetadata: (detail) => `Skill 元数据无效（${detail}）。`, metadataWarning: (detail) => `Skill 元数据需要注意（${detail}）。` },
    page: { title: '技能', subtitle: '启用模板，并诊断 Maka 所有项目中 Skill 的来源、覆盖关系与可用性。', actions: '技能操作', search: '搜索技能', openFolder: '打开目录', creating: '创建中…', createExample: '创建示例', add: '添加', refreshing: '刷新中…', refresh: '刷新' },
  },
  en: {
    categories: { '内容创作': 'Content creation', '数据与AI': 'Data & AI', '设计与UI': 'Design & UI', 'DevOps与部署': 'DevOps & deployment', '文档与写作': 'Documents & writing', '效率工具': 'Productivity', '研究与分析': 'Research & analysis' },
    tabs: { ariaLabel: 'Skill views', builtin: 'Available', installed: 'Discovered' },
    activation: { action: (name) => `View ${name} details`, enable: 'Enable in Maka', activeTitle: 'Enabled in the Maka workspace', active: 'Enabled', attention: 'Needs attention', available: 'Available', scopeHelp: 'Enabling creates a copy in the global Maka workspace for every project. A project Skill with the same id can still override it.', review: 'Template details', details: 'Details', confirm: 'Confirm enable', confirmTitle: 'Enable in Maka?', confirmDescription: 'Maka will copy this template to the global workspace. It will then move from Available to Discovered.', cancel: 'Cancel', close: 'Close', target: 'Target', requestedTools: 'Declared tools', requiredTools: 'Required tools', requiredCapabilities: 'Required capabilities', none: 'None', permissionNotice: 'This action grants no tool permissions. Actual permissions remain controlled by the current session policy.', noOverwriteNotice: 'If the target already exists, Maka stops without overwriting any file.', activeHelp: 'This template already exists in the Maka workspace.', attentionHelp: 'The Maka workspace copy has a configuration or state problem. See Discovered for diagnostics.' },
    builtin: { ariaLabel: 'Available Skills', title: 'Templates included with the app', emptyTitle: 'No available Skills', emptyBody: 'Skill templates included with the app appear here.', noMatchTitle: 'No matching templates', noMatchBody: 'Try another keyword or clear search to see every template.', fallback: 'Skill template included with Maka.' },
    installed: { emptySearchTitle: 'No matching Skills', emptyTitle: 'No Skills discovered', emptySearchBody: 'Try another keyword, clear search, or change the status filter.', emptyBodyBeforeCode: 'Place a folder containing', emptyBodyAfterCode: 'in a supported Skill directory, then refresh to show it here.', createPending: 'Creating…', createExample: 'Create example skill', refreshPending: 'Refreshing…', refresh: 'Refresh skills', count: (count) => `${count}`, listAriaLabel: 'Skill list', sectionLabel: 'Discovered skills', projectSection: 'Project Skills', workspaceSection: 'Maka workspace Skills', userSection: 'User Skills', compatibilityBasis: { session: 'Diagnostic basis: current session capabilities', desktop_default: 'Diagnostic basis: Desktop defaults (no session selected)' }, globalScope: 'Enable and disable apply globally by Skill ID across every Maka project. Running turns are unaffected.', filterHelp: 'Needs attention means invalid metadata or state; Unavailable means disabled, shadowed, or incompatible with this environment.', summary: (skills, tools) => `${skills} ${skills === 1 ? 'Skill' : 'Skills'} · ${tools} tool ${tools === 1 ? 'type' : 'types'}`, filters: { ariaLabel: 'Skill status filters', all: 'All', usable: 'Usable', attention: 'Needs attention', unavailable: 'Unavailable here' } },
    row: { hoverWithTools: (id, runtime, status, tools) => `Skill: ${id}\n\nRuntime status: ${runtime}\nSource status: ${status}\nDeclared tools: ${tools}\nPermissions still follow the current session policy; this is not authorization.`, hover: (id, runtime, status) => `Skill: ${id}\n\nRuntime status: ${runtime}\nSource status: ${status}`, opening: 'Opening…', updating: 'Updating…', toggling: 'Switching…', reviewing: 'Reviewing…', useAriaLabel: (name) => `Use ${name} in chat`, use: 'Use', openAriaLabel: (name) => `View SKILL.md for ${name}`, openRepairAriaLabel: (name) => `Open the relevant file to repair ${name}`, openTitle: 'View SKILL.md', openRepairTitle: 'Open the relevant file to repair', disableAriaLabel: (name) => `Disable ${name} globally`, enableAriaLabel: (name) => `Enable ${name} globally`, stateErrorTitle: 'The global Maka Skill state file is invalid', enabledTitle: 'Every Maka project can use this Skill', disabledTitle: 'No Maka project will see or load this Skill', enableGlobalTitle: 'Enable for all projects on the next Skill scan', disableGlobalTitle: 'Disable for all projects on the next Skill scan', viewDiff: 'View diff', viewUpdate: 'View update', confirmDeleteAriaLabel: (name) => `Confirm deletion of ${name}`, deleteAriaLabel: (name) => `Delete ${name}`, confirmDelete: 'Confirm delete', delete: 'Delete' },
    details: { action: 'View details', title: 'Skill diagnostics', status: 'Current status', source: 'Source', path: 'Path', effective: 'Effective', yes: 'Yes', no: 'No', issues: 'Diagnostic issues', requirements: 'Tool and capability requirements', shadowedBy: 'Effective entry', none: 'None', declaredNotice: 'Declared tools are requests, not granted permissions.', close: 'Close' },
    review: { ariaLabel: 'Skill update review', title: 'Update review', source: (id) => `Source ${id}`, managedSource: 'Managed source', hasBaseline: 'Baseline available', missingBaseline: 'No baseline', lineTransition: (current, source) => `${current} → ${source} lines`, changedLines: (count) => `${count} ${count === 1 ? 'line differs' : 'lines differ'}`, warning: 'The workspace copy has local changes. Continuing will replace the current SKILL.md with the source version.', workspace: 'Current workspace', sourceVersion: 'Source version', cancel: 'Cancel', overwrite: 'Overwrite local changes', update: 'Update to source version' },
    description: { document: 'Create, edit, and inspect documents.', presentation: 'Create, edit, and inspect presentations.', spreadsheet: 'Create, edit, and analyze spreadsheet data.', image: 'Generate or edit images.', browser: 'Open, inspect, and operate web interfaces.', macos: 'Build and debug macOS apps.', fallback: 'Open the skill file to see when to use it.' },
    status: { metadataError: 'Metadata error', managed: { source_missing: 'Source missing', update_available: 'Update available', local_modified: 'Locally modified', metadata_error: 'Metadata error', up_to_date: 'Managed', not_managed: 'Managed' }, modified: 'Modified', bundled: 'Built in', local: 'Local', stateError: 'State error', enabled: 'Enabled', disabled: 'Disabled', operational: { invalid: 'Invalid config', shadowed: 'Shadowed', state_error: 'State error', disabled: 'Disabled', host_incompatible: 'Unavailable here', eligible: 'Available' }, origin: { project_maka: 'Project · Maka', project_agents: 'Project · Shared', workspace: 'Workspace', user_maka: 'User · Maka', user_agents: 'User · Shared' }, missingTools: (tools) => `Missing required tools: ${tools}`, missingCapabilities: (capabilities) => `Missing capabilities: ${capabilities}`, shadowed: 'A higher-precedence source already provides this id.', stateFileError: 'The workspace Skill state file could not be read.', blockedPath: 'The Skill path was blocked by the safety policy.', unreadableSkill: 'SKILL.md could not be read safely.', invalidMetadata: (detail) => `Invalid Skill metadata (${detail}).`, metadataWarning: (detail) => `Skill metadata needs attention (${detail}).` },
    page: { title: 'Skills', subtitle: 'Enable templates and diagnose Skill sources, precedence, and availability across every Maka project.', actions: 'Skill actions', search: 'Search skills', openFolder: 'Open folder', creating: 'Creating…', createExample: 'Create example', add: 'Add', refreshing: 'Refreshing…', refresh: 'Refresh' },
  },
} satisfies UiCatalog<SkillsCopy>;

export function getSkillsCopy(locale: UiLocale): SkillsCopy {
  return SKILLS_COPY[locale];
}
