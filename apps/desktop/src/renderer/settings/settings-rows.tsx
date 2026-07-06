import type { ReactNode } from 'react';
import { Card } from '@maka/ui';

export function SettingsRows({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <Card className={className ? `settingsRows ${className}` : 'settingsRows'}>
      {children}
    </Card>
  );
}

export function SettingRow(props: { title: string; detail: string; value: string; mono?: boolean }) {
  return (
    <div className="settingsRow">
      <div>
        <strong>{props.title}</strong>
        <small>{props.detail}</small>
      </div>
      {/* mono: filesystem paths / identifiers — right-aligned proportional
          text wraps into a ragged multi-line block for long values. */}
      <span data-mono={props.mono ? 'true' : undefined}>{props.value}</span>
    </div>
  );
}
