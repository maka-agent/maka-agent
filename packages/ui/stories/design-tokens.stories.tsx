import type { Meta, StoryObj } from '@storybook/react-vite';
import { Button } from '../src/ui.js';

const meta = {
  title: 'Design System/Tokens',
  parameters: { layout: 'padded' },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

const colorTokens = [
  '--background',
  '--background-elevated',
  '--foreground',
  '--foreground-5',
  '--foreground-30',
  '--foreground-50',
  '--foreground-70',
  '--accent',
  '--info',
  '--success',
  '--destructive',
];

const radii = [
  ['control', 'var(--radius-control)'],
  ['surface', 'var(--radius-surface)'],
  ['modal', 'var(--radius-modal)'],
  ['pill', 'var(--radius-pill)'],
] as const;

export const TokenOverview: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 28, maxWidth: 760 }}>
      <section style={{ display: 'grid', gap: 12 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>Colors</h2>
        <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
          {colorTokens.map((token) => (
            <div key={token} style={{ display: 'grid', gap: 6 }}>
              <div
                style={{
                  background: `var(${token})`,
                  borderRadius: 'var(--radius-surface)',
                  boxShadow: 'var(--shadow-minimal-flat)',
                  height: 48,
                }}
              />
              <code style={{ color: 'var(--foreground-60)', fontSize: 12 }}>{token}</code>
            </div>
          ))}
        </div>
      </section>

      <section style={{ display: 'grid', gap: 12 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>Radius</h2>
        <div style={{ alignItems: 'end', display: 'flex', flexWrap: 'wrap', gap: 12 }}>
          {radii.map(([name, radius]) => (
            <div key={name} style={{ display: 'grid', gap: 6 }}>
              <div
                style={{
                  background: 'var(--background-elevated)',
                  borderRadius: radius,
                  boxShadow: 'var(--shadow-minimal-flat)',
                  height: 56,
                  width: name === 'pill' ? 112 : 88,
                }}
              />
              <code style={{ color: 'var(--foreground-60)', fontSize: 12 }}>{name}: {radius}</code>
            </div>
          ))}
        </div>
      </section>

      <section style={{ display: 'grid', gap: 12 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>Primary Action</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button>Foreground primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="outline">Outline</Button>
        </div>
      </section>
    </div>
  ),
};
