import { SettingsSelect, type SettingsSelectOption } from './primitives/settings-select.js';

// PR round-AB-shared-select (yuejing 2026-06-25, kenji styles inventory
// task #128): `PlanReminderSelect` is now a thin specialization of the
// shared `SettingsSelect` primitive — `width="full"` to preserve the
// existing edge-to-edge sizing inside `.maka-plan-delivery-grid`.
// Plan Reminder and Settings selects share one component so option
// shape, trigger/popup chrome, and the selected-trigger icon contract
// can't drift apart again.
//
// Issue #1044: shared by the panel (list filter/sort/range toolbars) and
// the extracted form dialog, so it lives in its own leaf module.
export function PlanReminderSelect<T extends string>(props: {
  value: T;
  options: ReadonlyArray<SettingsSelectOption<T>>;
  onChange(value: T): void;
  ariaLabel: string;
  disabled?: boolean;
}) {
  return <SettingsSelect width="full" {...props} />;
}
