import type { Meta, StoryObj } from '@storybook/react-vite';

const meta = {
  title: 'Design System/Elevation',
  parameters: { layout: 'padded' },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

const shadowRecipes = [
  ['minimal', '--shadow-minimal', '卡片、工具卡片基础层'],
  ['minimal-flat', '--shadow-minimal-flat', '无模糊,仅 1px border ring'],
  ['medium', '--shadow-medium', '悬浮卡片、popover'],
  ['modal', '--shadow-modal', '模态、对话框'],
] as const;

const borderTokens = [
  ['border', '--border', '默认分隔线'],
  ['border-strong', '--border-strong', '强调分隔线'],
  ['ring', '--ring', '聚焦环'],
  ['muted', '--muted', '静音/禁用态'],
] as const;

export const Elevation: Story = {
  render: () => (
    <section style={{ display: 'grid', gap: 24, maxWidth: 820 }}>
      <div style={{ display: 'grid', gap: 4 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>Elevation & Borders</h2>
        <p style={{ color: 'var(--foreground-secondary)', fontSize: 12, margin: 0, lineHeight: 1.5 }}>
          4 个 shadow recipe 承载所有视觉层级。视觉边框走 shadow-ring,布局边框保留 border。
        </p>
      </div>
      <div
        style={{
          display: 'grid',
          gap: 12,
          gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
        }}
      >
        {shadowRecipes.map(([name, token, usage]) => (
          <div key={name} style={{ display: 'grid', gap: 6 }}>
            <div
              style={{
                background: 'var(--background)',
                borderRadius: 'var(--radius-surface)',
                boxShadow: `var(${token})`,
                height: 80,
              }}
            />
            <strong style={{ fontSize: 12, fontWeight: 600 }}>{name}</strong>
            <code style={{ color: 'var(--foreground-secondary)', fontSize: 11 }}>{token}</code>
            <span style={{ color: 'var(--muted-foreground)', fontSize: 10, lineHeight: 1.3 }}>{usage}</span>
          </div>
        ))}
      </div>
      <div style={{ display: 'grid', gap: 8 }}>
        <h3 style={{ fontSize: 13, fontWeight: 600, margin: 0, color: 'var(--foreground-secondary)' }}>Border tokens</h3>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {borderTokens.map(([name, token, usage]) => (
            <div key={name} style={{ display: 'grid', gap: 4, placeItems: 'center' }}>
              <div
                style={{
                  background: `var(${token})`,
                  borderRadius: 'var(--radius-control)',
                  height: 36,
                  width: 72,
                }}
              />
              <code style={{ color: 'var(--foreground-secondary)', fontSize: 10 }}>{token}</code>
              <span style={{ color: 'var(--muted-foreground)', fontSize: 10 }}>{usage}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  ),
};
