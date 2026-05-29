import { useState } from 'react';
import { Check, Copy, Eye, EyeOff } from 'lucide-react';

/**
 * PR-BOT-SETTINGS-PASSWORD-EYE-0 / PR-BOT-SETTINGS-PASSWORD-COPY-0 /
 * PR-SETTINGS-PASSWORD-INPUT-REACH-0 (WAWQAQ msg `51c7b4ff` screenshots):
 * masked text input with a trailing Eye / EyeOff toggle and an
 * optional Copy button. Shared across Settings credential surfaces
 * (bot tokens / app secrets, provider API keys, Open Gateway token,
 * network proxy password, web search API key) so the visibility +
 * clipboard affordance is consistent.
 *
 * Initial state is masked. Toggle and copy are both real focusable
 * buttons so keyboard users can flip or copy without leaving the
 * field. On clipboard failure the copy click is silent — the masked
 * value remains readable on-screen.
 */
export function PasswordInput(props: {
  value: string;
  onChange(next: string): void;
  placeholder?: string;
  ariaLabel?: string;
  disabled?: boolean;
  onBlur?(): void;
}) {
  const [visible, setVisible] = useState(false);
  const [justCopied, setJustCopied] = useState(false);
  async function copyValue() {
    if (!props.value) return;
    try {
      await navigator.clipboard.writeText(props.value);
      setJustCopied(true);
      window.setTimeout(() => setJustCopied(false), 1200);
    } catch {
      /* clipboard unavailable; silent — user can still see the masked value */
    }
  }
  return (
    <div className="settingsPasswordField">
      <input
        type={visible ? 'text' : 'password'}
        value={props.value}
        onChange={(event) => props.onChange(event.currentTarget.value)}
        onBlur={props.onBlur}
        placeholder={props.placeholder}
        aria-label={props.ariaLabel}
        autoComplete="off"
        spellCheck={false}
        disabled={props.disabled}
      />
      <div className="settingsPasswordActions">
        {props.value && !props.disabled && (
          <button
            type="button"
            className="settingsPasswordToggle"
            onClick={() => void copyValue()}
            aria-label={justCopied ? '已复制' : '复制'}
          >
            {justCopied
              ? <Check size={16} strokeWidth={1.75} aria-hidden="true" />
              : <Copy size={16} strokeWidth={1.75} aria-hidden="true" />}
          </button>
        )}
        <button
          type="button"
          className="settingsPasswordToggle"
          onClick={() => setVisible((current) => !current)}
          disabled={props.disabled}
          aria-label={visible ? '隐藏' : '显示'}
          aria-pressed={visible}
        >
          {visible ? <EyeOff size={16} strokeWidth={1.75} aria-hidden="true" /> : <Eye size={16} strokeWidth={1.75} aria-hidden="true" />}
        </button>
      </div>
    </div>
  );
}
