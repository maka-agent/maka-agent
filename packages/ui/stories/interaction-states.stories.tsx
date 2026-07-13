import type { Meta, StoryObj } from '@storybook/react-vite';
import { Button } from '../src/ui.js';

const meta = {
  title: 'Design System/Interaction States',
  parameters: { layout: 'padded' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const VARIANTS = ['default', 'secondary', 'ghost', 'quiet', 'destructive'] as const;

export const ButtonStates: Story = {
  render: () => (
    <section style={{ display: 'grid', gap: 16, maxWidth: 760 }}>
      <div>
        <h2 style={{ fontSize: 16, margin: 0 }}>Button interaction contract</h2>
        <p style={{ color: 'var(--foreground-secondary)', fontSize: 12, margin: '4px 0 0' }}>
          Use the real controls below for hover, active and keyboard focus. Disabled controls remain distinguishable at 45% opacity.
        </p>
      </div>
      {VARIANTS.map((variant) => (
        <div key={variant} style={{ alignItems: 'center', display: 'grid', gap: 8, gridTemplateColumns: '88px repeat(3, max-content)' }}>
          <code style={{ color: 'var(--foreground-secondary)', fontSize: 11 }}>{variant}</code>
          <Button variant={variant}>中文状态</Button>
          <Button variant={variant}>English state</Button>
          <Button variant={variant} disabled>Disabled</Button>
        </div>
      ))}
    </section>
  ),
};

// Backward-compatible story id for the issue's before/after screenshot URL.
export const ListRowStates: Story = ButtonStates;
export const NeutralButtonStates: Story = ButtonStates;
export const SolidButtonStates: Story = ButtonStates;
