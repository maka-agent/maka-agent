import type { Meta, StoryObj } from '@storybook/react-vite';

const meta = {
  title: 'Design System/Spacing',
  parameters: { layout: 'padded' },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

const scale = [
  ['--space-0', 0, '无间距'],
  ['--space-0-5', 2, '极小间隙（chip 内图标）'],
  ['--space-1', 4, '小间隙'],
  ['--space-1-5', 6, 'dense UI 半步（chip gap、meta 行）'],
  ['--space-2', 8, 'turn 内间隙、卡片内边距'],
  ['--space-2-5', 10, 'section 间距半步'],
  ['--space-3', 12, '卡片内边距、section gap'],
  ['--space-4', 16, 'chat turn gap、卡片大边距'],
  ['--space-5', 20, '页面 padding'],
  ['--space-6', 24, '消息行水平 padding'],
  ['--space-8', 32, '大留白'],
  ['--space-10', 40, 'hero 区上下 padding'],
  ['--space-12', 48, '大段落间距'],
  ['--space-16', 64, '响应式大留白上限'],
] as const;

const layoutGeometry = [
  ['--w-sidebar', '240px', '侧边栏宽度'],
  ['--w-rail', '240px', '右侧栏宽度'],
  ['--w-sessionlist', '240px', '会话列表宽度'],
  ['--h-titlebar', '36px', '标题栏高度'],
  ['--h-toolbar', '40px', '工具栏高度'],
  ['--h-composer-min', '56px', '输入框最小高度'],
  ['--h-list-header', '52px', '列表头高度'],
] as const;

export const Spacing: Story = {
  render: () => (
    <section style={{ display: 'grid', gap: 24, maxWidth: 820 }}>
      <div style={{ display: 'grid', gap: 4 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>Spacing</h2>
        <p style={{ color: 'var(--foreground-60)', fontSize: 12, margin: 0, lineHeight: 1.5 }}>
          基础步长 --spacing: 4px。14 个 --space-* token 覆盖全部 padding/gap/margin。Tailwind 的 p-N/gap-N/m-N 通过 @theme inline 共用同一把尺子。1px 作为 hairline literal 保留，不进 scale。
        </p>
      </div>

      <div style={{ display: 'grid', gap: 8 }}>
        <h3 style={{ fontSize: 13, fontWeight: 600, margin: 0, color: 'var(--foreground-70)' }}>
          --space-* scale
        </h3>
        <div
          style={{
            display: 'grid',
            gap: 6,
            gridTemplateColumns: '140px minmax(0, 1fr) 56px',
            alignItems: 'center',
          }}
        >
          {scale.map(([token, px, usage]) => (
            <ScaleRow key={token} token={token} px={px} usage={usage} />
          ))}
        </div>
      </div>

      <div style={{ display: 'grid', gap: 8 }}>
        <h3 style={{ fontSize: 13, fontWeight: 600, margin: 0, color: 'var(--foreground-70)' }}>
          Hairline
        </h3>
        <div
          style={{
            display: 'grid',
            gap: 6,
            gridTemplateColumns: '140px minmax(0, 1fr) 56px',
            alignItems: 'center',
          }}
        >
          <code style={{ color: 'var(--foreground-60)', fontSize: 11 }}>1px literal</code>
          <div
            style={{
              height: 1,
              background: 'var(--foreground)',
              width: '100%',
            }}
          />
          <span style={{ color: 'var(--foreground-50)', fontSize: 11, fontVariantNumeric: 'tabular-nums' }}>
            1px
          </span>
        </div>
      </div>

      <div style={{ display: 'grid', gap: 8 }}>
        <h3 style={{ fontSize: 13, fontWeight: 600, margin: 0, color: 'var(--foreground-70)' }}>
          布局几何
        </h3>
        <div
          style={{
            display: 'grid',
            gap: 6,
            gridTemplateColumns: '140px 56px minmax(0, 1fr)',
            alignItems: 'baseline',
          }}
        >
          {layoutGeometry.map(([token, value, usage]) => (
            <FragmentRow key={token} token={token} value={value} usage={usage} />
          ))}
        </div>
      </div>
    </section>
  ),
};

function ScaleRow({ token, px, usage }: { token: string; px: number; usage: string }) {
  return (
    <>
      <code style={{ color: 'var(--foreground-60)', fontSize: 11 }}>{token}</code>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <div
          style={{
            background: 'var(--accent)',
            borderRadius: 'var(--radius-control)',
            height: 12,
            width: px === 0 ? 0 : `var(${token})`,
            minWidth: px === 0 ? 0 : 2,
            flexShrink: 0,
          }}
        />
        <span style={{ color: 'var(--foreground-50)', fontSize: 10, lineHeight: 1.3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {usage}
        </span>
      </div>
      <span style={{ color: 'var(--foreground-50)', fontSize: 11, fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}>
        {px === 0 ? '0' : `${px}px`}
      </span>
    </>
  );
}

function FragmentRow({ token, value, usage }: { token: string; value: string; usage: string }) {
  return (
    <>
      <code style={{ color: 'var(--foreground-60)', fontSize: 11 }}>{token}</code>
      <span style={{ color: 'var(--foreground-50)', fontSize: 11, fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </span>
      <span style={{ color: 'var(--foreground-50)', fontSize: 10, lineHeight: 1.3 }}>{usage}</span>
    </>
  );
}