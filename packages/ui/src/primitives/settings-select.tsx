"use client";

import type { ReactElement, ReactNode } from "react";
import { cn } from "../utils.js";
import {
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectPortal,
  SelectPositioner,
  SelectRoot,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "../ui.js";

/**
 * Unified Select primitive for settings-style pickers.
 *
 * Consolidates three local wrappers that all wrapped the same Base UI
 * Select primitives with slightly-different option shapes (kenji
 * inventory `notes/maka-styles-css-inventory-2026-06-25-task-128.md`
 * + audit msg `e4cfbfb0`):
 *
 *   - `apps/desktop/.../SettingsModal.tsx :: SettingsSelect`
 *     `[value, label]` tuples, fixed `.settingsBaseSelectTrigger` chrome.
 *   - `packages/ui/src/components.tsx :: PlanReminderSelect`
 *     `[value, label, icon?]` tuples, rich trigger renderer.
 *
 * The two had drifted into independent option shapes and CSS recipes;
 * a real bug (selected trigger losing the icon) only got fixed in the
 * Plan Reminder copy, not the Settings copy. This primitive collapses
 * both into one component so the same affordance behaves the same
 * everywhere.
 *
 * Option shape `[value, label, icon?]`: the third tuple slot is an
 * optional ReactNode rendered as a 16px leading icon on both the
 * selected trigger and each popup item.
 *
 * `width` controls the trigger max-width — `compact` (140px) is the
 * default for inputs/time pickers, `select` (320px) matches the
 * existing settings select width, `full` lets the parent constrain.
 */
export type SettingsSelectOption<T extends string> =
  | readonly [T, string]
  | readonly [T, string, ReactNode];

export interface SettingsSelectOptionGroup<T extends string> {
  label: string;
  icon?: ReactNode;
  options: ReadonlyArray<SettingsSelectOption<T>>;
}

export interface SettingsSelectProps<T extends string> {
  value: T;
  options: ReadonlyArray<SettingsSelectOption<T>>;
  optionGroups?: ReadonlyArray<SettingsSelectOptionGroup<T>>;
  onChange(value: T): void;
  ariaLabel: string;
  disabled?: boolean;
  /** Visual width bucket for the trigger. Defaults to `'select'`. */
  width?: "compact" | "select" | "full";
  /** Extra class names appended to the trigger element. */
  className?: string;
}

const WIDTH_CLASS: Record<NonNullable<SettingsSelectProps<string>["width"]>, string> = {
  compact: "max-w-[140px] w-full",
  select: "max-w-[320px] w-full",
  full: "w-full",
};

export function SettingsSelect<T extends string>(
  props: SettingsSelectProps<T>,
): ReactElement {
  const width = props.width ?? "select";
  const groupedValues = new Set<T>();
  for (const group of props.optionGroups ?? []) {
    for (const [value] of group.options) groupedValues.add(value);
  }
  const ungroupedOptions = props.optionGroups
    ? props.options.filter(([value]) => !groupedValues.has(value))
    : props.options;
  const hasOptionGroups = Boolean(props.optionGroups && props.optionGroups.length > 0);
  // Build a value → {label, icon} lookup so the selected-state trigger
  // can render the same icon + label row as the popup items. Without
  // this the collapsed trigger drops the icon — see Plan Reminder bug
  // kenji audit msg `232aec0f` finding #2.
  const optionByValue = new Map<T, { label: string; icon: ReactNode | null }>();
  for (const option of props.options) {
    const [value, label] = option;
    optionByValue.set(value, {
      label,
      icon: option.length === 3 ? option[2] : null,
    });
  }
  const renderOptionRow = (label: string, icon: ReactNode | null) =>
    icon ? (
      <span className="settingsSelectOption">
        <span className="settingsSelectOptionIcon" aria-hidden="true">{icon}</span>
        <span>{label}</span>
      </span>
    ) : (
      <>{label}</>
    );
  return (
    <SelectRoot
      value={props.value}
      items={props.options.map(([value, label]) => ({ value, label }))}
      disabled={props.disabled}
      onValueChange={(value) => {
        if (value !== null) props.onChange(value);
      }}
    >
      <SelectTrigger
        className={cn("settingsSelectTrigger", WIDTH_CLASS[width], props.className)}
        aria-label={props.ariaLabel}
      >
        <SelectValue>
          {(value: T) => {
            const entry = optionByValue.get(value);
            if (!entry) return null;
            return renderOptionRow(entry.label, entry.icon);
          }}
        </SelectValue>
      </SelectTrigger>
      <SelectPortal>
        <SelectPositioner alignItemWithTrigger={false} sideOffset={6} className="settingsSelectPositioner">
          <SelectPopup className={cn("settingsSelectPopup", hasOptionGroups ? "settingsSelectMenuPopup" : null)}>
            {ungroupedOptions.map((option) => {
              const [value, label] = option;
              const icon = option.length === 3 ? option[2] : null;
              return (
                <SelectItem key={value} value={value}>
                  {renderOptionRow(label, icon)}
                </SelectItem>
              );
            })}
            {ungroupedOptions.length > 0 && props.optionGroups && props.optionGroups.length > 0 && (
              <SelectSeparator />
            )}
            {props.optionGroups?.map((group) => (
              <SelectGroup key={group.label}>
                <SelectGroupLabel className="settingsSelectMenuGroupLabel">
                  {group.icon ? (
                    <span className="settingsSelectMenuGroupLogo" aria-hidden="true">{group.icon}</span>
                  ) : (
                    <span aria-hidden="true" />
                  )}
                  <span>{group.label}</span>
                </SelectGroupLabel>
                {group.options.map((option) => {
                  const [value, label] = option;
                  const icon = option.length === 3 ? option[2] : null;
                  return (
                    <SelectItem key={value} value={value}>
                      <span className="settingsSelectMenuOption">
                        {renderOptionRow(label, icon)}
                      </span>
                    </SelectItem>
                  );
                })}
              </SelectGroup>
            ))}
          </SelectPopup>
        </SelectPositioner>
      </SelectPortal>
    </SelectRoot>
  );
}
