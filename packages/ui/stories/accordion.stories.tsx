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

function Trigger({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ alignItems: 'center', display: 'flex', gap: 8, padding: '8px 4px', width: 320 }}>
      <span style={{ flex: 1, fontSize: 13, fontWeight: 500 }}>{children}</span>
      <ChevronRight size={14} strokeWidth={2} aria-hidden="true" style={{ transition: 'transform .15s' }} />
    </span>
  );
}

function Body({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 13, color: 'var(--muted-foreground)', padding: '0 4px 12px' }}>{children}</div>
  );
}

export const SingleOpen: Story = {
  render: () => (
    <Accordion defaultValue={['item-1']} style={{ width: 320 }}>
      <AccordionItem value="item-1">
        <AccordionHeader>
          <AccordionTrigger>
            <Trigger>第一项（默认展开）</Trigger>
          </AccordionTrigger>
        </AccordionHeader>
        <AccordionPanel>
          <Body>第一项的内容。单选模式下，同时只能展开一项。</Body>
        </AccordionPanel>
      </AccordionItem>
      <AccordionItem value="item-2">
        <AccordionHeader>
          <AccordionTrigger>
            <Trigger>第二项</Trigger>
          </AccordionTrigger>
        </AccordionHeader>
        <AccordionPanel>
          <Body>第二项的内容。</Body>
        </AccordionPanel>
      </AccordionItem>
      <AccordionItem value="item-3">
        <AccordionHeader>
          <AccordionTrigger>
            <Trigger>第三项</Trigger>
          </AccordionTrigger>
        </AccordionHeader>
        <AccordionPanel>
          <Body>第三项的内容。</Body>
        </AccordionPanel>
      </AccordionItem>
    </Accordion>
  ),
};

export const MultipleOpen: Story = {
  render: () => (
    <Accordion multiple defaultValue={['a', 'c']} style={{ width: 320 }}>
      <AccordionItem value="a">
        <AccordionHeader>
          <AccordionTrigger>
            <Trigger>A（默认展开）</Trigger>
          </AccordionTrigger>
        </AccordionHeader>
        <AccordionPanel>
          <Body>A 内容。multiple 模式下可以同时展开多项。</Body>
        </AccordionPanel>
      </AccordionItem>
      <AccordionItem value="b">
        <AccordionHeader>
          <AccordionTrigger>
            <Trigger>B</Trigger>
          </AccordionTrigger>
        </AccordionHeader>
        <AccordionPanel>
          <Body>B 内容。</Body>
        </AccordionPanel>
      </AccordionItem>
      <AccordionItem value="c">
        <AccordionHeader>
          <AccordionTrigger>
            <Trigger>C（默认展开）</Trigger>
          </AccordionTrigger>
        </AccordionHeader>
        <AccordionPanel>
          <Body>C 内容。</Body>
        </AccordionPanel>
      </AccordionItem>
    </Accordion>
  ),
};

export const AllCollapsed: Story = {
  render: () => (
    <Accordion style={{ width: 320 }}>
      <AccordionItem value="x">
        <AccordionHeader>
          <AccordionTrigger>
            <Trigger>收起态 X</Trigger>
          </AccordionTrigger>
        </AccordionHeader>
        <AccordionPanel>
          <Body>X 内容（初始收起）。</Body>
        </AccordionPanel>
      </AccordionItem>
      <AccordionItem value="y">
        <AccordionHeader>
          <AccordionTrigger>
            <Trigger>收起态 Y</Trigger>
          </AccordionTrigger>
        </AccordionHeader>
        <AccordionPanel>
          <Body>Y 内容。</Body>
        </AccordionPanel>
      </AccordionItem>
    </Accordion>
  ),
};