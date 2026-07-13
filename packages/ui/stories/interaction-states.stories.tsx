import type { Meta, StoryObj } from '@storybook/react-vite';
import { Button } from '../src/ui.js';

const meta = {
  title: 'Design System/Interaction States',
  parameters: { layout: 'padded' },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

// Visual contract for the two interaction-state backgrounds:
//   hover     -> --state-hover-bg     (4% foreground alpha, transient)
//   selected  -> --state-selected-bg  (6.5% foreground alpha, persistent)
//   pressed   -> :active background = --state-selected-bg (no scale transform)
// The rows below pin each state statically so reviewers can compare wash
// intensity and confirm hover (4%) < selected (6.5%). Press feedback is a
// background change, not a scale — pinned by the state-token contracts from #499.

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '8px 12px',
  borderRadius: 6,
  fontSize: 13,
  fontFamily: 'var(--font-sans)',
  border: '1px solid var(--border)',
};

export const ListRowStates: Story = {
  render: () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxWidth: 360 }}>
      <div style={{ ...rowStyle, background: 'transparent', color: 'var(--foreground-secondary)' }}>
        <span>default</span>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--muted-foreground)' }}>transparent</span>
      </div>
      <div style={{ ...rowStyle, background: 'var(--state-hover-bg)', color: 'var(--foreground)' }}>
        <span>hover</span>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--muted-foreground)' }}>--state-hover-bg · 4%</span>
      </div>
      <div style={{ ...rowStyle, background: 'var(--state-selected-bg)', color: 'var(--foreground)', fontWeight: 500 }}>
        <span>selected / pressed</span>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--muted-foreground)' }}>--state-selected-bg · 6.5% · no scale</span>
      </div>
    </div>
  ),
};

export const NeutralButtonStates: Story = {
  render: () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 480 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <Button variant="ghost">ghost default</Button>
        <Button variant="ghost" style={{ background: 'var(--muted)' } as React.CSSProperties}>
          ghost hover (demo)
        </Button>
        <Button variant="ghost" style={{ background: 'var(--state-selected-bg)' } as React.CSSProperties}>
          ghost pressed (demo)
        </Button>
      </div>
      <p style={{ fontSize: 11, color: 'var(--muted-foreground)', margin: 0 }}>
        Neutral variants (ghost/outline/secondary/quiet) press with state tokens: hover = <code>bg-muted</code> (var(--muted)), pressed = <code>--state-selected-bg</code>. Matches ui.tsx buttonVariants.
      </p>
    </div>
  ),
};

export const SolidButtonStates: Story = {
  render: () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 480 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <Button variant="default">default</Button>
        <Button variant="destructive">destructive</Button>
      </div>
      <p style={{ fontSize: 11, color: 'var(--muted-foreground)', margin: 0 }}>
        Solid variants (default/destructive) fill with primary/destructive and press to their hover state (<code>hover:bg-primary/90 active:bg-primary/90</code>). They are NOT state-token surfaces — see ui.tsx buttonVariants for the real values.
      </p>
    </div>
  ),
};
