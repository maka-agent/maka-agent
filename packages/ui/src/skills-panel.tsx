import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Blocks,
  BookOpen,
  CalendarDays,
  FileEdit,
  Loader2,
  Plus,
  Search,
  ShieldAlert,
} from './icons.js';
import type { CapabilityAuditReport } from '@maka/core';
import { deriveCapabilityAuditReport } from '@maka/core';
import { Button as UiButton, Switch, TabsRoot, TabsList, TabsTrigger, TabsPanel } from './ui.js';
import { Input } from './primitives/input.js';
import { EmptyState } from './empty-state.js';
import { CapabilityAuditStrip } from './capability-audit-strip.js';
import type { ManagedSkillSourceEntry, ManagedSkillUpdatePreview, SkillEntry } from './module-panel-types.js';

const SKILL_UPDATE_PREVIEW_MAX_LINES = 80;

function SkillLibraryPanel(props: {
  skills?: SkillEntry[];
  onRefreshSkills?(): void | Promise<void>;
  onCreateSkillTemplate?(): void | Promise<void>;
  onOpenSkill?(skillId: string): void | Promise<void>;
  onImportManagedSkillSource?(): void | Promise<void>;
  onInstallManagedSkill?(sourceId: string): void | Promise<void>;
  onPreviewManagedSkillUpdate?(skillId: string): Promise<ManagedSkillUpdatePreview | null>;
  onUpdateManagedSkill?(skillId: string, options?: { force?: boolean; expectedCurrentSha256?: string; expectedSourceSha256?: string }): boolean | Promise<boolean>;
  onSetSkillEnabled?(skillId: string, enabled: boolean): void | Promise<void>;
  actionBusy?: boolean;
  refreshPending?: boolean;
  createPending?: boolean;
  openingSkillId?: string | null;
  installingSourceId?: string | null;
  updatingSkillId?: string | null;
  togglingSkillId?: string | null;
  searchQuery?: string;
  managedSkillSources?: ManagedSkillSourceEntry[];
}) {
  const skillCount = props.skills?.length ?? 0;
  // Designer audit P1-5: land on skills the user can actually run, not the
  // marketplace — every market card is still 即将上线, and leading with
  // things you can't install undermines trust in the whole page.
  const [activeSkillTab, setActiveSkillTab] = useState<'market' | 'builtin' | 'installed'>(() => {
    const skills = props.skills ?? [];
    if (skills.some((skill) => skill.sourceType !== 'bundled')) return 'installed';
    if (skills.length > 0) return 'builtin';
    return 'market';
  });
  const [updatePreview, setUpdatePreview] = useState<ManagedSkillUpdatePreview | null>(null);
  const [reviewingSkillId, setReviewingSkillId] = useState<string | null>(null);
  const normalizedSkillQuery = props.searchQuery?.trim().toLowerCase() ?? '';
  const filteredSkills = (props.skills ?? []).filter((skill) => {
    if (!normalizedSkillQuery) return true;
    return `${skill.id} ${skill.name} ${skill.description ?? ''}`.toLowerCase().includes(normalizedSkillQuery);
  });
  // 内置 = bundled skills shipped with the app; 已安装 = everything the user
  // added themselves (workspace / unknown source). The two tabs used to
  // render the SAME list, which made them meaningless.
  const bundledSkills = filteredSkills.filter((skill) => skill.sourceType === 'bundled');
  const installedSkills = filteredSkills.filter((skill) => skill.sourceType !== 'bundled');
  const filteredMarketCards = SKILL_MARKETPLACE_CARDS.filter((card) => {
    if (!normalizedSkillQuery) return true;
    return `${card.title} ${card.body} ${card.meta}`.toLowerCase().includes(normalizedSkillQuery);
  });
  const skillListEmptyTitle = normalizedSkillQuery ? '没有匹配的 Skill' : '等待添加 Skill';
  const skillListEmptyBody: ReactNode = normalizedSkillQuery ? '换一个关键词，或清空搜索查看全部本地技能。' : (
    <>
      把一个含 <code className="maka-empty-state-code">SKILL.md</code> 的文件夹放到工作区的
      {' '}<code className="maka-empty-state-code">skills/</code> 目录下，刷新后会出现在这里。
    </>
  );
  const filteredManagedSources = (props.managedSkillSources ?? []).filter((source) => {
    if (!normalizedSkillQuery) return true;
    return `${source.id} ${source.name} ${source.description}`.toLowerCase().includes(normalizedSkillQuery);
  });
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

  const templates = (
    <section className="maka-skill-examples" aria-label="技能示例">
      <ul className="maka-skill-example-grid" aria-label="技能模板示例">
        {SKILL_EXAMPLE_CARDS.map((example) => (
          <li key={example.title} className="maka-skill-template-row">
            <span className="maka-skill-template-icon" aria-hidden="true">
              <example.Icon size={13} />
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
      <TabsList variant="underline" className="maka-skill-tabs" aria-label="技能视图">
        {([
          ['market', '市场', filteredMarketCards.length],
          ['builtin', '内置', bundledSkills.length],
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
      {/* Designer audit P1-9: the static 全部 / 排序：热门 pills were removed
          entirely — they were styled like buttons but dead, which reads as a
          broken control. Bring back real filter/sort controls with the
          marketplace launch. */}
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
                  <card.Icon size={18} />
                </span>
                <div>
                  <h3>{card.title}</h3>
                  <small>{card.meta}</small>
                </div>
              </div>
              <p>{card.body}</p>
              <div className="maka-skill-market-card-foot">
                <span>{card.source}</span>
                {/* Static label, not a disabled button — same rationale as
                    the filter pills above: marketplace install isn't wired
                    yet, and a dead 安装 button promises interactivity it
                    can't deliver. */}
                <span className="maka-skill-market-install" data-static="true">即将上线</span>
              </div>
            </article>
          ))}
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
          <div className="maka-skill-section-row">
            <span className="maka-skill-section-label">{label}</span>
            <small>{list.length} 个</small>
          </div>
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
                      <span className="maka-skill-library-name">{skill.name}</span>
                      {description && (
                        <span className="maka-skill-library-description">{description}</span>
                      )}
                    </span>
                    <span className="maka-skill-library-meta">
                      <span>{skill.id}</span>
                      {/* Detail round 6, exception-only: the adjacent Switch
                          already says enabled/disabled — the visible chip only
                          appears for states the switch can't express
                          (state_error). 已启用/已停用 stay in the hover text. */}
                      {skill.runtimeStatus === 'state_error' && (
                        <span className="maka-skill-library-runtime-label" data-status={skill.runtimeStatus}>{runtimeLabel}</span>
                      )}
                      <span className="maka-skill-library-status-label" data-status={skill.managedUpdateStatus ?? skill.validationStatus ?? skill.sourceType ?? 'workspace'}>{statusLabel}</span>
                      {opening && <span>打开中…</span>}
                      {updating && <span>更新中…</span>}
                      {toggling && <span>切换中…</span>}
                      {reviewing && <span>审查中…</span>}
                    </span>
                  </div>
                  <UiButton
                    type="button"
                    variant="ghost"
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
                      variant="ghost"
                      className="maka-skill-market-install"
                      onClick={() => void reviewManagedSkillUpdate(skill)}
                      disabled={props.actionBusy || reviewingSkillId !== null}
                    >
                      {reviewing ? '审查中…' : skill.managedUpdateStatus === 'local_modified' ? '查看差异' : '查看更新'}
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

  const managedSources = (
    <section className="maka-skill-installed" aria-label="来源库">
      <div className="maka-skill-section-row">
        <span className="maka-skill-section-label">来源库</span>
        <small>{filteredManagedSources.length} 个</small>
      </div>
      <div className="maka-skill-filter-actions" aria-label="来源库操作">
        <UiButton
          type="button"
          variant="secondary"
          className="maka-skill-filter-pill"
          onClick={props.onImportManagedSkillSource}
          disabled={!props.onImportManagedSkillSource || props.actionBusy}
        >
          导入本地 Skill
        </UiButton>
      </div>
      {filteredManagedSources.length === 0 ? (
        normalizedSkillQuery ? (
          <EmptyState
            Icon={BookOpen}
            title="没有匹配的来源"
            body="换一个关键词，或清空搜索查看全部来源。"
            extraClassName="maka-skill-installed-empty"
          />
        ) : null
      ) : (
        <ul className="maka-skill-library-list" aria-label="来源列表">
          {filteredManagedSources.map((source) => {
            const installed = (props.skills ?? []).some((skill) => skill.id === source.id);
            const installing = props.installingSourceId === source.id;
            return (
              <li key={source.id} className="maka-skill-library-item">
                <div className="maka-skill-library-row" title={`来源：${source.id}`}>
                  <span className="maka-skill-library-status" aria-hidden="true">
                    <BookOpen size={16} />
                  </span>
                  <span className="maka-skill-library-copy">
                    <span className="maka-skill-library-name">{source.name}</span>
                    <span className="maka-skill-library-description">{source.description || '本地来源库 Skill。'}</span>
                  </span>
                  <span className="maka-skill-library-meta">
                    <span>{source.id}</span>
                    <span>{installed ? '已安装' : '未安装'}</span>
                  </span>
                  <UiButton
                    type="button"
                    variant="ghost"
                    className="maka-skill-market-install"
                    onClick={() => props.onInstallManagedSkill?.(source.id)}
                    disabled={installed || props.actionBusy || !props.onInstallManagedSkill}
                  >
                    {installing ? '安装中…' : installed ? '已安装' : '安装'}
                  </UiButton>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );

  const updateReview = updatePreview ? (
    <section className="maka-skill-governance-review" aria-label="Skill 更新审查">
      <div className="maka-skill-section-row">
        <span className="maka-skill-section-label">更新审查</span>
        <small>{formatSkillStatusLabel(updatePreview.skill)}</small>
      </div>
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
          className="maka-skill-filter-pill"
          onClick={() => setUpdatePreview(null)}
          disabled={props.actionBusy}
        >
          取消
        </UiButton>
        <UiButton
          type="button"
          variant="secondary"
          className="maka-skill-filter-pill"
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
        <TabsPanel value="builtin">{skillList(bundledSkills, normalizedSkillQuery ? '没有匹配的内置技能' : '暂无内置技能', normalizedSkillQuery ? '换一个关键词试试。' : '应用自带的技能会出现在这里。', '内置技能')}</TabsPanel>
        <TabsPanel value="installed">
          {skillList(installedSkills, skillListEmptyTitle, skillListEmptyBody, '已安装技能')}
          {updateReview}
          {managedSources}
          {templates}
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

function previewText(content: string): string {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const clipped = lines.slice(0, SKILL_UPDATE_PREVIEW_MAX_LINES).join('\n');
  return lines.length > SKILL_UPDATE_PREVIEW_MAX_LINES ? `${clipped}\n...` : clipped;
}



export function SkillsModuleMain(props: {
  skills?: SkillEntry[];
  managedSkillSources?: ManagedSkillSourceEntry[];
  auditReport?: CapabilityAuditReport;
  onRefreshSkills?(): void | Promise<void>;
  onCreateSkillTemplate?(): void | Promise<void>;
  onOpenSkill?(skillId: string): void | Promise<void>;
  onOpenSkillsFolder?(): void | Promise<void>;
  onRefreshManagedSkillSources?(): void | Promise<void>;
  onImportManagedSkillSource?(): void | Promise<void>;
  onInstallManagedSkill?(sourceId: string): void | Promise<void>;
  onPreviewManagedSkillUpdate?(skillId: string): Promise<ManagedSkillUpdatePreview | null>;
  onUpdateManagedSkill?(skillId: string, options?: { force?: boolean; expectedCurrentSha256?: string; expectedSourceSha256?: string }): boolean | Promise<boolean>;
  onSetSkillEnabled?(skillId: string, enabled: boolean): void | Promise<void>;
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
      <header className="maka-module-main-header">
        <div>
          <h2>技能</h2>
          <p>安装与管理技能，在对话中扩展 Maka 的能力。</p>
        </div>
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
            className="maka-button"
            variant="outline"
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
            className="maka-skill-add-button"
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
            className="maka-button"
            variant="outline"
            type="button"
            onClick={() => void runSkillAction('refresh', props.onRefreshSkills)}
            disabled={!props.onRefreshSkills || skillActionBusy}
          >
            {pendingSkillAction === 'refresh' ? '刷新中…' : '刷新'}
          </UiButton>
        </div>
      </header>
      <CapabilityAuditStrip report={auditReport} />
      <SkillLibraryPanel
        skills={props.skills}
        managedSkillSources={props.managedSkillSources}
        onRefreshSkills={props.onRefreshSkills ? () => runSkillAction('refresh', props.onRefreshSkills) : undefined}
        onCreateSkillTemplate={props.onCreateSkillTemplate ? () => runSkillAction('create', props.onCreateSkillTemplate) : undefined}
        onOpenSkill={props.onOpenSkill ? (skillId) => runSkillAction(`open:${skillId}`, () => props.onOpenSkill?.(skillId)) : undefined}
        onImportManagedSkillSource={props.onImportManagedSkillSource ? () => runSkillAction('source:import', props.onImportManagedSkillSource) : undefined}
        onInstallManagedSkill={props.onInstallManagedSkill ? (sourceId) => runSkillAction(`source:install:${sourceId}`, () => props.onInstallManagedSkill?.(sourceId)) : undefined}
        onPreviewManagedSkillUpdate={props.onPreviewManagedSkillUpdate}
        onUpdateManagedSkill={props.onUpdateManagedSkill ? async (skillId, options) =>
          (await runSkillAction(`managed:update:${skillId}`, () => props.onUpdateManagedSkill?.(skillId, options))) === true : undefined}
        onSetSkillEnabled={props.onSetSkillEnabled ? (skillId, enabled) => runSkillAction(`runtime:set:${skillId}`, () => props.onSetSkillEnabled?.(skillId, enabled)) : undefined}
        actionBusy={skillActionBusy}
        refreshPending={pendingSkillAction === 'refresh'}
        createPending={pendingSkillAction === 'create'}
        openingSkillId={pendingSkillAction?.startsWith('open:') ? pendingSkillAction.slice('open:'.length) : null}
        installingSourceId={pendingSkillAction?.startsWith('source:install:') ? pendingSkillAction.slice('source:install:'.length) : null}
        updatingSkillId={pendingSkillAction?.startsWith('managed:update:') ? pendingSkillAction.slice('managed:update:'.length) : null}
        togglingSkillId={pendingSkillAction?.startsWith('runtime:set:') ? pendingSkillAction.slice('runtime:set:'.length) : null}
        searchQuery={skillSearchQuery}
      />
    </main>
  );
}
