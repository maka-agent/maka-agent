import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Toggle, ToggleGroup } from '../src/ui.js';

const meta = {
  title: 'Primitives/Toggle',
  parameters: {
    layout: 'centered',
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ alignItems: 'center', display: 'flex', gap: 12, width: 360 }}>
      <span style={{ color: 'var(--muted-foreground)', fontSize: 12, width: 80 }}>{label}</span>
      {children}
    </div>
  );
}

export const ToggleStates: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 14, width: 360 }}>
      <Row label="off">
        <Toggle>未按下</Toggle>
      </Row>
      <Row label="on">
        <Toggle defaultPressed>已按下</Toggle>
      </Row>
      <Row label="disabled">
        <Toggle disabled>禁用</Toggle>
      </Row>
      <Row label="disabled on">
        <Toggle disabled defaultPressed>禁用按下</Toggle>
      </Row>
      <Row label="controlled">
        <ControlledToggle />
      </Row>
    </div>
  ),
};

function ControlledToggle() {
  const [pressed, setPressed] = useState(false);
  return <Toggle pressed={pressed} onPressedChange={setPressed}>点击切换</Toggle>;
}

export const SingleSelect: Story = {
  render: () => {
    const [value, setValue] = useState<string | null>('bold');
    return (
      <div style={{ display: 'grid', gap: 12, width: 360 }}>
        <span style={{ color: 'var(--muted-foreground)', fontSize: 12 }}>单选（multiple=false，value 为单值）</span>
        <ToggleGroup value={value ? [value] : []} onValueChange={(v) => setValue(v[0] ?? null)}>
          <Toggle value="bold" aria-label="加粗">B</Toggle>
          <Toggle value="italic" aria-label="斜体">I</Toggle>
          <Toggle value="underline" aria-label="下划线">U</Toggle>
        </ToggleGroup>
      </div>
    );
  },
};

export const MultiSelect: Story = {
  render: () => {
    const [value, setValue] = useState<string[]>(['bold', 'underline']);
    return (
      <div style={{ display: 'grid', gap: 12, width: 360 }}>
        <span style={{ color: 'var(--muted-foreground)', fontSize: 12 }}>多选（multiple，value 为数组）</span>
        <ToggleGroup multiple value={value} onValueChange={setValue}>
          <Toggle value="bold" aria-label="加粗">B</Toggle>
          <Toggle value="italic" aria-label="斜体">I</Toggle>
          <Toggle value="underline" aria-label="下划线">U</Toggle>
          <Toggle value="strike" aria-label="删除线">S</Toggle>
        </ToggleGroup>
      </div>
    );
  },
};