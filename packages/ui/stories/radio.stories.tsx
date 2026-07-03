import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Radio, RadioGroup } from '../src/ui.js';

const meta = {
  title: 'Primitives/Radio',
  parameters: {
    layout: 'centered',
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

function Option({ value, children }: { value: string; children: React.ReactNode }) {
  return (
    <label style={{ alignItems: 'center', display: 'flex', gap: 8 }}>
      <Radio value={value} />
      <span style={{ fontSize: 13 }}>{children}</span>
    </label>
  );
}

export const Vertical: Story = {
  render: () => {
    const [value, setValue] = useState('a');
    return (
      <RadioGroup value={value} onValueChange={(v) => setValue(v as string)}>
        <Option value="a">选项 A</Option>
        <Option value="b">选项 B</Option>
        <Option value="c">选项 C</Option>
      </RadioGroup>
    );
  },
};

export const Horizontal: Story = {
  render: () => {
    const [value, setValue] = useState('a');
    return (
      <RadioGroup value={value} onValueChange={(v) => setValue(v as string)} style={{ flexDirection: 'row', gap: 16 }}>
        <Option value="a">A</Option>
        <Option value="b">B</Option>
        <Option value="c">C</Option>
      </RadioGroup>
    );
  },
};

export const Disabled: Story = {
  render: () => (
    <RadioGroup defaultValue="a">
      <Option value="a">可选</Option>
      <Option value="b">禁用项</Option>
      <Radio value="b" disabled />
      <Option value="c">可选</Option>
    </RadioGroup>
  ),
};

export const DefaultUncontrolled: Story = {
  render: () => (
    <RadioGroup defaultValue="b">
      <Option value="a">选项 A</Option>
      <Option value="b">选项 B（默认选中）</Option>
      <Option value="c">选项 C</Option>
    </RadioGroup>
  ),
};