import type { Meta, StoryObj } from '@storybook/react-vite';

const meta = {
  title: 'Design System/Typography',
  parameters: { layout: 'padded' },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const TypeScale: Story = {
  render: () => (
    <section style={{ display: 'grid', gap: 24, maxWidth: 760 }}>
      <div style={{ display: 'grid', gap: 4 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>Typography</h2>
        <p style={{ color: 'var(--foreground-secondary)', fontSize: 12, margin: 0, lineHeight: 1.5 }}>
          基础字号 15px。主字体走系统栈,CJK 回退到平台中文字体。Mono 用 Geist Mono。
        </p>
      </div>
      <div style={{ display: 'grid', gap: 14 }}>
        <div style={{ display: 'grid', gap: 4 }}>
          <code style={{ color: 'var(--foreground-secondary)', fontSize: 11 }}>--font-sans</code>
          <div style={{ fontFamily: 'var(--font-sans)', fontSize: 15 }}>
            The quick brown fox jumps over the lazy dog. 中文排版示例:敏捷的棕色狐狸跳过了懒狗。
          </div>
        </div>
        <div style={{ display: 'grid', gap: 4 }}>
          <code style={{ color: 'var(--foreground-secondary)', fontSize: 11 }}>--font-mono</code>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 14 }}>
            const greeting = "Hello, 世界";
          </div>
        </div>
      </div>
      <div style={{ display: 'grid', gap: 10 }}>
        <h3 style={{ fontSize: 13, fontWeight: 600, margin: 0, color: 'var(--foreground-secondary)' }}>Markdown 示例</h3>
        <div style={{ fontFamily: 'var(--font-sans)', fontSize: 15, display: 'grid', gap: 8 }}>
          <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0 }}>Heading 1</h1>
          <h2 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>Heading 2</h2>
          <h3 style={{ fontSize: 17, fontWeight: 600, margin: 0 }}>Heading 3</h3>
          <p style={{ margin: 0 }}>
            正文段落,包含 <strong>粗体</strong> 和 <em>斜体</em> 以及{' '}
            <code style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>inline code</code>。
          </p>
        </div>
      </div>
      <div style={{ display: 'grid', gap: 10 }}>
        <h3 style={{ fontSize: 13, fontWeight: 600, margin: 0, color: 'var(--foreground-secondary)' }}>Code block</h3>
        <pre
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 13,
            background: 'var(--foreground-5)',
            borderRadius: 'var(--radius-surface)',
            padding: 12,
            margin: 0,
            overflow: 'auto',
            boxShadow: 'inset 0 0 0 1px var(--border)',
          }}
        >
{`function greet(name: string): string {
  return \`Hello, \${name}!\`;
}`}
        </pre>
      </div>
    </section>
  ),
};
