import type { Meta, StoryObj } from '@storybook/react-vite';
import { Progress } from '../src/ui.js';

const meta = {
  title: 'Primitives/Progress',
  parameters: {
    layout: 'centered',
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ alignItems: 'center', display: 'flex', gap: 12, width: 360 }}>
      <span style={{ color: 'var(--muted-foreground)', fontSize: 12, width: 96 }}>{label}</span>
      {children}
    </div>
  );
}

export const Values: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 14, width: 360 }}>
      <Row label="0%">
        <Progress value={0} />
      </Row>
      <Row label="30%">
        <Progress value={30} />
      </Row>
      <Row label="70%">
        <Progress value={70} />
      </Row>
      <Row label="100%">
        <Progress value={100} />
      </Row>
      <Row label="indeterminate">
        <Progress value={null} />
      </Row>
    </div>
  ),
};