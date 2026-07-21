import type {
  BundledSkillTemplateSource,
  SkillDiscoveryOrigin,
  SkillInspectionEntry,
  SkillOperationalStatus,
} from '@maka/runtime';
import { parseSkillFrontMatter } from '@maka/runtime';

export type SkillManagementFilter = 'all' | 'usable' | 'attention' | 'unavailable';

export interface SkillTemplateManagementEntry {
  id: string;
  name: string;
  description: string;
  declaredTools: string[];
  requiredTools: string[];
  requiredCapabilities: string[];
  activationState: 'available' | 'active' | 'attention';
}

export const SKILL_MANAGEMENT_FILTERS: readonly SkillManagementFilter[] = [
  'all',
  'usable',
  'attention',
  'unavailable',
];

const FILTER_LABELS: Record<SkillManagementFilter, string> = {
  all: '全部',
  usable: '可用',
  attention: '需处理',
  unavailable: '当前不可用',
};

const STATUS_LABELS: Record<SkillOperationalStatus, string> = {
  eligible: '可使用',
  invalid: '配置无效',
  state_error: '状态异常',
  shadowed: '已被覆盖',
  disabled: '已停用',
  host_incompatible: '当前环境不可用',
};

const ORIGIN_LABELS: Record<SkillDiscoveryOrigin, string> = {
  project_maka: '项目 · Maka',
  project_agents: '项目 · 通用',
  workspace: 'Maka 工作区',
  user_maka: '用户 · Maka',
  user_agents: '用户 · 通用',
};

const ORIGIN_ORDER: Record<SkillDiscoveryOrigin, number> = {
  project_maka: 0,
  project_agents: 1,
  workspace: 2,
  user_maka: 3,
  user_agents: 4,
};

/** Strip terminal controls and bidi/zero-width formatting from local metadata. */
export function sanitizeSkillTerminalText(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function skillManagementFilterLabel(filter: SkillManagementFilter): string {
  return FILTER_LABELS[filter];
}

export function skillManagementStatusLabel(status: SkillOperationalStatus): string {
  return STATUS_LABELS[status];
}

export function skillManagementOriginLabel(origin: SkillDiscoveryOrigin): string {
  return ORIGIN_LABELS[origin];
}

export function skillManagementScopeLabel(origin: SkillDiscoveryOrigin): string {
  if (origin === 'project_maka' || origin === 'project_agents') return '项目级 Skill';
  if (origin === 'workspace') return 'Maka 工作区 Skill';
  return '用户级 Skill';
}

export function canToggleSkillManagementEntry(entry: SkillInspectionEntry): boolean {
  if (!entry.effective || entry.metadataStatus === 'invalid') return false;
  if (entry.operationalStatus === 'state_error' || entry.operationalStatus === 'shadowed') {
    return false;
  }
  return !entry.issues.some(
    (issue) => issue.code === 'blocked_path' || issue.code === 'unreadable_skill',
  );
}

export function matchesSkillManagementFilter(
  entry: SkillInspectionEntry,
  filter: SkillManagementFilter,
): boolean {
  if (filter === 'all') return true;
  if (filter === 'usable') return entry.operationalStatus === 'eligible';
  if (filter === 'attention') {
    return entry.operationalStatus === 'invalid' || entry.operationalStatus === 'state_error';
  }
  return (
    entry.operationalStatus === 'disabled' ||
    entry.operationalStatus === 'shadowed' ||
    entry.operationalStatus === 'host_incompatible'
  );
}

export function filterSkillManagementEntries(
  entries: readonly SkillInspectionEntry[],
  filter: SkillManagementFilter,
  rawQuery: string,
): SkillInspectionEntry[] {
  const query = sanitizeSkillTerminalText(rawQuery).toLowerCase();
  return entries
    .filter((entry) => {
      if (!matchesSkillManagementFilter(entry, filter)) return false;
      if (!query) return true;
      return [entry.id, entry.name, entry.description, ORIGIN_LABELS[entry.discoveryOrigin]].some(
        (value) => sanitizeSkillTerminalText(value).toLowerCase().includes(query),
      );
    })
    .sort((left, right) => {
      const origin = ORIGIN_ORDER[left.discoveryOrigin] - ORIGIN_ORDER[right.discoveryOrigin];
      if (origin !== 0) return origin;
      return left.name.localeCompare(right.name);
    });
}

export function formatSkillDiagnostic(
  entry: SkillInspectionEntry,
  entries: readonly SkillInspectionEntry[],
): string {
  const shadowedBy = entry.shadowedBy
    ? entries.find((candidate) => candidate.entryKey === entry.shadowedBy)
    : undefined;
  const issues =
    entry.issues.length > 0
      ? entry.issues
          .map((issue) => {
            const field = issue.field ? `${sanitizeSkillTerminalText(issue.field)}: ` : '';
            return `  - ${field}${sanitizeSkillTerminalText(issue.message)} (${issue.code})`;
          })
          .join('\n')
      : '  无';
  const requirements = [
    entry.declaredTools.length > 0 ? `声明工具：${entry.declaredTools.join(', ')}` : '',
    entry.requiredTools.length > 0 ? `必需工具：${entry.requiredTools.join(', ')}` : '',
    entry.requiredCapabilities.length > 0
      ? `必需能力：${entry.requiredCapabilities.join(', ')}`
      : '',
    entry.missingRequiredTools.length > 0
      ? `缺少工具：${entry.missingRequiredTools.join(', ')}`
      : '',
    entry.missingRequiredCapabilities.length > 0
      ? `缺少能力：${entry.missingRequiredCapabilities.join(', ')}`
      : '',
  ].filter(Boolean);

  return [
    `Skill 诊断 · ${sanitizeSkillTerminalText(entry.name)} (${sanitizeSkillTerminalText(entry.id)})`,
    `状态：${STATUS_LABELS[entry.operationalStatus]}`,
    `来源：${ORIGIN_LABELS[entry.discoveryOrigin]}`,
    `路径：${sanitizeSkillTerminalText(entry.path)}`,
    `当前生效：${entry.effective ? '是' : '否'}`,
    shadowedBy
      ? `实际生效项：${sanitizeSkillTerminalText(shadowedBy.name)} (${ORIGIN_LABELS[shadowedBy.discoveryOrigin]})`
      : '',
    '',
    '诊断问题：',
    issues,
    '',
    '工具与能力要求：',
    ...(requirements.length > 0 ? requirements.map((line) => `  ${line}`) : ['  无']),
    '声明工具仅表示请求，不代表已经获得权限。',
  ]
    .filter((line, index, lines) => line !== '' || (index > 0 && lines[index - 1] !== ''))
    .join('\n');
}

export function buildSkillTemplateManagementEntries(
  templates: readonly BundledSkillTemplateSource[],
  discovered: readonly SkillInspectionEntry[],
): SkillTemplateManagementEntry[] {
  const workspaceById = new Map(
    discovered
      .filter((entry) => entry.discoveryOrigin === 'workspace')
      .map((entry) => [entry.id, entry]),
  );
  return templates
    .map((template) => {
      const metadata = parseSkillFrontMatter(template.body);
      const workspaceEntry = workspaceById.get(template.id);
      const activationState: SkillTemplateManagementEntry['activationState'] = !workspaceEntry
        ? 'available'
        : workspaceEntry.operationalStatus === 'eligible' &&
            workspaceEntry.metadataStatus !== 'invalid'
          ? 'active'
          : 'attention';
      return {
        id: template.id,
        name: metadata.name ?? template.id,
        description: metadata.description ?? '',
        declaredTools: metadata.allowedTools,
        requiredTools: metadata.requiredTools,
        requiredCapabilities: metadata.requiredCapabilities,
        activationState,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function filterSkillTemplateManagementEntries(
  entries: readonly SkillTemplateManagementEntry[],
  rawQuery: string,
): SkillTemplateManagementEntry[] {
  const query = sanitizeSkillTerminalText(rawQuery).toLowerCase();
  const available = entries.filter((entry) => entry.activationState === 'available');
  if (!query) return available;
  return available.filter((entry) =>
    [entry.id, entry.name, entry.description].some((value) =>
      sanitizeSkillTerminalText(value).toLowerCase().includes(query),
    ),
  );
}

export function formatSkillTemplateReview(entry: SkillTemplateManagementEntry): string {
  const values = (items: readonly string[]) =>
    items.length > 0 ? items.map(sanitizeSkillTerminalText).join(', ') : '无';
  return [
    `模板详情 · ${sanitizeSkillTerminalText(entry.name)} (${sanitizeSkillTerminalText(entry.id)})`,
    `目标位置：skills/${sanitizeSkillTerminalText(entry.id)}`,
    `声明工具：${values(entry.declaredTools)}`,
    `必需工具：${values(entry.requiredTools)}`,
    `必需能力：${values(entry.requiredCapabilities)}`,
    '',
    '启用后会创建 Maka 全局工作区副本，对所有项目生效；项目级同 id Skill 仍可覆盖它。',
    '此操作不会授予工具权限，仍受当前会话权限策略约束。',
    '如果目标文件已经存在，Maka 会停止操作，不会覆盖已有文件。',
  ].join('\n');
}
