import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState, type CSSProperties, type ReactNode } from 'react';
import {
  Button,
  Menu,
  MenuItem,
  MenuPopup,
  MenuTrigger,
  PageHeader,
  TabsList,
  TabsRoot,
  TabsTrigger,
} from '@maka/ui';
import { Blocks, Check, ChevronDown, Plug, Plus, Search } from '@maka/ui/icons';

type ExtensionSection = 'skills' | 'mcp';

const options = [['skills', '技能'], ['mcp', 'MCP']] as const;

function sectionLabel(section: ExtensionSection) {
  return section === 'skills' ? '技能' : 'MCP';
}

function SectionMenu(props: {
  section: ExtensionSection;
  onChange: (section: ExtensionSection) => void;
  style?: CSSProperties;
  variant?: 'title' | 'path' | 'button';
}) {
  const icon = props.section === 'skills' ? <Blocks aria-hidden="true" size={props.variant === 'title' ? 20 : 15} /> : <Plug aria-hidden="true" size={props.variant === 'title' ? 20 : 15} />;
  const buttonStyle: CSSProperties = props.variant === 'title'
    ? { width: 'auto', height: 'auto', justifySelf: 'start', padding: '2px 4px', marginLeft: -4, fontSize: 24, fontWeight: 650, letterSpacing: '-0.02em', gap: 7 }
    : props.variant === 'path'
      ? { height: 'auto', padding: '2px 4px', fontSize: 22, fontWeight: 650, letterSpacing: '-0.02em', gap: 6 }
      : { minWidth: 112, justifyContent: 'space-between' };

  return (
    <Menu>
      <MenuTrigger render={<Button variant={props.variant === 'button' ? 'secondary' : 'quiet'} size={props.variant === 'button' ? 'sm' : undefined} />} style={{ ...buttonStyle, ...props.style }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>{icon}{sectionLabel(props.section)}</span>
        <ChevronDown aria-hidden="true" size={14} />
      </MenuTrigger>
      <MenuPopup align="start" sideOffset={6}>
        {options.map(([value, label]) => (
          <MenuItem key={value} onClick={() => props.onChange(value)}>
            {value === 'skills' ? <Blocks aria-hidden="true" size={14} /> : <Plug aria-hidden="true" size={14} />}
            <span style={{ minWidth: 72 }}>{label}</span>
            {props.section === value ? <Check aria-hidden="true" size={14} /> : null}
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}

function ContentPreview(props: { section: ExtensionSection }) {
  const skills = props.section === 'skills';
  return (
    <div style={{ display: 'grid', alignContent: 'start', gap: 14, minHeight: 0 }}>
      <TabsRoot defaultValue="market">
        <TabsList variant="underline" style={{ gap: 16, borderBottom: '1px solid var(--border)', width: '100%', justifyContent: 'flex-start' }}>
          <TabsTrigger value="market">市场</TabsTrigger>
          {skills ? <TabsTrigger value="builtin">内置</TabsTrigger> : null}
          <TabsTrigger value="installed">已安装</TabsTrigger>
        </TabsList>
      </TabsRoot>
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

function StudyShell(props: { label: string; description: string; recommendation?: string; children: ReactNode }) {
  return (
    <section style={{ display: 'grid', gridTemplateRows: 'auto 590px', gap: 10 }}>
      <header style={{ minHeight: 54, paddingInline: 4 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <h2 style={{ margin: 0, fontSize: 14, fontWeight: 650 }}>{props.label}</h2>
          {props.recommendation ? <span style={{ padding: '2px 6px', borderRadius: 999, background: 'var(--surface-subtle)', color: 'var(--foreground-secondary)', fontSize: 10, fontWeight: 600 }}>{props.recommendation}</span> : null}
        </div>
        <p style={{ margin: '4px 0 0', color: 'var(--muted-foreground)', fontSize: 11, lineHeight: 1.4 }}>{props.description}</p>
      </header>
      <div className="maka-panel maka-panel-detail maka-floating-panel" style={{ width: 570, height: 590, overflow: 'hidden', border: '1px solid var(--border)', borderRadius: 10 }}>
        {props.children}
      </div>
    </section>
  );
}

const pageStyle: CSSProperties = {
  height: '100%',
  padding: '40px 28px 24px',
  gap: 22,
};

function CurrentModuleTitleVariant() {
  const [section, setSection] = useState<ExtensionSection>('skills');
  return (
    <main className="maka-main detailPane maka-module-main agents-chat-panel" style={pageStyle}>
      <header style={{ display: 'grid', gap: 4 }}>
        <span style={{ color: 'var(--muted-foreground)', fontSize: 11, fontWeight: 600, letterSpacing: '0.04em' }}>扩展</span>
        <SectionMenu section={section} onChange={setSection} variant="title" />
        <p style={{ margin: 0, color: 'var(--muted-foreground)', fontSize: 12 }}>管理 Maka 可调用的{section === 'skills' ? '技能' : '外部工具'}。</p>
      </header>
      <ContentPreview section={section} />
    </main>
  );
}

function PathTitleVariant() {
  const [section, setSection] = useState<ExtensionSection>('skills');
  return (
    <main className="maka-main detailPane maka-module-main agents-chat-panel" style={pageStyle}>
      <header style={{ display: 'grid', gap: 5 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 650, letterSpacing: '-0.02em' }}>扩展</h2>
          <span aria-hidden="true" style={{ color: 'var(--border-strong)', fontSize: 21, fontWeight: 300 }}>/</span>
          <SectionMenu section={section} onChange={setSection} variant="path" />
        </div>
        <p style={{ margin: 0, color: 'var(--muted-foreground)', fontSize: 12 }}>管理 Maka 可调用的技能与外部工具。</p>
      </header>
      <ContentPreview section={section} />
    </main>
  );
}

function PrimaryNavVariant() {
  const [section, setSection] = useState<ExtensionSection>('skills');
  return (
    <main className="maka-main detailPane maka-module-main agents-chat-panel" style={{ ...pageStyle, gridTemplateRows: 'auto auto minmax(0, 1fr)', gap: 16 }}>
      <PageHeader className="maka-module-main-header" title="扩展" subtitle="管理 Maka 可调用的技能与外部工具。" />
      <nav aria-label="扩展类型" style={{ display: 'flex', gap: 24, borderBottom: '1px solid var(--border)' }}>
        {options.map(([value, label]) => {
          const active = section === value;
          return (
            <button
              key={value}
              type="button"
              onClick={() => setSection(value)}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '4px 2px 10px', marginBottom: -1, border: 0, borderBottom: active ? '2px solid var(--foreground)' : '2px solid transparent', background: 'transparent', color: active ? 'var(--foreground)' : 'var(--muted-foreground)', font: 'inherit', fontSize: 13, fontWeight: active ? 600 : 500, cursor: 'pointer' }}
            >
              {value === 'skills' ? <Blocks aria-hidden="true" size={15} /> : <Plug aria-hidden="true" size={15} />}{label}
            </button>
          );
        })}
      </nav>
      <ContentPreview section={section} />
    </main>
  );
}

function ModuleCardsVariant() {
  const [section, setSection] = useState<ExtensionSection>('skills');
  return (
    <main className="maka-main detailPane maka-module-main agents-chat-panel" style={{ ...pageStyle, gridTemplateRows: 'auto auto minmax(0, 1fr)', gap: 16 }}>
      <PageHeader className="maka-module-main-header" title="扩展" subtitle="管理 Maka 可调用的技能与外部工具。" />
      <nav aria-label="扩展类型" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8 }}>
        {options.map(([value, label]) => {
          const active = section === value;
          return (
            <button
              key={value}
              type="button"
              onClick={() => setSection(value)}
              style={{ display: 'grid', gridTemplateColumns: '28px minmax(0, 1fr) auto', alignItems: 'center', gap: 8, minHeight: 52, padding: '8px 10px', border: `1px solid ${active ? 'var(--foreground-secondary)' : 'var(--border)'}`, borderRadius: 8, background: active ? 'var(--surface-subtle)' : 'transparent', color: 'var(--foreground)', textAlign: 'left', cursor: 'pointer' }}
            >
              <span style={{ display: 'grid', placeItems: 'center', color: active ? 'var(--foreground)' : 'var(--muted-foreground)' }}>{value === 'skills' ? <Blocks aria-hidden="true" size={16} /> : <Plug aria-hidden="true" size={16} />}</span>
              <span>
                <strong style={{ display: 'block', fontSize: 12, fontWeight: 600 }}>{label}</strong>
                <small style={{ display: 'block', marginTop: 1, color: 'var(--muted-foreground)', fontSize: 10 }}>{value === 'skills' ? '能力与工作流' : '外部工具连接'}</small>
              </span>
              {active ? <Check aria-hidden="true" size={14} /> : null}
            </button>
          );
        })}
      </nav>
      <ContentPreview section={section} />
    </main>
  );
}

const meta = {
  title: 'Design Studies/Module Hub Navigation',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const Alternatives: Story = {
  render: () => (
    <main data-maka-e2e-fixture="true" style={{ minHeight: '100vh', overflowX: 'auto', background: 'var(--surface-canvas)', padding: '28px 32px 36px' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 570px)', gap: '28px 24px', width: 'max-content', marginInline: 'auto' }}>
        <StudyShell label="A · 当前模块作为标题" description="父级退成眉题；点击大标题切换技能 / MCP" recommendation="推荐"><CurrentModuleTitleVariant /></StudyShell>
        <StudyShell label="B · 路径式标题" description="保留“扩展”主语，用路径表达父子层级"><PathTitleVariant /></StudyShell>
        <StudyShell label="C · 独立一级导航" description="切换最直接，但会与内容 Tabs 形成两层横向导航"><PrimaryNavVariant /></StudyShell>
        <StudyShell label="D · 模块选择卡" description="识别度和点击区域最好，但占用更多页面空间"><ModuleCardsVariant /></StudyShell>
      </div>
    </main>
  ),
};
