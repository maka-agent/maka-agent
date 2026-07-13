import type { Meta, StoryObj } from '@storybook/react-vite';
import { Plus, Search, Trash2 } from '@maka/ui/icons';
import { Button } from '../src/ui.js';

const meta = {
  title: 'Primitives/Button',
  parameters: { layout: 'padded' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const VARIANTS = ['default', 'secondary', 'ghost', 'quiet', 'destructive'] as const;

const labelStyle: React.CSSProperties = {
  color: 'var(--foreground-secondary)',
  fontSize: 11,
  width: 80,
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ alignItems: 'center', display: 'flex', gap: 12 }}>
      <span style={labelStyle}>{label}</span>
      <div style={{ alignItems: 'center', display: 'flex', gap: 8, flexWrap: 'wrap' }}>{children}</div>
    </div>
  );
}

export const VariantMatrix: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 16, minWidth: 720 }}>
      {VARIANTS.map((variant) => (
        <Row key={variant} label={variant}>
          <Button variant={variant}>新建任务</Button>
          <Button variant={variant}>Create task</Button>
          <Button variant={variant}>打开 Workspace</Button>
          <Button variant={variant} disabled>Disabled</Button>
        </Row>
      ))}
    </div>
  ),
};

export const SizeMatrix: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 14 }}>
      <Row label="md · 32px">
        <Button size="md">中文按钮</Button>
        <Button size="md">English</Button>
        <Button size="md"><Plus aria-hidden="true" />新建 Task</Button>
        <Button size="icon" aria-label="搜索"><Search aria-hidden="true" /></Button>
      </Row>
      <Row label="sm · 28px">
        <Button size="sm" variant="secondary">中文按钮</Button>
        <Button size="sm" variant="secondary">English</Button>
        <Button size="sm" variant="secondary"><Plus aria-hidden="true" />新建 Task</Button>
        <Button size="icon-sm" variant="secondary" aria-label="删除"><Trash2 aria-hidden="true" /></Button>
      </Row>
    </div>
  ),
};

export const WithIcon: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: 8 }}>
      <Button><Plus aria-hidden="true" />新建</Button>
      <Button variant="secondary"><Search aria-hidden="true" />Search</Button>
      <Button variant="destructive"><Trash2 aria-hidden="true" />删除</Button>
    </div>
  ),
};

export const Loading: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: 8 }}>
      <Button disabled>提交中…</Button>
      <Button variant="secondary" size="sm" disabled>Loading…</Button>
    </div>
  ),
};
