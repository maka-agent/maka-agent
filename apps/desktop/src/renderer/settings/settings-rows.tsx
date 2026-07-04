import type { ReactNode } from 'react';

export function SettingsRows(props: { children: ReactNode }) {
  return <div className="settingsRows">{props.children}</div>;
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
