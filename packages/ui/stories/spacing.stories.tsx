import type { Meta, StoryObj } from '@storybook/react-vite';

const meta = {
  title: 'Design System/Spacing',
  parameters: { layout: 'padded' },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

const spacingSteps = [1, 2, 3, 4, 6, 8] as const;

const layoutGeometry = [
  ['w-sidebar', '--w-sidebar', '侧边栏宽度'],
  ['w-rail', '--w-rail', '右侧栏宽度'],
  ['w-sessionlist', '--w-sessionlist', '会话列表宽度'],
  ['h-titlebar', '--h-titlebar', '标题栏高度'],
  ['h-toolbar', '--h-toolbar', '工具栏高度'],
  ['h-composer-min', '--h-composer-min', '输入框最小高度'],
  ['h-list-header', '--h-list-header', '列表头高度'],
] as const;

export const Spacing: Story = {
  render: () => (
    <section style={{ display: 'grid', gap: 24, maxWidth: 760 }}>
      <div style={{ display: 'grid', gap: 4 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>Spacing</h2>
        <p style={{ color: 'var(--foreground-60)', fontSize: 12, margin: 0, lineHeight: 1.5 }}>
          基础步长 --spacing: 0.25rem (4px)。布局几何用语义 token,不写裸像素。
        </p>
      </div>
      <div style={{ display: 'grid', gap: 8 }}>
        <h3 style={{ fontSize: 13, fontWeight: 600, margin: 0, color: 'var(--foreground-70)' }}>步进</h3>
        {spacingSteps.map((step) => (
          <div key={step} style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <code style={{ color: 'var(--foreground-60)', fontSize: 11, minWidth: 160 }}>
              calc(var(--spacing) * {step})
            </code>
            <div
              style={{
                background: 'var(--accent)',
                borderRadius: 'var(--radius-control)',
                height: 16,
                width: `calc(var(--spacing) * ${step})`,
              }}
            />
            <span style={{ color: 'var(--foreground-50)', fontSize: 11 }}>{step * 4}px</span>
          </div>
        ))}
      </div>
      <div style={{ display: 'grid', gap: 8 }}>
        <h3 style={{ fontSize: 13, fontWeight: 600, margin: 0, color: 'var(--foreground-70)' }}>布局几何</h3>
        {layoutGeometry.map(([name, token, usage]) => (
          <div key={name} style={{ display: 'flex', gap: 12, alignItems: 'baseline' }}>
            <code style={{ color: 'var(--foreground-60)', fontSize: 11, minWidth: 160 }}>{token}</code>
            <span style={{ fontSize: 12 }}>{usage}</span>
          </div>
        ))}
      </div>
    </section>
  ),
};
