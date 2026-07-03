import type { Meta, StoryObj } from '@storybook/react-vite';
import { Badge } from '../src/ui.js';
import { Badge as PrimitiveBadge } from '../src/primitives/badge.js';

const meta = {
  title: 'Primitives/Badge',
  parameters: {
    layout: 'centered',
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ alignItems: 'center', display: 'flex', gap: 12, width: 480 }}>
      <span style={{ color: 'var(--muted-foreground)', fontSize: 12, width: 80 }}>{label}</span>
      <div style={{ alignItems: 'center', display: 'flex', gap: 8, flexWrap: 'wrap' }}>{children}</div>
    </div>
  );
}

const UI_VARIANTS = ['default', 'secondary', 'success', 'warning', 'destructive', 'muted'] as const;

export const UiBadgeVariants: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 12, width: 480 }}>
      {UI_VARIANTS.map((variant) => (
        <Group key={variant} label={variant}>
          <Badge variant={variant}>{variant}</Badge>
          <Badge variant={variant}>{variant} 12</Badge>
        </Group>
      ))}
    </div>
  ),
};

const PRIM_VARIANTS = ['default', 'destructive', 'error', 'info', 'outline', 'secondary', 'success', 'warning'] as const;
const SIZES = ['sm', 'default', 'lg'] as const;

export const PrimitiveBadgeVariants: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 12, width: 560 }}>
      {PRIM_VARIANTS.map((variant) => (
        <Group key={variant} label={variant}>
          <PrimitiveBadge variant={variant}>{variant}</PrimitiveBadge>
          <PrimitiveBadge variant={variant}>{variant} 3</PrimitiveBadge>
        </Group>
      ))}
    </div>
  ),
};

export const PrimitiveBadgeSizes: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 12, width: 480 }}>
      {SIZES.map((size) => (
        <Group key={size} label={`size=${size}`}>
          <PrimitiveBadge size={size}>Aa</PrimitiveBadge>
          <PrimitiveBadge size={size} variant="info">info</PrimitiveBadge>
          <PrimitiveBadge size={size} variant="success">ok 12</PrimitiveBadge>
        </Group>
      ))}
    </div>
  ),
};