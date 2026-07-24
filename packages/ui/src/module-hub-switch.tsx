import type { ReactNode } from 'react';
import type { AutomationModule, ExtensionModule } from './nav-selection.js';
import { useUiLocale } from './locale-context.js';
import { Segmented } from './primitives/segmented.js';
import { getSharedUiCopy } from './shared-ui-copy.js';

export type ModuleHubHeader = {
  title: string;
  subtitle?: string;
  badge: ReactNode;
};

type ModuleHubSwitchProps =
  | {
      hub: 'extensions';
      value: ExtensionModule;
      onChange(value: ExtensionModule): void;
    }
  | {
      hub: 'automations';
      value: AutomationModule;
      onChange(value: AutomationModule): void;
    };

export function ModuleHubSwitch(props: ModuleHubSwitchProps) {
  const copy = getSharedUiCopy(useUiLocale()).moduleHubs;
  if (props.hub === 'extensions') {
    return (
      <Segmented
        value={props.value}
        options={[
          ['skills', copy.extensions.skills],
          ['mcp', copy.extensions.mcp],
        ]}
        onChange={props.onChange}
        ariaLabel={copy.extensions.switchLabel}
        className="maka-module-hub-switch"
      />
    );
  }
  return (
    <Segmented
      value={props.value}
      options={[
        ['plan-reminders', copy.automations.planReminders],
        ['daily-review', copy.automations.dailyReview],
      ]}
      onChange={props.onChange}
      ariaLabel={copy.automations.switchLabel}
      className="maka-module-hub-switch"
    />
  );
}
