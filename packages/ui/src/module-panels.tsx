import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  ArchiveRestore,
  BookOpen,
  CalendarDays,
  Check,
  Clock,
  Copy,
  FileEdit,
  Info,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCcw,
  Repeat,
  Search,
  ShieldAlert,
  Sparkles,
  Trash2,
  X,
  IconifyIcon,
} from './icons.js';
import { BOT_BRAND } from './bot-brand.js';
import { SettingsSelect, type SettingsSelectOption } from './primitives/settings-select.js';
import type {
  BotProvider,
  CapabilityAuditReport,
  PlanReminder,
  PlanReminderDeliveryTarget,
  PlanReminderRecurrence,
  PlanReminderStatus,
} from '@maka/core';
import {
  BOT_DELIVERY_PROVIDERS,
  botDisplayLabel,
  deriveCapabilityAuditReport,
  formatPlanReminderDeliveryTarget,
} from '@maka/core';
import type {
  DailyReviewArchive,
  DailyReviewArchiveSummary,
  DailyReviewMode,
  DailyReviewSummary,
  DailyReviewTopEntry,
} from '@maka/core';
import {
  type DailyReviewRange,
  dailyReviewPanelErrorMessage,
  dailyReviewScopeKey,
  formatDailyReviewArchiveGeneratedAt,
  formatDailyReviewArchiveTitle,
  formatDailyReviewMarkdown,
} from './daily-review-helpers.js';
import {
  PLAN_REMINDER_EXAMPLE_TEMPLATES,
  type PlanReminderExampleTemplate,
  comparePlanReminderBySort,
  duplicatePlanReminderTitle,
  formatPlanDeliveryProviderList,
  formatPlanRecurrence,
  formatReminderCountdown,
  formatReminderTime,
  normalizePlanReminderSearchQuery,
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
  Badge,
  Button as UiButton,
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
} from './ui.js';
import { Alert, AlertAction, AlertDescription, AlertTitle } from './primitives/alert.js';
import { Menu, MenuItem, MenuPopup, MenuTrigger } from './primitives/menu.js';
import { EmptyState } from './empty-state.js';
import { CapabilityAuditStrip } from './capability-audit-strip.js';
import type {
  DailyReviewBridge,
  DailyReviewMarkdownActionInput,
  PlanReminderDraftInput,
  PlanReminderUpdatePatch,
  SkillEntry,
} from './module-panel-types.js';
import { RelativeTime } from './relative-time.js';

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



export function SkillsModuleMain(props: {
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

export function DailyReviewPanel(props: {
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

export function PlanReminderPanel(props: {
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
