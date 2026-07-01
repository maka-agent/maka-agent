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
    <div style={{ alignItems: 'center', display: 'flex', gap: 24 }}>
      <Spinner style={{ height: 20, width: 20 }} />
      <span
        style={{
          animation: 'maka-pulse 1.4s ease-in-out infinite',
          background: 'var(--accent)',
          borderRadius: 'var(--radius-pill)',
          display: 'inline-block',
          height: 10,
          width: 10,
        }}
      />
      <span
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
    </div>
  ),
};
