import type { Meta, StoryObj } from '@storybook/react-vite';
import { Button } from '../src/ui.js';
import { Spinner } from '../src/primitives/spinner.js';
import { Plus, Search, Trash2 } from '@maka/ui/icons';

const meta = {
  title: 'Design System/Interaction States',
  parameters: { layout: 'padded' },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const InteractionStates: Story = {
  render: () => (
    <section style={{ display: 'grid', gap: 24, maxWidth: 760 }}>
      <div style={{ display: 'grid', gap: 4 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>Interaction States</h2>
        <p style={{ color: 'var(--foreground-60)', fontSize: 12, margin: 0, lineHeight: 1.5 }}>
          按钮变体在 default / disabled / loading 下的表现。hover/active 需用鼠标交互查看。
        </p>
      </div>

      <div style={{ display: 'grid', gap: 10 }}>
        <h3 style={{ fontSize: 13, fontWeight: 600, margin: 0, color: 'var(--foreground-70)' }}>default</h3>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <Button>Action primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="quiet">Quiet</Button>
          <Button variant="destructive">Destructive</Button>
        </div>
      </div>

      <div style={{ display: 'grid', gap: 10 }}>
        <h3 style={{ fontSize: 13, fontWeight: 600, margin: 0, color: 'var(--foreground-70)' }}>disabled</h3>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <Button disabled>Action primary</Button>
          <Button variant="secondary" disabled>
            Secondary
          </Button>
          <Button variant="outline" disabled>
            Outline
          </Button>
          <Button variant="destructive" disabled>
            Destructive
          </Button>
        </div>
      </div>

      <div style={{ display: 'grid', gap: 10 }}>
        <h3 style={{ fontSize: 13, fontWeight: 600, margin: 0, color: 'var(--foreground-70)' }}>loading</h3>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <Button disabled>
            <Spinner style={{ height: 14, width: 14 }} />
            <span>Saving</span>
          </Button>
          <Button variant="secondary" disabled>
            <Spinner style={{ height: 14, width: 14 }} />
            <span>Syncing</span>
          </Button>
        </div>
      </div>

      <div style={{ display: 'grid', gap: 10 }}>
        <h3 style={{ fontSize: 13, fontWeight: 600, margin: 0, color: 'var(--foreground-70)' }}>icon buttons</h3>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <Button size="sm">
            <Plus /> Small
          </Button>
          <Button size="md">
            <Search /> Medium
          </Button>
          <Button size="icon" aria-label="添加">
            <Plus />
          </Button>
          <Button size="icon-sm" variant="outline" aria-label="删除">
            <Trash2 />
          </Button>
          <Button size="icon-sm" variant="outline" disabled aria-label="删除">
            <Trash2 />
          </Button>
        </div>
      </div>
    </section>
  ),
};
