import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useMountedRef } from './use-mounted-ref.js';
import {
  Blocks,
  BookOpen,
  Download,
  FileEdit,
  Loader2,
  Plus,
  Search,
  Trash2,
} from './icons.js';
import type { CapabilityAuditReport } from '@maka/core';
import { deriveCapabilityAuditReport } from '@maka/core';
import { Button as UiButton, Switch, TabsRoot, TabsList, TabsTrigger, TabsPanel } from './ui.js';
import { Chip, type ChipProps } from './primitives/chip.js';
import { PageHeader } from './primitives/page-header.js';
import { Input } from './primitives/input.js';
import { SettingsSelect, type SettingsSelectOption } from './primitives/settings-select.js';
import { EmptyState } from './empty-state.js';
import { SectionHeader } from './primitives/section-header.js';
import { CapabilityAuditStrip } from './capability-audit-strip.js';
import type { BundledSkillCatalogEntry, ManagedSkillCategory, ManagedSkillSourceEntry, ManagedSkillUpdatePreview, SkillEntry } from './module-panel-types.js';

// 市场 tab client-side filter/sort controls. Both are pure renderer
// state — the managed-source list itself is fetched once over IPC.
const MARKET_CATEGORY_ALL = '__all__';
const MARKET_CATEGORIES: ReadonlyArray<ManagedSkillCategory> = [
  '内容创作',
  '数据与AI',
  '设计与UI',
  'DevOps与部署',
  '文档与写作',
  '效率工具',
  '研究与分析',
];
type MarketSort = 'name' | 'recent';

const SKILL_UPDATE_PREVIEW_MAX_LINES = 80;
const DELETE_CONFIRM_TIMEOUT_MS = 4_000;

function SkillLibraryPanel(props: {
  skills?: SkillEntry[];
  onRefreshSkills?(): void | Promise<void>;
  onCreateSkillTemplate?(): void | Promise<void>;
  onOpenSkill?(skillId: string): void | Promise<void>;
  onUseSkill?(skillId: string, skillName: string): void;
  onImportManagedSkillSource?(): void | Promise<void>;
  onInstallManagedSkill?(sourceId: string): void | Promise<void>;
  onPreviewManagedSkillUpdate?(skillId: string): Promise<ManagedSkillUpdatePreview | null>;
  onUpdateManagedSkill?(skillId: string, options?: { force?: boolean; expectedCurrentSha256?: string; expectedSourceSha256?: string }): boolean | Promise<boolean>;
  onSetSkillEnabled?(skillId: string, enabled: boolean): void | Promise<void>;
  onDeleteSkill?(skillId: string): void | Promise<void>;
  actionBusy?: boolean;
  refreshPending?: boolean;
  createPending?: boolean;
  openingSkillId?: string | null;
  installingSourceId?: string | null;
  updatingSkillId?: string | null;
  togglingSkillId?: string | null;
  deletingSkillId?: string | null;
  searchQuery?: string;
  managedSkillSources?: ManagedSkillSourceEntry[];
  bundledSkillCatalog?: BundledSkillCatalogEntry[];
  onInstallBundledSkill?(id: string): void | Promise<void>;
  installingBundledId?: string | null;
}) {
  const skillCount = props.skills?.length ?? 0;
  // Designer audit P1-5: land on skills the user can actually run, not the
  // marketplace — every market card is still 即将上线, and leading with
  // things you can't install undermines trust in the whole page.
  const [activeSkillTab, setActiveSkillTab] = useState<'market' | 'builtin' | 'installed'>(() => {
    const skills = props.skills ?? [];
    // Land on 已安装 when the user already has skills in the workspace;
    // otherwise open on 内置, the always-populated shipped catalog.
    if (skills.length > 0) return 'installed';
    return 'builtin';
  });
  const [updatePreview, setUpdatePreview] = useState<ManagedSkillUpdatePreview | null>(null);
  const [reviewingSkillId, setReviewingSkillId] = useState<string | null>(null);
  // Two-step in-place delete confirm (no dialog precedent in this panel): the
  // first click arms 确认删除 on that row; a second click within the window
  // deletes. The timeout reverts the armed state so a stray first click can't
  // linger as a hot destructive control.
  const [confirmingDeleteSkillId, setConfirmingDeleteSkillId] = useState<string | null>(null);
  const deleteConfirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (deleteConfirmTimerRef.current) clearTimeout(deleteConfirmTimerRef.current);
  }, []);
  function clearDeleteConfirmTimer() {
    if (deleteConfirmTimerRef.current) {
      clearTimeout(deleteConfirmTimerRef.current);
      deleteConfirmTimerRef.current = null;
    }
  }
  function requestDeleteSkill(skill: SkillEntry) {
    if (!props.onDeleteSkill) return;
    if (confirmingDeleteSkillId !== skill.id) {
      clearDeleteConfirmTimer();
      setConfirmingDeleteSkillId(skill.id);
      deleteConfirmTimerRef.current = setTimeout(() => setConfirmingDeleteSkillId(null), DELETE_CONFIRM_TIMEOUT_MS);
      return;
    }
    clearDeleteConfirmTimer();
    setConfirmingDeleteSkillId(null);
    void props.onDeleteSkill(skill.id);
  }
  const [marketCategory, setMarketCategory] = useState<ManagedSkillCategory | typeof MARKET_CATEGORY_ALL>(MARKET_CATEGORY_ALL);
  const [marketSort, setMarketSort] = useState<MarketSort>('name');
  const normalizedSkillQuery = props.searchQuery?.trim().toLowerCase() ?? '';
  const filteredSkills = (props.skills ?? []).filter((skill) => {
    if (!normalizedSkillQuery) return true;
    return `${skill.id} ${skill.name} ${skill.description ?? ''}`.toLowerCase().includes(normalizedSkillQuery);
  });
  // 内置 = the shipped catalog (install-on-demand cards); 已安装 = everything
  // actually present in the workspace, regardless of source. A skill installed
  // from the 内置 catalog therefore shows as 已安装 on its catalog card AND as a
  // manageable (toggle/open) row under 已安装 — the same dual surface the 市场
  // install flow already has.
  const bundledCatalog = props.bundledSkillCatalog ?? [];
  const bundledCatalogFiltered = bundledCatalog.filter((entry) => {
    if (!normalizedSkillQuery) return true;
    return `${entry.id} ${entry.name} ${entry.description} ${entry.category}`.toLowerCase().includes(normalizedSkillQuery);
  });
  const installedSkills = filteredSkills;
  // Collision-only slug reveal: the slug normally lives in the row tooltip,
  // but when two visible skills share a display name (e.g. repeated starter
  // templates from old builds) the rows become indistinguishable — surface
  // the slug inline exactly for those rows.
  const skillNameCounts = new Map<string, number>();
  for (const skill of filteredSkills) {
    skillNameCounts.set(skill.name, (skillNameCounts.get(skill.name) ?? 0) + 1);
  }
  const allManagedSources = props.managedSkillSources ?? [];
  // 市场 tab: managed sources are the marketplace catalog. Search (shared
  // header field), category dropdown, and sort are all pure client-side —
  // the list is fetched once over IPC. Sort 最近 (order preserved from the
  // IPC list, which main already sorts by name) vs 名称 (explicit A→Z).
  const marketSources = useMemo(() => {
    const filtered = allManagedSources.filter((source) => {
      if (marketCategory !== MARKET_CATEGORY_ALL && source.category !== marketCategory) return false;
      if (!normalizedSkillQuery) return true;
      return `${source.id} ${source.name} ${source.description} ${source.category}`.toLowerCase().includes(normalizedSkillQuery);
    });
    if (marketSort === 'name') {
      return [...filtered].sort((a, b) => a.name.localeCompare(b.name));
    }
    return filtered;
  }, [allManagedSources, marketCategory, marketSort, normalizedSkillQuery]);
  const skillListEmptyTitle = normalizedSkillQuery ? '没有匹配的 Skill' : '等待添加 Skill';
  const skillListEmptyBody: ReactNode = normalizedSkillQuery ? '换一个关键词，或清空搜索查看全部本地技能。' : (
    <>
      把一个含 <code className="maka-empty-state-code">SKILL.md</code> 的文件夹放到工作区的
      {' '}<code className="maka-empty-state-code">skills/</code> 目录下，刷新后会出现在这里。
    </>
  );
  async function reviewManagedSkillUpdate(skill: SkillEntry) {
    if (!props.onPreviewManagedSkillUpdate || reviewingSkillId !== null) return;
    setReviewingSkillId(skill.id);
    try {
      const preview = await props.onPreviewManagedSkillUpdate(skill.id);
      if (preview) setUpdatePreview(preview);
    } finally {
      setReviewingSkillId(null);
    }
  }

  async function applyManagedSkillUpdate(preview: ManagedSkillUpdatePreview) {
    if (!props.onUpdateManagedSkill) return;
    const force = preview.skill.managedUpdateStatus === 'local_modified';
    const updated = await props.onUpdateManagedSkill(preview.skill.id, {
      ...(force ? { force: true } : {}),
      expectedCurrentSha256: preview.expectedCurrentSha256,
      expectedSourceSha256: preview.expectedSourceSha256,
    });
    if (updated) setUpdatePreview(null);
  }

  const categoryOptions: ReadonlyArray<SettingsSelectOption<ManagedSkillCategory | typeof MARKET_CATEGORY_ALL>> = [
    [MARKET_CATEGORY_ALL, '全部分类'],
    ...MARKET_CATEGORIES.map((category) => [category, category] as const),
  ];
  const sortOptions: ReadonlyArray<SettingsSelectOption<MarketSort>> = [
    ['name', '排序：名称'],
    ['recent', '排序：最近'],
  ];
  const marketControls = activeSkillTab === 'market' && allManagedSources.length > 0 ? (
    <div className="maka-skill-market-controls" role="group" aria-label="市场筛选与排序">
      <SettingsSelect<ManagedSkillCategory | typeof MARKET_CATEGORY_ALL>
        value={marketCategory}
        options={categoryOptions}
        onChange={(value) => setMarketCategory(value)}
        ariaLabel="按分类筛选市场技能"
        width="full"
        className="maka-skill-market-select"
      />
      <SettingsSelect<MarketSort>
        value={marketSort}
        options={sortOptions}
        onChange={(value) => setMarketSort(value)}
        ariaLabel="市场技能排序方式"
        width="full"
        className="maka-skill-market-select"
      />
    </div>
  ) : null;

  const tabs = (
    <div className="maka-skill-tabs-bar">
      <TabsList variant="underline" className="maka-skill-tabs" aria-label="技能视图">
        {([
          ['market', '市场', allManagedSources.length],
          ['builtin', '内置', bundledCatalog.length],
          ['installed', '已安装', installedSkills.length],
        ] as const).map(([tab, label, count]) => (
          <TabsTrigger
            key={tab}
            className="maka-skill-tab"
            value={tab}
          >
            {label}
            <span>{count}</span>
          </TabsTrigger>
        ))}
      </TabsList>
      {/* Marketplace launch: real client-side category + sort controls on
          the tab row's right side (market tab only). The old static 全部 /
          排序：热门 pills were dead chrome; these drive marketSources. */}
      {marketControls}
    </div>
  );

  const banner = (
    <section className="maka-skill-featured-banner" data-skills-banner aria-label="精选技能">
      <div>
        <h3>为你精选的职场技能</h3>
        <p>涵盖写作、效率、设计、数据分析等场景，将陆续上线，敬请期待。</p>
      </div>
      <div className="maka-skill-featured-art" aria-hidden="true">
        <span>
          <FileEdit size={22} />
          <strong>复盘</strong>
          <small>总结沉淀</small>
        </span>
        <span>
          <BookOpen size={22} />
          <strong>文档</strong>
          <small>审阅润色</small>
        </span>
        <span>
          <Blocks size={22} />
          <strong>发布</strong>
          <small>检查清单</small>
        </span>
      </div>
    </section>
  );

  const market = (
    <section className="maka-skill-market" aria-label="技能市场">
      <SectionHeader
        className="maka-skill-section-row"
        title={<span className="maka-skill-section-label">官方精选</span>}
        action={
          <div className="maka-skill-filter-actions" aria-label="来源库操作">
            <UiButton
              type="button"
              variant="secondary"
              size="sm"
              onClick={props.onImportManagedSkillSource}
              disabled={!props.onImportManagedSkillSource || props.actionBusy}
            >
              导入本地 Skill
            </UiButton>
          </div>
        }
      />
      {allManagedSources.length === 0 ? (
        <EmptyState
          Icon={BookOpen}
          title={normalizedSkillQuery ? '没有匹配的市场技能' : '来源库还是空的'}
          body={normalizedSkillQuery
            ? '换一个关键词，或清空搜索查看全部来源。'
            : '导入一个含 SKILL.md 的本地文件，它会作为可安装的来源出现在这里。'}
          extraClassName="maka-skill-installed-empty"
        />
      ) : marketSources.length === 0 ? (
        <EmptyState
          Icon={Search}
          title="没有匹配的市场技能"
          body="换一个分类或关键词，或清空筛选查看全部来源。"
          extraClassName="maka-skill-installed-empty"
        />
      ) : (
        <div className="maka-skill-market-grid">
          {marketSources.map((source) => {
            const installed = (props.skills ?? []).some((skill) => skill.id === source.id);
            const installing = props.installingSourceId === source.id;
            const description = source.description || '本地来源库 Skill。';
            return (
              <article key={source.id} className="maka-skill-market-card">
                <div className="maka-skill-market-card-head">
                  <span className="maka-skill-market-icon" aria-hidden="true">
                    <Blocks size={18} />
                  </span>
                  <div className="maka-skill-market-card-title">
                    <h3>{source.name}</h3>
                    <small>{source.id}</small>
                  </div>
                  {/* + install acts; the card itself is inert (honest
                      affordance). Disabled once the source is in the
                      workspace, so it reads as a real state, not a toggle. */}
                  <UiButton
                    type="button"
                    variant="secondary"
                    size="icon-sm"
                    onClick={() => props.onInstallManagedSkill?.(source.id)}
                    disabled={installed || props.actionBusy || !props.onInstallManagedSkill}
                    aria-label={`安装 ${source.name}`}
                    title={installed ? '已安装到当前工作区' : `安装 ${source.name}`}
                  >
                    {installing ? <Loader2 size={16} aria-hidden="true" /> : <Download size={16} aria-hidden="true" />}
                  </UiButton>
                </div>
                <p>{description}</p>
                <div className="maka-skill-market-card-foot">
                  <Chip size="sm" variant="neutral" className="maka-skill-market-category">{source.category}</Chip>
                  <span>{installed ? '已安装' : '未安装'}</span>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );

  const builtinCatalog = (
    <section className="maka-skill-market" aria-label="内置技能">
      <SectionHeader
        className="maka-skill-section-row"
        title={<span className="maka-skill-section-label">应用自带</span>}
      />
      {bundledCatalog.length === 0 ? (
        <EmptyState
          Icon={Blocks}
          title="暂无内置技能"
          body="应用自带的技能会出现在这里。"
          extraClassName="maka-skill-installed-empty"
        />
      ) : bundledCatalogFiltered.length === 0 ? (
        <EmptyState
          Icon={Search}
          title="没有匹配的内置技能"
          body="换一个关键词，或清空搜索查看全部内置技能。"
          extraClassName="maka-skill-installed-empty"
        />
      ) : (
        <div className="maka-skill-market-grid">
          {bundledCatalogFiltered.map((entry) => {
            const installing = props.installingBundledId === entry.id;
            const description = entry.description || '应用自带 Skill。';
            return (
              <article key={entry.id} className="maka-skill-market-card">
                <div className="maka-skill-market-card-head">
                  <span className="maka-skill-market-icon" aria-hidden="true">
                    <Blocks size={18} />
                  </span>
                  <div className="maka-skill-market-card-title">
                    <h3>{entry.name}</h3>
                    <small>{entry.id}</small>
                  </div>
                  {/* Install copies the shipped body into the workspace. Disabled
                      once installed, so the button reads as a state, not a toggle. */}
                  <UiButton
                    type="button"
                    variant="secondary"
                    size="icon-sm"
                    onClick={() => props.onInstallBundledSkill?.(entry.id)}
                    disabled={entry.installed || props.actionBusy || !props.onInstallBundledSkill}
                    aria-label={`安装 ${entry.name}`}
                    title={entry.installed ? '已安装到当前工作区' : `安装 ${entry.name}`}
                  >
                    {installing ? <Loader2 size={16} aria-hidden="true" /> : <Download size={16} aria-hidden="true" />}
                  </UiButton>
                </div>
                <p>{description}</p>
                <div className="maka-skill-market-card-foot">
                  <Chip size="sm" variant="neutral" className="maka-skill-market-category">{entry.category}</Chip>
                  <span>{entry.installed ? '已安装' : '未安装'}</span>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );

  const skillList = (list: SkillEntry[], emptyTitle: string, emptyBody: ReactNode, label: string) => (
    <section className="maka-skill-installed" aria-label={label}>
      {list.length === 0 ? (
        <EmptyState
          Icon={Blocks}
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
          <SectionHeader
            className="maka-skill-section-row"
            title={<span className="maka-skill-section-label">{label}</span>}
            count={`${list.length} 个`}
          />
          <ul className="maka-skill-library-list" aria-label="技能列表">
            {list.map((skill) => {
              const tools = skill.declaredTools ?? [];
              const toolsLabel = tools.length > 0 ? tools.join(', ') : '';
              const description = formatSkillLibraryDescription(skill);
              const statusLabel = formatSkillStatusLabel(skill);
              const runtimeLabel = formatSkillRuntimeLabel(skill);
              const opening = props.openingSkillId === skill.id;
              const updating = props.updatingSkillId === skill.id;
              const toggling = props.togglingSkillId === skill.id;
              const reviewing = reviewingSkillId === skill.id;
              const deleting = props.deletingSkillId === skill.id;
              const confirmingDelete = confirmingDeleteSkillId === skill.id;
              const reviewableManagedUpdate = skill.managedUpdateStatus === 'update_available' || skill.managedUpdateStatus === 'local_modified';
              const canToggleSkill = Boolean(props.onSetSkillEnabled) && skill.runtimeStatus !== 'state_error';
              const hoverText = tools.length > 0
                ? `技能：${skill.id}\n\n运行状态：${runtimeLabel}\n来源状态：${statusLabel}\n声明工具：${toolsLabel}\n权限仍按当前会话策略判断；这里不是授权。`
                : `技能：${skill.id}\n\n运行状态：${runtimeLabel}\n来源状态：${statusLabel}`;
              return (
                <li key={skill.id} className="maka-skill-library-item" data-runtime-status={skill.runtimeStatus}>
                  <div
                    className="maka-skill-library-row"
                    title={hoverText}
                  >
                    <span className="maka-skill-library-status" aria-hidden="true">
                      <Blocks size={16} />
                    </span>
                    <span className="maka-skill-library-copy">
                      <span className="maka-skill-library-name">
                        {skill.name}
                        {(skillNameCounts.get(skill.name) ?? 0) > 1 && (
                          <span className="maka-skill-library-slug">{skill.id}</span>
                        )}
                      </span>
                      {description && (
                        <span className="maka-skill-library-description">{description}</span>
                      )}
                    </span>
                    <span className="maka-skill-library-meta">
                      {/* Marketplace redesign: the slug moved into the row's
                          title tooltip (技能：${skill.id}) — the reference row
                          shows only name + description. The status chips below
                          stay (exception-only tone). */}
                      {/* Detail round 6, exception-only: the adjacent Switch
                          already says enabled/disabled — the visible chip only
                          appears for states the switch can't express
                          (state_error). 已启用/已停用 stay in the hover text. */}
                      {skill.runtimeStatus === 'state_error' && (
                        <Chip size="sm" variant="warning" className="maka-skill-library-runtime-label" data-status={skill.runtimeStatus}>{runtimeLabel}</Chip>
                      )}
                      <Chip size="sm" variant={skillStatusChipTone(skill)} className="maka-skill-library-status-label" data-status={skill.managedUpdateStatus ?? skill.validationStatus ?? skill.sourceType ?? 'workspace'}>{statusLabel}</Chip>
                      {opening && <span>打开中…</span>}
                      {updating && <span>更新中…</span>}
                      {toggling && <span>切换中…</span>}
                      {reviewing && <span>审查中…</span>}
                    </span>
                  </div>
                  {props.onUseSkill && skill.enabled && (
                    <UiButton
                      type="button"
                      variant="secondary"
                      size="sm"
                      className="maka-skill-library-use-button"
                      onClick={() => props.onUseSkill?.(skill.id, skill.name)}
                      disabled={props.actionBusy}
                      aria-label={`在对话中使用 ${skill.name}`}
                    >
                      使用
                    </UiButton>
                  )}
                  <UiButton
                    type="button"
                    variant="secondary"
                    size="icon-sm"
                    className="maka-skill-library-open-button"
                    onClick={() => props.onOpenSkill?.(skill.id)}
                    disabled={props.actionBusy || !props.onOpenSkill}
                    aria-label={`打开 ${skill.name} 的 SKILL.md`}
                    title="打开 SKILL.md"
                  >
                    {opening ? <Loader2 size={15} aria-hidden="true" /> : <FileEdit size={15} aria-hidden="true" />}
                  </UiButton>
                  <Switch
                    className="maka-skill-library-runtime-switch"
                    checked={skill.enabled}
                    disabled={props.actionBusy || !canToggleSkill}
                    aria-label={skill.enabled ? `停用 ${skill.name}` : `启用 ${skill.name}`}
                    title={skill.runtimeStatus === 'state_error' ? '当前项目的 Skill 状态文件异常' : skill.enabled ? '当前项目中 agent 可以使用此技能' : '当前项目中 agent 不会看到或加载此技能'}
                    onCheckedChange={(next) => props.onSetSkillEnabled?.(skill.id, next === true)}
                  />
                  {reviewableManagedUpdate && props.onPreviewManagedSkillUpdate && (
                    <UiButton
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => void reviewManagedSkillUpdate(skill)}
                      disabled={props.actionBusy || reviewingSkillId !== null}
                    >
                      {reviewing ? '审查中…' : skill.managedUpdateStatus === 'local_modified' ? '查看差异' : '查看更新'}
                    </UiButton>
                  )}
                  {props.onDeleteSkill && (
                    <UiButton
                      type="button"
                      variant="secondary"
                      size="sm"
                      className="maka-skill-library-delete-button"
                      data-confirming={confirmingDelete ? 'true' : undefined}
                      onClick={() => requestDeleteSkill(skill)}
                      disabled={props.actionBusy && !deleting}
                      aria-label={confirmingDelete ? `确认删除 ${skill.name}` : `删除 ${skill.name}`}
                    >
                      {deleting ? <Loader2 size={15} aria-hidden="true" /> : <Trash2 size={15} aria-hidden="true" />}
                      {confirmingDelete ? '确认删除' : '删除'}
                    </UiButton>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );

  const updateReview = updatePreview ? (
    <section className="maka-skill-governance-review" aria-label="Skill 更新审查">
      <SectionHeader
        className="maka-skill-section-row"
        title={<span className="maka-skill-section-label">更新审查</span>}
        count={formatSkillStatusLabel(updatePreview.skill)}
      />
      <div className="maka-skill-governance-summary">
        <span>{updatePreview.skill.name}</span>
        <span>{updatePreview.skill.managedSourceId ? `来源 ${updatePreview.skill.managedSourceId}` : '受管理来源'}</span>
        <span>{updatePreview.skill.hasManagedBaseline ? '已有基线' : '缺少基线'}</span>
        <span>{updatePreview.summary.currentLineCount} → {updatePreview.summary.sourceLineCount} 行</span>
        <span>{updatePreview.summary.changedLineCount} 行不同</span>
      </div>
      {updatePreview.skill.managedUpdateStatus === 'local_modified' && (
        <p className="maka-skill-governance-warning">
          工作区副本已有本地修改。继续更新会用来源库版本覆盖当前 SKILL.md。
        </p>
      )}
      <div className="maka-skill-diff-grid">
        <div>
          <span>当前工作区</span>
          <pre>{previewText(updatePreview.currentContent)}</pre>
        </div>
        <div>
          <span>来源库版本</span>
          <pre>{previewText(updatePreview.sourceContent)}</pre>
        </div>
      </div>
      <div className="maka-skill-governance-actions">
        <UiButton
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setUpdatePreview(null)}
          disabled={props.actionBusy}
        >
          取消
        </UiButton>
        <UiButton
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => void applyManagedSkillUpdate(updatePreview)}
          disabled={props.actionBusy || !props.onUpdateManagedSkill}
        >
          {updatePreview.skill.managedUpdateStatus === 'local_modified' ? '覆盖本地修改' : '更新到来源版本'}
        </UiButton>
      </div>
    </section>
  ) : null;

  return (
    <div className="maka-skill-library" aria-busy={props.actionBusy ? 'true' : undefined}>
      {banner}
      <TabsRoot value={activeSkillTab} onValueChange={(v) => setActiveSkillTab(v as 'market' | 'builtin' | 'installed')}>
        {tabs}
        <TabsPanel value="market">{market}</TabsPanel>
        <TabsPanel value="builtin">{builtinCatalog}</TabsPanel>
        <TabsPanel value="installed">
          {skillList(installedSkills, skillListEmptyTitle, skillListEmptyBody, '已安装技能')}
          {updateReview}
        </TabsPanel>
      </TabsRoot>
      {props.skills && props.skills.length > 0 ? (
        <span className="maka-skill-tool-summary-hidden" aria-hidden="true">
          {`${skillCount} 个 Skill · ${new Set((props.skills ?? []).flatMap((skill) => skill.declaredTools ?? [])).size} 类工具`}
        </span>
      ) : null}
    </div>
  );
}

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

function formatSkillStatusLabel(skill: SkillEntry): string {
  if (skill.validationStatus === 'metadata_error') return '元数据异常';
  if (skill.sourceType === 'managed') {
    if (skill.managedUpdateStatus === 'source_missing') return '来源缺失';
    if (skill.managedUpdateStatus === 'update_available') return '可更新';
    if (skill.managedUpdateStatus === 'local_modified') return '本地已修改';
    if (skill.managedUpdateStatus === 'metadata_error') return '元数据异常';
    return '受管理';
  }
  if (skill.userModified) return '已修改';
  if (skill.sourceType === 'bundled') return '内置';
  return '本地';
}

function formatSkillRuntimeLabel(skill: SkillEntry): string {
  if (skill.runtimeStatus === 'state_error') return '状态异常';
  return skill.enabled ? '已启用' : '已停用';
}

// Derive the source-status Chip tone from the same data-status the retired
// .maka-skill-library-status-label CSS keyed off. Exception-only: 内置 / 本地
// (expected states) stay neutral; only genuine attention states carry a tone.
//   metadata_error / local_modified → warning (needs the user's attention)
//   受管理 (managed base) → info (managed but nothing wrong)
//   bundled / workspace default → neutral
function skillStatusChipTone(skill: SkillEntry): ChipProps['variant'] {
  if (skill.validationStatus === 'metadata_error') return 'warning';
  if (skill.sourceType === 'managed') {
    if (skill.managedUpdateStatus === 'local_modified' || skill.managedUpdateStatus === 'metadata_error') return 'warning';
    return 'info';
  }
  return 'neutral';
}

function previewText(content: string): string {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const clipped = lines.slice(0, SKILL_UPDATE_PREVIEW_MAX_LINES).join('\n');
  return lines.length > SKILL_UPDATE_PREVIEW_MAX_LINES ? `${clipped}\n...` : clipped;
}



export function SkillsModuleMain(props: {
  skills?: SkillEntry[];
  managedSkillSources?: ManagedSkillSourceEntry[];
  bundledSkillCatalog?: BundledSkillCatalogEntry[];
  auditReport?: CapabilityAuditReport;
  onRefreshSkills?(): void | Promise<void>;
  onCreateSkillTemplate?(): void | Promise<void>;
  onOpenSkill?(skillId: string): void | Promise<void>;
  onUseSkill?(skillId: string, skillName: string): void;
  onOpenSkillsFolder?(): void | Promise<void>;
  onRefreshManagedSkillSources?(): void | Promise<void>;
  onRefreshBundledSkillCatalog?(): void | Promise<void>;
  onImportManagedSkillSource?(): void | Promise<void>;
  onInstallManagedSkill?(sourceId: string): void | Promise<void>;
  onInstallBundledSkill?(id: string): void | Promise<void>;
  onPreviewManagedSkillUpdate?(skillId: string): Promise<ManagedSkillUpdatePreview | null>;
  onUpdateManagedSkill?(skillId: string, options?: { force?: boolean; expectedCurrentSha256?: string; expectedSourceSha256?: string }): boolean | Promise<boolean>;
  onSetSkillEnabled?(skillId: string, enabled: boolean): void | Promise<void>;
  onDeleteSkill?(skillId: string): void | Promise<void>;
}) {
  const [pendingSkillAction, setPendingSkillAction] = useState<string | null>(null);
  const [skillSearchQuery, setSkillSearchQuery] = useState('');
  const skillActionMountedRef = useMountedRef();
  const pendingSkillActionRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      pendingSkillActionRef.current = null;
    };
  }, []);

  async function runSkillAction<Result>(
    actionKey: string,
    action: (() => Result | Promise<Result>) | undefined,
  ) {
    if (!action || pendingSkillActionRef.current !== null) return undefined;
    pendingSkillActionRef.current = actionKey;
    setPendingSkillAction(actionKey);
    try {
      return await action();
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
      <PageHeader
        className="maka-module-main-header"
        as="h2"
        title="技能"
        subtitle="安装与管理技能，在对话中扩展 Maka 的能力。"
        actions={
        <div className="maka-module-main-actions" role="group" aria-label="技能操作">
          <label className="maka-skill-search" aria-label="搜索技能">
            <Search size={15} aria-hidden="true" />
            <Input
              unstyled
              value={skillSearchQuery}
              onChange={(event) => setSkillSearchQuery(event.currentTarget.value)}
              maxLength={120}
              placeholder="搜索技能"
            />
          </label>
          <UiButton
            className="maka-skill-header-utility"
            variant="secondary"
            type="button"
            onClick={() => void runSkillAction('folder', props.onOpenSkillsFolder)}
            disabled={!props.onOpenSkillsFolder || skillActionBusy}
          >
            打开目录
          </UiButton>
          {/* Detail round 6: the page CTA is a REAL primary (variant default,
              same recipe as daily-review's 生成每日回顾) — previously a ghost
              re-skinned by CSS into a hardcoded black-gradient pill (theme-leak
              literals + off-family radius). */}
          <UiButton
            variant="default"
            type="button"
            onClick={() => void runSkillAction('create', props.onCreateSkillTemplate)}
            disabled={!props.onCreateSkillTemplate || skillActionBusy}
          >
            <Plus size={15} aria-hidden="true" />
            {pendingSkillAction === 'create' ? '创建中…' : '添加'}
            <span className="maka-visually-hidden">{skillCreateLegacyLabel}</span>
          </UiButton>
          <UiButton
            className="maka-skill-header-utility"
            variant="secondary"
            type="button"
            onClick={() => void runSkillAction('refresh', props.onRefreshSkills)}
            disabled={!props.onRefreshSkills || skillActionBusy}
          >
            {pendingSkillAction === 'refresh' ? '刷新中…' : '刷新'}
          </UiButton>
        </div>
        }
      />
      <CapabilityAuditStrip report={auditReport} />
      <SkillLibraryPanel
        skills={props.skills}
        managedSkillSources={props.managedSkillSources}
        bundledSkillCatalog={props.bundledSkillCatalog}
        onRefreshSkills={props.onRefreshSkills ? () => runSkillAction('refresh', props.onRefreshSkills) : undefined}
        onCreateSkillTemplate={props.onCreateSkillTemplate ? () => runSkillAction('create', props.onCreateSkillTemplate) : undefined}
        onOpenSkill={props.onOpenSkill ? (skillId) => runSkillAction(`open:${skillId}`, () => props.onOpenSkill?.(skillId)) : undefined}
        onImportManagedSkillSource={props.onImportManagedSkillSource ? () => runSkillAction('source:import', props.onImportManagedSkillSource) : undefined}
        onInstallManagedSkill={props.onInstallManagedSkill ? (sourceId) => runSkillAction(`source:install:${sourceId}`, () => props.onInstallManagedSkill?.(sourceId)) : undefined}
        onInstallBundledSkill={props.onInstallBundledSkill ? (id) => runSkillAction(`bundled:install:${id}`, () => props.onInstallBundledSkill?.(id)) : undefined}
        onPreviewManagedSkillUpdate={props.onPreviewManagedSkillUpdate}
        onUpdateManagedSkill={props.onUpdateManagedSkill ? async (skillId, options) =>
          (await runSkillAction(`managed:update:${skillId}`, () => props.onUpdateManagedSkill?.(skillId, options))) === true : undefined}
        onSetSkillEnabled={props.onSetSkillEnabled ? (skillId, enabled) => runSkillAction(`runtime:set:${skillId}`, () => props.onSetSkillEnabled?.(skillId, enabled)) : undefined}
        onDeleteSkill={props.onDeleteSkill ? (skillId) => runSkillAction(`delete:${skillId}`, () => props.onDeleteSkill?.(skillId)) : undefined}
        onUseSkill={props.onUseSkill}
        actionBusy={skillActionBusy}
        refreshPending={pendingSkillAction === 'refresh'}
        createPending={pendingSkillAction === 'create'}
        openingSkillId={pendingSkillAction?.startsWith('open:') ? pendingSkillAction.slice('open:'.length) : null}
        installingSourceId={pendingSkillAction?.startsWith('source:install:') ? pendingSkillAction.slice('source:install:'.length) : null}
        installingBundledId={pendingSkillAction?.startsWith('bundled:install:') ? pendingSkillAction.slice('bundled:install:'.length) : null}
        updatingSkillId={pendingSkillAction?.startsWith('managed:update:') ? pendingSkillAction.slice('managed:update:'.length) : null}
        togglingSkillId={pendingSkillAction?.startsWith('runtime:set:') ? pendingSkillAction.slice('runtime:set:'.length) : null}
        deletingSkillId={pendingSkillAction?.startsWith('delete:') ? pendingSkillAction.slice('delete:'.length) : null}
        searchQuery={skillSearchQuery}
      />
    </main>
  );
}
