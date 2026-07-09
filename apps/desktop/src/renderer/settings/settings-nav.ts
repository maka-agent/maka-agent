import { type ComponentType } from 'react';
import {
  Activity,
  BarChart3,
  Bot,
  Brain,
  CalendarDays,
  Cpu,
  Database,
  Info,
  Mic,
  Network,
  Palette,
  Search,
  Settings as SettingsIcon,
  ShieldCheck,
  type LucideProps,
} from '@maka/ui/icons';
import type { SettingsSection } from '@maka/core';
import { safeLocalStorageGet } from '../browser-storage';
import {
  NAV_GROUP_ORDER,
  type SettingsNavGroup,
} from './nav-group-summary';

type SettingsNavItem = {
  id: SettingsSection;
  label: string;
  Icon: ComponentType<LucideProps>;
  enabled: boolean;
  /** Group label rendered as a small uppercase divider above this item. */
  group: SettingsNavGroup;
  /**
   * PR-SETTINGS-PAGE-SUBTITLE-0 (round 4/15, WAWQAQ msg `f7e9d166`):
   * one-line description rendered below the page title (h2). Reference
   * carries this per-tab meta line; maka previously had only the bare
   * label. Helps the user understand "where am I?" at the page top.
   */
  description?: string;
  /**
   * PR-SETTINGS-NAV-REGROUP-0 (WAWQAQ msg `a9ef0d5d`): render a small
   * "Beta" chip next to the nav label. Reference uses this for the
   * 应用快照 / 工作台 items.
   */
  badge?: 'Beta';
};

type AccountSecretProbeStatus = boolean | 'loading' | 'error';
type AccountSecretProbeResult =
  | { slug: string; status: boolean }
  | { slug: string; status: 'error'; message: string };

// `focusRadioValue`, `onSettingsRadioGroupKeyDown`, `radioTabIndex` were
// the manual roving-tabindex / arrow-key handlers for the Theme,
// Palette, and Segmented radiogroups. Theme + Palette migrated to the
// Base UI `RadioGroup`-backed `ChoiceCard` primitive in PR #263;
// Segmented migrated to the Base UI `ToggleGroup`-backed
// `SettingsSegmented` primitive in PR yuejing/settings-segmented-primitive.
// Both primitives now provide the same keyboard contract for free, so
// these helpers are gone. `nextRadioId` still lives in
// `./model-table-keyboard.ts` because the provider detail model
// default picker keeps its hand-rolled radiogroup.

// `SettingsSelect` moved to `packages/ui/src/primitives/settings-select.tsx`
// in PR round-AB-shared-select (yuejing 2026-06-25). The Plan Reminder
// platform select now uses the same primitive, so option shape,
// selected-trigger icon rendering, and chrome contract are one source
// of truth (kenji styles inventory task #128). Imported via `@maka/ui`.

// `SettingsNavGroup` + `NAV_GROUP_ORDER` moved to `nav-group-summary.ts`
// (PR-HEALTH-1) so the H1/H2 group-summary assertions can be pinned with
// node:test without a DOM / React.
export type { SettingsNavGroup };

// PR-SETTINGS-IA-CONSOLIDATE-0 + PR-SETTINGS-REVIEW-0: WAWQAQ msg
// `886f6406` rolled back the 记忆+回顾 merge — the combined page was
// too dense. 记忆 and 每日回顾 are separate nav items again.
// PR-SETTINGS-NAV-REGROUP-0 (WAWQAQ msg `a9ef0d5d`): 5 narrow groups
// → 3 wider groups. 基础→通用, AI+集成→「AI 与集成」, 数据+其他→系统.
// Mirrors reference's tighter grouping (1 big group + a couple small
// ones) instead of 5 categories with only 1-3 items each.
export const SETTINGS_NAV: SettingsNavItem[] = [
  // Group 1: 通用
  { id: 'general', label: '通用', Icon: SettingsIcon, enabled: true, group: '通用',
    description: '隐身、启动、对话默认与网络代理等系统偏好。' },
  { id: 'appearance', label: '外观', Icon: Palette, enabled: true, group: '通用',
    description: '主题与配色。' },
  // Group 2: AI 与集成 — models, usage, memory, daily-review, voice+gateway, bots, search
  { id: 'models', label: '模型', Icon: Cpu, enabled: true, group: 'AI 与集成',
    description: '模型连接、API key 与 OAuth 订阅管理。' },
  { id: 'usage', label: '使用统计', Icon: BarChart3, enabled: true, group: 'AI 与集成',
    description: 'token、模型、工具使用走势与配额追踪。' },
  { id: 'memory', label: '记忆', Icon: Brain, enabled: true, group: 'AI 与集成',
    description: '本地 MEMORY.md、项目指令文件与上下文注入开关。' },
  { id: 'daily-review', label: '每日回顾', Icon: CalendarDays, enabled: true, group: 'AI 与集成',
    description: '每天自动分析本机对话，生成摘要、遗漏提醒和建议。模型按需消耗。' },
  { id: 'voice', label: '语音', Icon: Mic, enabled: true, group: 'AI 与集成',
    description: '语音转写、麦克风权限与本地音频管线设置。' },
  { id: 'open-gateway', label: '开放网关', Icon: Network, enabled: true, group: 'AI 与集成',
    description: 'Maka 开放网关 SSE/HTTP 接入、token 管理与运行时状态。' },
  { id: 'bot-chat', label: '机器人对话', Icon: Bot, enabled: true, group: 'AI 与集成',
    description: 'Telegram / 飞书 / 企业微信等机器人凭据与运行状态。' },
  { id: 'search', label: '联网搜索', Icon: Search, enabled: true, group: 'AI 与集成',
    description: '联网搜索供应商（如 Tavily）凭据与隐私边界。',
    badge: 'Beta' },
  // Group 3: 系统 — data, permissions, health, about
  { id: 'data', label: '数据', Icon: Database, enabled: true, group: '系统',
    description: '本地工作区路径、备份与恢复。' },
  { id: 'permissions', label: '权限与能力', Icon: ShieldCheck, enabled: true, group: '系统',
    description: '系统权限授予状态与 Maka 能力运行时检查。' },
  { id: 'health', label: '健康', Icon: Activity, enabled: true, group: '系统',
    description: '运行时连接、模型探针与本地健康状态。' },
  { id: 'about', label: '关于', Icon: Info, enabled: true, group: '系统',
    description: '版本、运行环境与隐私承诺。' },
];

/** Order-preserving grouping used by the nav renderer. */
export function groupedNav(): Array<{ group: SettingsNavGroup; items: SettingsNavItem[] }> {
  const byGroup = new Map<SettingsNavGroup, SettingsNavItem[]>();
  for (const item of SETTINGS_NAV) {
    if (!byGroup.has(item.group)) byGroup.set(item.group, []);
    byGroup.get(item.group)!.push(item);
  }
  return NAV_GROUP_ORDER.flatMap((group) => {
    const items = byGroup.get(group);
    return items && items.length > 0 ? [{ group, items }] : [];
  });
}

export function readLastSettingsSection(): SettingsSection {
  const value = safeLocalStorageGet('maka-settings-section-v1');
  if (!value) return 'models';
  // PR-VOICE-GATEWAY-SPLIT-0 (WAWQAQ msg `d3ea9a33` 2026-06-26):
  // anyone whose last visit was the now-retired combined 语音与网关
  // page lands on 语音 (the more user-frequent of the two split
  // pages) instead of being silently bounced back to 模型.
  if (value === 'voice-gateway') return 'voice';
  if (SETTINGS_NAV.some((item) => item.id === value)) {
    return value as SettingsSection;
  }
  return 'models';
}

export function navLabel(section: SettingsSection): string {
  return SETTINGS_NAV.find((item) => item.id === section)?.label ?? section;
}
