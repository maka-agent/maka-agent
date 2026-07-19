import type { Dispatch, SetStateAction } from 'react';
import type { SettingsSection, ThemePreference, UiLocale } from '@maka/core';
import type { InteractionQueues, LiveTurnProjection } from '@maka/ui';
import type { NavSelection } from '@maka/ui';
import { applyTheme } from './theme';
import type { SessionWorkbarTab } from './session-workbar-layout';

type StateUpdater<T> = (updater: (current: T) => T) => void;

export interface AppShellVisualSmokeActions {
  applyVisualSmokeFixture(): Promise<void>;
}

export function createAppShellVisualSmokeActions(options: {
  openPalette: () => void;
  openSettingsSection: (section: SettingsSection) => void;
  refreshSessions: () => Promise<unknown>;
  setActiveId: (sessionId: string | undefined) => void;
  setLiveBrowserSessionIds: Dispatch<SetStateAction<string[]>>;
  setLiveTurnBySession: StateUpdater<Record<string, LiveTurnProjection>>;
  setNavSelection: Dispatch<SetStateAction<NavSelection>>;
  setInteractionBySession: StateUpdater<InteractionQueues>;
  setSearchModalOpen: Dispatch<SetStateAction<boolean>>;
  setSessionListCollapsed: Dispatch<SetStateAction<boolean>>;
  setWorkbarCollapsed: Dispatch<SetStateAction<boolean>>;
  setWorkbarTab: Dispatch<SetStateAction<SessionWorkbarTab>>;
  setThemePref: Dispatch<SetStateAction<ThemePreference>>;
  setUiLocaleOverride: Dispatch<SetStateAction<UiLocale | null>>;
}): AppShellVisualSmokeActions {
  const {
    openPalette,
    openSettingsSection,
    refreshSessions,
    setActiveId,
    setLiveBrowserSessionIds,
    setLiveTurnBySession,
    setNavSelection,
    setInteractionBySession,
    setSearchModalOpen,
    setSessionListCollapsed,
    setWorkbarCollapsed,
    setWorkbarTab,
    setThemePref,
    setUiLocaleOverride,
  } = options;

  async function applyVisualSmokeFixture() {
    const state = await window.maka.visualSmoke.getState();
    if (!state) return;
    if (state.now) {
      // Fixture-only clock freeze: screenshot baselines should not drift
      // because relative timestamps or fetched-at labels crossed a minute
      // boundary between two runs. Real users never receive a visual
      // smoke state, so their Date API remains untouched.
      Date.now = () => state.now!;
    }
    document.documentElement.setAttribute('data-maka-visual-smoke', 'true');
    if (state.liveTurnBySession) {
      setLiveTurnBySession((current) => ({ ...current, ...state.liveTurnBySession }));
    }
    if (state.permissionBySession) {
      const seeded: InteractionQueues = {};
      for (const [seedSessionId, request] of Object.entries(state.permissionBySession)) {
        if (request) seeded[seedSessionId] = [request];
      }
      setInteractionBySession((current) => ({ ...current, ...seeded }));
    }
    // PR-IR-01b: theme override applied BEFORE the persisted user pref so
    // the screenshot variant matches `<theme>-<viewport>-<motion>.png`
    // exactly. `applyTheme` writes both the React state + the `.dark` class
    // on the html element. Real users never hit this branch because
    // `state` is null without `MAKA_VISUAL_SMOKE_FIXTURE`.
    if (state.theme) {
      applyTheme(state.theme);
      setThemePref(state.theme);
    }
    // PR-IR-04: apply reduced-motion attribute when the fixture asks for it.
    // The matching CSS rule in styles.css collapses all animations to
    // ~0.01ms so the screenshot pipeline can capture a reduced-motion
    // variant without depending on the host OS accessibility setting.
    // Real users never reach this code path (visualSmoke.getState returns
    // null without MAKA_VISUAL_SMOKE_FIXTURE).
    if (state.reducedMotion) {
      document.documentElement.setAttribute('data-maka-reduced-motion', 'true');
    }
    // PR-UI-VISUAL-SMOKE-LOCALE: lock the UI locale BEFORE
    // `refreshSessions()` resolves and BEFORE any locale-dependent
    // content (EmptyChatHero / Composer / OnboardingHero quickChat)
    // enters the React tree — all of those gate on sessions /
    // connection state which load inside this same effect. The reactive
    // override reaches every consumer before the fixture's
    // session refresh exposes locale-dependent content.
    // AppShell initial mount already ran when this effect fires,
    // but that initial mount renders no locale-aware copy yet
    // (it's a loading shell), so there's no observable host-locale
    // leak in the captured baseline. See @kenji review
    // @msg 7b96e182.
    setUiLocaleOverride(state.locale ?? null);
    // PR-UI-VISUAL-SMOKE-TIMEZONE (@kenji msg 45486cdf): mirror the
    // locale attribute pattern. When `MAKA_VISUAL_SMOKE_TIMEZONE` is
    // set and validates against `Intl.DateTimeFormat`, the IANA name
    // lands on `<html>` so any date / time formatting helper can
    // opt in by reading `document.documentElement.dataset.makaVisualSmokeTz`.
    // The attribute alone is the contract; per-call timezone
    // consumption is up to individual formatters as they migrate.
    if (state.timezone) {
      document.documentElement.setAttribute('data-maka-visual-smoke-tz', state.timezone);
    }
    await refreshSessions();
    if (state.activeSessionId) {
      setActiveId(state.activeSessionId);
    }
    // #819: seed live browser session ids so BrowserPanel mounts for the
    // active session (app-shell gates on `activeId &&
    // liveBrowserSessionIds.includes(activeId)`). Only the `browser-empty`
    // scenario sets this; real users never receive a visual smoke state.
    if (state.liveBrowserSessionIds) {
      setLiveBrowserSessionIds(state.liveBrowserSessionIds);
    }
    if (state.sidebarCollapsed !== undefined) {
      setSessionListCollapsed(state.sidebarCollapsed);
    }
    if (state.workbarCollapsed !== undefined) setWorkbarCollapsed(state.workbarCollapsed);
    if (state.workbarTab) setWorkbarTab(state.workbarTab);
    if (state.openSettingsSection) {
      openSettingsSection(state.openSettingsSection);
    }
    // PR-SIDEBAR-IA-0 Phase 2 fixup v3 (xuan msg `dce5a6fb` #2): when
    // the fixture sets `searchModalOpen`, auto-open the sidebar
    // Search modal so the screenshot pipeline captures the modal
    // shell deterministically. Real users never reach this branch
    // (visualSmoke.getState returns null without MAKA_VISUAL_SMOKE_FIXTURE).
    if (state.searchModalOpen) {
      setSearchModalOpen(true);
    }
    // PR-shared primitive-COMMAND-INPUT-0: visual-smoke-only opener for the command
    // palette so screenshot baselines can cover its input shell without
    // requiring Cmd/Ctrl+K in the capture harness.
    if (state.paletteOpen) {
      openPalette();
    }
    if (state.sidebarSection === 'automations') {
      setNavSelection({ section: 'automations' });
    } else if (state.sidebarSection === 'skills') {
      setNavSelection({ section: 'skills' });
    } else if (state.sidebarSection === 'mcp') {
      setNavSelection({ section: 'mcp' });
    } else if (state.sidebarSection === 'daily-review') {
      setNavSelection({ section: 'daily-review' });
    } else if (state.sidebarSection === 'sessions') {
      setNavSelection({ section: 'sessions', filter: 'chats' });
    }
    // PR-SIDEBAR-IA-0 Phase 3 P0 fixup v4 (WAWQAQ msg `5dd1c348`,
    // kenji `b3d156e9`): when the fixture sets `focusActiveRow`,
    // focus the active row's button after the next paint so the
    // row's `:focus-within` triggers and the `.maka-list-row-menu-trigger`
    // becomes visible. The auto-capture then shows the overflow
    // trigger against the slim row, proving the time meta
    // + unread dot are hidden underneath (no overlap with the
    // action icons — the bug WAWQAQ flagged). Two RAFs let React
    // commit the active selection before we query the DOM.
    if (state.focusActiveRow) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const activeRowButton = document.querySelector<HTMLButtonElement>(
            '.maka-list-row[data-active="true"] .maka-list-row-main',
          );
          activeRowButton?.focus({ preventScroll: true });
        });
      });
    }
    // PR-IR-01: when MAKA_VISUAL_SMOKE_AUTO_CAPTURE is set, snap a
    // screenshot once the fixture has settled and the renderer has
    // committed. We wait two RAFs + a small idle delay so async layout
    // (Settings modal mount, sidebar group rendering, etc.) finishes
    // before the capture lands. The driver script reads the stdout
    // marker emitted from main and kills the subprocess after.
    if (state.autoCaptureVariant) {
      const variant = state.autoCaptureVariant;
      // Two RAFs + 400ms idle is the same pattern Chromium uses for
      // settled layout in DevTools "Capture full size screenshot" —
      // gives fonts and late-stream IPC time to flush.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setTimeout(async () => {
            // Keep screenshot baselines free of focus rings / caret blink.
            // Interaction-specific focus behavior is covered by node tests
            // and manual smoke paths; auto-capture should measure layout.
            //
            // PR-SIDEBAR-IA-0 Phase 3 P0 fixup v4 exception (WAWQAQ
            // msg `5dd1c348`): when the fixture asks for a focused
            // active row (e.g. the `sidebar-row-actions-visible`
            // scenario, which proves the overflow action doesn't
            // overlap the time meta), the blur step would defeat the
            // whole point of the capture. Skip the blur in that
            // narrow case; other captures still get a clean (focusless)
            // baseline.
            if (!state.focusActiveRow && document.activeElement instanceof HTMLElement) {
              document.activeElement.blur();
            }
            if ('fonts' in document) {
              await document.fonts.ready;
            }
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                void window.maka.visualSmoke.capture({ scenario: state.scenario, variant });
              });
            });
          }, 400);
        });
      });
    }
  }

  return { applyVisualSmokeFixture };
}
