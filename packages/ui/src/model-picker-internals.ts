import { type ModelMenuGroup, modelChoiceValue } from './chat-model-helpers.js';
import type { ProviderType } from '@maka/core';

export interface ModelPickerOption {
  /** Encoded `<connectionSlug>:<model>` pair, or a pinned item's raw value. */
  value: string;
  label: string;
  groupHeading?: string;
  providerType?: ProviderType;
  pinned?: boolean;
}

export interface ModelPickerOptionGroup {
  key: string;
  connectionSlug?: string;
  providerType?: ProviderType;
  heading?: string;
  items: ModelPickerOption[];
}

export interface ModelPickerPinnedItem {
  value: string;
  label: string;
}

function normalizeSearch(value: string): string {
  return value.trim().toLocaleLowerCase();
}

export function buildModelPickerGroups(
  groups: readonly ModelMenuGroup[],
  pinnedItem?: ModelPickerPinnedItem,
): ModelPickerOptionGroup[] {
  const pickerGroups: ModelPickerOptionGroup[] = [];

  if (pinnedItem) {
    pickerGroups.push({
      key: '__pinned',
      items: [{ ...pinnedItem, pinned: true }],
    });
  }

  for (const group of groups) {
    pickerGroups.push({
      key: group.connectionSlug,
      connectionSlug: group.connectionSlug,
      providerType: group.providerType,
      heading: group.heading,
      items: group.choices.map((choice) => ({
        value: modelChoiceValue(choice.connectionSlug, choice.model),
        label: choice.label,
        groupHeading: group.heading,
        providerType: group.providerType,
      })),
    });
  }

  return pickerGroups;
}

export function filterModelPickerOption(option: ModelPickerOption, query: string): boolean {
  if (option.pinned) return true;

  const q = normalizeSearch(query);
  if (!q) return true;

  return normalizeSearch(option.label).includes(q) || normalizeSearch(option.groupHeading ?? '').includes(q);
}

export function modelPickerHasCatalogMatches(options: readonly ModelPickerOption[]): boolean {
  return options.some((option) => !option.pinned);
}
