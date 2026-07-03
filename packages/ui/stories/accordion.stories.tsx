import { ChevronRight } from '@maka/ui/icons';
import {
  Accordion,
  AccordionHeader,
  AccordionItem,
  AccordionPanel,
  AccordionTrigger,
} from '../src/primitives/accordion.js';

import type { Meta, StoryObj } from '@storybook/react-vite';

const meta = {
  title: 'Primitives/Accordion',
  parameters: {
    layout: 'padded',
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

type AccItem = { value: string; title: string; body: string };

const ITEMS: AccItem[] = [
  { value: 'a', title: '第一项', body: '第一项的内容。单选模式下，同时只能展开一项。' },
  { value: 'b', title: '第二项', body: '第二项的内容。' },
  { value: 'c', title: '第三项', body: '第三项的内容。' },
];

function Trigger({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ alignItems: 'center', display: 'flex', gap: 8, padding: '8px 4px', width: 320 }}>
      <span style={{ flex: 1, fontSize: 13, fontWeight: 500 }}>{children}</span>
      <ChevronRight size={14} strokeWidth={2} aria-hidden="true" style={{ transition: 'transform .15s' }} />
    </span>
  );
}

function SampleAccordion({
  multiple,
  defaultValue,
  items = ITEMS,
}: {
  multiple?: boolean;
  defaultValue: string[];
  items?: AccItem[];
}) {
  return (
    <Accordion multiple={multiple} defaultValue={defaultValue} style={{ width: 320 }}>
      {items.map((item) => (
        <AccordionItem key={item.value} value={item.value}>
          <AccordionHeader>
            <AccordionTrigger>
              <Trigger>{item.title}</Trigger>
            </AccordionTrigger>
          </AccordionHeader>
          <AccordionPanel>
            <div style={{ fontSize: 13, color: 'var(--muted-foreground)', padding: '0 4px 12px' }}>{item.body}</div>
          </AccordionPanel>
        </AccordionItem>
      ))}
    </Accordion>
  );
}

export const SingleOpen: Story = {
  render: () => <SampleAccordion defaultValue={['a']} />,
};

export const MultipleOpen: Story = {
  render: () => <SampleAccordion multiple defaultValue={['a', 'c']} />,
};

export const AllCollapsed: Story = {
  render: () => <SampleAccordion defaultValue={[]} items={ITEMS.slice(0, 2)} />,
};