import type { Meta, StoryObj } from '@storybook/react-vite';
import { Alert, AlertDescription, AlertTitle } from './alert.js';
import { Button } from './button.js';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from './empty.js';
import { Spinner } from './spinner.js';

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
    <div className="grid w-[420px] gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <Button>Primary</Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="outline">Outline</Button>
        <Button loading>Loading</Button>
      </div>

      <Alert variant="info">
        <AlertTitle>提示</AlertTitle>
        <AlertDescription>这条 story 只验证 primitive 能离开 app shell 独立渲染。</AlertDescription>
      </Alert>

      <Empty className="min-h-64 rounded-xl border border-dashed bg-card">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Spinner className="size-4" />
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
