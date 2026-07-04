import { useEffect, useRef } from 'react';
import type {
  LlmConnection,
  SettingsSection,
  ThemePalette,
  ThemePreference,
} from '@maka/core';
import { SettingsSurface } from './settings-surface';

export { SETTINGS_NAV } from './settings-nav';
export type { SettingsNavGroup } from './settings-nav';

export function SettingsModal(props: {
  connections: LlmConnection[];
  defaultSlug: string | null;
  onRefresh(): Promise<void>;
  onClose(): void;
  themePref: ThemePreference;
  onThemeChange(pref: ThemePreference): void;
  /**
   * PR-THEME-APPLY-AND-DONE-POLISH-0 (WAWQAQ msg `dec85e5b`): current
   * palette + live setter. Click handler calls `onThemePaletteChange(next)`
   * synchronously so the `data-maka-theme` attribute updates on the same
   * tick — no need to wait for the IPC `appearance.palette` round-trip,
   * and no need for a restart for switching to take visible effect.
   */
  themePalette: ThemePalette;
  onThemePaletteChange(palette: ThemePalette): void;
  onUserLabelChange?(label: string): void;
  /**
   * Force the modal to a specific section when it (re-)mounts or when the
   * value changes while already open. Used by the command palette so
   * ⌘K → "网络" jumps straight to the section without an extra click.
   */
  requestedSection?: SettingsSection;
  /**
   * PR-DAILY-REVIEW-MVP-0 follow-up: navigate to the sidebar's
   * Daily Review module. Optional so the settings page degrades
   * gracefully when the shell does not provide the jump.
   */
  onOpenDailyReview?(): void;
  /**
   * Jump from diagnostics surfaces (usage rows, later run history) back to the
   * source conversation. Settings owns the table, shell owns navigation.
   */
  onOpenSession?(sessionId: string): void;
}) {
  const pageRef = useRef<HTMLDivElement>(null);
  const activeNavRef = useRef<HTMLButtonElement>(null);
  // Focus the modal exactly once, when it actually opens -- not on every
  // re-render. `onClose` (app-shell.tsx's `closeSettings`) is a plain
  // function recreated on every AppShell render, and AppShell re-renders on
  // every streamed token (streamingBySession state). Previously this effect
  // was keyed on `[props.onClose]`, so it tore down and re-ran on every
  // token while a session was streaming, and `activeNavRef.current?.focus()`
  // forcibly yanked focus back to the settings nav each time -- stealing
  // focus from whatever the user had just opened/clicked inside Settings
  // (most visibly, a focus-managed popup like the default-permission-mode
  // menu, which closes/stops responding to clicks when it loses focus).
  useEffect(() => {
    activeNavRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only by design, see comment above.
  }, []);

  // The Escape listener is safe to resubscribe on every onClose identity
  // change (it only adds/removes a DOM listener, not a focus-stealing side
  // effect), and keeping it keyed on `onClose` guarantees Escape always
  // calls the current closure rather than a stale one.
  useEffect(() => {
    function onKey(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') props.onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props.onClose]);

  return (
    <div
      ref={pageRef}
      role="region"
      aria-label="设置"
      className="settingsModal settingsPage agents-layout-root"
      data-agents-page
    >
      <SettingsSurface
        connections={props.connections}
        defaultSlug={props.defaultSlug}
        onRefresh={props.onRefresh}
        onClose={props.onClose}
        themePref={props.themePref}
        onThemeChange={props.onThemeChange}
        themePalette={props.themePalette}
        onThemePaletteChange={props.onThemePaletteChange}
        onUserLabelChange={props.onUserLabelChange}
        requestedSection={props.requestedSection}
        initialFocusRef={activeNavRef}
        onOpenDailyReview={props.onOpenDailyReview}
        onOpenSession={props.onOpenSession}
      />
    </div>
  );
}
