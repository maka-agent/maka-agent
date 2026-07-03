import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Plus, Trash2 } from '@maka/ui/icons';
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuShortcut,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from '../src/primitives/menu.js';
import { Button } from '../src/ui.js';

const meta = {
  title: 'Primitives/Menu',
  parameters: {
    layout: 'padded',
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Basic: Story = {
  render: () => (
    <Menu>
      <MenuTrigger render={<Button variant="outline" />}>打开菜单</MenuTrigger>
      <MenuPopup>
        <MenuItem>新建文件</MenuItem>
        <MenuItem>打开…</MenuItem>
        <MenuItem>保存</MenuItem>
        <MenuSeparator />
        <MenuItem variant="destructive">删除</MenuItem>
      </MenuPopup>
    </Menu>
  ),
};

export const WithShortcuts: Story = {
  render: () => (
    <Menu>
      <MenuTrigger render={<Button variant="outline" />}>带快捷键</MenuTrigger>
      <MenuPopup>
        <MenuItem>
          新建
          <MenuShortcut>⌘N</MenuShortcut>
        </MenuItem>
        <MenuItem>
          打开
          <MenuShortcut>⌘O</MenuShortcut>
        </MenuItem>
        <MenuItem>
          保存
          <MenuShortcut>⌘S</MenuShortcut>
        </MenuItem>
        <MenuSeparator />
        <MenuItem variant="destructive">
          删除
          <MenuShortcut>⌫</MenuShortcut>
        </MenuItem>
      </MenuPopup>
    </Menu>
  ),
};

export const CheckboxItems: Story = {
  render: () => (
    <Menu>
      <MenuTrigger render={<Button variant="outline" />}>勾选项</MenuTrigger>
      <MenuPopup>
        <MenuCheckboxItem checked>显示行号</MenuCheckboxItem>
        <MenuCheckboxItem checked={false}>自动换行</MenuCheckboxItem>
        <MenuSeparator />
        <MenuGroup>
          <MenuGroupLabel>视图</MenuGroupLabel>
          <MenuCheckboxItem checked>侧栏</MenuCheckboxItem>
          <MenuCheckboxItem checked={false}>小地图</MenuCheckboxItem>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  ),
};

export const RadioItems: Story = {
  render: () => (
    <Menu>
      <MenuTrigger render={<Button variant="outline" />}>单选项</MenuTrigger>
      <MenuPopup>
        <MenuGroupLabel>主题</MenuGroupLabel>
        <MenuRadioGroup defaultValue="system">
          <MenuRadioItem value="light">浅色</MenuRadioItem>
          <MenuRadioItem value="dark">深色</MenuRadioItem>
          <MenuRadioItem value="system">跟随系统</MenuRadioItem>
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  ),
};

export const Submenu: Story = {
  render: () => (
    <Menu>
      <MenuTrigger render={<Button variant="outline" />}>子菜单</MenuTrigger>
      <MenuPopup>
        <MenuItem>新建</MenuItem>
        <MenuSub>
          <MenuSubTrigger>导出为…</MenuSubTrigger>
          <MenuSubPopup>
            <MenuItem>PDF</MenuItem>
            <MenuItem>Markdown</MenuItem>
            <MenuItem>HTML</MenuItem>
          </MenuSubPopup>
        </MenuSub>
        <MenuSeparator />
        <MenuItem variant="destructive">关闭项目</MenuItem>
      </MenuPopup>
    </Menu>
  ),
};

export const WithIcons: Story = {
  render: () => (
    <Menu>
      <MenuTrigger render={<Button variant="outline" />}>带图标</MenuTrigger>
      <MenuPopup>
        <MenuItem>
          <Plus size={14} aria-hidden="true" />
          新建
        </MenuItem>
        <MenuItem variant="destructive">
          <Trash2 size={14} aria-hidden="true" />
          删除
        </MenuItem>
      </MenuPopup>
    </Menu>
  ),
};

export const OpenSnapshot: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 16, padding: 24, width: 320 }}>
      <span style={{ color: 'var(--muted-foreground)', fontSize: 12 }}>popup 常驻 open（快照用）</span>
      <Menu open>
        <MenuTrigger render={<Button variant="outline" />} />
        <MenuPopup>
          <MenuItem>新建文件</MenuItem>
          <MenuItem>打开…</MenuItem>
          <MenuItem>
            保存
            <MenuShortcut>⌘S</MenuShortcut>
          </MenuItem>
          <MenuSeparator />
          <MenuItem variant="destructive">删除</MenuItem>
        </MenuPopup>
      </Menu>
    </div>
  ),
};