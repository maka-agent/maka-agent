import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState, type ReactNode } from 'react';
import {
  Button,
  PageHeader,
  Segmented,
  TabsList,
  TabsPanel,
  TabsRoot,
  TabsTrigger,
} from '@maka/ui';
import { Blocks, Plug, Plus, Search } from '@maka/ui/icons';

type ExtensionSection = 'skills' | 'mcp';

const options = [['skills', '技能'], ['mcp', 'MCP']] as const;

function ContentPreview(props: { section: ExtensionSection }) {
  const skills = props.section === 'skills';
  return (
    <div style={{ display: 'grid', alignContent: 'start', gap: 18, minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ position: 'relative', flex: '1 1 auto' }}>
          <Search aria-hidden="true" size={14} style={{ position: 'absolute', left: 10, top: 9, color: 'var(--muted-foreground)' }} />
          <div style={{ height: 32, border: '1px solid var(--border)', borderRadius: 6, padding: '7px 10px 7px 30px', color: 'var(--muted-foreground)', fontSize: 12 }}>
            {skills ? '搜索技能…' : '搜索 MCP 服务…'}
          </div>
        </div>
        <Button size="sm"><Plus aria-hidden="true" />{skills ? '添加技能' : '添加服务'}</Button>
      </div>
      <section style={{ display: 'grid', gap: 8 }}>
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>{skills ? '技能市场' : 'MCP 市场'}</h3>
        {skills ? (
          <>
            <PreviewRow icon={<Blocks size={16} />} title="代码评审" detail="从多个角度检查改动与风险" />
            <PreviewRow icon={<Blocks size={16} />} title="并行研究" detail="分派独立证据路径并交叉验证" />
            <PreviewRow icon={<Blocks size={16} />} title="调试" detail="系统化定位故障与性能回归" />
          </>
        ) : (
          <>
            <PreviewRow icon={<Plug size={16} />} title="GitHub" detail="Issues、Pull Requests 与仓库内容" />
            <PreviewRow icon={<Plug size={16} />} title="Linear" detail="项目与任务协作" />
            <PreviewRow icon={<Plug size={16} />} title="Notion" detail="搜索和维护团队知识" />
          </>
        )}
      </section>
    </div>
  );
}

function PreviewRow(props: { icon: ReactNode; title: string; detail: string }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '28px minmax(0, 1fr) auto', alignItems: 'center', gap: 10, minHeight: 52, padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 8 }}>
      <span style={{ display: 'grid', placeItems: 'center', color: 'var(--foreground-secondary)' }}>{props.icon}</span>
      <span style={{ minWidth: 0 }}>
        <strong style={{ display: 'block', fontSize: 12, fontWeight: 600 }}>{props.title}</strong>
        <small style={{ display: 'block', marginTop: 2, color: 'var(--muted-foreground)', fontSize: 11 }}>{props.detail}</small>
      </span>
      <Button variant="secondary" size="sm">查看</Button>
    </div>
  );
}

function StudyShell(props: { label: string; description: string; children: ReactNode }) {
  return (
    <section style={{ display: 'grid', gridTemplateRows: 'auto 630px', gap: 10 }}>
      <header style={{ minHeight: 50, paddingInline: 4 }}>
        <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>{props.label}</h2>
        <p style={{ margin: '4px 0 0', color: 'var(--muted-foreground)', fontSize: 11, lineHeight: 1.4 }}>{props.description}</p>
      </header>
      <div className="maka-panel maka-panel-detail maka-floating-panel" style={{ width: 424, height: 630, overflow: 'hidden', border: '1px solid var(--border)', borderRadius: 10 }}>
        {props.children}
      </div>
    </section>
  );
}

function UnderlineTabsVariant() {
  const [section, setSection] = useState<ExtensionSection>('skills');
  return (
    <main className="maka-main detailPane maka-module-main agents-chat-panel" style={{ height: '100%', padding: '44px 24px 24px', gridTemplateRows: 'auto minmax(0, 1fr)' }}>
      <PageHeader className="maka-module-main-header" title="扩展" subtitle="管理 Maka 可调用的技能与外部工具。" />
      <TabsRoot value={section} onValueChange={(value) => setSection(value as ExtensionSection)} style={{ minHeight: 0 }}>
        <TabsList variant="underline" style={{ gap: 16, borderBottom: '1px solid var(--border)', width: '100%', justifyContent: 'flex-start' }}>
          <TabsTrigger value="skills"><Blocks aria-hidden="true" />技能</TabsTrigger>
          <TabsTrigger value="mcp"><Plug aria-hidden="true" />MCP</TabsTrigger>
        </TabsList>
        <TabsPanel value="skills"><ContentPreview section="skills" /></TabsPanel>
        <TabsPanel value="mcp"><ContentPreview section="mcp" /></TabsPanel>
      </TabsRoot>
    </main>
  );
}

function HeaderSegmentedVariant() {
  const [section, setSection] = useState<ExtensionSection>('skills');
  return (
    <main className="maka-main detailPane maka-module-main agents-chat-panel" style={{ height: '100%', padding: '44px 24px 24px' }}>
      <PageHeader
        className="maka-module-main-header"
        title={section === 'skills' ? '技能' : 'MCP'}
        subtitle={section === 'skills' ? '发现、安装并管理可复用能力。' : '连接并管理外部工具服务。'}
        actions={<Segmented value={section} options={options} onChange={setSection} ariaLabel="扩展类型" />}
      />
      <ContentPreview section={section} />
    </main>
  );
}

function LocalRailVariant() {
  const [section, setSection] = useState<ExtensionSection>('skills');
  return (
    <main className="maka-main detailPane maka-module-main agents-chat-panel" style={{ height: '100%', padding: '44px 24px 24px' }}>
      <PageHeader className="maka-module-main-header" title="扩展" subtitle="管理 Maka 可调用的技能与外部工具。" />
      <div style={{ display: 'grid', gridTemplateColumns: '88px minmax(0, 1fr)', gap: 18, minHeight: 0 }}>
        <nav aria-label="扩展类型" style={{ display: 'grid', alignContent: 'start', gap: 4, paddingRight: 14, borderRight: '1px solid var(--border)' }}>
          {options.map(([value, label]) => (
            <Button key={value} variant={section === value ? 'secondary' : 'quiet'} size="sm" onClick={() => setSection(value)} style={{ justifyContent: 'flex-start' }}>
              {value === 'skills' ? <Blocks aria-hidden="true" /> : <Plug aria-hidden="true" />}{label}
            </Button>
          ))}
        </nav>
        <ContentPreview section={section} />
      </div>
    </main>
  );
}

const meta = {
  title: 'Design Studies/Module Hub Navigation',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const SideBySide: Story = {
  render: () => (
    <main data-maka-e2e-fixture="true" style={{ minHeight: '100vh', overflowX: 'auto', background: 'var(--surface-canvas)', padding: '28px 32px 36px' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 424px)', gap: 20, width: 'max-content', marginInline: 'auto' }}>
        <StudyShell label="A · 标题下 Tabs" description="扩展是页面；技能 / MCP 是同级内容目的地"><UnderlineTabsVariant /></StudyShell>
        <StudyShell label="B · 标题侧分段" description="保留技能 / MCP 原页面标题；切换器放在操作区"><HeaderSegmentedVariant /></StudyShell>
        <StudyShell label="C · 内容区局部导航" description="扩展标题稳定；技能 / MCP 常驻在内容左侧"><LocalRailVariant /></StudyShell>
      </div>
    </main>
  ),
};
