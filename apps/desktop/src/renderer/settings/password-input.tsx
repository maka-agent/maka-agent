import { useEffect, useRef, useState } from 'react';
import { Check, Copy, Eye, EyeOff } from '@maka/ui/icons';
import { Button, Input, useToast } from '@maka/ui';

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
 * field. Clipboard failure is visible because these fields often hold
 * credentials; a silent copy miss looks like the user copied a secret
 * when the OS actually rejected it.
 */
export function PasswordInput(props: {
  value: string;
  onChange(next: string): void;
  placeholder?: string;
  ariaLabel?: string;
  disabled?: boolean;
  onBlur?(): void;
}) {
  const toast = useToast();
  const [visible, setVisible] = useState(false);
  const [justCopied, setJustCopied] = useState(false);
  const [copying, setCopying] = useState(false);
  const copyingRef = useRef(false);
  const mountedRef = useRef(true);
  const copyFeedbackTimerRef = useRef<number | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      copyingRef.current = false;
      if (copyFeedbackTimerRef.current !== null) {
        window.clearTimeout(copyFeedbackTimerRef.current);
        copyFeedbackTimerRef.current = null;
      }
    };
  }, []);

  function showCopiedFeedback() {
    if (copyFeedbackTimerRef.current !== null) {
      window.clearTimeout(copyFeedbackTimerRef.current);
    }
    setJustCopied(true);
    copyFeedbackTimerRef.current = window.setTimeout(() => {
      copyFeedbackTimerRef.current = null;
      if (mountedRef.current) setJustCopied(false);
    }, 1200);
  }

  async function copyValue() {
    if (!props.value) return;
    if (copyingRef.current) return;
    copyingRef.current = true;
    setCopying(true);
    try {
      await navigator.clipboard.writeText(props.value);
      if (mountedRef.current) showCopiedFeedback();
    } catch {
      if (mountedRef.current) toast.error('复制失败', '剪贴板不可用或被系统拒绝。');
    } finally {
      copyingRef.current = false;
      if (mountedRef.current) setCopying(false);
    }
  }
  return (
    <div className="settingsPasswordField">
      <Input
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
          <Button
            type="button"
            className="settingsPasswordToggle"
            variant="quiet"
            size="icon-sm"
            disabled={copying}
            onClick={() => void copyValue()}
            aria-label={copying ? '复制中' : justCopied ? '已复制' : '复制'}
          >
            {justCopied
              ? <Check size={16} aria-hidden="true" />
              : <Copy size={16} aria-hidden="true" />}
          </Button>
        )}
        <Button
          type="button"
          className="settingsPasswordToggle"
          variant="quiet"
          size="icon-sm"
          onClick={() => setVisible((current) => !current)}
          disabled={props.disabled}
          aria-label={visible ? '隐藏' : '显示'}
          aria-pressed={visible}
        >
          {visible ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
        </Button>
      </div>
    </div>
  );
}
