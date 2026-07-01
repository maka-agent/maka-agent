import type { Meta, StoryObj } from '@storybook/react-vite';
import { Spinner } from '../src/primitives/spinner.js';

const meta = {
  title: 'Design System/Animation Catalog',
  parameters: { layout: 'centered' },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const RetainedFunctionalMotion: Story = {
  render: () => (
    <div style={{ alignItems: 'end', display: 'grid', gap: 24, gridTemplateColumns: 'repeat(3, minmax(96px, 1fr))' }}>
      <div style={{ alignItems: 'center', display: 'grid', gap: 8, justifyItems: 'center' }}>
        <Spinner style={{ height: 20, width: 20 }} />
        <span style={{ color: 'var(--foreground-70)', fontSize: 12, fontWeight: 600 }}>Spinner</span>
      </div>
      <div style={{ alignItems: 'center', display: 'grid', gap: 8, justifyItems: 'center' }}>
        <span
          aria-hidden="true"
          style={{
            animation: 'maka-pulse 1.4s ease-in-out infinite',
            background: 'var(--accent)',
            borderRadius: 'var(--radius-pill)',
            display: 'inline-block',
            height: 10,
            width: 10,
          }}
        />
        <span style={{ color: 'var(--foreground-70)', fontSize: 12, fontWeight: 600 }}>Status pulse</span>
      </div>
      <div style={{ alignItems: 'center', display: 'grid', gap: 8, justifyItems: 'center' }}>
        <span
          aria-hidden="true"
          style={{
            animation: 'maka-shimmer 1.8s linear infinite',
            background:
              'linear-gradient(120deg, transparent 40%, oklch(from var(--foreground) l c h / 0.16), transparent 60%) var(--foreground-5) 0 0 / 200% 100%',
            borderRadius: 'var(--radius-surface)',
            display: 'inline-block',
            height: 20,
            width: 96,
          }}
        />
        <span style={{ color: 'var(--foreground-70)', fontSize: 12, fontWeight: 600 }}>Shimmer</span>
      </div>
    </div>
  ),
};
