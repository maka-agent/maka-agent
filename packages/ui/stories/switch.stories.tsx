import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Switch } from '../src/ui.js';

const meta = {
  title: 'Primitives/Switch',
  parameters: {
    layout: 'centered',
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ alignItems: 'center', display: 'flex', gap: 12 }}>
      <span style={{ color: 'var(--muted-foreground)', fontSize: 12, width: 80 }}>{label}</span>
      {children}
    </div>
  );
}

function ControlledSwitch({ initial = false }: { initial?: boolean }) {
  const [checked, setChecked] = useState(initial);
  return <Switch checked={checked} onChange={setChecked} aria-label="受控开关" />;
}

export const OnOff: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 14, width: 240 }}>
      <Row label="off">
        <Switch checked={false} onChange={() => undefined} aria-label="关闭态" />
      </Row>
      <Row label="on">
        <Switch checked onChange={() => undefined} aria-label="开启态" />
      </Row>
      <Row label="controlled">
        <ControlledSwitch />
      </Row>
      <Row label="controlled on">
        <ControlledSwitch initial />
      </Row>
    </div>
  ),
};

export const Disabled: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 14, width: 240 }}>
      <Row label="disabled off">
        <Switch checked={false} disabled onChange={() => undefined} aria-label="禁用关闭" />
      </Row>
      <Row label="disabled on">
        <Switch checked disabled onChange={() => undefined} aria-label="禁用开启" />
      </Row>
    </div>
  ),
};