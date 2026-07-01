import type { Meta, StoryObj } from '@storybook/react-vite';
import { Alert, AlertDescription, AlertTitle } from '../src/primitives/alert.js';
import { Button } from '../src/primitives/button.js';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '../src/primitives/empty.js';
import { Spinner } from '../src/primitives/spinner.js';

const meta = {
  title: 'Primitives/Storybook Baseline',
  parameters: {
    layout: 'centered',
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const BasicStates: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 20, width: 420 }}>
      <div style={{ alignItems: 'center', display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <Button>Primary</Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="outline">Outline</Button>
        <Button loading>Loading</Button>
      </div>

      <Alert variant="info">
        <AlertTitle>提示</AlertTitle>
        <AlertDescription>这条 story 只验证 primitive 能离开 app shell 独立渲染。</AlertDescription>
      </Alert>

      <Empty
        style={{
          background: 'var(--background)',
          border: '1px dashed var(--border)',
          borderRadius: 'var(--radius-xl)',
          minHeight: 256,
        }}
      >
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Spinner style={{ height: 16, width: 16 }} />
          </EmptyMedia>
          <EmptyTitle>暂无内容</EmptyTitle>
          <EmptyDescription>空状态、按钮和提示组件共享 renderer 的 Tailwind 与 token 环境。</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button variant="ghost" size="sm">刷新</Button>
        </EmptyContent>
      </Empty>
    </div>
  ),
};
