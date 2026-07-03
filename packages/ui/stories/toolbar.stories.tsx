import type { Meta, StoryObj } from '@storybook/react-vite';
import { Copy, FolderOpen, Save, Trash2 } from '@maka/ui/icons';
import { Toolbar, ToolbarGroup, ToolbarSeparator } from '../src/primitives/toolbar.js';
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