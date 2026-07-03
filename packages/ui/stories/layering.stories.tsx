import type { Meta, StoryObj } from '@storybook/react-vite';

const meta = {
  title: 'Design System/Layering',
  parameters: { layout: 'padded' },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

const zScale = [
  ['base', '--z-base', '0', '基础层'],
  ['panel-action', '--z-panel-action', '4', '面板内操作层'],
  ['sticky', '--z-sticky', '20', '粘性定位'],
  ['settings-fullpage', '--z-settings-fullpage', '35', '设置全页'],
  ['titlebar', '--z-titlebar', '40', '标题栏'],
  ['panel', '--z-panel', '50', '浮动面板'],
  ['dropdown', '--z-dropdown', '100', '下拉菜单'],
  ['tooltip', '--z-tooltip', '150', '工具提示'],
  ['modal', '--z-modal', '200', '模态框'],
  ['overlay', '--z-overlay', '300', '全局遮罩'],
] as const;

export const Layering: Story = {
  render: () => (
    <section style={{ display: 'grid', gap: 24, maxWidth: 760 }}>
      <div style={{ display: 'grid', gap: 4 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>Layering / Z-index</h2>
        <p style={{ color: 'var(--foreground-secondary)', fontSize: 12, margin: 0, lineHeight: 1.5 }}>
          语义 z-index token,按值排序。值越大越在上层。裸 z-index 数字在 renderer CSS 中被 contract 禁止。
        </p>
      </div>
      <div style={{ display: 'grid', gap: 6 }}>
        {zScale.map(([name, token, value, usage], index) => (
          <div
            key={name}
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(0, 1fr) 56px 60px',
              gap: 12,
              alignItems: 'center',
              padding: '8px 12px',
              borderRadius: 'var(--radius-control)',
              background: 'var(--foreground-5)',
              marginLeft: `${index * 12}px`,
            }}
          >
            <div style={{ display: 'grid', gap: 2, minWidth: 0 }}>
              <strong style={{ fontSize: 13, fontWeight: 600 }}>{name}</strong>
              <span style={{ color: 'var(--foreground-secondary)', fontSize: 11 }}>{usage}</span>
            </div>
            <code style={{ color: 'var(--foreground-secondary)', fontSize: 11, textAlign: 'right' }}>{token}</code>
            <span
              style={{
                fontSize: 13,
                fontWeight: 650,
                fontVariantNumeric: 'tabular-nums',
                textAlign: 'right',
                color: 'var(--accent)',
              }}
            >
              {value}
            </span>
          </div>
        ))}
      </div>
    </section>
  ),
};
