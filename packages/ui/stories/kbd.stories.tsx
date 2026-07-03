import type { Meta, StoryObj } from '@storybook/react-vite';
import { Kbd, KbdGroup } from '../src/primitives/kbd.js';

const meta = {
  title: 'Primitives/Kbd',
  parameters: {
    layout: 'centered',
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ alignItems: 'center', display: 'flex', gap: 12, width: 360 }}>
      <span style={{ color: 'var(--muted-foreground)', fontSize: 12, width: 120 }}>{label}</span>
      <div style={{ alignItems: 'center', display: 'flex', gap: 6 }}>{children}</div>
    </div>
  );
}

export const SingleKeys: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 12, width: 360 }}>
      <Row label="enter">
        <Kbd>↵</Kbd>
      </Row>
      <Row label="escape">
        <Kbd>Esc</Kbd>
      </Row>
      <Row label="tab">
        <Kbd>Tab</Kbd>
      </Row>
      <Row label="space">
        <Kbd>Space</Kbd>
      </Row>
    </div>
  ),
};

export const Combos: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 12, width: 360 }}>
      <Row label="command palette">
        <Kbd>⌘</Kbd>
        <span style={{ color: 'var(--muted-foreground)', fontSize: 12 }}>+</span>
        <Kbd>K</Kbd>
      </Row>
      <Row label="shift+cmd+P">
        <Kbd>⇧</Kbd>
        <span style={{ color: 'var(--muted-foreground)', fontSize: 12 }}>+</span>
        <Kbd>⌘</Kbd>
        <span style={{ color: 'var(--muted-foreground)', fontSize: 12 }}>+</span>
        <Kbd>P</Kbd>
      </Row>
      <Row label="undo">
        <Kbd>⌘</Kbd>
        <span style={{ color: 'var(--muted-foreground)', fontSize: 12 }}>+</span>
        <Kbd>Z</Kbd>
      </Row>
    </div>
  ),
};

export const ArrowGroup: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 12, width: 360 }}>
      <Row label="navigate">
        <KbdGroup>
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd>
        </KbdGroup>
      </Row>
      <Row label="navigate all">
        <KbdGroup>
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd>
          <Kbd>←</Kbd>
          <Kbd>→</Kbd>
        </KbdGroup>
      </Row>
    </div>
  ),
};