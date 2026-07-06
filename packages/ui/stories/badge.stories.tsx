import type { Meta, StoryObj } from '@storybook/react-vite';
import { Badge } from '../src/primitives/badge.js';

const meta = {
  title: 'Primitives/Badge',
  parameters: {
    layout: 'centered',
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

// #520 PR9: the legacy ui.tsx Badge + .settingsBadge/.settingsConnectionBadge
// CSS chips collapsed onto this one primitive. Variants below cover every
// status tone statusBadgeVariant maps onto (success/warning/destructive/info
// /neutral-as-secondary) plus the rest of the shipped set.
const VARIANTS = ['default', 'destructive', 'error', 'info', 'outline', 'secondary', 'success', 'warning'] as const;
const SIZES = ['sm', 'default', 'lg'] as const;

export const BadgeMatrix: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={{ alignItems: 'center', display: 'flex', gap: 8, paddingLeft: 80 }}>
        {VARIANTS.map((v) => (
          <span key={v} style={{ color: 'var(--muted-foreground)', fontSize: 11, width: 72 }}>{v}</span>
        ))}
      </div>
      {SIZES.map((size) => (
        <div key={size} style={{ alignItems: 'center', display: 'flex', gap: 8 }}>
          <span style={{ color: 'var(--muted-foreground)', fontSize: 12, width: 72 }}>{size}</span>
          {VARIANTS.map((variant) => (
            <Badge key={variant} size={size} variant={variant} style={{ width: 72, justifyContent: 'center' }}>
              {variant}
            </Badge>
          ))}
        </div>
      ))}
    </div>
  ),
};
