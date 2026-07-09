/**
 * Shared, searchable model picker popup: one component behind both the chat
 * composer's model switcher and Settings → 通用 → 默认模型, so grouping,
 * provider marks, and search behavior cannot drift between the two surfaces.
 */

import { type ReactNode, forwardRef, useMemo, useState } from 'react';
import { Combobox as BaseCombobox } from '@base-ui/react/combobox';
import type { ProviderType } from '@maka/core';
import { type ModelMenuGroup } from './chat-model-helpers.js';
import { Check, ChevronDown } from './icons.js';
import {
  buildModelPickerGroups,
  filterModelPickerOption,
  modelPickerHasCatalogMatches,
  type ModelPickerOption,
  type ModelPickerOptionGroup,
  type ModelPickerPinnedItem,
} from './model-picker-internals.js';
import { cn } from './utils.js';
import { buttonVariants } from './ui.js';

export interface ModelPickerProps {
  groups: ModelMenuGroup[];
  value: string;
  onValueChange(value: string): void;
  renderProviderMark?(type: ProviderType): ReactNode;
  disabled?: boolean;
  /** Row pinned above catalog groups and exempt from search filtering. */
  pinnedItem?: ModelPickerPinnedItem;
  searchPlaceholder?: string;
  emptyMessage?: string;
  triggerClassName?: string;
  popupClassName?: string;
  ariaLabel: string;
  title?: string;
  /** Static popup footer, outside the scrollable model list. */
  footer?(context: { open: boolean; close(): void }): ReactNode;
  /** Trigger button inner content; the chevron is added by ModelPicker. */
  children: ReactNode;
}

const ModelPickerTrigger = forwardRef<HTMLButtonElement, React.ComponentPropsWithoutRef<typeof BaseCombobox.Trigger>>(function ModelPickerTrigger(
  { className, children, ...props },
  ref,
) {
  return (
    <BaseCombobox.Trigger
      ref={ref}
      className={cn(buttonVariants({ variant: 'outline' }), 'justify-between', className)}
      {...props}
    >
      {children}
      <BaseCombobox.Icon>
        <ChevronDown size={14} aria-hidden="true" />
      </BaseCombobox.Icon>
    </BaseCombobox.Trigger>
  );
});

const ModelPickerInput = forwardRef<HTMLInputElement, React.ComponentPropsWithoutRef<typeof BaseCombobox.Input>>(function ModelPickerInput(
  { className, ...props },
  ref,
) {
  return <BaseCombobox.Input ref={ref} className={cn('w-full bg-transparent text-sm outline-none placeholder:text-foreground-secondary', className)} {...props} />;
});

const ModelPickerPopup = forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<typeof BaseCombobox.Popup>>(function ModelPickerPopup(
  { className, ...props },
  ref,
) {
  return <BaseCombobox.Popup ref={ref} className={cn('z-[var(--z-overlay)] min-w-40 rounded-md bg-popover p-1 text-popover-foreground shadow-maka-panel', className)} {...props} />;
});

const ModelPickerGroup = forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<typeof BaseCombobox.Group>>(function ModelPickerGroup(
  { className, ...props },
  ref,
) {
  return <BaseCombobox.Group ref={ref} className={cn('py-1', className)} {...props} />;
});

const ModelPickerGroupLabel = forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<typeof BaseCombobox.GroupLabel>>(function ModelPickerGroupLabel(
  { className, ...props },
  ref,
) {
  return <BaseCombobox.GroupLabel ref={ref} className={cn('px-2 py-1 text-xs font-medium text-foreground-secondary', className)} {...props} />;
});

const ModelPickerItem = forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<typeof BaseCombobox.Item>>(function ModelPickerItem(
  { className, children, ...props },
  ref,
) {
  return (
    <BaseCombobox.Item
      ref={ref}
      className={cn('grid cursor-default grid-cols-[1rem_1fr] items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-muted data-[selected]:text-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50', className)}
      {...props}
    >
      <span className="flex h-4 w-4 items-center justify-center" aria-hidden="true">
        <BaseCombobox.ItemIndicator>
          <Check size={13} aria-hidden="true" />
        </BaseCombobox.ItemIndicator>
      </span>
      <span className="min-w-0">{children}</span>
    </BaseCombobox.Item>
  );
});

function ModelPickerOptions(props: {
  query: string;
  hasPinnedItem: boolean;
  emptyMessage?: string;
  renderProviderMark?(type: ProviderType): ReactNode;
}) {
  const filteredGroups = BaseCombobox.useFilteredItems<ModelPickerOptionGroup>();
  const filteredOptions = filteredGroups.flatMap((group) => group.items);
  const noMatches = !modelPickerHasCatalogMatches(filteredOptions) && (props.query.trim().length > 0 || !props.hasPinnedItem);

  return (
    <>
      {noMatches && (
        <div className="modelPickerEmpty">{props.emptyMessage ?? '没有匹配的模型'}</div>
      )}
      <BaseCombobox.List className="modelPickerList">
        {filteredGroups.map((group) => {
          if (!group.heading) {
            return group.items.map((item) => (
              <ModelPickerItem key={item.value} value={item}>
                <span className="settingsSelectMenuOption">{item.label}</span>
              </ModelPickerItem>
            ));
          }

          const logo = group.providerType ? props.renderProviderMark?.(group.providerType) : null;
          return (
            <ModelPickerGroup key={group.key} items={group.items}>
              <ModelPickerGroupLabel className="settingsSelectMenuGroupLabel">
                {logo ? (
                  <span className="settingsSelectMenuGroupLogo" aria-hidden="true">{logo}</span>
                ) : (
                  <span aria-hidden="true" />
                )}
                <span>{group.heading}</span>
              </ModelPickerGroupLabel>
              <BaseCombobox.Collection>
                {(item: ModelPickerOption) => (
                  <ModelPickerItem key={item.value} value={item}>
                    <span className="settingsSelectMenuOption">{item.label}</span>
                  </ModelPickerItem>
                )}
              </BaseCombobox.Collection>
            </ModelPickerGroup>
          );
        })}
      </BaseCombobox.List>
    </>
  );
}

export function ModelPicker(props: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const groups = useMemo(() => buildModelPickerGroups(props.groups, props.pinnedItem), [props.groups, props.pinnedItem]);
  const allOptions = useMemo(() => groups.flatMap((group) => group.items), [groups]);
  const selectedItem = useMemo(
    () => allOptions.find((item) => item.value === props.value) ?? null,
    [allOptions, props.value],
  );

  return (
    <BaseCombobox.Root<ModelPickerOption>
      items={groups}
      value={selectedItem}
      inputValue={query}
      open={open}
      onOpenChange={(nextOpen, details) => {
        const target = details.event?.target;
        if (
          !nextOpen &&
          details.reason === 'outside-press' &&
          target instanceof Element &&
          target.closest('[data-model-picker-nested-popup]')
        ) {
          details.cancel();
          return;
        }
        setOpen(nextOpen);
        if (!nextOpen) setQuery('');
      }}
      onValueChange={(item) => {
        if (!item) return;
        props.onValueChange(item.value);
        setQuery('');
        setOpen(false);
      }}
      onInputValueChange={(next) => setQuery(String(next))}
      filter={filterModelPickerOption}
      isItemEqualToValue={(item, value) => item.value === value.value}
      itemToStringLabel={(item) => item.label}
      disabled={props.disabled}
    >
      <ModelPickerTrigger
        className={props.triggerClassName}
        aria-label={props.ariaLabel}
        title={props.title}
        disabled={props.disabled}
      >
        {props.children}
      </ModelPickerTrigger>
      <BaseCombobox.Portal>
        <BaseCombobox.Positioner sideOffset={8} className="settingsSelectPositioner">
          <ModelPickerPopup className={props.popupClassName ?? 'settingsSelectMenuPopup modelPickerPopup'}>
            <ModelPickerInput
              className="modelPickerSearchInput"
              placeholder={props.searchPlaceholder ?? '搜索模型…'}
              aria-label={props.searchPlaceholder ?? '搜索模型'}
            />
            <ModelPickerOptions
              query={query}
              hasPinnedItem={Boolean(props.pinnedItem)}
              emptyMessage={props.emptyMessage}
              renderProviderMark={props.renderProviderMark}
            />
            {props.footer?.({
              open,
              close: () => {
                setOpen(false);
                setQuery('');
              },
            })}
          </ModelPickerPopup>
        </BaseCombobox.Positioner>
      </BaseCombobox.Portal>
    </BaseCombobox.Root>
  );
}
