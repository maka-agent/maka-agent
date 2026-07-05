/**
 * Shared, searchable model picker popup — one component behind both the
 * chat composer's model switcher and the Settings → 通用 → 默认模型 select,
 * so the grouped list, provider marks, and search behavior can't drift
 * between the two surfaces (same governance goal as `PermissionModeMenuPopup`
 * in `permission-mode-menu.tsx`).
 *
 * Built on Base UI's `Combobox` (button trigger + popup-internal search input)
 * rather than `Select`, because `Select`'s built-in typeahead
 * isn't enough once a connection has dozens of catalog models.
 * `@maka/ui` stays icon-agnostic: `renderProviderMark` is supplied by the
 * desktop app, same convention as `ChatModelSwitcher`/`NewChatModelPicker`.
 *
 * Filtering is done by hand (`visibleGroups` below) rather than via
 * Combobox's built-in `filter` prop: a `<Combobox.Group items={...}>`
 * renders exactly the array it's given — it does not re-slice that array
 * against the live query itself. The built-in `filter` only affects the
 * root's own bookkeeping (e.g. `Combobox.Empty`'s empty check), not what a
 * manually-declared group renders, so grouped + filterable has to compute
 * its own per-group subsets from the query and hand those to each group.
 */

import { type ReactNode, useMemo, useState } from 'react';
import {
  ComboboxRoot,
  ComboboxTrigger,
  ComboboxPortal,
  ComboboxPositioner,
  ComboboxPopup,
  ComboboxInput,
  ComboboxList,
  ComboboxGroup,
  ComboboxGroupLabel,
  ComboboxCollection,
  ComboboxItem,
} from './ui.js';
import { type ModelMenuGroup, modelChoiceValue } from './chat-model-helpers.js';
import type { ProviderType } from '@maka/core';

interface ModelPickerItem {
  /** Encoded `<connectionSlug>:<model>` pair, or the pinned item's raw value (e.g. `''` for 未设置). */
  value: string;
  label: string;
}

export interface ModelPickerProps {
  groups: ModelMenuGroup[];
  value: string;
  onValueChange(value: string): void;
  renderProviderMark?(type: ProviderType): ReactNode;
  disabled?: boolean;
  /**
   * Extra row pinned above the groups and exempt from search filtering —
   * e.g. Settings' "未设置" or the composer's "current model isn't in the
   * catalog anymore" fallback row.
   */
  pinnedItem?: { value: string; label: string };
  searchPlaceholder?: string;
  emptyMessage?: string;
  triggerClassName?: string;
  popupClassName?: string;
  ariaLabel: string;
  title?: string;
  /** Trigger button inner content (icon + label + whatever chrome the call site wants); the chevron is added automatically. */
  children: ReactNode;
}

function toItem(connectionSlug: string, model: string, label: string): ModelPickerItem {
  return { value: modelChoiceValue(connectionSlug, model), label };
}

export function ModelPicker(props: ModelPickerProps) {
  const [query, setQuery] = useState('');

  const allItems = useMemo<ModelPickerItem[]>(() => [
    ...(props.pinnedItem ? [props.pinnedItem] : []),
    ...props.groups.flatMap((group) => group.choices.map((choice) => toItem(choice.connectionSlug, choice.model, choice.label))),
  ], [props.groups, props.pinnedItem]);

  const selectedItem = useMemo(
    () => allItems.find((item) => item.value === props.value) ?? null,
    [allItems, props.value],
  );

  const visibleGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return props.groups;
    return props.groups
      .map((group) => ({
        ...group,
        choices: group.choices.filter(
          (choice) => choice.label.toLowerCase().includes(q) || group.heading.toLowerCase().includes(q),
        ),
      }))
      .filter((group) => group.choices.length > 0);
  }, [props.groups, query]);

  // The pinned row is exempt from filtering, so it alone doesn't count as a
  // match: an active query with zero real hits still shows the empty message.
  const noMatches = visibleGroups.length === 0 && (query.trim().length > 0 || !props.pinnedItem);

  return (
    <ComboboxRoot<ModelPickerItem>
      items={allItems}
      value={selectedItem}
      onValueChange={(item) => {
        if (item) props.onValueChange(item.value);
      }}
      onInputValueChange={(next) => setQuery(next)}
      isItemEqualToValue={(item, value) => item.value === value.value}
      itemToStringLabel={(item) => item.label}
      disabled={props.disabled}
    >
      <ComboboxTrigger
        className={props.triggerClassName}
        aria-label={props.ariaLabel}
        title={props.title}
        disabled={props.disabled}
      >
        {props.children}
      </ComboboxTrigger>
      <ComboboxPortal>
        <ComboboxPositioner sideOffset={8} className="settingsSelectPositioner">
          <ComboboxPopup className={props.popupClassName ?? 'settingsSelectMenuPopup modelPickerPopup'}>
            <ComboboxInput
              className="modelPickerSearchInput"
              placeholder={props.searchPlaceholder ?? '搜索模型…'}
              aria-label={props.searchPlaceholder ?? '搜索模型'}
            />
            {noMatches && (
              <div className="modelPickerEmpty">{props.emptyMessage ?? '没有匹配的模型'}</div>
            )}
            <ComboboxList>
              {props.pinnedItem && (
                <ComboboxItem value={props.pinnedItem}>
                  <span className="settingsSelectMenuOption">{props.pinnedItem.label}</span>
                </ComboboxItem>
              )}
              {visibleGroups.map((group) => {
                const logo = props.renderProviderMark?.(group.providerType);
                const groupItems = group.choices.map((choice) => toItem(choice.connectionSlug, choice.model, choice.label));
                return (
                  <ComboboxGroup key={group.connectionSlug} items={groupItems}>
                    <ComboboxGroupLabel className="settingsSelectMenuGroupLabel">
                      {logo ? (
                        <span className="settingsSelectMenuGroupLogo" aria-hidden="true">{logo}</span>
                      ) : (
                        <span aria-hidden="true" />
                      )}
                      <span>{group.heading}</span>
                    </ComboboxGroupLabel>
                    <ComboboxCollection>
                      {(item: ModelPickerItem) => (
                        <ComboboxItem key={item.value} value={item}>
                          <span className="settingsSelectMenuOption">{item.label}</span>
                        </ComboboxItem>
                      )}
                    </ComboboxCollection>
                  </ComboboxGroup>
                );
              })}
            </ComboboxList>
          </ComboboxPopup>
        </ComboboxPositioner>
      </ComboboxPortal>
    </ComboboxRoot>
  );
}
