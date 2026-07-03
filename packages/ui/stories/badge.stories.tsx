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

const UI_VARIANTS = ['default', 'secondary', 'success', 'warning', 'destructive', 'muted'] as const;

export const UiBadgeVariants: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 12, width: 480 }}>
      {UI_VARIANTS.map((variant) => (
        <div key={variant} style={{ alignItems: 'center', display: 'flex', gap: 8 }}>
          <span style={{ color: 'var(--muted-foreground)', fontSize: 12, width: 80 }}>{variant}</span>
          <Badge variant={variant}>{variant}</Badge>
          <Badge variant={variant}>{variant} 12</Badge>
        </div>
      ))}
    </div>
  ),
};

const PRIM_VARIANTS = ['default', 'destructive', 'error', 'info', 'outline', 'secondary', 'success', 'warning'] as const;
const SIZES = ['sm', 'default', 'lg'] as const;

export const PrimitiveBadgeMatrix: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={{ alignItems: 'center', display: 'flex', gap: 8, paddingLeft: 80 }}>
        {PRIM_VARIANTS.map((v) => (
          <span key={v} style={{ color: 'var(--muted-foreground)', fontSize: 11, width: 72 }}>{v}</span>
        ))}
      </div>
      {SIZES.map((size) => (
        <div key={size} style={{ alignItems: 'center', display: 'flex', gap: 8 }}>
          <span style={{ color: 'var(--muted-foreground)', fontSize: 12, width: 72 }}>{size}</span>
          {PRIM_VARIANTS.map((variant) => (
            <PrimitiveBadge key={variant} size={size} variant={variant} style={{ width: 72, justifyContent: 'center' }}>
              {variant}
            </PrimitiveBadge>
          ))}
        </div>
      ))}
    </div>
  ),
};