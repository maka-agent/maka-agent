import { useMemo, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ProviderType } from '@maka/core';
import { ModelPicker } from '../src/model-picker.js';
import type { ModelMenuGroup } from '../src/chat-model-helpers.js';

const meta = {
  title: 'Product/Model Picker',
  parameters: {
    layout: 'padded',
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

const GROUPS: ModelMenuGroup[] = [
  {
    connectionSlug: 'openai-main',
    providerType: 'openai',
    heading: 'OpenAI main',
    choices: [
      { connectionSlug: 'openai-main', providerType: 'openai', model: 'gpt-5', label: 'GPT-5' },
      { connectionSlug: 'openai-main', providerType: 'openai', model: 'gpt-5-mini', label: 'GPT-5 mini' },
      { connectionSlug: 'openai-main', providerType: 'openai', model: 'o3', label: 'o3' },
      { connectionSlug: 'openai-main', providerType: 'openai', model: 'o3-mini', label: 'o3 mini' },
    ],
  },
  {
    connectionSlug: 'anthropic-team',
    providerType: 'anthropic',
    heading: 'Claude Team',
    choices: [
      { connectionSlug: 'anthropic-team', providerType: 'anthropic', model: 'claude-opus-4-1', label: 'Claude Opus 4.1' },
      { connectionSlug: 'anthropic-team', providerType: 'anthropic', model: 'claude-sonnet-4', label: 'Claude Sonnet 4' },
      { connectionSlug: 'anthropic-team', providerType: 'anthropic', model: 'claude-haiku-3-5', label: 'Claude Haiku 3.5' },
    ],
  },
  {
    connectionSlug: 'google-lab',
    providerType: 'google',
    heading: 'Gemini Lab',
    choices: [
      { connectionSlug: 'google-lab', providerType: 'google', model: 'gemini-3-pro', label: 'Gemini 3 Pro' },
      { connectionSlug: 'google-lab', providerType: 'google', model: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    ],
  },
  {
    connectionSlug: 'openrouter',
    providerType: 'openai-compatible',
    heading: 'OpenRouter',
    choices: Array.from({ length: 14 }, (_, index) => ({
      connectionSlug: 'openrouter',
      providerType: 'openai-compatible' as const,
      model: `catalog-model-${index + 1}`,
      label: `Catalog model ${index + 1}`,
    })),
  },
];

function providerMark(type: ProviderType) {
  const labels: Partial<Record<ProviderType, string>> = {
    openai: 'O',
    anthropic: 'A',
    google: 'G',
    'openai-compatible': 'R',
  };
  return <span style={{ fontSize: 11, fontWeight: 700 }}>{labels[type] ?? 'M'}</span>;
}

function selectedLabel(value: string) {
  if (!value) return '未设置';
  return GROUPS.flatMap((group) => group.choices).find((choice) => `${choice.connectionSlug}:${choice.model}` === value)?.label ?? value;
}

function ModelPickerFrame() {
  const [value, setValue] = useState('');
  const label = useMemo(() => selectedLabel(value), [value]);

  return (
    <div style={{ display: 'grid', gap: 12, width: 280 }}>
      <ModelPicker
        groups={GROUPS}
        value={value}
        onValueChange={setValue}
        pinnedItem={{ value: '', label: '未设置' }}
        renderProviderMark={providerMark}
        ariaLabel="选择模型"
        triggerClassName="settingsSelectTrigger"
        popupClassName="settingsSelectMenuPopup modelPickerPopup"
      >
        <span className="settingsSelectMenuOption">{label}</span>
      </ModelPicker>
      <span style={{ color: 'var(--muted-foreground)', fontSize: 12 }}>
        试试搜索 “sonnet”、“OpenAI” 或一个不存在的词。
      </span>
    </div>
  );
}

export const Default: Story = {
  render: () => <ModelPickerFrame />,
};
