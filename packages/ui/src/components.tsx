import React, { createContext, forwardRef, memo, useContext, useEffect, useImperativeHandle, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type FocusEvent, type FormEvent, type KeyboardEvent, type MouseEvent, type ReactNode, type RefObject } from 'react';
import {
  AlertOctagon,
  AlertTriangle,
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  Ban,
  BookOpen,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronRight,
  CircleCheckBig,
  Clock,
  Copy,
  Eye,
  FileEdit,
  Flag,
  FolderOpen,
  GitBranch,
  GitMerge,
  Globe,
  HelpCircle,
  Hourglass,
  Info,
  LineChart,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  Mic,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RefreshCcw,
  Repeat,
  Search,
  Settings,
  ShieldAlert,
  Sparkles,
  SquarePen,
  Terminal,
  Trash2,
  Wifi,
  X,
  IconifyIcon,
} from './icons.js';
import { BOT_BRAND } from './bot-brand.js';
import { SettingsSelect, type SettingsSelectOption } from './primitives/settings-select.js';
import { redactSecrets } from './redact.js';
import { DeepResearchEmptyHero, EmptyChatHero } from './chat-empty-hero.js';
import { ChatModelSwitcher, ModelChipStatic, NewChatModelPicker } from './chat-model-switcher.js';
import {
  type ClipboardCopyPhase,
  useClipboardCopyFeedback,
} from './clipboard-feedback.js';
import { Markdown, MakaUriContext } from './markdown.js';
import {
  type UiLocale,
  detectUiLocale,
  getPromptSuggestions,
} from './locale-helpers.js';
import {
  createAbsoluteTimeFormat,
  formatAbsoluteTimestamp,
  formatTurnDuration,
  turnAbortMarkerLabel,
} from './chat-display-helpers.js';
import {
  type ChatModelChoice,
  modelChoiceValue,
} from './chat-model-helpers.js';
import {
  type DailyReviewRange,
  dailyReviewPanelErrorMessage,
  dailyReviewScopeKey,
  formatDailyReviewArchiveGeneratedAt,
  formatDailyReviewArchiveTitle,
  formatDailyReviewMarkdown,
} from './daily-review-helpers.js';
import {
  type ComposerHistoryState,
  appendPromptContextDraft,
  navigateComposerHistory,
  readComposerDraft,
  rememberComposerDraft,
  rememberComposerHistoryEntry,
} from './composer-helpers.js';
import {
  PLAN_REMINDER_EXAMPLE_TEMPLATES,
  type PlanReminderDisplayRow,
  type PlanReminderExampleTemplate,
  comparePlanReminderBySort,
  duplicatePlanReminderTitle,
  formatPlanDeliveryProviderList,
  formatPlanRecurrence,
  formatReminderCountdown,
  formatReminderTime,
  normalizePlanReminderSearchQuery,
  planReminderDisplayRows,
  planReminderEditableRunAt,
  planReminderFormValidationMessage,
  planReminderMatchesSearch,
  planReminderPresetRunAt,
  planReminderRecurrenceValue,
  planReminderRunRangeStart,
  planReminderStatusLabel,
  planReminderTemplateNextRunAt,
  runStatusLabel,
  toPlanReminderDateTimeInputValue,
} from './plan-reminder-helpers.js';
import {
  isMakaUriCandidate,
  isSafeExternalScheme,
  parseMakaUri,
  type MakaUriDest,
} from './maka-uri.js';
import { prepareSmoothStreamText, useSmoothStreamContent } from './smooth-stream.js';
import { OverlayScrollArea } from './overlay-scroll-area.js';
// Self-review: ReactMarkdown / remarkGfm / remarkBreaks / rehypeHighlight
// imports moved to `./markdown.js` (PR-UI-LIB-EXTRACT-6). The orphan
// imports here were leftover from the extract and unused — removed.
import type {
  PermissionMode,
  PermissionRequestEvent,
  PermissionResponse,
  CapabilityAuditReport,
  BotProvider,
  PlanReminder,
  PlanReminderDeliveryTarget,
  PlanReminderRecurrence,
  PlanReminderStatus,
  ProviderType,
  SearchErrorReason,
  SearchRequest,
  SearchResult,
  SessionSummary,
  StoredMessage,
  ToolResultContent,
} from '@maka/core';
import {
  derivePermissionRequestHealth,
  BOT_DELIVERY_PROVIDERS,
  botDisplayLabel,
  deriveCapabilityAuditReport,
  formatPlanReminderDeliveryTarget,
  formatPermissionRequestWait,
  formatRelativeTimestamp,
  generalizedErrorMessageChinese,
  DEEP_RESEARCH_EVIDENCE_CHECKLIST,
  DEEP_RESEARCH_PROGRESS_CHECKPOINTS,
  DEEP_RESEARCH_REPORT_SECTIONS,
  DEEP_RESEARCH_SCOPE_OPTIONS,
  DEEP_RESEARCH_STARTER_PROMPTS,
  DEEP_RESEARCH_WORKFLOW_STEPS,
  isDeepResearchSession,
  normalizeSearchUrl,
  nextRelativeRefreshDelay,
} from '@maka/core';
import type {
  DailyReviewArchive,
  DailyReviewArchiveSummary,
  DailyReviewConfig,
  DailyReviewMode,
  DailyReviewSummary,
  DailyReviewTopEntry,
} from '@maka/core';
import {
  materializeChat,
  materializeTools,
  materializeTurns,
  type ToolActivityItem,
  type ToolOutputChunk,
  type TurnViewModel,
} from './materialize.js';
import {
  Badge,
  Button as UiButton,
  Checkbox,
  DialogClose,
  DialogContent,
  DialogRoot,
  Input,
  Switch,
  TabsList,
  TabsPanel,
  TabsRoot,
  TabsTrigger,
  Textarea as UiTextarea,
  cn,
} from './ui.js';
import { Alert, AlertAction, AlertDescription, AlertTitle } from './primitives/alert.js';
import { Bubble, LiveIndicator, Marker, markerVariants, Message, previewVariants, streamVariants, toolVariants } from './primitives/chat.js';
import { Button as PrimitiveButton } from './primitives/button.js';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from './primitives/empty.js';
import { InputGroup, InputGroupAddon, InputGroupInput } from './primitives/input-group.js';
import { Kbd } from './primitives/kbd.js';
import { Menu, MenuItem, MenuPopup, MenuTrigger } from './primitives/menu.js';
import type { NavSelection } from './nav-selection.js';
import { EmptyState } from './empty-state.js';
import { CapabilityAuditStrip } from './capability-audit-strip.js';
import type {
  DailyReviewBridge,
  DailyReviewMarkdownActionInput,
  PlanReminderDraftInput,
  PlanReminderUpdatePatch,
  SkillEntry,
} from './module-panel-types.js';
import { ToolActivity } from './tool-activity.js';

export type { NavSelection } from './nav-selection.js';
export { useModalA11y } from './modal-a11y.js';
export { CapabilityAuditStrip } from './capability-audit-strip.js';
export { SearchModal } from './search-modal.js';
export { SessionListPanel } from './session-list-panel.js';
export type { SkillEntry } from './module-panel-types.js';
export { describeLoadToolResult, formatRedactedJson, formatToolIntent, loadToolDisplayName } from './tool-format.js';
export { formatBytes, OverlayHost, ToolActivity } from './tool-activity.js';
export { PermissionDialog } from './permission-dialog.js';

function Count(props: { value: number }) {
  if (props.value <= 0) return null;
  return <small>{props.value}</small>;
}

function SkillLibraryPanel(props: {
  skills?: SkillEntry[];
  onRefreshSkills?(): void | Promise<void>;
  onCreateSkillTemplate?(): void | Promise<void>;
  onOpenSkill?(skillId: string): void | Promise<void>;
  actionBusy?: boolean;
  refreshPending?: boolean;
  createPending?: boolean;
  openingSkillId?: string | null;
  searchQuery?: string;
}) {
  const skillCount = props.skills?.length ?? 0;
  const [activeSkillTab, setActiveSkillTab] = useState<'market' | 'builtin' | 'installed'>('market');
  const normalizedSkillQuery = props.searchQuery?.trim().toLowerCase() ?? '';
  const filteredSkills = (props.skills ?? []).filter((skill) => {
    if (!normalizedSkillQuery) return true;
    return `${skill.id} ${skill.name} ${skill.description ?? ''}`.toLowerCase().includes(normalizedSkillQuery);
  });
  const filteredMarketCards = SKILL_MARKETPLACE_CARDS.filter((card) => {
    if (!normalizedSkillQuery) return true;
    return `${card.title} ${card.body} ${card.meta}`.toLowerCase().includes(normalizedSkillQuery);
  });
  const templates = (
    <section className="maka-skill-examples" aria-label="技能示例">
      <ul className="maka-skill-example-grid" aria-label="技能模板示例">
        {SKILL_EXAMPLE_CARDS.map((example) => (
          <li key={example.title} className="maka-skill-template-row">
            <span className="maka-skill-template-icon" aria-hidden="true">
              <example.Icon size={13} strokeWidth={1.8} />
            </span>
            <span className="maka-skill-template-copy">
              <strong>{example.title}</strong>
              <span>{example.body}</span>
            </span>
            <small>{example.meta}</small>
          </li>
        ))}
      </ul>
    </section>
  );

  const tabs = (
    <div className="maka-skill-tabs-bar">
      <div className="maka-skill-tabs" role="tablist" aria-label="技能视图">
        {([
          ['market', '市场', filteredMarketCards.length],
          ['builtin', '内置', filteredSkills.length],
          ['installed', '已安装', skillCount],
        ] as const).map(([tab, label, count]) => (
          <UiButton
            key={tab}
            type="button"
            variant="ghost"
            role="tab"
            aria-selected={activeSkillTab === tab}
            className="maka-skill-tab"
            data-state={activeSkillTab === tab ? 'active' : 'inactive'}
            onClick={() => setActiveSkillTab(tab)}
          >
            {label}
            {tab === 'installed' && <span>{count}</span>}
          </UiButton>
        ))}
      </div>
      {activeSkillTab === 'market' && (
        <div className="maka-skill-filter-actions" aria-label="技能筛选排序">
          <UiButton type="button" variant="secondary" className="maka-skill-filter-pill" disabled aria-disabled="true">
            全部
          </UiButton>
          <UiButton type="button" variant="secondary" className="maka-skill-filter-pill" disabled aria-disabled="true">
            排序：热门
          </UiButton>
        </div>
      )}
    </div>
  );

  const banner = (
    <section className="maka-skill-featured-banner" data-skills-banner aria-label="精选技能">
      <div>
        <h3>为你精选的职场技能</h3>
        <p>涵盖写作、效率、设计、数据分析等多种场景，一键安装后在对话中继续使用。</p>
      </div>
      <div className="maka-skill-featured-art" aria-hidden="true">
        <span>
          <FileEdit size={22} strokeWidth={1.7} />
          <strong>复盘</strong>
          <small>总结沉淀</small>
        </span>
        <span>
          <BookOpen size={22} strokeWidth={1.7} />
          <strong>文档</strong>
          <small>审阅润色</small>
        </span>
        <span>
          <Sparkles size={22} strokeWidth={1.7} />
          <strong>发布</strong>
          <small>检查清单</small>
        </span>
      </div>
    </section>
  );

  const market = (
    <section className="maka-skill-market" aria-label="技能市场">
      <div className="maka-skill-section-row">
        <span className="maka-skill-section-label">市场技能</span>
        <small>精选模板</small>
      </div>
      {filteredMarketCards.length === 0 ? (
        <EmptyState
          Icon={Search}
          title="没有匹配的市场技能"
          body="换一个关键词，或清空搜索查看全部精选技能。"
          extraClassName="maka-skill-installed-empty"
        />
      ) : (
        <div className="maka-skill-market-grid">
          {filteredMarketCards.map((card) => (
            <article key={card.title} className="maka-skill-market-card">
              <div className="maka-skill-market-card-head">
                <span className="maka-skill-market-icon" aria-hidden="true">
                  <card.Icon size={18} strokeWidth={1.8} />
                </span>
                <div>
                  <h3>{card.title}</h3>
                  <small>{card.meta}</small>
                </div>
              </div>
              <p>{card.body}</p>
              <div className="maka-skill-market-card-foot">
                <span>{card.source}</span>
                <UiButton className="maka-skill-market-install" type="button" variant="ghost" disabled aria-disabled="true">
                  安装
                </UiButton>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );

  const skillList = (list: SkillEntry[], emptyTitle: string, emptyBody: ReactNode) => (
    <section className="maka-skill-installed" aria-label="已安装技能">
      {list.length === 0 ? (
        <EmptyState
          Icon={Sparkles}
          title={emptyTitle}
          body={emptyBody}
          cta={props.onCreateSkillTemplate ? {
            label: props.createPending ? '创建中…' : '创建示例技能',
            onClick: props.onCreateSkillTemplate,
            disabled: props.actionBusy,
          } : undefined}
          secondaryCta={props.onRefreshSkills ? {
            label: props.refreshPending ? '刷新中…' : '刷新技能',
            onClick: props.onRefreshSkills,
            disabled: props.actionBusy,
          } : undefined}
          extraClassName="maka-skill-installed-empty"
        />
      ) : (
        <>
          <div className="maka-skill-section-row">
            <span className="maka-skill-section-label">{activeSkillTab === 'installed' ? '已安装技能' : '内置技能'}</span>
            <small>{list.length} 个</small>
          </div>
          <ul className="maka-skill-library-list" aria-label="技能列表">
            {list.map((skill) => {
              const tools = skill.declaredTools ?? [];
              const toolsLabel = tools.length > 0 ? tools.join(', ') : '';
              const description = formatSkillLibraryDescription(skill);
              const opening = props.openingSkillId === skill.id;
              const hoverText = tools.length > 0
                ? `打开技能文件：${skill.id}\n\n声明工具：${toolsLabel}\n权限仍按当前会话策略判断；这里不是授权。`
                : `打开技能文件：${skill.id}`;
              return (
                <li key={skill.id} className="maka-skill-library-item">
                  <UiButton
                    type="button"
                    variant="ghost"
                    className="maka-skill-library-row"
                    onClick={() => props.onOpenSkill?.(skill.id)}
                    disabled={props.actionBusy}
                    title={hoverText}
                  >
                    <span className="maka-skill-library-status" aria-hidden="true">
                      {opening ? <Loader2 size={16} strokeWidth={1.8} /> : <Sparkles size={16} strokeWidth={1.8} />}
                    </span>
                    <span className="maka-skill-library-copy">
                      <span className="maka-skill-library-name">{skill.name}</span>
                      {description && (
                        <span className="maka-skill-library-description">{description}</span>
                      )}
                    </span>
                    <span className="maka-skill-library-meta">
                      <span>{skill.id}</span>
                      {opening && <span>打开中…</span>}
                    </span>
                    <span className="maka-skill-library-action" aria-hidden="true">
                      打开
                    </span>
                    <span className="maka-skill-library-switch" aria-hidden="true" data-state="on" />
                  </UiButton>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );

  if (!props.skills || props.skills.length === 0) {
    return (
      <div className="maka-skill-library" aria-busy={props.actionBusy ? 'true' : undefined}>
        {banner}
        {tabs}
        {activeSkillTab === 'market'
          ? market
          : skillList(
            [],
            normalizedSkillQuery ? '没有匹配的 Skill' : '等待添加 Skill',
            normalizedSkillQuery ? '换一个关键词，或清空搜索查看全部本地技能。' : (
              <>
                把一个含 <code className="maka-empty-state-code">SKILL.md</code> 的文件夹放到工作区的
                {' '}<code className="maka-empty-state-code">skills/</code> 目录下，刷新后会出现在这里。
              </>
            ),
          )}
        {activeSkillTab !== 'market' && templates}
      </div>
    );
  }

  return (
    <div className="maka-skill-library" aria-busy={props.actionBusy ? 'true' : undefined}>
      {banner}
      {tabs}
      {activeSkillTab === 'market'
        ? market
        : skillList(
          filteredSkills,
          normalizedSkillQuery ? '没有匹配的 Skill' : '等待添加 Skill',
          normalizedSkillQuery ? '换一个关键词，或清空搜索查看全部本地技能。' : (
            <>
              把一个含 <code className="maka-empty-state-code">SKILL.md</code> 的文件夹放到工作区的
              {' '}<code className="maka-empty-state-code">skills/</code> 目录下，刷新后会出现在这里。
            </>
          ),
        )}
      {activeSkillTab !== 'market' && templates}
      <span className="maka-skill-tool-summary-hidden" aria-hidden="true">
        {`${skillCount} 个 Skill · ${new Set((props.skills ?? []).flatMap((skill) => skill.declaredTools ?? [])).size} 类工具`}
      </span>
    </div>
  );
}

const SKILL_EXAMPLE_CARDS: ReadonlyArray<{
  title: string;
  body: string;
  meta: string;
  Icon: typeof FileEdit;
}> = [
  {
    title: '文档处理流',
    body: '润色、批注、检查 DOCX 内容，把重复文档步骤沉进 Skill。',
    meta: 'Office · 审阅 · 导出',
    Icon: FileEdit,
  },
  {
    title: '演示资料流',
    body: '生成结构、整理讲稿、检查 PPTX 页面，让演示准备更稳定。',
    meta: 'Slides · 提纲 · 校对',
    Icon: BookOpen,
  },
];

const SKILL_MARKETPLACE_CARDS: ReadonlyArray<{
  title: string;
  body: string;
  meta: string;
  source: string;
  Icon: typeof FileEdit;
}> = [
  {
    title: '研究简报',
    body: '把网页资料、引用和结论整理成结构化 brief，适合快速进入陌生领域。',
    meta: 'Research · Web',
    source: '官方精选',
    Icon: Search,
  },
  {
    title: '文档审阅',
    body: '检查 DOCX / Markdown 的结构、语气和遗漏项，并输出可执行修改建议。',
    meta: 'Writing · Office',
    source: '官方精选',
    Icon: FileEdit,
  },
  {
    title: '会议跟进',
    body: '从会议记录里抽取决定、风险和 owner，生成下一步任务清单。',
    meta: 'Ops · Summary',
    source: '社区模板',
    Icon: CalendarDays,
  },
  {
    title: '发布检查',
    body: '按发布前 checklist 扫描 diff、测试和文档，减少临门一脚的遗漏。',
    meta: 'Engineering · QA',
    source: '团队模板',
    Icon: ShieldAlert,
  },
];

function formatSkillLibraryDescription(skill: SkillEntry): string | undefined {
  const raw = skill.description?.trim();
  if (!raw) return undefined;
  if (/[\u3400-\u9fff]/.test(raw)) return raw;

  const source = `${skill.id} ${skill.name} ${raw}`.toLowerCase();
  if (source.includes('docx') || source.includes('word') || source.includes('google docs')) {
    return '创建、编辑、检查文档内容。';
  }
  if (source.includes('ppt') || source.includes('powerpoint') || source.includes('slide') || source.includes('presentation')) {
    return '创建、编辑、检查演示文稿。';
  }
  if (source.includes('spreadsheet') || source.includes('excel') || source.includes('csv') || source.includes('xlsx')) {
    return '创建、编辑、分析表格数据。';
  }
  if (source.includes('image') || source.includes('photo') || source.includes('bitmap')) {
    return '生成或编辑图片素材。';
  }
  if (source.includes('browser') || source.includes('chrome') || source.includes('web target')) {
    return '打开、检查、操作网页界面。';
  }
  if (source.includes('macos') || source.includes('swiftui') || source.includes('appkit')) {
    return '辅助构建和调试 macOS 应用。';
  }
  return '打开技能文件查看适用场景。';
}



function SkillsModuleMain(props: {
  skills?: SkillEntry[];
  auditReport?: CapabilityAuditReport;
  onRefreshSkills?(): void | Promise<void>;
  onCreateSkillTemplate?(): void | Promise<void>;
  onOpenSkill?(skillId: string): void | Promise<void>;
  onOpenSkillsFolder?(): void | Promise<void>;
}) {
  const [pendingSkillAction, setPendingSkillAction] = useState<string | null>(null);
  const [skillSearchQuery, setSkillSearchQuery] = useState('');
  const skillActionMountedRef = useRef(true);
  const pendingSkillActionRef = useRef<string | null>(null);

  useEffect(() => {
    skillActionMountedRef.current = true;
    return () => {
      skillActionMountedRef.current = false;
      pendingSkillActionRef.current = null;
    };
  }, []);

  async function runSkillAction(
    actionKey: string,
    action: (() => void | Promise<void>) | undefined,
  ) {
    if (!action || pendingSkillActionRef.current !== null) return;
    pendingSkillActionRef.current = actionKey;
    setPendingSkillAction(actionKey);
    try {
      await action();
    } finally {
      if (pendingSkillActionRef.current === actionKey) {
        pendingSkillActionRef.current = null;
        if (skillActionMountedRef.current) setPendingSkillAction(null);
      }
    }
  }

  const skillActionBusy = pendingSkillAction !== null;
  const skillCreateLegacyLabel = pendingSkillAction === 'create' ? '创建中…' : '创建示例';
  const auditReport = props.auditReport ?? deriveCapabilityAuditReport({ skills: props.skills ?? [] });
  return (
    <main className="maka-main detailPane maka-module-main agents-chat-panel" aria-label="技能">
      <header className="maka-module-main-header">
        <div>
          <h2>技能</h2>
          <p>安装与管理技能，在对话中扩展 Maka 的能力。</p>
        </div>
        <div className="maka-module-main-actions" role="group" aria-label="技能操作">
          <label className="maka-skill-search" aria-label="搜索技能">
            <Search size={15} strokeWidth={1.75} aria-hidden="true" />
            <Input
              value={skillSearchQuery}
              onChange={(event) => setSkillSearchQuery(event.currentTarget.value)}
              maxLength={120}
              placeholder="搜索技能"
            />
          </label>
          <UiButton
            className="maka-button maka-button-ghost"
            variant="ghost"
            type="button"
            onClick={() => void runSkillAction('folder', props.onOpenSkillsFolder)}
            disabled={!props.onOpenSkillsFolder || skillActionBusy}
          >
            打开目录
          </UiButton>
          <UiButton
            className="maka-button maka-skill-add-button"
            variant="ghost"
            type="button"
            onClick={() => void runSkillAction('create', props.onCreateSkillTemplate)}
            disabled={!props.onCreateSkillTemplate || skillActionBusy}
          >
            <Plus size={15} strokeWidth={1.75} aria-hidden="true" />
            {pendingSkillAction === 'create' ? '创建中…' : '添加'}
            <span className="maka-visually-hidden">{skillCreateLegacyLabel}</span>
          </UiButton>
          <UiButton
            className="maka-button maka-button-ghost"
            variant="ghost"
            type="button"
            onClick={() => void runSkillAction('refresh', props.onRefreshSkills)}
            disabled={!props.onRefreshSkills || skillActionBusy}
          >
            {pendingSkillAction === 'refresh' ? '刷新中…' : '刷新'}
          </UiButton>
        </div>
      </header>
      <CapabilityAuditStrip report={auditReport} focus="skills" />
      <SkillLibraryPanel
        skills={props.skills}
        onRefreshSkills={props.onRefreshSkills ? () => runSkillAction('refresh', props.onRefreshSkills) : undefined}
        onCreateSkillTemplate={props.onCreateSkillTemplate ? () => runSkillAction('create', props.onCreateSkillTemplate) : undefined}
        onOpenSkill={props.onOpenSkill ? (skillId) => runSkillAction(`open:${skillId}`, () => props.onOpenSkill?.(skillId)) : undefined}
        actionBusy={skillActionBusy}
        refreshPending={pendingSkillAction === 'refresh'}
        createPending={pendingSkillAction === 'create'}
        openingSkillId={pendingSkillAction?.startsWith('open:') ? pendingSkillAction.slice('open:'.length) : null}
        searchQuery={skillSearchQuery}
      />
    </main>
  );
}


type DailyReviewArchiveSectionKey = keyof DailyReviewArchive['sections'];

const DAILY_REVIEW_ARCHIVE_SECTION_LABEL: Record<DailyReviewArchiveSectionKey, string> = {
  summary: '对话摘要',
  gaps: '遗漏提醒',
  usage: '使用洞察',
  code: '代码建议',
};

const DAILY_REVIEW_ARCHIVE_STATUS_LABEL: Record<DailyReviewArchive['status'], string> = {
  ok: '已生成',
  no_model: '缺少模型',
  no_data: '无数据',
  failed: '生成失败',
  skipped: '已跳过',
};

const DAILY_REVIEW_ARCHIVE_TRIGGER_LABEL: Record<DailyReviewArchive['trigger'], string> = {
  cron: '定时',
  manual: '手动',
};

function DailyReviewPanel(props: {
  bridge: DailyReviewBridge;
  onSelectSession?: (sessionId: string) => void;
  onCopyMarkdown?: (input: DailyReviewMarkdownActionInput) => Promise<void> | void;
  onAppendMarkdown?: (input: DailyReviewMarkdownActionInput) => Promise<void> | void;
  onSaveMarkdown?: (input: DailyReviewMarkdownActionInput) => Promise<void> | void;
}) {
  const [offsetDays, setOffsetDays] = useState(0);
  // PR-DAILY-REVIEW-RANGE-0: 今日 / 本周 / 本月 tabs that map to a
  // 1 / 7 / 30 day aggregation. When span > 1, the day-stepper
  // navigates by the same span (一个 30 天 window steps back 30 days).
  const [range, setRange] = useState<DailyReviewRange>(1);
  const [summary, setSummary] = useState<DailyReviewSummary | null>(null);
  const [summaryScopeKey, setSummaryScopeKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadToken, setReloadToken] = useState(0);
  const [pendingDailyReviewAction, setPendingDailyReviewAction] = useState<string | null>(null);
  const [archives, setArchives] = useState<DailyReviewArchiveSummary[]>([]);
  const [selectedArchiveId, setSelectedArchiveId] = useState<string | null>(null);
  const [selectedArchive, setSelectedArchive] = useState<DailyReviewArchive | null>(null);
  const [archiveLoading, setArchiveLoading] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [archiveReloadToken, setArchiveReloadToken] = useState(0);
  const modelOptions = props.bridge.modelOptions ?? [];
  const [selectedModelKey, setSelectedModelKey] = useState<string>(modelOptions[0]?.[0] ?? '');
  const dailyReviewMountedRef = useRef(true);
  const summaryScopeKeyRef = useRef<string | null>(null);
  const pendingDailyReviewActionRef = useRef<string | null>(null);
  const archiveLoadRequestRef = useRef(0);
  const currentSummaryScopeKey = dailyReviewScopeKey(offsetDays, range);
  const visibleSummary = summaryScopeKey === currentSummaryScopeKey ? summary : null;
  const canLoadArchives = Boolean(props.bridge.listArchives && props.bridge.getArchive);

  useEffect(() => {
    dailyReviewMountedRef.current = true;
    return () => {
      dailyReviewMountedRef.current = false;
      pendingDailyReviewActionRef.current = null;
      archiveLoadRequestRef.current += 1;
    };
  }, []);

  function chooseDailyReviewArchive(archiveId: string) {
    archiveLoadRequestRef.current += 1;
    setSelectedArchiveId(archiveId);
    setSelectedArchive(null);
    setArchiveLoading(Boolean(props.bridge.getArchive));
    setArchiveError(null);
  }

  useEffect(() => {
    let cancelled = false;
    const scopeKey = dailyReviewScopeKey(offsetDays, range);
    setLoading(true);
    setError(null);
    props.bridge
      .fetchDay(offsetDays, range)
      .then((next) => {
        if (cancelled) return;
        setSummary(next);
        summaryScopeKeyRef.current = scopeKey;
        setSummaryScopeKey(scopeKey);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (summaryScopeKeyRef.current !== scopeKey) {
          summaryScopeKeyRef.current = null;
          setSummary(null);
          setSummaryScopeKey(null);
        }
        setError(dailyReviewPanelErrorMessage(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [offsetDays, range, reloadToken, props.bridge]);

  useEffect(() => {
    const listArchives = props.bridge.listArchives;
    if (!listArchives) {
      setArchives([]);
      setSelectedArchiveId(null);
      setSelectedArchive(null);
      return;
    }
    let cancelled = false;
    setArchiveError(null);
    listArchives()
      .then((next) => {
        if (cancelled) return;
        setArchives(next);
        setSelectedArchiveId((current) => {
          if (current && next.some((archive) => archive.id === current)) return current;
          return next[0]?.id ?? null;
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setArchiveError(dailyReviewPanelErrorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [archiveReloadToken, props.bridge]);

  useEffect(() => {
    const getArchive = props.bridge.getArchive;
    if (!getArchive || !selectedArchiveId) {
      archiveLoadRequestRef.current += 1;
      setSelectedArchive(null);
      setArchiveLoading(false);
      return;
    }
    let cancelled = false;
    const archiveId = selectedArchiveId;
    const archiveRequestId = ++archiveLoadRequestRef.current;
    setSelectedArchive(null);
    setArchiveLoading(true);
    setArchiveError(null);
    getArchive(archiveId)
      .then((next) => {
        if (cancelled) return;
        if (archiveLoadRequestRef.current !== archiveRequestId) return;
        setSelectedArchive(next);
        setArchiveLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (archiveLoadRequestRef.current !== archiveRequestId) return;
        setSelectedArchive(null);
        setArchiveError(dailyReviewPanelErrorMessage(err));
        setArchiveLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [archiveReloadToken, selectedArchiveId, props.bridge]);

  useEffect(() => {
    if (modelOptions.length === 0) {
      setSelectedModelKey('');
      return;
    }
    setSelectedModelKey((current) => {
      if (modelOptions.some(([value]) => value === current)) return current;
      return modelOptions[0]?.[0] ?? '';
    });
  }, [modelOptions]);

  const dayLabel = (() => {
    if (range === 1) {
      if (offsetDays === 0) return '今天';
      if (offsetDays === -1) return '昨天';
      return `${-offsetDays} 天前`;
    }
    const rangeText = range === 7 ? '最近 7 天' : '最近 30 天';
    if (offsetDays === 0) return rangeText;
    return `${rangeText}（往前 ${-offsetDays} 天）`;
  })();

  // Stepper step matches the range size — for 7-day mode the user
  // skips a whole week at a time, not a single day.
  const stepperLabel = range === 1 ? '天' : range === 7 ? '周' : '月';
  const emptyActivityTitle = offsetDays === 0 && range === 1
    ? '等待记录今天活动'
    : `${dayLabel}无活动`;
  const emptyActivityBody = range === 1
    ? '这一天没有发起对话，也没有调用模型。'
    : `${dayLabel}范围内没有发起对话，也没有调用模型。`;

  async function runDailyReviewAction(actionKey: string, action: () => void | Promise<void>) {
    if (pendingDailyReviewActionRef.current !== null) return;
    pendingDailyReviewActionRef.current = actionKey;
    setPendingDailyReviewAction(actionKey);
    try {
      await action();
    } finally {
      if (pendingDailyReviewActionRef.current === actionKey) {
        pendingDailyReviewActionRef.current = null;
        if (dailyReviewMountedRef.current) setPendingDailyReviewAction(null);
      }
    }
  }

  function isDailyReviewActionCurrent(actionKey: string): boolean {
    return dailyReviewMountedRef.current && pendingDailyReviewActionRef.current === actionKey;
  }

  const dailyReviewActionBusy = pendingDailyReviewAction !== null;
  const hasDailyReviewActions = Boolean(props.onCopyMarkdown || props.onAppendMarkdown || props.onSaveMarkdown);
  const canManualRun = Boolean(props.bridge.runOnce);

  async function triggerManualRun(mode: DailyReviewMode) {
    const runOnce = props.bridge.runOnce;
    if (!runOnce) return;
    const actionKey = `run:${mode}`;
    await runDailyReviewAction(actionKey, async () => {
      try {
        const result = await runOnce({ mode, modelKey: selectedModelKey });
        if (!isDailyReviewActionCurrent(actionKey)) return;
        chooseDailyReviewArchive(result.archiveId);
        setArchiveReloadToken((n) => n + 1);
        setReloadToken((n) => n + 1);
      } catch (err) {
        if (isDailyReviewActionCurrent(actionKey)) setError(dailyReviewPanelErrorMessage(err));
      }
    });
  }

  return (
    <div className="maka-daily-review-panel" data-loading={loading ? 'true' : undefined}>
      <header className="maka-daily-review-header">
        <UiButton
          type="button"
          variant="ghost"
          size="icon-sm"
          className="maka-daily-review-stepper"
          onClick={() => setOffsetDays((n) => n - range)}
          aria-label={`查看更早一${stepperLabel}`}
        >
          ‹
        </UiButton>
        <div className="maka-daily-review-day">{dayLabel}</div>
        <UiButton
          type="button"
          variant="ghost"
          size="icon-sm"
          className="maka-daily-review-stepper"
          onClick={() => setOffsetDays((n) => Math.min(0, n + range))}
          disabled={offsetDays >= 0}
          aria-label={`查看更晚一${stepperLabel}`}
        >
          ›
        </UiButton>
      </header>
      <section className="maka-daily-review-info" aria-label="每日回顾说明">
        <p className="maka-daily-review-info-body">
          每日回顾会自动汇总本机的对话历史，生成
          <strong>对话摘要</strong>和
          <strong>遗漏提醒</strong>；开启
          <strong>深度分析</strong>后还会做更长周期的项目趋势与技术调研。
        </p>
        <p className="maka-daily-review-info-hint">
          在设置中开启<strong>定时执行</strong>，或在此页面手动触发一次。
        </p>
      </section>
      {canManualRun && (
        <div className="maka-daily-review-quick-runs" aria-label="手动触发回顾">
          {modelOptions.length > 0 && (
            <SettingsSelect
              value={selectedModelKey}
              ariaLabel="每日回顾分析模型"
              options={modelOptions}
              onChange={setSelectedModelKey}
              disabled={dailyReviewActionBusy}
              className="maka-daily-review-model-select"
            />
          )}
          <UiButton
            type="button"
            variant="default"
            size="sm"
            className="maka-daily-review-quick-run"
            onClick={() => void triggerManualRun('daily')}
            disabled={dailyReviewActionBusy}
            data-pending={pendingDailyReviewAction === 'run:daily' ? 'true' : undefined}
            aria-busy={pendingDailyReviewAction === 'run:daily' ? 'true' : undefined}
          >
            {pendingDailyReviewAction === 'run:daily' ? '生成中…' : '生成每日回顾'}
          </UiButton>
          <UiButton
            type="button"
            variant="outline"
            size="sm"
            className="maka-daily-review-quick-run"
            onClick={() => void triggerManualRun('deep')}
            disabled={dailyReviewActionBusy}
            data-pending={pendingDailyReviewAction === 'run:deep' ? 'true' : undefined}
            aria-busy={pendingDailyReviewAction === 'run:deep' ? 'true' : undefined}
          >
            {pendingDailyReviewAction === 'run:deep' ? '生成中…' : '生成深度分析'}
          </UiButton>
        </div>
      )}
      {canLoadArchives && (
        <section className="maka-daily-review-archives" aria-label="已生成报告">
          <div className="maka-daily-review-archives-header">
            <h4 className="maka-daily-review-section-title">已生成报告</h4>
            <span className="maka-daily-review-archive-count">{archives.length} 份</span>
          </div>
          {archiveError && (
            <Alert variant="warning" className="maka-daily-review-alert">
              <AlertDescription>回顾报告读取失败：{archiveError}</AlertDescription>
              <AlertAction>
                <UiButton
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="maka-daily-review-alert-retry"
                  onClick={() => setArchiveReloadToken((n) => n + 1)}
                  disabled={archiveLoading}
                >
                  重试
                </UiButton>
              </AlertAction>
            </Alert>
          )}
          {archives.length === 0 && !archiveError ? (
            <p className="maka-daily-review-archive-empty">
              还没有生成报告。点击上方按钮后，报告会保存到本机并显示在这里。
            </p>
          ) : (
            <div className="maka-daily-review-archive-layout">
              {/* PR-DAILYREVIEW-ARCHIVE-ROW-A11Y-0 (round 7/30):
                  the archive list was a `<div role="list">` with
                  `<button role="listitem">` children. `role` doesn't
                  layer like that — a `<button>` is already a button,
                  so giving it `role="listitem"` either gets ignored
                  by ATs or produces inconsistent announcements.
                  Switched to semantic `<ul>` / `<li>` and routed the
                  click target through UiButton so disabled-state +
                  focus-visible + `:active` come from the shared
                  contract. */}
              <ul className="maka-daily-review-archive-list" aria-label="回顾报告历史">
                {archives.map((archive) => (
                  <li key={archive.id}>
                    <UiButton
                      type="button"
                      variant="quiet"
                      className="maka-daily-review-archive-row"
                      data-active={selectedArchiveId === archive.id ? 'true' : undefined}
                      onClick={() => chooseDailyReviewArchive(archive.id)}
                    >
                      <span className="maka-daily-review-archive-row-title">
                        {formatDailyReviewArchiveTitle(archive)}
                      </span>
                      <span className="maka-daily-review-archive-row-meta">
                        {DAILY_REVIEW_ARCHIVE_STATUS_LABEL[archive.status]} · {archive.totals.sessionCount} 对话 · {formatDailyReviewArchiveGeneratedAt(archive.generatedAt)}
                      </span>
                    </UiButton>
                  </li>
                ))}
              </ul>
              <DailyReviewArchiveBody archive={selectedArchive} loading={archiveLoading} />
            </div>
          )}
        </section>
      )}
      <nav className="maka-daily-review-range" aria-label="时间范围切换">
        <div className="maka-daily-review-range-tabs">
          {([1, 7, 30] as const).map((option) => (
            <UiButton
              key={option}
              type="button"
              variant="ghost"
              size="sm"
              className="maka-daily-review-range-tab"
              data-active={range === option ? 'true' : undefined}
              aria-pressed={range === option}
              onClick={() => {
                setRange(option);
                setOffsetDays(0);
              }}
            >
              {option === 1 ? '今日' : option === 7 ? '本周' : '本月'}
            </UiButton>
          ))}
        </div>
        {visibleSummary && visibleSummary.totals.sessionCount + visibleSummary.totals.requestCount > 0 && hasDailyReviewActions && (
          <div className="maka-daily-review-actions" aria-label="回顾导出操作">
            {props.onCopyMarkdown && (
              <UiButton
                type="button"
                variant="ghost"
                size="sm"
                className="maka-daily-review-copy"
                onClick={() => void runDailyReviewAction('copy', async () => {
                  const md = formatDailyReviewMarkdown(visibleSummary, dayLabel);
                  await props.onCopyMarkdown?.({ markdown: md, label: dayLabel, summary: visibleSummary });
                })}
                disabled={dailyReviewActionBusy}
                data-pending={pendingDailyReviewAction === 'copy' ? 'true' : undefined}
                aria-busy={pendingDailyReviewAction === 'copy' ? 'true' : undefined}
                title="复制为 Markdown 摘要，方便分享 / 贴到笔记"
              >
                {pendingDailyReviewAction === 'copy' ? '复制中…' : '复制'}
              </UiButton>
            )}
            {props.onAppendMarkdown && (
              <UiButton
                type="button"
                variant="ghost"
                size="sm"
                className="maka-daily-review-append"
                onClick={() => void runDailyReviewAction('append', async () => {
                  const md = formatDailyReviewMarkdown(visibleSummary, dayLabel);
                  await props.onAppendMarkdown?.({ markdown: md, label: dayLabel, summary: visibleSummary });
                })}
                disabled={dailyReviewActionBusy}
                data-pending={pendingDailyReviewAction === 'append' ? 'true' : undefined}
                aria-busy={pendingDailyReviewAction === 'append' ? 'true' : undefined}
                title="追加到当前输入框草稿"
              >
                {pendingDailyReviewAction === 'append' ? '追加中…' : '粘到输入框'}
              </UiButton>
            )}
            {props.onSaveMarkdown && (
              <UiButton
                type="button"
                variant="ghost"
                size="sm"
                className="maka-daily-review-save"
                onClick={() => void runDailyReviewAction('save', async () => {
                  const md = formatDailyReviewMarkdown(visibleSummary, dayLabel);
                  await props.onSaveMarkdown?.({ markdown: md, label: dayLabel, summary: visibleSummary });
                })}
                disabled={dailyReviewActionBusy}
                data-pending={pendingDailyReviewAction === 'save' ? 'true' : undefined}
                aria-busy={pendingDailyReviewAction === 'save' ? 'true' : undefined}
                title="保存为 Markdown 文件"
              >
                {pendingDailyReviewAction === 'save' ? '保存中…' : '保存'}
              </UiButton>
            )}
          </div>
        )}
      </nav>

      {error && visibleSummary ? (
        <Alert variant="warning" className="maka-daily-review-alert">
          <AlertDescription>每日回顾刷新失败：{error}</AlertDescription>
          <AlertAction>
            <UiButton
              type="button"
              variant="ghost"
              size="sm"
              className="maka-daily-review-alert-retry"
              onClick={() => setReloadToken((n) => n + 1)}
              disabled={loading}
            >
              重试
            </UiButton>
          </AlertAction>
        </Alert>
      ) : null}

      {error && !visibleSummary ? (
        <EmptyState
          Icon={CalendarDays}
          title="读取失败"
          body={error}
          cta={{ label: '重试', onClick: () => setReloadToken((n) => n + 1) }}
          extraClassName="maka-daily-review-summary-empty"
        />
      ) : !visibleSummary ? (
        <div className="maka-daily-review-loading" aria-busy="true">
          <div className="maka-skeleton maka-skeleton-line" style={{ width: '60%' }} />
          <div className="maka-skeleton maka-skeleton-line" style={{ width: '90%' }} />
          <div className="maka-skeleton maka-skeleton-line" style={{ width: '75%' }} />
        </div>
      ) : visibleSummary.totals.sessionCount === 0 && visibleSummary.totals.requestCount === 0 ? (
        <EmptyState
          Icon={CalendarDays}
          title={emptyActivityTitle}
          body={emptyActivityBody}
          extraClassName="maka-daily-review-summary-empty"
        />
      ) : (
        <>
          <section className="maka-daily-review-totals" aria-label={`${dayLabel}总览`}>
            <DailyReviewTotalsCell label="对话" value={visibleSummary.totals.sessionCount.toString()} />
            <DailyReviewTotalsCell label="请求" value={visibleSummary.totals.requestCount.toString()} />
            <DailyReviewTotalsCell
              label="Token"
              value={visibleSummary.totals.totalTokens.toLocaleString()}
            />
            <DailyReviewTotalsCell
              label="费用"
              value={`$${visibleSummary.totals.costUsd.toFixed(2)}`}
            />
            {visibleSummary.totals.errorCount > 0 && (
              <DailyReviewTotalsCell
                label="错误"
                value={visibleSummary.totals.errorCount.toString()}
                tone="error"
              />
            )}
          </section>

          {visibleSummary.sessions.length > 0 && (
            <section className="maka-daily-review-section" aria-label="活跃对话">
              <h4 className="maka-daily-review-section-title">活跃对话</h4>
              <ul className="maka-daily-review-list" aria-label="活跃对话列表">
                {visibleSummary.sessions.map((session) => (
                  <li key={session.id} className="maka-daily-review-list-item">
                    {/* PR-DAILYREVIEW-SESSION-BUTTON-PRIMITIVE-0
                        (round 6/30): the active-conversation row
                        used a raw <button>. Routed through UiButton
                        variant="quiet" so disabled-state styling +
                        focus-visible + :active scale come from the
                        shared button contract. Custom class still
                        owns the in-row layout (name left, relative
                        time right). */}
                    <UiButton
                      type="button"
                      variant="quiet"
                      className="maka-daily-review-session-button"
                      onClick={() => props.onSelectSession?.(session.id)}
                      disabled={!props.onSelectSession}
                    >
                      <span className="maka-daily-review-session-name">{session.name}</span>
                      <RelativeTime
                        ts={session.lastMessageAt}
                        className="maka-daily-review-session-time"
                      />
                    </UiButton>
                    {session.lastMessagePreview && (
                      <span className="maka-daily-review-session-preview">
                        {session.lastMessagePreview}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {visibleSummary.topModels.length > 0 && (
            <DailyReviewTopList title="模型使用" entries={visibleSummary.topModels} />
          )}

          {visibleSummary.topTools.length > 0 && (
            <DailyReviewTopList title="工具调用" entries={visibleSummary.topTools} />
          )}
        </>
      )}
    </div>
  );
}

function DailyReviewArchiveBody(props: { archive: DailyReviewArchive | null; loading: boolean }) {
  if (props.loading) {
    return (
      <div className="maka-daily-review-archive-body" aria-busy="true">
        <div className="maka-skeleton maka-skeleton-line" style={{ width: '58%' }} />
        <div className="maka-skeleton maka-skeleton-line" style={{ width: '92%' }} />
        <div className="maka-skeleton maka-skeleton-line" style={{ width: '74%' }} />
      </div>
    );
  }
  if (!props.archive) {
    return (
      <div className="maka-daily-review-archive-body" data-empty="true">
        选择一份报告查看生成内容。
      </div>
    );
  }
  const archive = props.archive;
  const sections = (Object.keys(DAILY_REVIEW_ARCHIVE_SECTION_LABEL) as DailyReviewArchiveSectionKey[])
    .map((key) => {
      const content = archive.sections[key]?.trim();
      return content ? { key, content } : null;
    })
    .filter((entry): entry is { key: DailyReviewArchiveSectionKey; content: string } => entry !== null);
  return (
    <article className="maka-daily-review-archive-body" aria-label={formatDailyReviewArchiveTitle(archive)}>
      <header className="maka-daily-review-archive-body-header">
        <div>
          <h4>{formatDailyReviewArchiveTitle(archive)}</h4>
          <p>
            {DAILY_REVIEW_ARCHIVE_TRIGGER_LABEL[archive.trigger]}生成 · {formatDailyReviewArchiveGeneratedAt(archive.generatedAt)}
            {archive.modelKey ? ` · ${archive.modelKey}` : ' · 默认对话模型'}
          </p>
        </div>
        <span className="maka-daily-review-archive-status" data-status={archive.status}>
          {DAILY_REVIEW_ARCHIVE_STATUS_LABEL[archive.status]}
        </span>
      </header>
      {archive.errorMessage && (
        <p className="maka-daily-review-archive-error">{archive.errorMessage}</p>
      )}
      {sections.length > 0 ? (
        <div className="maka-daily-review-archive-sections">
          {sections.map((section) => (
            <section key={section.key} className="maka-daily-review-archive-section">
              <h5>{DAILY_REVIEW_ARCHIVE_SECTION_LABEL[section.key]}</h5>
              <p>{section.content}</p>
            </section>
          ))}
        </div>
      ) : (
        <p className="maka-daily-review-archive-empty">
          这份报告没有生成正文内容。
        </p>
      )}
    </article>
  );
}

function DailyReviewTotalsCell(props: { label: string; value: string; tone?: 'error' }) {
  return (
    <div className="maka-daily-review-totals-cell" data-tone={props.tone}>
      <span className="maka-daily-review-totals-value">{props.value}</span>
      <span className="maka-daily-review-totals-label">{props.label}</span>
    </div>
  );
}

function DailyReviewTopList(props: { title: string; entries: ReadonlyArray<DailyReviewTopEntry> }) {
  return (
    <section className="maka-daily-review-section" aria-label={props.title}>
      <h4 className="maka-daily-review-section-title">{props.title}</h4>
      <ul className="maka-daily-review-list" aria-label={`${props.title}列表`}>
        {props.entries.map((entry) => (
          <li key={entry.key} className="maka-daily-review-list-item">
            <span className="maka-daily-review-top-label">{entry.label}</span>
            <span className="maka-daily-review-top-meta">
              {entry.requests} 次 · {entry.totalTokens.toLocaleString()} tok
              {entry.costUsd > 0 ? ` · $${entry.costUsd.toFixed(2)}` : ''}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// PR round-AB-shared-select (yuejing 2026-06-25, kenji styles inventory
// task #128): `PlanReminderSelect` is now a thin specialization of the
// shared `SettingsSelect` primitive — `width="full"` to preserve the
// existing edge-to-edge sizing inside `.maka-plan-delivery-grid`.
// Plan Reminder and Settings selects share one component so option
// shape, trigger/popup chrome, and the selected-trigger icon contract
// can't drift apart again.
function PlanReminderSelect<T extends string>(props: {
  value: T;
  options: ReadonlyArray<SettingsSelectOption<T>>;
  onChange(value: T): void;
  ariaLabel: string;
  disabled?: boolean;
}) {
  return <SettingsSelect width="full" {...props} />;
}

function PlanReminderPanel(props: {
  reminders: PlanReminder[];
  auditReport?: CapabilityAuditReport;
  onRefresh?(): void | Promise<void>;
  onCreate?(input: PlanReminderDraftInput): boolean | Promise<boolean> | void | Promise<void>;
  onUpdate?(id: string, patch: PlanReminderUpdatePatch): boolean | Promise<boolean> | void | Promise<void>;
  onToggle?(id: string, enabled: boolean): void | Promise<void>;
  onTriggerNow?(id: string): void | Promise<void>;
  onSnooze?(id: string): void | Promise<void>;
  onClearRunHistory?(id: string): void | Promise<void>;
  onDelete?(id: string): void | Promise<void>;
}) {
  type PlanReminderListFilter = 'all' | PlanReminderStatus;
  type PlanReminderView = 'tasks' | 'runs';
  type PlanReminderRunRange = 'day' | 'week' | 'month' | 'all';
  type PlanReminderSort = 'created-desc' | 'next-run-asc' | 'updated-desc';
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [runAtLocal, setRunAtLocal] = useState(() => toPlanReminderDateTimeInputValue(Date.now() + 60 * 60 * 1000));
  const [recurrence, setRecurrence] = useState<PlanReminderRecurrence>('none');
  const [cronExpression, setCronExpression] = useState('0 9 * * 1-5');
  const [deliveryChannel, setDeliveryChannel] = useState<PlanReminderDeliveryTarget['channel']>('local');
  const [deliveryPlatform, setDeliveryPlatform] = useState<BotProvider>('telegram');
  const [deliveryChatId, setDeliveryChatId] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [submitPending, setSubmitPending] = useState(false);
  const [pendingActionKeys, setPendingActionKeys] = useState<ReadonlySet<string>>(() => new Set());
  const planReminderMountedRef = useRef(true);
  const submitPendingRef = useRef(false);
  const refreshPendingRef = useRef(false);
  const pendingActionKeysRef = useRef<Set<string>>(new Set());
  const [formDialogOpen, setFormDialogOpen] = useState(false);
  const [planView, setPlanView] = useState<PlanReminderView>('tasks');
  const [runRange, setRunRange] = useState<PlanReminderRunRange>('week');
  const [listFilter, setListFilter] = useState<PlanReminderListFilter>('all');
  const [listSort, setListSort] = useState<PlanReminderSort>('created-desc');
  const [listQuery, setListQuery] = useState('');
  const [refreshPending, setRefreshPending] = useState(false);
  const parsedRunAt = Date.parse(runAtLocal);
  const normalizedListQuery = normalizePlanReminderSearchQuery(listQuery);
  const searchMatchedReminders = normalizedListQuery
    ? props.reminders.filter((reminder) => planReminderMatchesSearch(reminder, normalizedListQuery))
    : props.reminders;
  const visibleReminders = listFilter === 'all'
    ? searchMatchedReminders
    : searchMatchedReminders.filter((reminder) => reminder.status === listFilter);
  const sortedReminders = [...visibleReminders].sort((a, b) => comparePlanReminderBySort(a, b, listSort));
  const runRangeStart = planReminderRunRangeStart(runRange, Date.now());
  const visibleRunEntries = props.reminders
    .flatMap((reminder) => reminder.runs.map((run) => ({ reminder, run })))
    .filter((entry) => runRangeStart === null || entry.run.at >= runRangeStart)
    .sort((a, b) => b.run.at - a.run.at);
  const filterCounts: Record<PlanReminderListFilter, number> = {
    all: searchMatchedReminders.length,
    scheduled: searchMatchedReminders.filter((reminder) => reminder.status === 'scheduled').length,
    paused: searchMatchedReminders.filter((reminder) => reminder.status === 'paused').length,
    completed: searchMatchedReminders.filter((reminder) => reminder.status === 'completed').length,
  };
  const delivery: PlanReminderDeliveryTarget = deliveryChannel === 'bot'
    ? { channel: 'bot', platform: deliveryPlatform, chatId: deliveryChatId.trim() }
    : { channel: 'local' };
  const validationMessage = planReminderFormValidationMessage({
    title,
    parsedRunAt,
    recurrence,
    cronExpression,
    delivery,
    now: Date.now(),
  });
  const canCreate = validationMessage === null;
  const submitDisabled = !canCreate || submitPending;
  const formInteractionDisabled = submitPending;
  const isEditing = editingId !== null;
  const auditReport = props.auditReport ?? deriveCapabilityAuditReport({ planReminders: props.reminders });

  useEffect(() => {
    planReminderMountedRef.current = true;
    return () => {
      planReminderMountedRef.current = false;
      submitPendingRef.current = false;
      refreshPendingRef.current = false;
      pendingActionKeysRef.current = new Set();
    };
  }, []);

  useEffect(() => {
    if (editingId && !props.reminders.some((reminder) => reminder.id === editingId)) resetForm();
  }, [editingId, props.reminders]);

  function resetForm() {
    setTitle('');
    setNote('');
    setRecurrence('none');
    setCronExpression('0 9 * * 1-5');
    setDeliveryChannel('local');
    setDeliveryPlatform('telegram');
    setDeliveryChatId('');
    setRunAtLocal(toPlanReminderDateTimeInputValue(Date.now() + 60 * 60 * 1000));
    setEditingId(null);
  }

  function openCreateReminderDialog() {
    resetForm();
    setFormDialogOpen(true);
  }

  function openPlanReminderTemplate(template: PlanReminderExampleTemplate) {
    setEditingId(null);
    setTitle(template.title);
    setNote(template.note);
    setRecurrence(template.recurrence);
    setCronExpression(template.cronExpression);
    setDeliveryChannel('local');
    setDeliveryPlatform('telegram');
    setDeliveryChatId('');
    setRunAtLocal(toPlanReminderDateTimeInputValue(planReminderTemplateNextRunAt(template)));
    setFormDialogOpen(true);
  }

  function closeReminderDialog() {
    if (submitPendingRef.current) return;
    setFormDialogOpen(false);
    resetForm();
  }

  function editReminder(reminder: PlanReminder) {
    setEditingId(reminder.id);
    setTitle(reminder.title);
    setNote(reminder.note);
    setRunAtLocal(toPlanReminderDateTimeInputValue(planReminderEditableRunAt(reminder)));
    setRecurrence(planReminderRecurrenceValue(reminder));
    setCronExpression(reminder.schedule.kind === 'cron' ? reminder.schedule.expression : '0 9 * * 1-5');
    setDeliveryChannel(reminder.delivery.channel);
    if (reminder.delivery.channel === 'bot') {
      setDeliveryPlatform(reminder.delivery.platform);
      setDeliveryChatId(reminder.delivery.chatId);
    } else {
      setDeliveryPlatform('telegram');
      setDeliveryChatId('');
    }
    setFormDialogOpen(true);
  }

  function duplicateReminder(reminder: PlanReminder) {
    setEditingId(null);
    setTitle(duplicatePlanReminderTitle(reminder.title));
    setNote(reminder.note);
    setRunAtLocal(toPlanReminderDateTimeInputValue(planReminderEditableRunAt(reminder)));
    setRecurrence(planReminderRecurrenceValue(reminder));
    setCronExpression(reminder.schedule.kind === 'cron' ? reminder.schedule.expression : '0 9 * * 1-5');
    setDeliveryChannel(reminder.delivery.channel);
    if (reminder.delivery.channel === 'bot') {
      setDeliveryPlatform(reminder.delivery.platform);
      setDeliveryChatId(reminder.delivery.chatId);
    } else {
      setDeliveryPlatform('telegram');
      setDeliveryChatId('');
    }
    setFormDialogOpen(true);
  }

  function applyRunAtPreset(preset: 'ten-minutes' | 'one-hour' | 'tomorrow-morning' | 'next-monday') {
    setRunAtLocal(toPlanReminderDateTimeInputValue(planReminderPresetRunAt(preset)));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitDisabled || submitPendingRef.current) return;
    submitPendingRef.current = true;
    const input = {
      title: title.trim(),
      note: note.trim(),
      runAt: parsedRunAt,
      recurrence,
      ...(recurrence === 'cron' ? { cronExpression: cronExpression.trim() } : {}),
      delivery,
    };
    setSubmitPending(true);
    try {
      const result = editingId
        ? await props.onUpdate?.(editingId, input)
        : await props.onCreate?.({
          ...input,
          ...(input.note ? { note: input.note } : {}),
        });
      if (result !== false && planReminderMountedRef.current) {
        resetForm();
        setFormDialogOpen(false);
      }
    } finally {
      submitPendingRef.current = false;
      if (planReminderMountedRef.current) setSubmitPending(false);
    }
  }

  async function runPlanReminderAction(
    actionKey: string,
    action: (() => void | Promise<void>) | undefined,
  ) {
    if (!action || pendingActionKeysRef.current.has(actionKey)) return;
    const pendingWithAction = new Set(pendingActionKeysRef.current);
    pendingWithAction.add(actionKey);
    pendingActionKeysRef.current = pendingWithAction;
    setPendingActionKeys(pendingWithAction);
    try {
      await action();
    } finally {
      const pendingWithoutAction = new Set(pendingActionKeysRef.current);
      pendingWithoutAction.delete(actionKey);
      pendingActionKeysRef.current = pendingWithoutAction;
      if (planReminderMountedRef.current) setPendingActionKeys(pendingWithoutAction);
    }
  }

  async function refreshFromPanel() {
    if (!props.onRefresh || refreshPendingRef.current) return;
    refreshPendingRef.current = true;
    setRefreshPending(true);
    try {
      await props.onRefresh();
    } finally {
      refreshPendingRef.current = false;
      if (planReminderMountedRef.current) setRefreshPending(false);
    }
  }

  return (
    <div className="maka-plan-panel">
      <div className="maka-plan-shell agents-inner-view-clamp">
        <div className="maka-plan-hero">
          <div className="maka-plan-heading">
            <h2>定时任务</h2>
            <p>
              创建和管理周期性任务，让 Maka 按计划执行提醒、复盘和投递。
            </p>
          </div>
          <div className="maka-plan-top-actions" aria-label="计划提醒操作">
            <UiButton
              type="button"
              variant="quiet"
              size="icon-sm"
              className="maka-plan-refresh-button"
              onClick={() => void refreshFromPanel()}
              disabled={!props.onRefresh || refreshPending}
              aria-label={refreshPending ? '正在刷新定时任务' : '刷新定时任务'}
              aria-busy={refreshPending ? 'true' : undefined}
              title={refreshPending ? '正在刷新定时任务' : '刷新定时任务'}
            >
              <RefreshCcw size={15} strokeWidth={1.75} aria-hidden="true" />
            </UiButton>
            <UiButton
              type="button"
              variant="secondary"
              className="maka-plan-create-through"
              onClick={openCreateReminderDialog}
            >
              <Sparkles size={14} strokeWidth={1.75} aria-hidden="true" />
              通过 Maka 创建
            </UiButton>
            <UiButton type="button" className="maka-plan-new-task-button" onClick={openCreateReminderDialog}>
              <Plus size={15} strokeWidth={1.75} aria-hidden="true" />
              新建定时任务
            </UiButton>
          </div>
        </div>

        {/* PR-UI-ALIGN-1 (2026-06-21): the inline example-template strip
            (每日新闻摘要 / 周末待办整理) cluttered the top of the page and has no
            equivalent in 参考实现, whose 定时任务 page goes straight
            header → info-banner → tabs → card grid. Templates now live only in
            the empty state (quick-start), so the populated/default view matches
            the reference's clean flow. */}

        <Alert variant="info" className="maka-plan-system-alert">
          <div className="maka-plan-system-alert-main">
            <Info strokeWidth={1.75} aria-hidden="true" />
            <div>
              <AlertTitle>计划提醒会在本机唤醒时运行</AlertTitle>
              <AlertDescription>
                Maka 会保留执行记录；重复提醒、机器人投递和手动触发都走同一套计划队列。
              </AlertDescription>
            </div>
          </div>
          <div className="maka-plan-system-alert-switch">
            <span>保持系统唤醒</span>
            <Switch checked={false} disabled aria-label="保持系统唤醒暂未启用" />
          </div>
        </Alert>

        <CapabilityAuditStrip report={auditReport} focus="automations" />

        <TabsRoot
          className="maka-plan-tabs"
          value={planView}
          onValueChange={(value) => {
            if (value === 'tasks' || value === 'runs') setPlanView(value);
          }}
        >
          <div className="maka-plan-tabs-bar">
            <TabsList className="maka-plan-tabs-list" aria-label="计划提醒视图">
              <TabsTrigger className="maka-plan-tab" value="tasks">
                我的定时任务
                <span>{props.reminders.length}</span>
              </TabsTrigger>
              <TabsTrigger className="maka-plan-tab" value="runs">
                执行记录
                <span>{visibleRunEntries.length}</span>
              </TabsTrigger>
            </TabsList>
            {planView === 'tasks' ? (
              <div className="maka-plan-toolbar" aria-label="计划提醒筛选">
                <label className="maka-plan-compact-select maka-plan-sort-select">
                  <span>排序</span>
                  <PlanReminderSelect
                    value={listSort}
                    onChange={(value) => setListSort(value)}
                    ariaLabel="定时任务排序"
                    options={[
                      ['created-desc', '按创建时间倒序'],
                      ['next-run-asc', '按下次触发升序'],
                      ['updated-desc', '按更新时间倒序'],
                    ] satisfies ReadonlyArray<readonly [PlanReminderSort, string]>}
                  />
                </label>
                <label className="maka-plan-search">
                  <span>搜索计划提醒</span>
                  <Input
                    value={listQuery}
                    onChange={(event) => setListQuery(event.currentTarget.value)}
                    maxLength={120}
                    placeholder="搜索标题、备注、投递或执行记录…"
                  />
                </label>
                <label className="maka-plan-compact-select">
                  <span>状态</span>
                  <PlanReminderSelect
                    value={listFilter}
                    onChange={(value) => setListFilter(value)}
                    ariaLabel="计划提醒筛选"
                    options={[
                      ['all', `全部 ${filterCounts.all}`],
                      ['scheduled', `待触发 ${filterCounts.scheduled}`],
                      ['paused', `已暂停 ${filterCounts.paused}`],
                      ['completed', `已完成 ${filterCounts.completed}`],
                    ] satisfies ReadonlyArray<readonly [PlanReminderListFilter, string]>}
                  />
                </label>
              </div>
            ) : (
              <div className="maka-plan-toolbar maka-plan-toolbar-compact" aria-label="执行记录筛选">
                <label className="maka-plan-compact-select">
                  <span>范围</span>
                  <PlanReminderSelect
                    value={runRange}
                    onChange={(value) => setRunRange(value)}
                    ariaLabel="执行记录范围"
                    options={[
                      ['day', '今天'],
                      ['week', '近 7 天'],
                      ['month', '近 30 天'],
                      ['all', '全部记录'],
                    ] satisfies ReadonlyArray<readonly [PlanReminderRunRange, string]>}
                  />
                </label>
              </div>
            )}
          </div>

          <TabsPanel className="maka-plan-tab-panel" value="tasks">
            {normalizedListQuery && (
              <div className="maka-plan-search-summary" role="status" aria-live="polite">
                <span>找到 {searchMatchedReminders.length} 个匹配提醒</span>
                <UiButton type="button" variant="ghost" size="sm" onClick={() => setListQuery('')}>清除搜索</UiButton>
              </div>
            )}
            {props.reminders.length === 0 ? (
              <div className="maka-plan-empty-wrap" data-mode="starter-cards">
                <div className="maka-plan-template-strip" data-layout="cards" aria-label="定时任务示例模板">
                  {PLAN_REMINDER_EXAMPLE_TEMPLATES.map((template) => (
                    <UiButton
                      key={template.id}
                      type="button"
                      variant="ghost"
                      className="maka-plan-template-card"
                      onClick={() => openPlanReminderTemplate(template)}
                    >
                      <span className="maka-plan-template-icon" aria-hidden="true">
                        <span className="maka-plan-template-switch" />
                      </span>
                      <span className="maka-plan-template-main">
                        <span className="maka-plan-template-title">{template.title}</span>
                        <span className="maka-plan-template-note">{template.note}</span>
                      </span>
                      <span className="maka-plan-template-schedule">
                        <Clock size={13} strokeWidth={1.75} aria-hidden="true" />
                        {template.scheduleLabel}
                      </span>
                    </UiButton>
                  ))}
                </div>
              </div>
            ) : sortedReminders.length === 0 ? (
              <EmptyState
                Icon={Clock}
                title={normalizedListQuery ? '没有匹配的提醒' : '当前筛选没有提醒'}
                body={normalizedListQuery ? '调整搜索词，或切换状态筛选查看其他提醒。' : '切换筛选查看其他状态，或创建新的计划提醒。'}
                secondaryCta={{ label: '清除搜索', onClick: () => setListQuery(''), disabled: !normalizedListQuery }}
                extraClassName="maka-plan-empty"
              />
            ) : (
              <div className="maka-plan-card-grid agents-dual-card-row" aria-label="计划提醒列表">
                {sortedReminders.map((reminder) => {
                  const reminderActionPrefix = `${reminder.id}:`;
                  const reminderActionPending = Array.from(pendingActionKeys).some((key) => key.startsWith(reminderActionPrefix));
                  return (
                    <article key={reminder.id} className="maka-plan-card" data-status={reminder.status}>
                      <div className="maka-plan-card-chrome">
                        <Switch
                          checked={reminder.enabled}
                          disabled={reminderActionPending || reminder.status === 'completed'}
                          aria-label={reminder.enabled ? '暂停提醒' : '启用提醒'}
                          onCheckedChange={() => void runPlanReminderAction(`${reminder.id}:toggle`, () => props.onToggle?.(reminder.id, !reminder.enabled))}
                        />
                        <Menu>
                          <MenuTrigger
                            className="maka-plan-card-menu-trigger"
                            disabled={reminderActionPending}
                            aria-label="提醒操作"
                          >
                            <MoreHorizontal size={16} strokeWidth={1.75} aria-hidden="true" />
                          </MenuTrigger>
                          <MenuPopup className="maka-plan-card-menu" align="end">
                            <MenuItem
                              onClick={() => editReminder(reminder)}
                              disabled={submitPending || reminderActionPending || reminder.status === 'completed'}
                            >
                              <Pencil size={14} strokeWidth={1.75} aria-hidden="true" />
                              编辑
                            </MenuItem>
                            <MenuItem
                              onClick={() => duplicateReminder(reminder)}
                              disabled={submitPending || reminderActionPending}
                            >
                              <Copy size={14} strokeWidth={1.75} aria-hidden="true" />
                              复制
                            </MenuItem>
                            <MenuItem
                              onClick={() => void runPlanReminderAction(`${reminder.id}:trigger`, () => props.onTriggerNow?.(reminder.id))}
                              disabled={reminderActionPending || !reminder.enabled}
                            >
                              <RefreshCcw size={14} strokeWidth={1.75} aria-hidden="true" />
                              {pendingActionKeys.has(`${reminder.id}:trigger`) ? '触发中…' : '立即触发'}
                            </MenuItem>
                            <MenuItem
                              onClick={() => void runPlanReminderAction(`${reminder.id}:snooze`, () => props.onSnooze?.(reminder.id))}
                              disabled={reminderActionPending || !reminder.enabled || reminder.status !== 'scheduled' || typeof reminder.nextRunAt !== 'number'}
                            >
                              <Clock size={14} strokeWidth={1.75} aria-hidden="true" />
                              {pendingActionKeys.has(`${reminder.id}:snooze`) ? '延后中…' : '延后 10 分钟'}
                            </MenuItem>
                            <MenuItem
                              onClick={() => void runPlanReminderAction(`${reminder.id}:clear-runs`, () => props.onClearRunHistory?.(reminder.id))}
                              disabled={reminderActionPending || reminder.runs.length === 0 || reminder.status === 'completed'}
                            >
                              <ArchiveRestore size={14} strokeWidth={1.75} aria-hidden="true" />
                              {pendingActionKeys.has(`${reminder.id}:clear-runs`) ? '清空中…' : '清空记录'}
                            </MenuItem>
                            <MenuItem
                              variant="destructive"
                              onClick={() => void runPlanReminderAction(`${reminder.id}:delete`, () => props.onDelete?.(reminder.id))}
                              disabled={reminderActionPending}
                            >
                              <Trash2 size={14} strokeWidth={1.75} aria-hidden="true" />
                              {pendingActionKeys.has(`${reminder.id}:delete`) ? '删除中…' : '删除'}
                            </MenuItem>
                          </MenuPopup>
                        </Menu>
                      </div>
                      <div className="maka-plan-card-main">
                        <div className="maka-plan-card-title-row">
                          <h3 className="maka-plan-card-title">{reminder.title}</h3>
                          <Badge variant={reminder.status === 'scheduled' ? 'success' : reminder.status === 'paused' ? 'warning' : 'secondary'}>
                            {planReminderStatusLabel(reminder.status)}
                          </Badge>
                        </div>
                        <p className="maka-plan-card-note">
                          {reminder.note || `触发后投递到：${formatPlanReminderDeliveryTarget(reminder.delivery)}`}
                        </p>
                        {reminder.lastRun && (
                          <div className="maka-plan-card-run">
                            {runStatusLabel(reminder.lastRun.status)}：{reminder.lastRun.message}
                          </div>
                        )}
                      </div>
                      <div className="maka-plan-card-footer">
                        <span className="maka-plan-card-chip">
                          <Clock size={13} strokeWidth={1.75} aria-hidden="true" />
                          {reminder.nextRunAt ? (
                            <>
                              下次触发：{formatReminderTime(reminder.nextRunAt)}
                              <span className="maka-plan-card-countdown">{formatReminderCountdown(reminder.nextRunAt)}</span>
                            </>
                          ) : reminder.lastRun ? (
                            `最近 ${formatReminderTime(reminder.lastRun.at)}`
                          ) : (
                            '未安排'
                          )}
                        </span>
                        <span className="maka-plan-card-chip">
                          <Repeat size={13} strokeWidth={1.75} aria-hidden="true" />
                          {formatPlanRecurrence(reminder)}
                        </span>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </TabsPanel>

          <TabsPanel className="maka-plan-tab-panel" value="runs">
            {visibleRunEntries.length === 0 ? (
              <EmptyState
                Icon={Clock}
                title="暂无执行记录"
                body="提醒触发、手动执行或投递失败后，会在这里保留最近记录。"
                extraClassName="maka-plan-empty maka-plan-runs-empty"
              />
            ) : (
              <div className="maka-plan-run-list" aria-label="计划提醒执行记录">
                {visibleRunEntries.map(({ reminder, run }) => (
                  <article key={`${reminder.id}:${run.id}`} className="maka-plan-run-row">
                    <div className="maka-plan-run-status" data-status={run.status}>
                      {runStatusLabel(run.status)}
                    </div>
                    <div className="maka-plan-run-main">
                      <strong>{reminder.title}</strong>
                      <span>{run.message}</span>
                    </div>
                    <time>{formatReminderTime(run.at)}</time>
                  </article>
                ))}
              </div>
            )}
          </TabsPanel>
        </TabsRoot>
      </div>

      <DialogRoot
        open={formDialogOpen}
        onOpenChange={(open) => {
          if (open) {
            setFormDialogOpen(true);
          } else {
            closeReminderDialog();
          }
        }}
      >
        <DialogContent
          className="maka-plan-dialog w-[min(92vw,680px)] p-0"
          aria-labelledby="maka-plan-dialog-title"
          showClose={false}
        >
          <form className="maka-plan-form" onSubmit={submit} aria-busy={submitPending ? 'true' : undefined}>
            <header className="maka-plan-form-header">
              <div>
                <p className="maka-plan-eyebrow">计划提示词</p>
                <h3 id="maka-plan-dialog-title" className="maka-plan-form-title">{isEditing ? '编辑提醒' : '新建提醒'}</h3>
              </div>
              <DialogClose
                render={<UiButton variant="quiet" size="icon-sm" />}
                type="button"
                onClick={closeReminderDialog}
                disabled={formInteractionDisabled}
                aria-label="关闭计划提醒表单"
              >
                <X size={16} strokeWidth={1.8} aria-hidden="true" />
              </DialogClose>
            </header>
            <div className="maka-plan-form-grid">
              <label className="maka-plan-field">
                <span>标题</span>
                <Input
                  value={title}
                  onChange={(event) => setTitle(event.currentTarget.value)}
                  maxLength={120}
                  data-maka-plan-title-input="true"
                  placeholder="例如：明天复盘项目进度"
                  disabled={formInteractionDisabled}
                />
              </label>
              <label className="maka-plan-field">
                <span>时间</span>
                <Input
                  value={runAtLocal}
                  onChange={(event) => setRunAtLocal(event.currentTarget.value)}
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="2026-06-05 13:44"
                  aria-label="提醒时间"
                  disabled={formInteractionDisabled}
                />
              </label>
            </div>
            <div className="maka-plan-presets" aria-label="快速设置提醒时间">
              {[
                ['ten-minutes', '10 分钟后'],
                ['one-hour', '1 小时后'],
                ['tomorrow-morning', '明天 9 点'],
                ['next-monday', '下周一 9 点'],
              ].map(([preset, label]) => (
                <UiButton
                  key={preset}
                  type="button"
                  variant="secondary"
                  className="maka-plan-preset"
                  onClick={() => applyRunAtPreset(preset as 'ten-minutes' | 'one-hour' | 'tomorrow-morning' | 'next-monday')}
                  disabled={formInteractionDisabled}
                >
                  {label}
                </UiButton>
              ))}
            </div>
            <div className="maka-plan-form-grid">
              <label className="maka-plan-field">
                <span>重复</span>
                <PlanReminderSelect
                  value={recurrence}
                  onChange={(value) => setRecurrence(value)}
                  disabled={formInteractionDisabled}
                  ariaLabel="重复"
                  options={[
                    ['none', '不重复'],
                    ['daily', '每天'],
                    ['weekly', '每周'],
                    ['monthly', '每月'],
                    ['cron', 'Cron'],
                  ] satisfies ReadonlyArray<readonly [PlanReminderRecurrence, string]>}
                />
              </label>
              <label className="maka-plan-field">
                <span>投递</span>
                <PlanReminderSelect
                  value={deliveryChannel}
                  onChange={(value) => setDeliveryChannel(value)}
                  disabled={formInteractionDisabled}
                  ariaLabel="投递"
                  options={[
                    ['local', '本地提醒'],
                    ['bot', '机器人聊天'],
                  ] satisfies ReadonlyArray<readonly [PlanReminderDeliveryTarget['channel'], string]>}
                />
              </label>
            </div>
            {recurrence === 'cron' && (
              <label className="maka-plan-field">
                <span>Cron</span>
                <Input
                  value={cronExpression}
                  onChange={(event) => setCronExpression(event.currentTarget.value)}
                  maxLength={80}
                  placeholder="例如 0 9 * * 1-5"
                  disabled={formInteractionDisabled}
                />
              </label>
            )}
            {deliveryChannel === 'bot' && (
              <>
                <div className="maka-plan-delivery-grid">
                  <label className="maka-plan-field">
                    <span>平台</span>
                    <PlanReminderSelect
                      value={deliveryPlatform}
                      onChange={(value) => setDeliveryPlatform(value)}
                      disabled={formInteractionDisabled}
                      ariaLabel="平台"
                      options={BOT_DELIVERY_PROVIDERS.map((provider) => {
                        const brand = BOT_BRAND[provider];
                        const icon = (
                          <IconifyIcon
                            icon={brand.iconifyId}
                            width="100%"
                            height="100%"
                            aria-hidden="true"
                            fallback={<>{brand.glyph}</>}
                          />
                        );
                        return [provider, botDisplayLabel(provider), icon] as const;
                      })}
                    />
                  </label>
                  <label className="maka-plan-field">
                    <span>Chat ID</span>
                    <Input
                      value={deliveryChatId}
                      onChange={(event) => setDeliveryChatId(event.currentTarget.value)}
                      maxLength={160}
                      placeholder="例如 Telegram chat_id"
                      disabled={formInteractionDisabled}
                    />
                  </label>
                </div>
                <p className="maka-plan-delivery-help">
                  当前可投递到 {formatPlanDeliveryProviderList()}；其它机器人平台不会出现在投递目标里。
                </p>
              </>
            )}
            <label className="maka-plan-field maka-plan-prompt-field">
              <span>备注</span>
              <UiTextarea
                value={note}
                onChange={(event) => setNote(event.currentTarget.value)}
                maxLength={1000}
                rows={5}
                placeholder="可选：补充需要提醒的上下文"
                disabled={formInteractionDisabled}
              />
            </label>
            {validationMessage && (
              <p className="maka-plan-validation" role="status" aria-live="polite">
                {validationMessage}
              </p>
            )}
            <footer className="maka-plan-form-footer">
              <UiButton
                className="maka-button maka-plan-submit"
                variant="secondary"
                type="button"
                onClick={closeReminderDialog}
                disabled={formInteractionDisabled}
              >
                取消
              </UiButton>
              <UiButton className="maka-button maka-plan-submit" type="submit" disabled={submitDisabled}>
                {isEditing ? <Check size={14} strokeWidth={1.75} aria-hidden="true" /> : <Plus size={14} strokeWidth={1.75} aria-hidden="true" />}
                <span>{submitPending ? (isEditing ? '保存中…' : '创建中…') : (isEditing ? '保存提醒' : '创建提醒')}</span>
              </UiButton>
            </footer>
          </form>
        </DialogContent>
      </DialogRoot>
    </div>
  );
}










/**
 * Lifecycle status badge in the chat header (PR109b §9.8). Visual
 * tone matches the SessionStatusIcon mapping so the sidebar row icon
 * and the header badge read as the same status.
 */
function SessionStatusBadge(props: {
  badge: {
    status: string;
    label: string;
    tone: 'accent' | 'warning' | 'destructive' | 'info' | 'success' | 'muted' | 'neutral';
    tooltip?: string;
  };
}) {
  return (
    <span
      className="maka-chat-header-status"
      data-tone={props.badge.tone}
      data-status={props.badge.status}
      role="status"
      aria-label={props.badge.tooltip ?? props.badge.label}
      title={props.badge.tooltip ?? props.badge.label}
    >
      <span>{props.badge.label}</span>
    </span>
  );
}





const SCROLL_BOTTOM_THRESHOLD = 64; // px

// Back-compat alias for the helper introduced in PR-UI-14.
const detectPromptSuggestionLocale = detectUiLocale;


interface PermissionModeMeta {
  label: string;
  hint: string;
  tone: 'info' | 'accent' | 'caution';
}

/**
 * PR-MOVE-PERMISSION-MODE (WAWQAQ msgs 47fe0d0e / 21993dcc / a667cf6c
 * 2026-06-23): the user-facing permission-mode picker is now a
 * three-option dropdown sitting in the composer left-controls instead
 * of a 3-chip switcher at the chat header. The `explore` (read-only)
 * mode was retired from the picker — for an agent that can't write
 * or run anything, the mode is "not useful". Internally `explore`
 * still exists in the `PermissionMode` enum because Deep Research
 * sessions and Bot-incoming guards use it as their default; the
 * picker collapses those sessions to display `询问权限` so the user
 * sees a coherent option.
 *
 * Labels follow WAWQAQ's a667cf6c renaming — direct, action-led copy
 * instead of engineering shorthand.
 */
const PERMISSION_MODE_META: Record<PermissionMode, PermissionModeMeta> = {
  explore: {
    label: '只读模式',
    hint: '只读模式：读取、列表、搜索直通，写入或网络仍需明确确认。Deep Research 默认走这档；不再出现在用户切换里。',
    tone: 'info',
  },
  ask: {
    label: '询问权限',
    hint: '每次工具调用前都弹出对话框让你确认。最稳健，适合需要盯着 agent 干活的场景。',
    tone: 'accent',
  },
  execute: {
    label: '自动执行',
    hint: '常见工具直通，破坏性操作、特权操作和浏览器操作仍会停下来确认。',
    tone: 'caution',
  },
  bypass: {
    label: 'Bypass permissions',
    hint: '跳过全部工具确认，包括破坏性操作、特权操作和浏览器操作。只在完全信任本轮任务时使用。',
    tone: 'caution',
  },
};

const PERMISSION_MODE_ORDER: PermissionMode[] = ['ask', 'execute', 'bypass'];

export interface ChatHeaderAlert {
  /** Visual tone — drives badge color in the chat header. */
  tone: 'info' | 'warning' | 'destructive';
  /** Short label shown inside the chat header (e.g. "需要重新登录"). */
  label: string;
  /**
   * Optional longer explanation rendered as the badge's `title` attribute
   * (native browser tooltip). Use this to explain WHY the badge is up
   * without bloating the label — e.g. "原会话使用演示 backend，发送时
   * 会切换到默认连接".
   */
  tooltip?: string;
  /** Optional click handler — e.g. open Settings · 账号 to fix it. */
  onClick?(): void;
}

export function ChatView(props: {
  messages: StoredMessage[];
  streamingText: string;
  /** True after upstream emitted the final assistant text, while the UI is draining the smoother. */
  streamingComplete?: boolean;
  /** Assistant message id hidden while the matching streaming bubble drains. */
  streamingMessageId?: string;
  /** Called once the streaming bubble has displayed the final text and can hand off to history. */
  onStreamingSettled?(): void;
  /**
   * PR-UI-LAYOUT-42: Anthropic extended-thinking stream from
   * `ThinkingDeltaEvent` (`@maka/core/events`). When non-empty, a
   * collapsible "Reasoning" panel renders above the streaming text
   * so users with thinking models see the live reasoning while the
   * answer is being composed. Empty string = no thinking active.
   */
  thinkingText?: string;
  /**
   * PR-UI-C0 review fixup (@kenji msg 7885a347): true when the
   * renderer's `applyThinkingDelta` / `applyThinkingComplete` helper
   * dropped or truncated content (per-delta cap, per-session total
   * cap). `<ReasoningPanel>` renders a "已截断" pill in the header
   * when true so the user knows the visible reasoning is bounded.
   */
  thinkingTruncated?: boolean;
  /**
   * PR-UI-Cx (@kenji msg cd09bcac): true when the renderer's
   * `applyAssistantDelta` chokepoint either tail-kept a single
   * oversize delta or head-capped the per-session total. The
   * streaming bubble renders a small "已截断" affordance so the
   * user knows the visible answer is bounded.
   */
  streamingTruncated?: boolean;
  tools: ToolActivityItem[];
  activeSession?: SessionSummary;
  activeConnectionLabel?: string;
  activeModel?: string;
  activeModelLabel?: string;
  /** Renders a provider brand mark next to the model name in the chat tab. */
  activeProviderType?: ProviderType;
  /** Optional renderer for the provider mark; supplied by the desktop app to
   *  avoid bringing the full provider SVG library into @maka/ui. */
  renderProviderMark?(type: ProviderType): ReactNode;
  modelChoices?: ChatModelChoice[];
  modelChangePending?: boolean;
  onModelChange?(input: { llmConnectionSlug: string; model: string }): void | Promise<void>;
  /** Personalized user label shown on user messages. Falls back to "你". */
  userLabel?: string;
  /**
   * PR-MEMORY-VISIBILITY-INDICATOR-0 — true when the agent is reading
   * local MEMORY.md content into the system prompt this session.
   * Drives a subtle pill in the chat header so the user remembers
   * memory is in effect (kenji `19b0996f` boundary: no implicit
   * durable memory; xuan `c06e13f` MVP + yuejing PR-MEMORY-PROMPT-
   * INJECT-0 wiring).
   */
  memoryActive?: boolean;
  /** Click target for the memory pill — usually opens Settings · 记忆. */
  onOpenMemorySettings?(): void;
  mode: NavSelection['section'];
  /**
   * When the user has no real LLM connection configured, the empty state
   * defers to this slot. App renders `<OnboardingHero>` here; if undefined,
   * the regular prompt-suggestion hero shows.
   */
  emptyOverride?: ReactNode;
  /**
   * Surfaces a small status pill in the chat header — used to expose a
   * `needs_reauth` / `error` connection state from the credential
   * lifecycle directly into the chat surface so the user notices before
   * sending another doomed message.
   */
  connectionAlert?: ChatHeaderAlert;
  /**
   * Visible health for the renderer's live session-event subscription.
   * Used when the stream goes stale and the desktop shell is refreshing
   * from persisted messages/session state.
   */
  eventStreamAlert?: ChatHeaderAlert;
  /** Error from loading the active session's persisted message log. */
  messageLoadError?: string;
  messageLoadRetryPending?: boolean;
  onRetryMessages?(): void;
  /**
   * Lifecycle status badge for the active session (PR109b, design-system
   * §9.8). Separate from `connectionAlert` because the alert is an
   * ephemeral fault signal while status is the session's settled
   * lifecycle position. Hidden for `active` (default) to reduce noise.
   */
  sessionStatusBadge?: {
    status: string;
    label: string;
    tone: 'accent' | 'warning' | 'destructive' | 'info' | 'success' | 'muted' | 'neutral';
    tooltip?: string;
  };
  /**
   * PR109d-b: footer actions per turn, keyed by turnId. The renderer
   * (apps/desktop/src/renderer/main.tsx) computes these from
   * `deriveTurnFooterActions()` over each turn's `TurnStatus` + lineage
   * state, then hands them in. Keeps the action policy with the
   * consumer that has visibility into the full turn list.
   */
  turnFooterActionsByTurn?: Record<string, ReadonlyArray<TurnFooterActionMeta>>;
  onTurnFooterAction?: (turnId: string, actionId: TurnFooterActionMeta['id']) => void;
  /**
   * PR109e-d/e: per-turn metadata for failed banner + lineage badges.
   * Renderer computes from materialized turns + lineage map + the
   * generalized error-class mapping (`describeTurnErrorClass()`),
   * keeping enum-to-Chinese translation outside @maka/ui.
   */
  turnFailedReasonLabels?: Record<string, string>;
  turnFailedRecoveryLabels?: Record<string, string>;
  turnLineageBadgesByTurn?: Record<string, TurnLineageBadge[]>;
  onLineageBadgeClick?: (targetTurnId: string) => void;
  skills?: SkillEntry[];
  onRefreshSkills?(): void | Promise<void>;
  onCreateSkillTemplate?(): void | Promise<void>;
  onOpenSkill?(skillId: string): void | Promise<void>;
  onOpenSkillsFolder?(): void | Promise<void>;
  planReminders?: PlanReminder[];
  onRefreshPlanReminders?: () => void | Promise<void>;
  onCreatePlanReminder?(input: PlanReminderDraftInput): boolean | Promise<boolean> | void | Promise<void>;
  onUpdatePlanReminder?(id: string, patch: PlanReminderUpdatePatch): boolean | Promise<boolean> | void | Promise<void>;
  onTogglePlanReminder?: (id: string, enabled: boolean) => void | Promise<void>;
  onTriggerPlanReminderNow?: (id: string) => void | Promise<void>;
  onSnoozePlanReminder?: (id: string) => void | Promise<void>;
  onClearPlanReminderRunHistory?: (id: string) => void | Promise<void>;
  onDeletePlanReminder?: (id: string) => void | Promise<void>;
  dailyReviewBridge?: DailyReviewBridge;
  onCopyDailyReviewMarkdown?: (input: DailyReviewMarkdownActionInput) => Promise<void> | void;
  onAppendDailyReviewMarkdown?: (input: DailyReviewMarkdownActionInput) => Promise<void> | void;
  onSaveDailyReviewMarkdown?: (input: DailyReviewMarkdownActionInput) => Promise<void> | void;
  onSelectSession?: (sessionId: string) => void;
  /**
   * Search-result navigation target. The desktop shell owns session
   * switching and hands the matched turn id here after selection; the
   * chat view only scrolls/highlights the already-rendered turn.
   */
  scrollTargetTurn?: { turnId: string; nonce: number };
  scrollBehavior?: ScrollBehavior;
  /**
   * PR109f: when the active session is a branched session
   * (`parentSessionId` set on its summary), show a banner above the
   * chat surface so the user knows they're in a derived conversation
   * and can jump back to the parent.
   *
   * Renderer (main.tsx) resolves the parent name from the connections /
   * sessions list — @maka/ui never queries the storage layer directly.
   */
  branchBanner?: {
    parentSessionId: string;
    parentSessionName: string;
    /**
     * Set when the branch starting point was an aborted turn. UI shows
     * "从中断前分支" copy so the user understands the branch starts
     * from before the cancel point, not from the abort itself.
     */
    fromAbortedTurn?: boolean;
  };
  onBranchBannerClick?: (parentSessionId: string) => void;
  onNew(): void;
  onPromptSuggestion?(prompt: string): void;
}) {
  // chat + storedTools survive for the empty-state and streaming-bubble
  // paths; the main message log is now driven by `turns` (per @kenji UI-04
  // turn-grouping projection).
  const visibleMessages = props.streamingComplete && props.streamingMessageId
    ? props.messages.filter((message) => !(message.type === 'assistant' && message.id === props.streamingMessageId))
    : props.messages;
  const chat = materializeChat(visibleMessages);
  const storedTools = materializeTools(visibleMessages);
  const tools = mergeTools(storedTools, props.tools);
  const turns = materializeTurns(visibleMessages, props.tools);
  const capabilityAuditReport = useMemo(
    () => deriveCapabilityAuditReport({
      skills: props.skills ?? [],
      planReminders: props.planReminders ?? [],
    }),
    [props.skills, props.planReminders],
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pinnedToBottom, setPinnedToBottom] = useState(true);
  const [highlightedTurnId, setHighlightedTurnId] = useState<string | null>(null);

  // Reset to "pinned at bottom" whenever the active session changes. Without
  // this, switching from a long history to a fresh chat would keep the
  // previous scrollTop and the user wouldn't see their last message.
  useEffect(() => {
    setPinnedToBottom(true);
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [props.activeSession?.id]);

  // Auto-scroll on new content if the user is already at (or near) the
  // bottom. If they've scrolled up to read history we don't yank them back.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !pinnedToBottom) return;
    el.scrollTop = el.scrollHeight;
  }, [chat.length, props.streamingText, tools.length, pinnedToBottom]);

  useEffect(() => {
    const target = props.scrollTargetTurn;
    if (!target?.turnId) return;
    const frame = window.requestAnimationFrame(() => {
      const root = scrollRef.current;
      if (!root) return;
      const el = root.querySelector(`[data-turn-id="${CSS.escape(target.turnId)}"]`);
      if (!el || !('scrollIntoView' in el)) return;
      const targetEl = el as HTMLElement;
      targetEl.setAttribute('tabindex', '-1');
      targetEl.scrollIntoView({
        behavior: props.scrollBehavior ?? 'smooth',
        block: 'center',
      });
      targetEl.focus({ preventScroll: true });
      setPinnedToBottom(false);
      setHighlightedTurnId(target.turnId);
    });
    const clear = window.setTimeout(() => {
      setHighlightedTurnId((current) => (current === target.turnId ? null : current));
    }, 2200);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(clear);
    };
  }, [props.scrollTargetTurn?.turnId, props.scrollTargetTurn?.nonce, props.scrollBehavior, props.activeSession?.id, props.messages]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setPinnedToBottom(distanceFromBottom <= SCROLL_BOTTOM_THRESHOLD);
  }

  function scrollToBottom() {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: props.scrollBehavior ?? 'smooth' });
    setPinnedToBottom(true);
  }

  if (props.mode === 'skills') {
    return (
      <SkillsModuleMain
        skills={props.skills}
        auditReport={capabilityAuditReport}
        onRefreshSkills={props.onRefreshSkills}
        onCreateSkillTemplate={props.onCreateSkillTemplate}
        onOpenSkill={props.onOpenSkill}
        onOpenSkillsFolder={props.onOpenSkillsFolder}
      />
    );
  }

  if (props.mode === 'automations') {
    return (
      <main className="maka-main detailPane maka-module-main agents-chat-panel" aria-label="定时任务">
        <PlanReminderPanel
          reminders={props.planReminders ?? []}
          auditReport={capabilityAuditReport}
          onRefresh={props.onRefreshPlanReminders}
          onCreate={props.onCreatePlanReminder}
          onUpdate={props.onUpdatePlanReminder}
          onToggle={props.onTogglePlanReminder}
          onTriggerNow={props.onTriggerPlanReminderNow}
          onSnooze={props.onSnoozePlanReminder}
          onClearRunHistory={props.onClearPlanReminderRunHistory}
          onDelete={props.onDeletePlanReminder}
        />
      </main>
    );
  }

  if (props.mode === 'daily-review') {
    return (
      <main
        className="maka-main detailPane maka-module-main agents-chat-panel"
        data-module="daily-review"
        aria-label="每日回顾"
      >
        <header className="maka-module-main-header">
          <div>
            <h2>每日回顾</h2>
            <p>查看本机对话、请求、Token、费用和工具调用汇总。</p>
          </div>
        </header>
        {props.dailyReviewBridge ? (
          <DailyReviewPanel
            bridge={props.dailyReviewBridge}
            onSelectSession={props.onSelectSession}
            onCopyMarkdown={props.onCopyDailyReviewMarkdown}
            onAppendMarkdown={props.onAppendDailyReviewMarkdown}
            onSaveMarkdown={props.onSaveDailyReviewMarkdown}
          />
        ) : (
          <EmptyState
            Icon={CalendarDays}
            title="等待连接每日回顾数据"
            body="桌面端数据桥当前未连接。"
          />
        )}
      </main>
    );
  }

  if (!props.activeSession) {
    return (
      <main className="maka-main detailPane agents-chat-panel agents-chat-view-root">
        {/* PR-REMOVE-CHAT-TAB (WAWQAQ msg d401938d 2026-06-23): the
            browser-style session tab + the duplicate "新建对话" plus
            button were removed. The session name lives in the sidebar;
            the new-task button at the top of the sidebar is the
            canonical create-session entry point. The chat header
            keeps the permission-mode switcher only. */}
        {/* PR-MOVE-PERMISSION-MODE: chat header no longer carries the
            permission-mode chips — the picker lives inside the composer's
            left controls so the new-session screen and active-session
            screen share the same "create / pick mode / send" rhythm. */}
        <header className="maka-chat-header" data-empty="true">
          <span className="maka-chat-header-spacer" />
        </header>
        <OverlayScrollArea
          className="maka-chat messages"
          viewportClassName="maka-chatViewport"
          contentClassName="maka-chatContent"
        >
          {props.emptyOverride ?? <EmptyChatHero onPromptSuggestion={props.onPromptSuggestion} userLabel={props.userLabel} />}
        </OverlayScrollArea>
      </main>
    );
  }

  const isLocalSimulationBackend = props.activeSession.backend === 'fake';
  const deepResearchActive = isDeepResearchSession(props.activeSession.labels);

  return (
    <main className="maka-main detailPane agents-chat-panel agents-chat-view-root">
      {/* PR-REMOVE-CHAT-TAB (WAWQAQ msg d401938d): no more browser-style
          session tab in the chat header. Session name + model live in
          the sidebar; the new-task button at the top of the sidebar is
          the canonical create-session entry. The chat header is now
          just a thin chrome strip carrying the permission-mode
          switcher and the per-session memory/mode chips. */}
      <header className="maka-chat-header">
        <span className="maka-chat-header-spacer" />
        {props.memoryActive && (
          /* PR-CHAT-HEADER-MEMORY-PILL-PRIMITIVE-0 (round 11/30):
             accent-tinted memory indicator pill in the chat
             header was a raw <button>. Routed through UiButton
             variant="quiet" — the bespoke `.maka-chat-header-
             memory-pill` class still owns the pill's tinted
             background, 999px border-radius, 11px font, and
             accent border. */
          <UiButton
            type="button"
            variant="quiet"
            className="maka-chat-header-memory-pill"
            data-active="true"
            onClick={() => props.onOpenMemorySettings?.()}
            title="本地 MEMORY.md 已加入 agent 系统提示。点击进入设置 · 记忆 管理。"
            aria-label="本地记忆已启用"
          >
            <BookOpen size={12} strokeWidth={1.75} aria-hidden="true" />
            <span>记忆</span>
          </UiButton>
        )}
        {deepResearchActive && (
          <span
            className="maka-chat-header-mode-pill"
            data-mode="deep-research"
            title="深度研究会话使用只读探索边界：先阅读和分析，默认不改文件。"
            aria-label="深度研究，只读探索"
          >
            <Sparkles size={12} strokeWidth={1.75} aria-hidden="true" />
            <span>深度研究</span>
          </span>
        )}
        {props.sessionStatusBadge && <SessionStatusBadge badge={props.sessionStatusBadge} />}
        {props.connectionAlert && <ChatHeaderAlertBadge alert={props.connectionAlert} />}
        {props.eventStreamAlert && <ChatHeaderAlertBadge alert={props.eventStreamAlert} />}
        {/* PR-MOVE-PERMISSION-MODE: switcher relocated into the
            composer left-controls. Header keeps the per-session status
            chips only. */}
      </header>
      {isLocalSimulationBackend && (
        <Alert variant="info" className="maka-fake-backend-banner" role="status">
          <AlertTriangle size={14} strokeWidth={1.75} aria-hidden="true" />
          <AlertDescription>
            当前会话来自旧的本地模拟连接。要拿到真实 LLM 回复，请到 <strong>设置 · 模型</strong> 添加 Anthropic / OpenAI / GLM 等 API key。
          </AlertDescription>
        </Alert>
      )}
      <div className="maka-chat-shell">
        {props.branchBanner && (
          <SessionBranchBanner
            banner={props.branchBanner}
            onClick={props.onBranchBannerClick}
          />
        )}
        <OverlayScrollArea
          ref={scrollRef}
          className="maka-chat messages"
          viewportClassName="maka-chatViewport"
          contentClassName="maka-chatContent"
          onScroll={onScroll}
        >
          {chat.length === 0 && !props.streamingText && (
            props.messageLoadError ? (
              <div role="alert" aria-busy={props.messageLoadRetryPending ? 'true' : undefined}>
                <EmptyState
                  Icon={AlertTriangle}
                  title="对话载入失败"
                  body={props.messageLoadError}
                  cta={props.onRetryMessages ? {
                    label: props.messageLoadRetryPending ? '载入中…' : '重试载入',
                    onClick: props.onRetryMessages,
                    disabled: props.messageLoadRetryPending,
                  } : undefined}
                />
              </div>
            ) : props.emptyOverride ?? (
              deepResearchActive ? (
                <DeepResearchEmptyHero onPromptSuggestion={props.onPromptSuggestion} />
              ) : (
                <EmptyChatHero onPromptSuggestion={props.onPromptSuggestion} userLabel={props.userLabel} />
              )
            )
          )}
          {turns.map((turn, idx) => {
            // PR-CHAT-NON-DEFAULT-MODEL-CHIP-0 (kenji `af77f61`
            // session-sticky merge): prefer comparing against the
            // session's sticky model when available, falling back
            // to the previous turn's modelId for older sessions
            // that pre-date the sticky-model field. Either way,
            // TurnSummary flags the chip when this turn departs
            // from the expected baseline.
            const expectedModelId =
              (props.activeSession?.model && props.activeSession.model.length > 0
                ? props.activeSession.model
                : undefined)
              ?? (() => {
                for (let i = idx - 1; i >= 0; i--) {
                  const earlier = turns[i];
                  if (earlier && earlier.modelId) return earlier.modelId;
                }
                return undefined;
              })();
            return (
              <TurnView
                key={turn.turnId}
                turn={turn}
                userLabel={props.userLabel}
                footerActions={props.turnFooterActionsByTurn?.[turn.turnId]}
                onFooterAction={(actionId) => props.onTurnFooterAction?.(turn.turnId, actionId)}
                failedReasonLabel={props.turnFailedReasonLabels?.[turn.turnId]}
                failedRecoveryLabel={props.turnFailedRecoveryLabels?.[turn.turnId]}
                lineageBadges={props.turnLineageBadgesByTurn?.[turn.turnId]}
                onLineageBadgeClick={props.onLineageBadgeClick}
                previousModelId={expectedModelId}
                searchHighlighted={highlightedTurnId === turn.turnId}
              />
            );
          })}
          {(props.streamingText || props.thinkingText) && (
            // PR-STREAM-TURN-CENTER: the in-flight answer must use the SAME
            // `.maka-turn` shell a committed turn uses. `.maka-turn` owns the
            // centered 680px reading column (max-width + margin:0 auto). A bare
            // `.message.assistant` instead left-aligns — its unlayered
            // margin-right:auto outranks `.maka-message-row`'s margin:0 auto —
            // so without this wrapper the streaming answer rendered ~110px left
            // of where it lands once committed, a visible horizontal jump on
            // text_complete. Wrapping here makes streaming structurally
            // identical to TurnView's committed turn.
            <section className="maka-turn maka-turn-streaming">
              <Message variant="assistant">
                {/* PR-UI-LAYOUT-42: Reasoning panel for Anthropic-style
                 * extended thinking. Renders ABOVE the streaming
                 * answer because thinking always precedes the
                 * answer. Default-open during streaming so the user
                 * sees the model reasoning; users can collapse it
                 * if too verbose. The panel disappears entirely on
                 * text_complete / abort / error (parent clears the
                 * thinkingBySession entry). */}
                {props.thinkingText && (
                  <ReasoningPanel
                    text={props.thinkingText}
                    live={!props.streamingText}
                    truncated={props.thinkingTruncated === true}
                  />
                )}
                {props.streamingText && (
                  <StreamingAssistantBubble
                    text={props.streamingText}
                    live={props.streamingComplete !== true}
                    truncated={props.streamingTruncated === true}
                    onSettled={props.onStreamingSettled}
                  />
                )}
              </Message>
            </section>
          )}
          {/* Defensive: if any tool ended up outside a turn (e.g. legacy
              sessions without turnId), render those at the very end so they
              still appear instead of vanishing. materializeTurns already
              folds these into the `__loose` turn, so this is normally a
              no-op. */}
        </OverlayScrollArea>
        {!pinnedToBottom && (
          <UiButton
            type="button"
            className="maka-chat-jump-bottom"
            variant="secondary"
            size="icon-sm"
            onClick={scrollToBottom}
            aria-label="跳到最新消息"
          >
            <ArrowDown size={16} strokeWidth={2} aria-hidden="true" />
          </UiButton>
        )}
      </div>
    </main>
  );
}

/**
 * Renders an individual chat message body.
 *
 * - `user` messages stay verbatim (whitespace + line breaks preserved); the
 *   user's literal input shouldn't be reinterpreted as markdown.
 * - `assistant` / `system` (and anything else) flow through the markdown
 *   renderer so code fences, lists, tables, and links display natively.
 *
 * Assistant messages get a hover Copy button that yanks the raw markdown
 * source to the clipboard.
 *
 * Memoized because chat scroll re-renders the whole list on every streaming
 * delta; this keeps already-final bubbles from re-parsing markdown.
 */
const MessageBody = memo(function MessageBody(props: { role: string; text: string; ts?: number }) {
  if (props.role === 'user') {
    // User turn: the message sits in a tinted, width-capped block aligned to
    // the right (so the right-anchor reads even for long messages), with a
    // quiet always-visible time + a copy affordance in a meta row beneath it.
    // The time is no longer hover-gated (was `opacity: 0` until hover, which
    // hid it from touch + assistive tech). Copy reuses MessageCopyButton in
    // `footerStyle`, so it's the same quiet ghost action as the assistant
    // turn footer's copy (same primitive + `markerVariants('footer-action')`).
    return (
      <>
        <Bubble variant="user">
          <span>{props.text}</span>
        </Bubble>
        <div className="maka-message-meta">
          {props.ts !== undefined && (
            <RelativeTime ts={props.ts} className="maka-message-time-inline" />
          )}
          <MessageCopyButton text={props.text} footerStyle />
        </div>
      </>
    );
  }
  // Assistant / system body: open prose, no bubble. Per-turn timing lives in
  // the turn summary; copy + the other actions live in the turn footer.
  return (
    <Bubble variant="assistant" className="maka-bubble-with-actions">
      <Markdown text={props.text} />
    </Bubble>
  );
});

function MessageCopyButton(props: { text: string; label?: string; footerStyle?: boolean }) {
  const copyFeedback = useClipboardCopyFeedback(1400, { redact: false });
  const copyPhase = copyFeedback.phaseFor('message');
  const copyPending = copyPhase === 'pending';
  const copied = copyPhase === 'copied';

  async function copy() {
    await copyFeedback.copy('message', props.text);
  }

  // `footerStyle` renders this copy as the SAME quiet ghost action the
  // assistant turn footer uses (`markerVariants('footer-action')` on a
  // UiButton variant="quiet" size="nav" — the bare size, with icon + "复制").
  // The user-message copy and the assistant copy then read as one button by
  // construction — same primitive, same class, same icon metrics — instead
  // of a look-alike bespoke treatment.
  const footer = props.footerStyle === true;
  const visibleLabel = footer ? (props.label ?? '复制') : props.label;
  const iconSize = footer ? 12 : 14;

  const baseLabel = props.label ?? (footer ? '复制' : '复制消息');
  const actionLabel = copyPhase === 'pending'
    ? '复制中'
    : copyPhase === 'copied'
      ? '已复制'
      : copyPhase === 'failed'
        ? '复制失败'
        : baseLabel;
  return (
    <UiButton
      type="button"
      className={footer ? markerVariants({ variant: 'footer-action' }) : 'maka-message-copy'}
      variant="quiet"
      // `nav` is the bare size: the footer-action marker shell owns its own
      // height/padding/font (see `markerVariants`), so it doesn't inherit —
      // and then have to merge out — `sm`'s `h-8`/`px-2.5`/`text-xs`.
      size={footer ? 'nav' : 'icon-sm'}
      onClick={() => void copy()}
      aria-label={copyPhase ? `${actionLabel} · ${baseLabel}` : baseLabel}
      aria-busy={copyPending ? 'true' : undefined}
      disabled={copyPending}
      data-copied={copied}
      data-copy-feedback={copyPhase ?? undefined}
      data-pending={copyPending ? 'true' : undefined}
      data-labelled={(!footer && props.label) ? 'true' : undefined}
    >
      {copied ? <Check size={iconSize} strokeWidth={2} aria-hidden="true" /> : <Copy size={iconSize} strokeWidth={footer ? 2 : 1.75} aria-hidden="true" />}
      {visibleLabel && <span>{copyPhase === 'pending' ? '复制中…' : copyPhase === 'failed' ? '复制失败' : copied ? '已复制' : visibleLabel}</span>}
    </UiButton>
  );
}


/**
 * Locale-aware copy bundle for the empty-chat hero. Mirrors the
 * locale split applied to `PROMPT_SUGGESTIONS_BY_LOCALE` (PR-UI-14)
 * so the eyebrow, headline, and intro paragraph don't fall back to
 * Chinese while the chips switch to English.
 *
 * PR-UI-LAYOUT-4 (@yuejing 2026-05-22): time-of-day greeting in the
 * headline, matching the reference screenshot 1 ("晚上好，安静的夜晚适合
 * 深度思考"). The greeting hook is a tiny calm touch but it makes
 * the empty-chat surface read as a welcoming space rather than a
 * generic "start typing" prompt. We bucket the local hour into four
 * windows (morning / noon / afternoon / evening) and render
 * `${greeting}{label}` if the user set a display name, otherwise
 * just the greeting + a softer fallback line.
 */

/**
 * Small actionable pill that surfaces a credential / readiness issue
 * inline in the chat header. Kept neutral about the source — it just
 * renders a tone + label and an optional click handler. The connection
 * lifecycle helper in the desktop renderer decides when to mount this.
 */
function ChatHeaderAlertBadge(props: { alert: ChatHeaderAlert }) {
  const { tone, label, tooltip, onClick } = props.alert;
  if (onClick) {
    return (
      <UiButton
        className="maka-chat-header-alert"
        variant="quiet"
        size="sm"
        data-tone={tone}
        type="button"
        onClick={onClick}
        aria-label={tooltip ?? label}
        title={tooltip}
      >
        <AlertTriangle size={12} strokeWidth={2} aria-hidden="true" />
        <span>{label}</span>
      </UiButton>
    );
  }
  return (
    <span
      className="maka-chat-header-alert"
      data-tone={tone}
      aria-label={tooltip ?? label}
      title={tooltip}
    >
      <AlertTriangle size={12} strokeWidth={2} aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}

// PR-MOVE-PERMISSION-MODE: the chat-header `PermissionModeSwitcher`
// radiogroup was deleted. Mode picking now lives inside the composer's
// left-controls dropdown (see Composer + maka-composer-mode-chip / -menu)
// so the picker sits where you actually start typing, matching the
// reference product. The `radiogroup` keyboard contract was traded for
// base-ui Menu's built-in arrow/Home/End handling.

/**
 * PR-RELATIVE-TIME-0: a self-refreshing relative-time label. Sidebar +
 * message rows stay correct even when the window has been open for
 * hours without re-rendering on their own. The tick cadence comes from
 * `nextRelativeRefreshDelay` so we tick every second within the first
 * minute, every minute within the first hour, then every 10 minutes;
 * past the 7-day horizon we stop ticking and show the absolute date.
 */
export function RelativeTime(props: { ts: number; className?: string; suppressTitle?: boolean }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const delay = nextRelativeRefreshDelay(props.ts);
    if (delay === null) return;
    const id = setTimeout(() => setTick((n) => n + 1), delay);
    return () => clearTimeout(id);
  });
  return (
    <small
      className={props.className ?? 'maka-message-time'}
      aria-hidden="true"
      title={props.suppressTitle ? undefined : formatAbsoluteTimestamp(props.ts)}
    >
      {formatRelativeTimestamp(props.ts)}
    </small>
  );
}

/**
 * Compact summary strip rendered between the user message and the tools/
 * answer for the current turn. Surfaces the @kenji UI-04 follow-up
 * questions: which model, how many tools, how long. Only renders when at
 * least one signal is present so an in-flight first-render doesn't show
 * an empty chip strip.
 */
function TurnSummary(props: { turn: TurnViewModel; previousModelId?: string }) {
  const { turn } = props;
  const hasModel = Boolean(turn.modelId);
  // PR-CHAT-NON-DEFAULT-MODEL-CHIP-0: per-turn override is allowed
  // but must be visible (kenji 3-way decision lock 7749c411).
  // When the prior turn used a different model, mark this turn's
  // model chip with a "切换" pill so the user notices.
  const modelSwitched =
    hasModel
    && typeof props.previousModelId === 'string'
    && props.previousModelId.length > 0
    && props.previousModelId !== turn.modelId;
  const hasTools = turn.tools.length > 0;
  // Show duration only when the assistant has actually landed (durationMs
  // is computed from assistant.ts). For in-progress turns we render an
  // "进行中" pill instead of a number that would tick up forever — per
  // @kenji's PR82 review.
  const hasDuration = turn.durationMs !== undefined && turn.durationMs > 0;
  const inProgress = turn.status === 'running' && turn.user !== undefined && turn.assistant === undefined;
  const hasTokens = Boolean(turn.tokens && (turn.tokens.input > 0 || turn.tokens.output > 0));
  // costUsd is only meaningful when present AND > 0 — never fabricate a
  // "$0.00" hover, that reads as false precision (also @kenji PR82 review).
  const hasCost = turn.tokens?.costUsd !== undefined && turn.tokens.costUsd > 0;
  if (!hasModel && !hasTools && !hasDuration && !hasTokens && !inProgress) return null;
  return (
    <Marker variant="summary" aria-label="本轮对话摘要">
      {hasModel && (
        <Marker
          as="span"
          variant="summary-chip"
          data-kind="model"
          data-switched={modelSwitched ? 'true' : undefined}
          title={
            modelSwitched
              ? `本轮使用 ${turn.modelId}，session 期望 ${props.previousModelId}`
              : turn.modelId
          }
        >
          <code>{turn.modelId}</code>
          {modelSwitched && (
            <Marker as="span" variant="summary-switched" aria-label="本轮切换了模型">
              切换
            </Marker>
          )}
        </Marker>
      )}
      {hasTools && (
        <Marker as="span" variant="summary-chip" data-kind="tools">
          {turn.tools.length} 个工具
        </Marker>
      )}
      {hasDuration ? (
        <Marker as="span" variant="summary-chip" data-kind="duration">
          {formatTurnDuration(turn.durationMs!)}
        </Marker>
      ) : inProgress ? (
        <Marker as="span" variant="summary-chip" data-kind="duration" data-state="in-progress">
          进行中
        </Marker>
      ) : null}
      {hasTokens && (
        <Marker
          as="span"
          variant="summary-chip"
          data-kind="tokens"
          title={hasCost ? `$${turn.tokens!.costUsd!.toFixed(4)}` : undefined}
        >
          {turn.tokens!.input.toLocaleString()} → {turn.tokens!.output.toLocaleString()} tok
        </Marker>
      )}
    </Marker>
  );
}


/**
 * Renders one conversational turn: user message → tools used → assistant
 * answer, in that order, as a single visual unit. Replaces the previous
 * "message stack + tools panel at end" layout so the user sees the
 * narrative of "ask → tools fired → answer" as one work unit.
 */
function TurnView(props: {
  turn: TurnViewModel;
  userLabel?: string;
  /**
   * PR109d-b: footer actions derived from `TurnStatus` + lineage map
   * by the consumer (renderer/main.tsx). Each action carries its
   * own `enabled` flag + tooltip; @maka/ui doesn't compute these
   * itself so the policy stays in the renderer where the lineage
   * map is built.
   */
  footerActions?: ReadonlyArray<TurnFooterActionMeta>;
  onFooterAction?: (actionId: TurnFooterActionMeta['id']) => void;
  /**
   * PR109e-d: pre-translated Chinese phrase for a failed turn's
   * `errorClass`. Caller computes via `describeTurnErrorClass()`.
   * Undefined for non-failed turns or when the runtime didn't
   * populate `errorClass`. UI never sees the raw enum identifier.
   */
  failedReasonLabel?: string;
  /**
   * PR-PawWork-run-incident-lite: pre-derived recovery guidance for a failed
   * turn. Caller computes this from error class, retained partial output, and
   * tool activity so the banner can distinguish "retry" from "inspect tool
   * output first".
   */
  failedRecoveryLabel?: string;
  /**
   * PR109e-e: forward + reverse lineage badges. The renderer
   * computes the labels (with short turn ids) and click targets;
   * @maka/ui just renders the badge UI.
   */
  lineageBadges?: TurnLineageBadge[];
  /** PR109e-e: invoked when the user clicks a lineage badge. The
   *  renderer scrolls the target turn into view. */
  onLineageBadgeClick?: (targetTurnId: string) => void;
  /**
   * PR-CHAT-NON-DEFAULT-MODEL-CHIP-0: the most-recent prior turn's
   * assistant modelId, used by TurnSummary to flag a per-turn
   * model switch (kenji `7749c411` lock decision: per-turn override
   * is allowed but MUST be visible).
   */
  previousModelId?: string;
  /** True when a search result just navigated to this turn. */
  searchHighlighted?: boolean;
}) {
  const { turn } = props;
  const forwardBadges = props.lineageBadges?.filter((b) => b.direction === 'forward') ?? [];
  const reverseBadges = props.lineageBadges?.filter((b) => b.direction === 'reverse') ?? [];
  return (
    <section
      className="maka-turn"
      data-turn-id={turn.turnId}
      data-search-highlight={props.searchHighlighted ? 'true' : undefined}
      tabIndex={props.searchHighlighted ? -1 : undefined}
    >
      {forwardBadges.length > 0 && (
        <Marker variant="lineage-row" aria-label="本轮回答的来源">
          {forwardBadges.map((badge) => (
            <UiButton
              key={badge.id}
              type="button"
              className={markerVariants({ variant: 'lineage-badge' })}
              variant="quiet"
              size="nav"
              data-direction="forward"
              title={badge.tooltip ?? badge.label}
              onClick={() => props.onLineageBadgeClick?.(badge.targetTurnId)}
            >
              <GitBranch size={11} strokeWidth={2} aria-hidden="true" />
              <span>{badge.label}</span>
            </UiButton>
          ))}
        </Marker>
      )}
      {turn.user && (
        <Message
          variant="user"
          aria-label="你发送的消息"
          title={turn.user.ts ? formatAbsoluteTimestamp(turn.user.ts) : undefined}
        >
          <MessageBody role="user" text={turn.user.text} ts={turn.user.ts} />
        </Message>
      )}
      <TurnSummary turn={turn} previousModelId={props.previousModelId} />

      {turn.notes.map((note) => (
        <Message
          key={note.id}
          variant="system"
          title={note.ts ? formatAbsoluteTimestamp(note.ts) : undefined}
        >
          <MessageBody role="system" text={note.text} ts={note.ts} />
        </Message>
      ))}
      {turn.tools.length > 0 && (
        <div className="maka-turn-tools">
          <ToolActivity items={turn.tools} />
        </div>
      )}
      {turn.assistant && (
        <Message
          variant="assistant"
          data-turn-status={turn.status}
          aria-label="Maka 的回答"
          title={turn.assistant.ts ? formatAbsoluteTimestamp(turn.assistant.ts) : undefined}
        >
          <div className="flex flex-col">
            {turn.assistantThinking && (
              <details className="maka-turn-thinking">
                <summary>
                  <span>查看思考过程</span>
                  <span className="maka-turn-thinking-note">模型推理草稿，不是最终答案</span>
                </summary>
                <div className="maka-turn-thinking-body">
                  <Markdown text={turn.assistantThinking} />
                  <div className="maka-turn-thinking-actions">
                    <MessageCopyButton text={turn.assistantThinking} label="复制思考过程" />
                  </div>
                </div>
              </details>
            )}
            {/* PR109d-c: aborted turn body gets a muted "(已中断)" prefix
                + Ban icon so the user can see this turn was cancelled
                without it looking like a fault state (which is reserved
                for `failed`). Lives in the message body wrapper so the
                Copy button below still copies the assistant text without
                the prefix. */}
            {turn.status === 'aborted' && (
              <Marker variant="aborted" role="status">
                <Ban size={12} strokeWidth={2} aria-hidden="true" />
                <em>{turnAbortMarkerLabel(turn.abortSource)}</em>
              </Marker>
            )}
            {/* PR109e-d: failed turn AlertOctagon banner with generalized
                Chinese copy (no raw `errorClass` leak per @kenji gate #3).
                Caller passes the pre-translated `failedReasonLabel` —
                @maka/ui doesn't know how to translate the runtime enum;
                that mapping lives in `session-status-presentation.ts`
                via `describeTurnErrorClass()`. */}
            {turn.status === 'failed' && props.failedReasonLabel && (
              <Marker variant="failed-banner" role="alert">
                <Marker as="span" variant="failed-icon" aria-hidden="true">
                  <AlertOctagon size={14} strokeWidth={2} />
                </Marker>
                <span>{props.failedReasonLabel}</span>
                {props.failedRecoveryLabel && (
                  <Marker as="span" variant="failed-recovery">{props.failedRecoveryLabel}</Marker>
                )}
              </Marker>
            )}
            <MessageBody role="assistant" text={turn.assistant.text} ts={turn.assistant.ts} />
          </div>
          {reverseBadges.length > 0 && (
            <Marker variant="lineage-row-reverse" aria-label="本轮回答的衍生">
              {reverseBadges.map((badge) => (
                <UiButton
                  key={badge.id}
                  type="button"
                  className={markerVariants({ variant: 'lineage-badge' })}
                  variant="quiet"
                  size="nav"
                  data-direction="reverse"
                  title={badge.tooltip ?? badge.label}
                  onClick={() => props.onLineageBadgeClick?.(badge.targetTurnId)}
                >
                  <GitBranch size={11} strokeWidth={2} aria-hidden="true" />
                  <span>{badge.label}</span>
                </UiButton>
              ))}
            </Marker>
          )}
          {props.footerActions && props.footerActions.length > 0 && (
            <TurnFooterActions
              actions={props.footerActions}
              onAction={props.onFooterAction}
              assistantText={turn.assistant.text}
            />
          )}
        </Message>
      )}
    </section>
  );
}

/**
 * Turn footer actions row (PR109d-b). Renders icon+text buttons for
 * `重试 / 重新生成 / 分支 / 复制` driven by the pure helper's enabled
 * matrix. Disabled buttons stay rendered so the user can see what
 * actions exist on the turn; click handlers no-op when disabled.
 *
 * Copy action is handled locally (write to clipboard) so the
 * consumer doesn't need a clipboard IPC for it. Other actions
 * (retry / regenerate / branch) bubble up via `onAction`.
 */
export interface TurnFooterActionMeta {
  id: 'retry' | 'regenerate' | 'branch' | 'copy';
  label: string;
  enabled: boolean;
  tooltip?: string;
}

/**
 * Branched session banner (PR109f). Surfaces above the chat surface
 * when the active session has `parentSessionId` set. Click jumps the
 * user back to the parent session.
 */
function SessionBranchBanner(props: {
  banner: {
    parentSessionId: string;
    parentSessionName: string;
    fromAbortedTurn?: boolean;
  };
  onClick?: (parentSessionId: string) => void;
}) {
  const { banner } = props;
  return (
    <UiButton
      type="button"
      className="maka-session-branch-banner"
      variant="quiet"
      size="sm"
      data-from-aborted={banner.fromAbortedTurn || undefined}
      onClick={() => props.onClick?.(banner.parentSessionId)}
      aria-label={banner.fromAbortedTurn
        ? `从中断前分支自 ${banner.parentSessionName} · 点击跳回原会话`
        : `分自 ${banner.parentSessionName} · 点击跳回原会话`}
    >
      <GitBranch size={12} strokeWidth={2} aria-hidden="true" />
      <span>
        {banner.fromAbortedTurn
          ? `从中断前分支自 ${banner.parentSessionName}`
          : `分自 ${banner.parentSessionName}`}
      </span>
    </UiButton>
  );
}

/**
 * Lineage badge rendered on a turn, either pointing to its origin
 * ("重试自 turn ${id}") or to a descendant ("已重试 → turn ${id}").
 * Renderer (main.tsx) computes the labels and targets from the lineage
 * map; @maka/ui renders the badge UI. PR109e-e.
 */
export interface TurnLineageBadge {
  /** Stable key for React. */
  id: string;
  /** Chinese label. UI surfaces it verbatim — caller is responsible for
   *  generalized phrasing (never expose enum identifiers). */
  label: string;
  /** Optional tooltip / aria-label override. Falls back to `label`. */
  tooltip?: string;
  /** Click target turn id. Renderer scrolls + highlights that turn. */
  targetTurnId: string;
  /**
   * Forward = "this turn was retried/regenerated from another";
   * reverse = "another turn descends from this one". UI shows them
   * in different positions (forward at top, reverse at bottom).
   */
  direction: 'forward' | 'reverse';
}

function TurnFooterActions(props: {
  actions: ReadonlyArray<TurnFooterActionMeta>;
  onAction?: (actionId: TurnFooterActionMeta['id']) => void;
  /** Assistant text used by the inline copy action. */
  assistantText?: string;
}) {
  const [copyPhase, setCopyPhase] = useState<ClipboardCopyPhase | null>(null);
  const copyPendingRef = useRef(false);
  const copyResetTimerRef = useRef<number | null>(null);
  const copyMountedRef = useRef(true);

  function clearCopyResetTimer() {
    if (copyResetTimerRef.current === null) return;
    window.clearTimeout(copyResetTimerRef.current);
    copyResetTimerRef.current = null;
  }

  useEffect(() => {
    copyMountedRef.current = true;
    return () => {
      copyMountedRef.current = false;
      clearCopyResetTimer();
    };
  }, []);

  function settleCopy(phase: Exclude<ClipboardCopyPhase, 'pending'>) {
    if (!copyMountedRef.current) return;
    setCopyPhase(phase);
    copyResetTimerRef.current = window.setTimeout(() => {
      if (!copyMountedRef.current) return;
      setCopyPhase(null);
      copyResetTimerRef.current = null;
    }, 1400);
  }

  async function copyAssistantText() {
    if (!props.assistantText || copyPendingRef.current) return;
    copyPendingRef.current = true;
    clearCopyResetTimer();
    setCopyPhase('pending');
    try {
      await navigator.clipboard.writeText(props.assistantText);
      settleCopy('copied');
    } catch {
      settleCopy('failed');
    } finally {
      copyPendingRef.current = false;
    }
  }

  async function handleClick(action: TurnFooterActionMeta) {
    if (!action.enabled) return;
    if (action.id === 'copy') {
      await copyAssistantText();
      return;
    }
    props.onAction?.(action.id);
  }
  return (
    <Marker variant="footer" role="toolbar" aria-label="本轮回答操作">
      {props.actions.map((action) => {
        // Per @kenji review: pending state must keep the original button
        // label visible (not a spinner-only) so screen readers can hear
        // which action is processing. `data-pending` + `aria-busy="true"`
        // are the signals — the `footer-action` marker shell renders as a
        // bare `quiet` button in every state, so pending never keys off the
        // Button `variant`, and no presentation-priority hook is emitted.
        const isPending = action.tooltip === '正在处理…';
        const isCopyAction = action.id === 'copy';
        const copyIsPending = isCopyAction && copyPhase === 'pending';
        const copyFeedbackLabel = copyPhase === 'pending'
          ? '复制中…'
          : copyPhase === 'copied'
            ? '已复制'
            : copyPhase === 'failed'
              ? '复制失败'
              : action.label;
        const isActionPending = isPending || copyIsPending;
        return (
          <UiButton
            key={action.id}
            type="button"
            className={markerVariants({ variant: 'footer-action' })}
            variant="quiet"
            size="nav"
            data-action={action.id}
            data-pending={isActionPending || undefined}
            data-copy-feedback={isCopyAction && copyPhase ? copyPhase : undefined}
            disabled={!action.enabled || copyIsPending}
            aria-disabled={!action.enabled || copyIsPending}
            aria-busy={isActionPending || undefined}
            title={action.tooltip ?? action.label}
            onClick={() => void handleClick(action)}
          >
            {isCopyAction && copyPhase === 'copied' ? <Check size={12} strokeWidth={2} aria-hidden="true" /> : STATUS_FOOTER_ICON[action.id]}
            <span>{isCopyAction ? copyFeedbackLabel : action.label}</span>
          </UiButton>
        );
      })}
    </Marker>
  );
}

const STATUS_FOOTER_ICON: Record<TurnFooterActionMeta['id'], ReactNode> = {
  retry: <Repeat size={12} strokeWidth={2} aria-hidden="true" />,
  regenerate: <RefreshCcw size={12} strokeWidth={2} aria-hidden="true" />,
  branch: <GitBranch size={12} strokeWidth={2} aria-hidden="true" />,
  copy: <Copy size={12} strokeWidth={2} aria-hidden="true" />,
};

/**
 * PR-UI-LAYOUT-42 — ReasoningPanel: collapsible "thinking" panel for
 * Anthropic-style extended thinking. Renders the live
 * `ThinkingDeltaEvent.text` (or final `ThinkingCompleteEvent.text`)
 * accumulated by the renderer in `thinkingBySession`.
 *
 * Default-open during streaming so the user sees the live reasoning;
 * collapses to a single-line summary if user clicks the header. The
 * panel itself is wrapped in a `<details>` for native keyboard a11y
 * (Space/Enter toggles).
 *
 * `live=true` means thinking is still streaming (no text yet). Adds
 * a small pulse dot in the header so users see motion.
 *
 * The text inside is rendered as `<pre>` so the model's
 * step-by-step reasoning preserves indentation / line breaks. We
 * don't pipe through Markdown — thinking is usually plain prose +
 * occasional code, and full markdown would slow the streaming.
 */
/**
 * PR-UI-RENDER-1 — streaming assistant bubble.
 *
 * Wraps the live `streamingText` in `useSmoothStreamContent` so the
 * visible text grows at the EMA-tracked arrival CPS instead of
 * lurching with each network chunk. On `text_complete`, the parent keeps
 * the bubble mounted with `live=false` so the smoother can drain the final
 * tail before settled history takes over. Abort / error still unmount
 * immediately.
 *
 * `live=false` after `text_complete`: keep the bubble mounted until
 * the smoother catches up, then notify the parent to hand off to history.
 */
function StreamingAssistantBubble(props: { text: string; live: boolean; truncated?: boolean; onSettled?: () => void }) {
  // PR-UI-C1 review fixup (@kenji msg fbb8f119): the smoother
  // typewriters PREFIXES of its input string. If the raw text
  // contains a mid-delta secret like `Authorization: Bearer sk-...`,
  // prefixes such as `Authorization: Bearer s` don't match any
  // redaction pattern by themselves and would leak to the DOM for
  // a frame or two before the downstream Markdown redactor sees
  // the full token. `prepareSmoothStreamText` runs `redactSecrets`
  // on the FULL raw text BEFORE the smoother sees it, so every
  // displayed prefix is guaranteed secret-free.
  //
  // PR-UI-Cx (@kenji msg cd09bcac): `props.text` is already the
  // post-redaction post-cap output of `applyAssistantDelta` (parent
  // ran the chokepoint inside `setStreamingBySession` updater),
  // so the smoother only sees safe text. `prepareSmoothStreamText`
  // here is defense-in-depth — `redactSecrets` is idempotent on
  // already-masked text, and the gate guarantees the smoother
  // contract holds even if a future caller forgets the chokepoint.
  const snap = useStreamSnap();
  const safeText = prepareSmoothStreamText(props.text);
  const { displayed, catchingUp } = useSmoothStreamContent(safeText, {
    streaming: props.live,
    snap,
  });
  const settledRef = useRef(false);

  useEffect(() => {
    settledRef.current = false;
  }, [safeText, props.live]);

  useEffect(() => {
    if (props.live || catchingUp || settledRef.current) return;
    settledRef.current = true;
    props.onSettled?.();
  }, [props.live, catchingUp, props.onSettled]);

  return (
    <Bubble variant="assistant" className="maka-bubble-streaming">
      <Markdown text={displayed} />
      {props.truncated && (
        <div
          className="mt-1.5 inline-block cursor-help rounded-[4px] border border-[oklch(from_var(--warning)_l_c_h_/_0.24)] bg-[oklch(from_var(--warning)_l_c_h_/_0.05)] px-[5px] text-[10px] text-[color:var(--warning-text,var(--info-text))]"
          role="status"
          aria-live="polite"
          title="助手输出已超过单次回合上限，超出部分未渲染。如需完整内容请重新生成或查看持久化的会话日志。"
        >
          已截断
        </div>
      )}
    </Bubble>
  );
}

function ReasoningPanel(props: { text: string; live: boolean; truncated: boolean }) {
  // PR-UI-RENDER-1 + PR-UI-C0: smooth-stream the thinking text on top
  // of the C0 redaction/cap chokepoint. `props.text` is the already-
  // redacted-and-capped buffer (renderer ran it through
  // `applyThinkingDelta` / `applyThinkingComplete` before passing
  // here), so the smoother is purely a visual frame-pacing layer.
  //
  // C1 review fixup (@kenji msg fbb8f119) — defense in depth: even
  // though C0 already redacted, we run `prepareSmoothStreamText`
  // again before the smoother. `redactSecrets` is idempotent on
  // already-masked text, and the gate guarantees the smoother
  // contract ("smoother never sees raw secrets") holds even if a
  // future change accidentally bypasses the C0 chokepoint.
  //
  // `live=true` means thinking is still flowing (no answer yet) →
  // streaming=true so the smoother typewriters. `live=false` means
  // `thinking_complete` already fired (caller passes a settled blob)
  // → streaming=false, hook snaps. Reduced-motion / visual-smoke
  // also forces snap so deterministic capture sees the final text
  // immediately.
  const snap = useStreamSnap();
  const safeText = prepareSmoothStreamText(props.text);
  const { displayed } = useSmoothStreamContent(safeText, {
    streaming: props.live,
    snap,
  });
  // PR-UI-RENDER-1 @kenji review concern #4 — explicitly controlled
  // open state. With a raw `open` JSX attribute, React's reconciler
  // could re-assert the open state and undo the user's manual collapse
  // on the next stream-driven re-render (the smoother re-renders at
  // ~60Hz while the stream is live, so any reconciliation drift is
  // immediately visible to the user). Owning the open state via
  // useState + onToggle makes the panel uncontrolled-from-React's-view:
  // the user's collapse sticks because we only write `open` from our
  // own state, which we only mutate from the onToggle callback.
  // Default-open at mount so users see the reasoning by default; first
  // click toggles to closed and that sticks.
  const [open, setOpen] = useState(true);
  return (
    <details
      className="maka-reasoning-panel"
      data-live={props.live ? 'true' : undefined}
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="maka-reasoning-panel-header">
        {props.live && <span className="maka-reasoning-panel-dot" aria-hidden="true" />}
        <span className="maka-reasoning-panel-label">
          {props.live ? '正在思考…' : '思考过程'}
        </span>
        {/* PR-UI-C0 review fixup (@kenji msg 7885a347): "已截断" pill
            fires when `applyThinkingDelta` / `applyThinkingComplete`
            dropped content (per-delta cap or per-session total cap).
            Same chrome family as the A3 tool-output truncated pill. */}
        {props.truncated && (
          <span
            className="maka-reasoning-panel-truncated"
            data-truncated="true"
            title="部分 reasoning 已截断；显示的是最近的内容"
          >
            已截断
          </span>
        )}
        <span className="maka-reasoning-panel-chevron" aria-hidden="true">›</span>
      </summary>
      <pre className="maka-reasoning-panel-body">{displayed}</pre>
    </details>
  );
}

/**
 * PR-UI-RENDER-1 — reduced-motion / visual-smoke probe for the
 * streaming smoother.
 *
 * Three triggers force the smoother to snap (mirroring the rule in
 * `apps/desktop/src/renderer/scroll-motion-policy.ts`):
 *
 *   1. `data-maka-reduced-motion="true"` — set by the PR-IR-04
 *      reduced variant of the visual-smoke fixture.
 *   2. `data-maka-visual-smoke="true"` — set by ANY visual-smoke
 *      capture so screenshots see the final text on the first paint.
 *   3. OS-level `prefers-reduced-motion: reduce`.
 *
 * The hook reads the dataset attributes once on mount (they're set
 * pre-React in main.tsx and don't toggle during a session) but
 * subscribes to `matchMedia` for the OS preference so a mid-session
 * toggle reaches the running stream.
 */
function useStreamSnap(): boolean {
  const [snap, setSnap] = useState(() => readStreamSnap());
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setSnap(readStreamSnap());
    // Initial read (in case dataset attrs landed after first paint).
    setSnap(readStreamSnap());
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', onChange);
      return () => mq.removeEventListener('change', onChange);
    }
    return undefined;
  }, []);
  return snap;
}

function readStreamSnap(): boolean {
  if (typeof document === 'undefined' || typeof window === 'undefined') return true;
  const root = document.documentElement;
  if (root.dataset.makaReducedMotion === 'true') return true;
  if (root.dataset.makaVisualSmoke === 'true') return true;
  if (typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }
  return false;
}

const COMPOSER_MAX_HEIGHT = 240;

/**
 * PR-UI-15 (@yuejing 2026-05-22): Composer copy is locale-aware.
 *
 * Audit §3.5 — placeholder + state copy were hardcoded zh and drifted
 * stylistically from OnboardingHero's quickChat input (which used a
 * long example sentence as the placeholder). Unified style: both
 * surfaces show the same short action-oriented placeholder, and
 * OnboardingHero gets a separate `<small>` example hint below the
 * textarea so first-run users still know what to type.
 */
const COMPOSER_COPY_BY_LOCALE: Record<UiLocale, {
  placeholder: string;
  textareaAriaLabel: string;
  awaitingPermission: string;
  sending: string;
  streamingHintPrefix: string;
  streamingHintInterrupt: string;
}> = {
  zh: {
    placeholder: '描述任务  /  快捷调用  @  添加上下文',
    textareaAriaLabel: '消息输入框',
    awaitingPermission: '等待你确认权限…',
    sending: '正在发送…',
    // PR-UX-POLISH-1 (yuejing UX audit msg `9c779b56`): composer streaming
    // hint now reads `正在回答` so it doesn't conflict with the
    // ReasoningPanel's `正在思考` (which displays the model's actual
    // extended-thinking stream). Composer = output-streaming;
    // ReasoningPanel = reasoning-streaming; distinct signals, distinct copy.
    streamingHintPrefix: 'Maka 正在回答…',
    streamingHintInterrupt: '或点停止中断',
  },
  en: {
    placeholder: 'Describe a task, / for commands, @ for context…',
    textareaAriaLabel: 'Message input',
    awaitingPermission: 'Waiting for your permission decision…',
    sending: 'Sending…',
    // PR-UX-POLISH-1: parallel en-locale fix — `is responding` instead of
    // `is thinking`, so it doesn't collide with the ReasoningPanel's
    // `Thinking…` label.
    streamingHintPrefix: 'Maka is responding…',
    streamingHintInterrupt: 'or click Stop to interrupt',
  },
};

const COMPOSER_BUTTON_COPY_BY_LOCALE: Record<UiLocale, { sendLabel: string; stopLabel: string }> = {
  zh: { sendLabel: '发送', stopLabel: '停止' },
  en: { sendLabel: 'Send', stopLabel: 'Stop' },
};

export interface ComposerHandle {
  /** Replace the textarea value and resize, leaving focus on the input. */
  setText(text: string): void;
  /** Append a prompt/context fragment after the existing draft instead of replacing it. */
  appendText(text: string): void;
  /** Move focus to the textarea without changing its content. */
  focus(): void;
}

type ComposerImportActionId = 'file' | 'folder' | 'drop' | 'paste';

export const Composer = forwardRef<
  ComposerHandle,
  {
    disabled?: boolean;
    hidden?: boolean;
    /**
     * When true, the assistant is currently streaming a response.
     * Toolbar swaps to a "Maka 正在回答…" hint and the Stop button is
     * the only visible action — Send is hidden because the model is busy.
     */
    streaming?: boolean;
    /** True while the current streaming session is processing a stop request. */
    stopPending?: boolean;
    /** Runtime-only key used to keep unsent drafts isolated per session. */
    draftKey?: string;
    onSend(text: string): boolean | void | Promise<boolean | void>;
    onStop(): void | Promise<void>;
    onImportTextFile?(): void | Promise<void>;
    onImportFolderOutline?(): void | Promise<void>;
    onImportDroppedTextFiles?(files: File[]): void | Promise<void>;
    modelLabel?: string;
    activeSession?: SessionSummary;
    activeConnectionLabel?: string;
    activeModel?: string;
    activeModelLabel?: string;
    modelChoices?: ChatModelChoice[];
    /** Renders the provider brand mark on each group heading of the model menus;
     *  injected by the desktop app to keep the provider SVG library out of @maka/ui. */
    renderProviderMark?(type: ProviderType): ReactNode;
    modelChangePending?: boolean;
    onModelChange?(input: { llmConnectionSlug: string; model: string }): void | Promise<void>;
    /**
     * Home / empty-state composer only (no active session yet): the model
     * the next new chat will start with, and the picker callback. When set,
     * the otherwise-static model chip becomes a real dropdown so the user can
     * choose the new-chat model inline instead of only via Settings · 模型.
     */
    newChatModel?: { llmConnectionSlug: string; model: string };
    onPickNewChatModel?(input: { llmConnectionSlug: string; model: string }): void | Promise<void>;
    /**
     * Empty-state only: no models are configured yet, so the model chip is a
     * non-interactive label. When provided, the chip becomes a button into
     * Settings · 模型 instead of wearing a dropdown chevron it cannot honor.
     */
    onOpenModelSettings?(): void;
    workspacePicker?: {
      label?: string;
      branch?: string | null;
      pending?: boolean;
      onOpen(): void;
    };
    /**
     * PR-MOVE-PERMISSION-MODE (WAWQAQ 47fe0d0e + a667cf6c): the
     * permission mode picker lives inside the composer left-controls
     * instead of the chat header. Composer renders a dropdown labelled
     * by the current mode (询问权限 / 自动执行 / Bypass permissions);
     * selecting an option fires `onPermissionModeChange`. When the
     * active session is in the legacy `explore` mode the picker
     * collapses to display 询问权限 — explore is internal-only now and
     * won't surface here.
     */
    permissionMode?: PermissionMode;
    permissionModePending?: boolean;
    permissionModeDisabledReason?: string;
    onPermissionModeChange?(mode: PermissionMode): void | Promise<void>;
  }
>(function Composer(props, ref) {
  const formRef = useRef<HTMLFormElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [dragActive, setDragActive] = useState(false);
  const [sendPending, setSendPending] = useState(false);
  const [pendingImportAction, setPendingImportAction] = useState<ComposerImportActionId | null>(null);
  const [hasDraftText, setHasDraftText] = useState(false);
  const draftStoreRef = useRef<Map<string, string>>(new Map());
  const activeDraftKeyRef = useRef<string | undefined>(props.draftKey);
  const composerMountedRef = useRef(true);
  const sendPendingRef = useRef(false);
  const pendingImportActionRef = useRef<ComposerImportActionId | null>(null);
  const promptHistoryRef = useRef<ComposerHistoryState>({ entries: [], index: -1, savedDraft: '' });
  // PR-UI-15: locale-aware copy for placeholder + toolbar states. We
  // detect once per render (cheap) rather than memoizing — the locale
  // is effectively constant for the lifetime of the renderer but the
  // few ns of detection cost beats wiring up a context provider just
  // for this bundle.
  const locale = detectUiLocale();
  const copy = COMPOSER_COPY_BY_LOCALE[locale];
  const buttonCopy = COMPOSER_BUTTON_COPY_BY_LOCALE[locale];

  useEffect(() => {
    composerMountedRef.current = true;
    return () => {
      composerMountedRef.current = false;
      sendPendingRef.current = false;
      pendingImportActionRef.current = null;
    };
  }, []);

  function autoResize() {
    const el = textareaRef.current;
    if (!el) return;
    // Standard "reset to auto, then set to scrollHeight" trick so the
    // textarea can both grow and shrink as the user edits. Cap at
    // COMPOSER_MAX_HEIGHT so it never pushes the chat surface off-screen;
    // overflow becomes an internal scroll past that.
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT)}px`;
  }

  function saveCurrentDraft(value?: string) {
    const nextValue = value ?? textareaRef.current?.value ?? '';
    rememberComposerDraft(draftStoreRef.current, activeDraftKeyRef.current, nextValue);
    setHasDraftText(Boolean(nextValue.trim()));
  }

  function resetPromptHistoryNavigation() {
    promptHistoryRef.current = {
      entries: promptHistoryRef.current.entries,
      index: -1,
      savedDraft: '',
    };
  }

  useEffect(() => {
    const el = textareaRef.current;
    const previousKey = activeDraftKeyRef.current;
    const nextKey = props.draftKey;

    if (previousKey !== nextKey) {
      rememberComposerDraft(draftStoreRef.current, previousKey, el?.value ?? '');
      activeDraftKeyRef.current = nextKey;
      resetPromptHistoryNavigation();
      if (el) {
        const nextDraft = readComposerDraft(draftStoreRef.current, nextKey);
        el.value = nextDraft;
        setHasDraftText(Boolean(nextDraft.trim()));
        autoResize();
        const length = el.value.length;
        el.setSelectionRange(length, length);
      }
    }
  }, [props.draftKey]);

  useImperativeHandle(
    ref,
    () => ({
      setText(text: string) {
        const el = textareaRef.current;
        if (!el) return;
        resetPromptHistoryNavigation();
        el.value = text;
        saveCurrentDraft(text);
        autoResize();
        el.focus();
        // Move caret to end so the user can keep typing.
        const length = el.value.length;
        el.setSelectionRange(length, length);
      },
      appendText(text: string) {
        const el = textareaRef.current;
        if (!el) return;
        resetPromptHistoryNavigation();
        el.value = appendPromptContextDraft(el.value, text);
        saveCurrentDraft(el.value);
        autoResize();
        el.focus();
        const length = el.value.length;
        el.setSelectionRange(length, length);
      },
      focus() {
        textareaRef.current?.focus();
      },
    }),
    [],
  );

  async function sendCurrent() {
    if (props.disabled || sendPendingRef.current || pendingImportActionRef.current) return;
    const textarea = textareaRef.current;
    const form = formRef.current;
    const text = (textarea?.value ?? '').trim();
    if (!text) return;
    const submittedDraftKey = activeDraftKeyRef.current;
    sendPendingRef.current = true;
    setSendPending(true);
    let sent: boolean | void;
    try {
      sent = await props.onSend(text);
    } finally {
      sendPendingRef.current = false;
      if (composerMountedRef.current) setSendPending(false);
    }
    if (!composerMountedRef.current) return;
    if (sent === false) return;
    promptHistoryRef.current = {
      entries: rememberComposerHistoryEntry(promptHistoryRef.current.entries, text),
      index: -1,
      savedDraft: '',
    };
    rememberComposerDraft(draftStoreRef.current, submittedDraftKey, '');
    saveCurrentDraft('');
    form?.reset();
    // form.reset() empties the textarea but doesn't fire input — collapse
    // manually so the composer snaps back to its single-row footprint.
    if (textarea) {
      textarea.style.height = '';
      autoResize();
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void sendCurrent();
  }

  async function runImportAction(actionId: ComposerImportActionId, action: (() => void | Promise<void>) | undefined) {
    if (!action || props.disabled || props.streaming || pendingImportActionRef.current) return;
    pendingImportActionRef.current = actionId;
    setPendingImportAction(actionId);
    try {
      await action();
    } finally {
      if (pendingImportActionRef.current === actionId) {
        pendingImportActionRef.current = null;
        if (composerMountedRef.current) setPendingImportAction(null);
      }
    }
  }

  function onTextareaKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Skip when an IME composition is active so CJK input isn't interrupted.
    if (event.nativeEvent.isComposing || event.key === 'Process') return;
    // Esc while a drag-active highlight is showing should clear it
    // immediately. The existing useEffect listens for blur/dragend/drop
    // but not keydown, so a user who hits Esc to cancel a stuck drag
    // gesture would otherwise see the highlight linger until they
    // blurred the window or completed a real drop somewhere.
    if (event.key === 'Escape' && dragActive) {
      setDragActive(false);
    }
    // Esc during streaming interrupts the model. We don't preventDefault
    // unconditionally so Esc still works to close modals when the composer
    // happens to be focused outside a streaming turn.
    if (event.key === 'Escape' && props.streaming) {
      event.preventDefault();
      if (props.stopPending) return;
      props.onStop();
      return;
    }
    if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) {
      const el = textareaRef.current;
      const isNavigatingHistory = promptHistoryRef.current.index >= 0;
      const canStartHistory = Boolean(el && !el.value.trim());
      if (el && (isNavigatingHistory || canStartHistory)) {
        const next = navigateComposerHistory(
          promptHistoryRef.current,
          event.key === 'ArrowUp' ? 'previous' : 'next',
          el.value,
        );
        if (next.changed) {
          event.preventDefault();
          promptHistoryRef.current = next.state;
          el.value = next.value;
          saveCurrentDraft(next.value);
          autoResize();
          const length = el.value.length;
          el.setSelectionRange(length, length);
          return;
        }
      }
    }
    if (event.key !== 'Enter') return;
    if (event.shiftKey || event.altKey) return; // Shift+Enter / Alt+Enter inserts a newline.
    event.preventDefault();
    void sendCurrent();
  }

  function onTextareaInput() {
    resetPromptHistoryNavigation();
    autoResize();
    saveCurrentDraft();
  }

  function canAcceptDroppedTextFiles(): boolean {
    return Boolean(props.onImportDroppedTextFiles && !props.disabled && !props.streaming && !pendingImportActionRef.current);
  }

  function hasDraggedFiles(event: DragEvent<HTMLFormElement>): boolean {
    return Array.from(event.dataTransfer.types).includes('Files');
  }

  function hasPastedFiles(event: ClipboardEvent<HTMLTextAreaElement>): boolean {
    return Array.from(event.clipboardData.types).includes('Files') || event.clipboardData.files.length > 0;
  }

  function onComposerDragOver(event: DragEvent<HTMLFormElement>) {
    if (!canAcceptDroppedTextFiles() || !hasDraggedFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setDragActive(true);
  }

  function onComposerDragLeave(event: DragEvent<HTMLFormElement>) {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDragActive(false);
  }

  function onComposerDrop(event: DragEvent<HTMLFormElement>) {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    setDragActive(false);
    if (!canAcceptDroppedTextFiles()) return;
    const files = Array.from(event.dataTransfer.files);
    if (files.length === 0) return;
    void runImportAction('drop', () => props.onImportDroppedTextFiles?.(files));
  }

  function onTextareaPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    // PR-FE-BUG-HUNT-10 hotfix: extend the IME composition guard from
    // the keydown path (line 5640) to the paste path. If the user is
    // mid-CJK composition and the clipboard happens to contain a file
    // (screenshot shortcut etc.), `event.preventDefault()` below would
    // interrupt the IME mid-character.
    //
    // Original PR #216 copied `event.nativeEvent.isComposing` from the
    // keydown handler verbatim, but `isComposing` only exists on
    // KeyboardEvent / InputEvent in the DOM spec — not ClipboardEvent.
    // (Browsers happen to expose it on the underlying event too, but
    // TypeScript types don't acknowledge that.) Use a narrow `in` check
    // + a typed cast so this compiles AND keeps working when the
    // browser does expose the flag.
    const native = event.nativeEvent;
    if ('isComposing' in native && (native as { isComposing?: boolean }).isComposing) return;
    if (!hasPastedFiles(event)) return;
    if (!canAcceptDroppedTextFiles()) return;
    const files = Array.from(event.clipboardData.files);
    if (files.length === 0) return;
    event.preventDefault();
    void runImportAction('paste', () => props.onImportDroppedTextFiles?.(files));
  }

  useEffect(() => {
    if (!dragActive) return undefined;
    const clearDragActive = () => setDragActive(false);
    window.addEventListener('blur', clearDragActive);
    window.addEventListener('dragend', clearDragActive);
    window.addEventListener('drop', clearDragActive);
    return () => {
      window.removeEventListener('blur', clearDragActive);
      window.removeEventListener('dragend', clearDragActive);
      window.removeEventListener('drop', clearDragActive);
    };
  }, [dragActive]);

  if (props.hidden) return null;
  const importActionBusy = pendingImportAction !== null;
  const sendDisabled = props.disabled || sendPending || importActionBusy || !hasDraftText;
  const modelChipLabel = props.modelLabel?.trim() || '选择模型';
  const modelSwitcherDisabledReason = props.streaming
    ? '当前对话正在流式输出，等结束后再切换模型。'
    : props.activeSession?.status === 'running'
      ? '当前对话正在运行，等结束后再切换模型。'
      : props.activeSession?.status === 'waiting_for_user'
        ? '当前有工具调用正在等待确认，处理后再切换模型。'
        : undefined;

  return (
    <form
      ref={formRef}
      className="maka-composer composer"
      data-drag-active={dragActive ? 'true' : undefined}
      onDragOver={onComposerDragOver}
      onDragLeave={onComposerDragLeave}
      onDrop={onComposerDrop}
      onSubmit={submit}
    >
      <div className="maka-composer-inner composerInner agents-parchment-paper-surface">
        <UiTextarea
          ref={textareaRef}
          name="text"
          className="maka-composer-textarea min-h-[44px] resize-none border-0 bg-transparent px-0 py-0 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
          placeholder={copy.placeholder}
          aria-label={copy.textareaAriaLabel}
          disabled={props.disabled}
          onKeyDown={onTextareaKeyDown}
          onPaste={onTextareaPaste}
          onInput={onTextareaInput}
          rows={1}
          autoComplete="off"
          spellCheck={false}
        />
        {dragActive && (
          <span className="maka-visually-hidden" role="status" aria-live="polite">
            松开以导入文件内容
          </span>
        )}
        <div className="maka-composer-toolbar composerActions" data-streaming={props.streaming ? 'true' : undefined}>
          <div className="maka-composer-left-controls">
            {!props.streaming && props.onImportTextFile && props.onImportFolderOutline ? (
              <Menu>
                <MenuTrigger
                  className="maka-composer-tool-button maka-composer-context-plus"
                  type="button"
                  disabled={props.disabled || importActionBusy}
                  aria-label={pendingImportAction ? '正在添加上下文' : '添加上下文'}
                  aria-busy={pendingImportAction ? 'true' : undefined}
                  data-pending={pendingImportAction ? 'true' : undefined}
                  title={pendingImportAction ? '正在添加上下文' : '添加上下文'}
                >
                  <Plus size={15} strokeWidth={1.85} aria-hidden="true" />
                </MenuTrigger>
                <MenuPopup className="maka-composer-context-menu" align="start">
                  <MenuItem
                    onClick={() => void runImportAction('file', props.onImportTextFile)}
                    disabled={props.disabled || importActionBusy}
                  >
                    <FileEdit size={14} strokeWidth={1.75} aria-hidden="true" />
                    导入文件内容
                  </MenuItem>
                  <MenuItem
                    onClick={() => void runImportAction('folder', props.onImportFolderOutline)}
                    disabled={props.disabled || importActionBusy}
                  >
                    <FolderOpen size={14} strokeWidth={1.75} aria-hidden="true" />
                    导入文件夹目录
                  </MenuItem>
                </MenuPopup>
              </Menu>
            ) : !props.streaming && props.onImportTextFile ? (
              <UiButton
                variant="quiet"
                size="icon-sm"
                className="maka-composer-tool-button maka-composer-context-plus"
                type="button"
                disabled={props.disabled || importActionBusy}
                onClick={() => void runImportAction('file', props.onImportTextFile)}
                aria-label={pendingImportAction === 'file' ? '正在添加上下文' : '添加上下文'}
                aria-busy={pendingImportAction === 'file' ? 'true' : undefined}
                data-pending={pendingImportAction === 'file' ? 'true' : undefined}
                title={pendingImportAction === 'file' ? '正在添加上下文' : '添加上下文'}
              >
                <Plus size={15} strokeWidth={1.85} aria-hidden="true" />
              </UiButton>
            ) : null}
            {/* PR-MOVE-PERMISSION-MODE: the static "通用" role chip
                was replaced by the permission-mode dropdown — that
                spot is where the reference Settings expects users to
                pick "Ask permissions" / "Auto mode" / "Bypass
                permissions". Maka exposes the user-facing modes
                `ask` / `execute` / `bypass`; `explore` collapses to `ask` in the
                display because Deep Research sessions use it
                internally but it's not a useful runtime toggle for
                normal chat. */}
            {props.onPermissionModeChange ? (() => {
              const rawMode = props.permissionMode ?? 'ask';
              const displayMode: PermissionMode = rawMode === 'explore' ? 'ask' : rawMode;
              const meta = PERMISSION_MODE_META[displayMode];
              const triggerDisabled = props.permissionModePending === true || Boolean(props.permissionModeDisabledReason);
              return (
                <Menu>
                  {/* PR-COMPOSER-MODE-CHIP-PRIMITIVE-0 (round 15/30):
                      LAST raw <button> in `components.tsx`. The
                      permission mode chip (自动执行 ▾) is wrapped in
                      a MenuTrigger render-prop. Kept the callback
                      form (the menu library wants explicit
                      triggerProps spread) but the button now flows
                      through UiButton variant="quiet" size="nav" —
                      the bespoke `.maka-composer-mode-chip` class
                      still owns the chip's accent-tinted background,
                      data-mode + data-tone state visuals, and tight
                      composer-chrome density. */}
                  <MenuTrigger
                    render={(triggerProps) => (
                      <UiButton
                        {...triggerProps}
                        variant="quiet"
                        size="nav"
                        type="button"
                        className="maka-composer-mode-chip"
                        data-mode={displayMode}
                        data-tone={meta.tone}
                        data-pending={props.permissionModePending ? 'true' : undefined}
                        disabled={triggerDisabled}
                        aria-label={`权限模式：${meta.label}`}
                        title={props.permissionModeDisabledReason ?? meta.hint}
                      >
                        <span className="maka-composer-mode-chip-label">{meta.label}</span>
                        <ChevronDown size={12} strokeWidth={1.8} aria-hidden="true" />
                      </UiButton>
                    )}
                  />
                  <MenuPopup className="maka-composer-mode-menu" align="start">
                    {PERMISSION_MODE_ORDER.map((mode) => {
                      const optionMeta = PERMISSION_MODE_META[mode];
                      return (
                        <MenuItem
                          key={mode}
                          onClick={() => {
                            if (mode === displayMode) return;
                            void props.onPermissionModeChange?.(mode);
                          }}
                          data-active={mode === displayMode}
                          data-tone={optionMeta.tone}
                        >
                          <div className="maka-composer-mode-menu-item">
                            <span className="maka-composer-mode-menu-label">{optionMeta.label}</span>
                            <span className="maka-composer-mode-menu-hint">{optionMeta.hint}</span>
                          </div>
                          {mode === displayMode ? (
                            <Check size={12} strokeWidth={2} aria-hidden="true" />
                          ) : null}
                        </MenuItem>
                      );
                    })}
                  </MenuPopup>
                </Menu>
              );
            })() : null}
          </div>
          <span className="maka-composer-status-slot">
            {props.disabled ? (
              // PR-COMPOSER-PERMISSION-PULSE-0 (WAWQAQ msg `ed67a267`,
              // skills round task #116): wrap the "等待权限确认" text
              // in a styled hint with a pulsing accent dot. Plain text
              // was easy to miss — the dot signals "system is waiting
              // on YOU" with the same visual weight as the streaming
              // 3-dot bounce on the other side of the disabled/active
              // boundary.
              <span className="maka-composer-permission-hint">
                <span className="maka-composer-permission-dot" aria-hidden="true" />
                {copy.awaitingPermission}
              </span>
            ) : sendPending ? (
              copy.sending
            ) : importActionBusy ? (
              '正在导入…'
            ) : props.streaming ? (
              <span className="maka-composer-streaming-hint">
                <span className="maka-composer-streaming-dot" aria-hidden="true" />
                {copy.streamingHintPrefix} <Kbd className="maka-shortcut-kbd">Esc</Kbd> {copy.streamingHintInterrupt}
              </span>
            ) : (
              null
            )}
          </span>
          <div className="maka-composer-right-controls">
            {!props.streaming && (
              <>
                {props.activeSession ? (
                  <ChatModelSwitcher
                    activeSession={props.activeSession}
                    activeModel={props.activeModel}
                    activeConnectionLabel={props.activeConnectionLabel}
                    activeModelLabel={props.activeModelLabel}
                    choices={props.modelChoices ?? []}
                    pending={props.modelChangePending}
                    disabledReason={modelSwitcherDisabledReason}
                    renderProviderMark={props.renderProviderMark}
                    onChange={props.onModelChange}
                  />
                ) : props.onPickNewChatModel && (props.modelChoices?.length ?? 0) > 0 ? (
                  <NewChatModelPicker
                    label={modelChipLabel}
                    choices={props.modelChoices ?? []}
                    currentValue={
                      props.newChatModel
                        ? modelChoiceValue(props.newChatModel.llmConnectionSlug, props.newChatModel.model)
                        : undefined
                    }
                    renderProviderMark={props.renderProviderMark}
                    onPick={props.onPickNewChatModel}
                  />
                ) : (
                  <ModelChipStatic label={modelChipLabel} onOpenSettings={props.onOpenModelSettings} />
                )}
                <UiButton
                  variant="quiet"
                  size="icon-sm"
                  className="maka-composer-tool-button maka-composer-mic-button"
                  type="button"
                  disabled
                  aria-label="语音输入暂未启用"
                  title="语音输入暂未启用"
                >
                  <Mic size={14} strokeWidth={1.75} aria-hidden="true" />
                </UiButton>
              </>
            )}
            {props.streaming ? (
              <UiButton
                className="maka-button"
                variant="default"
                type="button"
                disabled={props.stopPending}
                onClick={() => {
                  if (props.stopPending) return;
                  void props.onStop();
                }}
                aria-busy={props.stopPending ? 'true' : undefined}
                data-pending={props.stopPending ? 'true' : undefined}
              >
                {props.stopPending ? '停止中…' : buttonCopy.stopLabel}
              </UiButton>
            ) : (
              <UiButton
                className="maka-composer-send-button"
                variant="default"
                size="icon-sm"
                type="submit"
                disabled={sendDisabled}
                aria-label={buttonCopy.sendLabel}
                aria-busy={sendPending ? 'true' : undefined}
                data-pending={sendPending ? 'true' : undefined}
                title={buttonCopy.sendLabel}
              >
                <ArrowUp size={16} strokeWidth={2.1} aria-hidden="true" />
              </UiButton>
            )}
          </div>
        </div>
      </div>
      {props.workspacePicker && (
        <div className="maka-composer-workspace-row">
          {/* PR-COMPOSER-WORKSPACE-PICKER-PRIMITIVE-0 (round 9/30):
              the workspace picker badge was a raw `<button>`.
              Routed through UiButton variant="quiet"; custom class
              still owns the picker's inline-flex shape (icon +
              label + chevron) and the bespoke 3px accent
              focus-visible ring. */}
          <UiButton
            type="button"
            variant="quiet"
            className="maka-composer-workspace-picker"
            disabled={props.workspacePicker.pending === true}
            aria-busy={props.workspacePicker.pending === true ? 'true' : undefined}
            onClick={props.workspacePicker.onOpen}
            title={props.workspacePicker.branch ? `选择工作目录 · ${props.workspacePicker.branch}` : '选择工作目录'}
            aria-label={props.workspacePicker.branch
              ? `选择工作目录：${props.workspacePicker.label ?? '当前工作目录'}，当前分支 ${props.workspacePicker.branch}`
              : `选择工作目录：${props.workspacePicker.label ?? '当前工作目录'}`}
          >
            <FolderOpen size={13} strokeWidth={1.7} aria-hidden="true" />
            {/* WAWQAQ msg `28128c9e` (2026-06-20): when a directory has
                been chosen, the label replaces the "选择工作目录"
                placeholder rather than appearing next to it. The
                placeholder is purely for the empty state. */}
            {props.workspacePicker.label
              ? <span className="maka-composer-workspace-current">{props.workspacePicker.label}</span>
              : <span>选择工作目录</span>}
            <ChevronDown size={12} strokeWidth={1.8} aria-hidden="true" />
          </UiButton>
        </div>
      )}
    </form>
  );
});























































function mergeTools(stored: ToolActivityItem[], live: ToolActivityItem[]): ToolActivityItem[] {
  const byId = new Map(stored.map((item) => [item.toolUseId, item]));
  for (const item of live) byId.set(item.toolUseId, { ...byId.get(item.toolUseId), ...item });
  return [...byId.values()];
}

const noMessagesYet = '暂无消息';
