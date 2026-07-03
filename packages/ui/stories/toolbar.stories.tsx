import type { Meta, StoryObj } from '@storybook/react-vite';
import { Copy, FolderOpen, Save, Trash2 } from '@maka/ui/icons';
import { Toolbar, ToolbarGroup, ToolbarInput, ToolbarLink, ToolbarSeparator } from '../src/primitives/toolbar.js';
import { Button } from '../src/ui.js';

const meta = {
  title: 'Primitives/Toolbar',
  parameters: {
    layout: 'padded',
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const ArtifactActions: Story = {
  render: () => (
    <Toolbar aria-label="生成文件操作" style={{ width: 520 }}>
      <ToolbarGroup>
        <Button type="button" variant="secondary" size="sm">
          <FolderOpen size={14} aria-hidden="true" />
          <span>在 Finder 中打开</span>
        </Button>
        <Button type="button" variant="secondary" size="sm">
          <Save size={14} aria-hidden="true" />
          <span>另存为</span>
        </Button>
        <Button type="button" variant="secondary" size="sm">
          <Copy size={14} aria-hidden="true" />
          <span>复制文本</span>
        </Button>
      </ToolbarGroup>
      <ToolbarSeparator orientation="vertical" />
      <ToolbarGroup>
        <Button type="button" variant="destructive" size="sm">
          <Trash2 size={14} aria-hidden="true" />
          <span>删除</span>
        </Button>
      </ToolbarGroup>
    </Toolbar>
  ),
};

export const WithInput: Story = {
  render: () => (
    <Toolbar aria-label="搜索与操作" style={{ width: 520 }}>
      <ToolbarInput type="search" placeholder="搜索文件…" aria-label="搜索文件" />
      <ToolbarSeparator orientation="vertical" />
      <ToolbarGroup>
        <Button type="button" variant="secondary" size="sm">
          <FolderOpen size={14} aria-hidden="true" />
          <span>打开</span>
        </Button>
        <Button type="button" variant="secondary" size="sm">
          <Save size={14} aria-hidden="true" />
          <span>保存</span>
        </Button>
      </ToolbarGroup>
    </Toolbar>
  ),
};

export const WithLink: Story = {
  render: () => (
    <Toolbar aria-label="链接工具栏" style={{ width: 420 }}>
      <ToolbarGroup>
        <ToolbarLink href="#" render={<Button variant="ghost" size="sm" />}>
          文档
        </ToolbarLink>
        <ToolbarLink href="#" render={<Button variant="ghost" size="sm" />}>
          源码
        </ToolbarLink>
        <ToolbarLink href="#" render={<Button variant="ghost" size="sm" />}>
          反馈
        </ToolbarLink>
      </ToolbarGroup>
      <ToolbarSeparator orientation="vertical" />
      <ToolbarGroup>
        <Button type="button" variant="secondary" size="sm">
          <Save size={14} aria-hidden="true" />
          <span>导出</span>
        </Button>
      </ToolbarGroup>
    </Toolbar>
  ),
};

export const DisabledStates: Story = {
  render: () => (
    <Toolbar aria-label="禁用状态" style={{ width: 420 }}>
      <ToolbarGroup>
        <Button type="button" variant="secondary" size="sm" disabled>
          <FolderOpen size={14} aria-hidden="true" />
          <span>打开</span>
        </Button>
        <Button type="button" variant="secondary" size="sm" disabled>
          <Save size={14} aria-hidden="true" />
          <span>另存为</span>
        </Button>
        <Button type="button" variant="secondary" size="sm" disabled>
          <Copy size={14} aria-hidden="true" />
          <span>复制</span>
        </Button>
      </ToolbarGroup>
      <ToolbarSeparator orientation="vertical" />
      <ToolbarGroup>
        <Button type="button" variant="destructive" size="sm" disabled>
          <Trash2 size={14} aria-hidden="true" />
          <span>删除</span>
        </Button>
      </ToolbarGroup>
    </Toolbar>
  ),
};