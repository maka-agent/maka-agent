"use client";

import { Toggle as BaseToggle } from "@base-ui/react/toggle";
import { ToggleGroup as BaseToggleGroup } from "@base-ui/react/toggle-group";
import type { ReactElement } from "react";
import { cn } from "../utils.js";

/**
 * Pill / segmented control primitive.
 *
 * Replaces the hand-rolled `function Segmented` in SettingsModal.tsx
 * that wrapped a `<div role="radiogroup">` plus manual arrow-key
 * keyboard handling via `onSettingsRadioGroupKeyDown`. Single-select
 * is preserved by using Base UI's `ToggleGroup` with `toggleMultiple
 * = false` (the default), which also gives us proper roving tabindex,
 * arrow-key navigation, and `data-pressed` state for the active item
 * for free.
 *
 * Caller's `className` (legacy `.settingsSegmented`) still owns the
 * visual chrome. The primitive only contributes Base UI's behavior
 * contract, the same way `ChoiceCard` / `SettingsSelect` are layered.
 */
export interface SettingsSegmentedProps<T extends string> {
  value: T;
  options: ReadonlyArray<readonly [T, string]>;
  onChange(value: T): void;
  ariaLabel?: string;
  disabled?: boolean;
  className?: string;
}

export function SettingsSegmented<T extends string>(
  props: SettingsSegmentedProps<T>,
): ReactElement {
  return (
    <BaseToggleGroup
      // `toggleMultiple` defaults to false → single-select radio
      // semantics. `defaultValue` is unused; we control the value.
      value={props.value ? [props.value] : []}
      onValueChange={(next) => {
        const first = next[0];
        if (typeof first === "string") props.onChange(first as T);
      }}
      disabled={props.disabled}
      aria-label={props.ariaLabel}
      className={cn("settingsSegmented", props.className)}
    >
      {props.options.map(([value, label]) => (
        <BaseToggle
          key={value}
          value={value}
          disabled={props.disabled}
        >
          {label}
        </BaseToggle>
      ))}
    </BaseToggleGroup>
  );
}
