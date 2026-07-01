import type { Meta, StoryObj } from '@storybook/react-vite';
import { Button } from '../src/ui.js';

const meta = {
  title: 'Design System/Tokens',
  parameters: { layout: 'padded' },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

const colorSwatches = [
  ['background', '--background'],
  ['foreground', '--foreground'],
  ['accent', '--accent'],
  ['action', '--action'],
  ['control', '--control'],
  ['info', '--info'],
  ['success', '--success'],
  ['destructive', '--destructive'],
] as const;

const emphasisAliases = [
  '--link',
  '--focus-ring',
  '--status-running',
  '--nav-active',
  '--toast-accent',
] as const;

const radiusSamples = [
  ['control', '6px', '--radius-control', 'Buttons, inputs, compact chips', 96, 56],
  ['surface', '8px', '--radius-surface', 'Cards, popovers, code blocks', 112, 64],
  ['modal', '12px', '--radius-modal', 'Dialogs and composer-scale surfaces', 128, 72],
  ['pill', '999px', '--radius-pill', 'Badges, dots, status pills', 144, 56],
] as const;

export const Colors: Story = {
  render: () => (
    <section style={{ display: 'grid', gap: 12, maxWidth: 760 }}>
      <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>Colors</h2>
      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(132px, 1fr))' }}>
        {colorSwatches.map(([name, token]) => (
          <div key={token} style={{ display: 'grid', gap: 6, minWidth: 0 }}>
            <div
              style={{
                background: `var(${token})`,
                borderRadius: 'var(--radius-surface)',
                boxShadow: 'var(--shadow-minimal-flat)',
                height: 48,
              }}
            />
            <strong style={{ fontSize: 12, fontWeight: 600 }}>{name}</strong>
            <code style={{ color: 'var(--foreground-60)', fontSize: 11, wordBreak: 'break-word' }}>{token}</code>
          </div>
        ))}
      </div>
      <div style={{ color: 'var(--foreground-60)', display: 'flex', flexWrap: 'wrap', gap: 6, fontSize: 12 }}>
        {emphasisAliases.map((token) => (
          <code key={token} style={{ borderRadius: 'var(--radius-control)', background: 'var(--foreground-5)', padding: '2px 6px' }}>{token}</code>
        ))}
      </div>
    </section>
  ),
};

export const Radius: Story = {
  render: () => (
    <section style={{ display: 'grid', gap: 14, maxWidth: 760 }}>
      <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>Radius</h2>
      <div style={{ display: 'grid', gap: 10 }}>
        {radiusSamples.map(([name, value, token, usage, width, height]) => (
          <div
            key={name}
            style={{
              alignItems: 'center',
              display: 'grid',
              gap: 16,
              gridTemplateColumns: 'minmax(0, 1fr) 180px',
              minWidth: 0,
              padding: '10px 0',
            }}
          >
            <div style={{ display: 'grid', gap: 5, minWidth: 0 }}>
              <strong style={{ fontSize: 14, fontWeight: 650 }}>{name}</strong>
              <span style={{ fontSize: 28, fontWeight: 650, lineHeight: 1 }}>{value}</span>
              <code style={{ color: 'var(--foreground-60)', fontSize: 11, wordBreak: 'break-word' }}>{token}</code>
              <span style={{ color: 'var(--foreground-60)', fontSize: 12, lineHeight: 1.4 }}>{usage}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
              <div
                style={{
                  background: 'var(--background-elevated)',
                  borderRadius: `var(${token})`,
                  boxShadow: 'var(--shadow-minimal-flat)',
                  height,
                  width,
                }}
              />
            </div>
          </div>
        ))}
      </div>
    </section>
  ),
};

export const PrimaryActions: Story = {
  render: () => (
    <section style={{ display: 'grid', gap: 12, maxWidth: 760 }}>
      <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>Primary Actions</h2>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <Button>Action primary</Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="outline">Outline</Button>
      </div>
    </section>
  ),
};
