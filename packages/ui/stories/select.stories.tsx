import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Search } from '@maka/ui/icons';
import {
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPortal,
  SelectPositioner,
  SelectPopup,
  SelectRoot,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '../src/ui.js';

const meta = {
  title: 'Primitives/Select',
  parameters: {
    layout: 'padded',
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

type Option = { value: string; label: string };

const FRUITS: Option[] = [
  { value: 'apple', label: '苹果' },
  { value: 'banana', label: '香蕉' },
  { value: 'cherry', label: '樱桃' },
  { value: 'durian', label: '榴莲' },
];

const GROUPS: { label: string; options: Option[] }[] = [
  { label: '柑橘类', options: [
    { value: 'orange', label: '橙子' },
    { value: 'lemon', label: '柠檬' },
    { value: 'grapefruit', label: '柚子' },
  ]},
  { label: '浆果类', options: [
    { value: 'strawberry', label: '草莓' },
    { value: 'blueberry', label: '蓝莓' },
    { value: 'raspberry', label: '树莓' },
  ]},
];

function SelectPopupFrame({ children }: { children: React.ReactNode }) {
  return (
    <SelectPortal>
      <SelectPositioner alignItemWithTrigger={false} sideOffset={8}>
        <SelectPopup>
          {children}
        </SelectPopup>
      </SelectPositioner>
    </SelectPortal>
  );
}

function FruitItems() {
  return (
    <>
      {FRUITS.map((opt) => (
        <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
      ))}
    </>
  );
}

function GroupedItems() {
  return (
    <>
      {GROUPS.map((group, index) => (
        <div key={group.label}>
          {index > 0 && <SelectSeparator />}
          <SelectGroup>
            <SelectGroupLabel>{group.label}</SelectGroupLabel>
            {group.options.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
            ))}
          </SelectGroup>
        </div>
      ))}
    </>
  );
}

function useFruitSelect(initial: string) {
  const [value, setValue] = useState(initial);
  const onChange = (v: unknown) => { if (v !== null) setValue(v as string); };
  return { value, onChange };
}

export const Basic: Story = {
  render: () => {
    const sel = useFruitSelect('apple');
    return (
      <SelectRoot items={FRUITS} value={sel.value} onValueChange={sel.onChange}>
        <SelectTrigger style={{ width: 200 }} aria-label="选择水果">
          <SelectValue />
        </SelectTrigger>
        <SelectPopupFrame><FruitItems /></SelectPopupFrame>
      </SelectRoot>
    );
  },
};

export const Grouped: Story = {
  render: () => {
    const sel = useFruitSelect('orange');
    return (
      <SelectRoot items={GROUPS.flatMap((g) => g.options)} value={sel.value} onValueChange={sel.onChange}>
        <SelectTrigger style={{ width: 200 }} aria-label="选择水果（分组）">
          <SelectValue />
        </SelectTrigger>
        <SelectPopupFrame><GroupedItems /></SelectPopupFrame>
      </SelectRoot>
    );
  },
};

export const Disabled: Story = {
  render: () => (
    <SelectRoot items={FRUITS} value="apple" disabled>
      <SelectTrigger style={{ width: 200 }} aria-label="禁用选择器">
        <SelectValue />
      </SelectTrigger>
      <SelectPopupFrame><FruitItems /></SelectPopupFrame>
    </SelectRoot>
  ),
};

export const WithLeadingIcon: Story = {
  render: () => {
    const sel = useFruitSelect('apple');
    return (
      <SelectRoot items={FRUITS} value={sel.value} onValueChange={sel.onChange}>
        <SelectTrigger style={{ width: 220 }} aria-label="带前缀图标的选择器">
          <Search size={14} strokeWidth={1.75} aria-hidden="true" style={{ marginRight: 4 }} />
          <SelectValue />
        </SelectTrigger>
        <SelectPopupFrame><FruitItems /></SelectPopupFrame>
      </SelectRoot>
    );
  },
};

export const OpenSnapshot: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 24, padding: 24, width: 240 }}>
      <span style={{ color: 'var(--muted-foreground)', fontSize: 12 }}>popup 常驻 open（快照用）</span>
      <SelectRoot items={FRUITS} value="banana" open>
        <SelectTrigger style={{ width: 200 }} aria-label="快照选择器">
          <SelectValue />
        </SelectTrigger>
        <SelectPopupFrame><FruitItems /></SelectPopupFrame>
      </SelectRoot>
    </div>
  ),
};

export const GroupedOpenSnapshot: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 24, padding: 24, width: 240 }}>
      <span style={{ color: 'var(--muted-foreground)', fontSize: 12 }}>分组 popup 常驻 open（快照用）</span>
      <SelectRoot items={GROUPS.flatMap((g) => g.options)} value="strawberry" open>
        <SelectTrigger style={{ width: 200 }} aria-label="分组快照选择器">
          <SelectValue />
        </SelectTrigger>
        <SelectPopupFrame><GroupedItems /></SelectPopupFrame>
      </SelectRoot>
    </div>
  ),
};