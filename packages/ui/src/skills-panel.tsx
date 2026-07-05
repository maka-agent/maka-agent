import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  BookOpen,
  CalendarDays,
  FileEdit,
  Loader2,
  Plus,
  Search,
  ShieldAlert,
  Sparkles,
} from './icons.js';
import type { CapabilityAuditReport } from '@maka/core';
import { deriveCapabilityAuditReport } from '@maka/core';
import { Button as UiButton, TabsRoot, TabsList, TabsTrigger, TabsPanel } from './ui.js';
import { Input } from './primitives/input.js';
import { EmptyState } from './empty-state.js';
import { CapabilityAuditStrip } from './capability-audit-strip.js';
import type { SkillEntry } from './module-panel-types.js';

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
  const skillListEmptyTitle = normalizedSkillQuery ? '没有匹配的 Skill' : '等待添加 Skill';
  const skillListEmptyBody: ReactNode = normalizedSkillQuery ? '换一个关键词，或清空搜索查看全部本地技能。' : (
    <>
      把一个含 <code className="maka-empty-state-code">SKILL.md</code> 的文件夹放到工作区的
      {' '}<code className="maka-empty-state-code">skills/</code> 目录下，刷新后会出现在这里。
    </>
  );
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
      <TabsList variant="underline" className="maka-skill-tabs" aria-label="技能视图">
        {([
          ['market', '市场', filteredMarketCards.length],
          ['builtin', '内置', filteredSkills.length],
          ['installed', '已安装', skillCount],
        ] as const).map(([tab, label, count]) => (
          <TabsTrigger
            key={tab}
            className="maka-skill-tab"
            value={tab}
          >
            {label}
            {tab === 'installed' && <span>{count}</span>}
          </TabsTrigger>
        ))}
      </TabsList>
      {activeSkillTab === 'market' && (
        <div className="maka-skill-filter-actions" aria-label="技能筛选排序">
          {/* Static labels, not disabled buttons: filter/sort are not
              wired yet, and a styled-but-dead button visually promises
              interactivity it can't deliver. */}
          <span className="maka-skill-filter-pill" data-static="true">全部</span>
          <span className="maka-skill-filter-pill" data-static="true">排序：热门</span>
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
            <span className="maka-skill-section-label">{label}</span>
            <small>{list.length} 个</small>
          </div>
          <ul className="maka-skill-library-list" aria-label="技能列表">
            {list.map((skill) => {
              const tools = skill.declaredTools ?? [];
              const toolsLabel = tools.length > 0 ? tools.join(', ') : '';
              const description = formatSkillLibraryDescription(skill);
              const statusLabel = formatSkillStatusLabel(skill);
              const opening = props.openingSkillId === skill.id;
              const hoverText = tools.length > 0
                ? `打开技能文件：${skill.id}\n\n来源状态：${statusLabel}\n声明工具：${toolsLabel}\n权限仍按当前会话策略判断；这里不是授权。`
                : `打开技能文件：${skill.id}\n\n来源状态：${statusLabel}`;
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
                      <span>{statusLabel}</span>
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

  return (
    <div className="maka-skill-library" aria-busy={props.actionBusy ? 'true' : undefined}>
      {banner}
      <TabsRoot value={activeSkillTab} onValueChange={(v) => setActiveSkillTab(v as 'market' | 'builtin' | 'installed')}>
        {tabs}
        <TabsPanel value="market">{market}</TabsPanel>
        <TabsPanel value="builtin">{skillList(filteredSkills, skillListEmptyTitle, skillListEmptyBody, '内置技能')}{templates}</TabsPanel>
        <TabsPanel value="installed">{skillList(filteredSkills, skillListEmptyTitle, skillListEmptyBody, '已安装技能')}{templates}</TabsPanel>
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
  if (skill.userModified) return '已修改';
  if (skill.sourceType === 'bundled') return '内置';
  return '本地';
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
              unstyled
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
