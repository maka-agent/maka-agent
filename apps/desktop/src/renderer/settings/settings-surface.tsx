import { useEffect, useRef, useState, type RefObject } from 'react';
import { ArrowLeft } from '@maka/ui/icons';
import type {
  AppSettings,
  LlmConnection,
  SettingsSection,
  ThemePalette,
  ThemePreference,
  UpdateAppSettingsResult,
  UsageRange,
  UsageStats,
} from '@maka/core';
import { createDefaultSettings } from '@maka/core/settings';
import { Button, OverlayScrollArea, useToast } from '@maka/ui';
import { ProvidersPanel } from './ProvidersPanel';
import { safeLocalStorageSet } from '../browser-storage';
import { AccountSettingsPage } from './account-settings-page';
import { AboutSettingsPage } from './about-settings-page';
import { AppearanceSettingsPage } from './appearance-settings-page';
import { BotChatSettingsPage } from './bot-chat-settings-page';
import { DailyReviewSettingsPage } from './daily-review-settings-page';
import { DataSettingsPage } from './data-settings-page';
import { GeneralSettingsPage } from './general-settings-page';
import { HealthCenterPage } from './health-center-page';
import { MemorySettingsPage } from './memory-settings-page';
import { OpenGatewaySettingsPage } from './open-gateway-settings-page';
import { PermissionCenterPage } from './permission-center-page';
import { SettingsSkeleton } from './settings-skeleton';
import { SETTINGS_NAV, groupedNav, navLabel, readLastSettingsSection } from './settings-nav';
import { SettingsRows, SettingRow } from './settings-rows';
import { settingsActionErrorMessage } from './settings-error-copy';
import { UsageSettingsPage } from './usage-settings-page';
import { VoiceModelsSettingsPage } from './voice-settings-page';
import { WebSearchSettingsPage } from './web-search-settings-page';

export function SettingsSurface(props: {
  connections: LlmConnection[];
  defaultSlug: string | null;
  onRefresh(): Promise<void>;
  onClose(): void;
  themePref: ThemePreference;
  onThemeChange(pref: ThemePreference): void;
  themePalette: ThemePalette;
  onThemePaletteChange(palette: ThemePalette): void;
  onUserLabelChange?(label: string): void;
  requestedSection?: SettingsSection;
  initialFocusRef: RefObject<HTMLButtonElement | null>;
  onOpenDailyReview?(): void;
  onOpenSession?(sessionId: string): void;
}) {
  const [section, setSection] = useState<SettingsSection>(() => props.requestedSection ?? readLastSettingsSection());

  // When the parent updates requestedSection (e.g. the palette opens
  // Settings with a different section while it's already mounted), reflect
  // that into the local state.
  useEffect(() => {
    if (props.requestedSection && props.requestedSection !== section) {
      setSection(props.requestedSection);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.requestedSection]);

  // Focus follows the active section's nav button: on mount, and whenever
  // `section` changes (nav click — a native-focus no-op — or a ⌘K palette
  // jump while the modal is already open, where nothing else moves focus).
  // Keyed on `section`, NOT on any parent callback prop: parent callbacks
  // (e.g. onClose) are recreated on every AppShell render — which happens
  // per streamed token — and keying a focus side effect on one yanks focus
  // away from anything the user opened inside Settings dozens of times a
  // second while a session streams.
  useEffect(() => {
    props.initialFocusRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ref identity is stable; re-run only on section change.
  }, [section]);

  // PR-MODEL-OAUTH-SECTION-0: ProvidersPanel's OAuth cards dispatch a
  // `maka:jumpToSettingsSection` window event to navigate between
  // Settings sections without threading another prop through. The event
  // payload is the destination SettingsSection id.
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ section?: SettingsSection }>).detail;
      // PR-OAUTH-CARD-LIVE-STATE-0: validate against SETTINGS_NAV so
      // a dispatched section id that doesn't match any nav item falls
      // through to the default fallback page silently. Previously
      // any truthy string was accepted; a typo would land the user
      // on "该设置页已纳入 Maka 设置树…" with no clear cause.
      if (
        detail?.section &&
        SETTINGS_NAV.some((item) => item.id === detail.section)
      ) {
        setSection(detail.section);
      }
    };
    window.addEventListener('maka:jumpToSettingsSection', handler);
    return () => window.removeEventListener('maka:jumpToSettingsSection', handler);
  }, []);

  useEffect(() => {
    safeLocalStorageSet('maka-settings-section-v1', section);
  }, [section]);
  const [settings, setSettings] = useState<AppSettings>(() => createDefaultSettings());
  const [usageStats, setUsageStats] = useState<UsageStats | null>(null);
  const [loading, setLoading] = useState(true);
  const settingsModalMountedRef = useRef(false);
  const settingsReloadTicketRef = useRef(0);
  const settingsUpdateTicketRef = useRef(0);
  const usageReloadTicketRef = useRef(0);
  const toast = useToast();

  useEffect(() => {
    settingsModalMountedRef.current = true;
    return () => {
      settingsModalMountedRef.current = false;
      settingsReloadTicketRef.current += 1;
      settingsUpdateTicketRef.current += 1;
      usageReloadTicketRef.current += 1;
    };
  }, []);

  async function reloadSettings() {
    const ticket = settingsReloadTicketRef.current + 1;
    settingsReloadTicketRef.current = ticket;
    try {
      const next = await window.maka.settings.get();
      if (settingsModalMountedRef.current && ticket === settingsReloadTicketRef.current) {
        setSettings(next);
      }
    } catch (error) {
      if (settingsModalMountedRef.current && ticket === settingsReloadTicketRef.current) {
        toast.error('载入设置失败', settingsActionErrorMessage(error));
      }
    } finally {
      if (settingsModalMountedRef.current && ticket === settingsReloadTicketRef.current) {
        setLoading(false);
      }
    }
  }

  async function updateSettings(patch: Parameters<typeof window.maka.settings.update>[0]) {
    const ticket = settingsUpdateTicketRef.current + 1;
    settingsUpdateTicketRef.current = ticket;
    const result = await window.maka.settings.update(patch);
    const next = result.settings;
    if (settingsModalMountedRef.current && ticket === settingsUpdateTicketRef.current) {
      setSettings(next);
      props.onUserLabelChange?.(next.personalization.displayName);
    }
    return result;
  }

  async function reloadUsage(range: UsageRange = settings.usage.range) {
    const ticket = usageReloadTicketRef.current + 1;
    usageReloadTicketRef.current = ticket;
    try {
      const next = await window.maka.settings.usageStats(range);
      if (settingsModalMountedRef.current && ticket === usageReloadTicketRef.current) {
        setUsageStats(next);
      }
    } catch (error) {
      if (settingsModalMountedRef.current && ticket === usageReloadTicketRef.current) {
        toast.error('载入使用统计失败', settingsActionErrorMessage(error));
      }
    }
  }

  useEffect(() => {
    void reloadSettings();
  }, []);

  useEffect(() => {
    if (section === 'usage') void reloadUsage();
  }, [section]);

  const activeItem = SETTINGS_NAV.find((item) => item.id === section) ?? SETTINGS_NAV[0];

  return (
    <main className="settingsSurface agents-layout-body" data-modal="true" aria-label="设置内容">
      <aside className="settingsSidebar agents-sidebar" data-settings-nav-column aria-label="设置侧栏">
        <div className="settingsSidebarInner">
          {/* PR-SETTINGS-NO-PANE-BORDER-0 (WAWQAQ msg `8effe691`):
              reference sidebar has just `← 返回应用` then straight
              into the nav — no big "设置" brand label. Match it. */}
          <Button
            className="settingsBackButton"
            variant="quiet"
            type="button"
            aria-label="返回应用"
            onClick={props.onClose}
          >
            <ArrowLeft size={16} aria-hidden="true" />
            <span>返回应用</span>
          </Button>
          <nav aria-label="设置分组">
            {groupedNav().map(({ group, items }) => (
              <div key={group} className="settingsNavGroup" role="group" aria-label={group}>
                <div className="settingsNavGroupLabel">{group}</div>
                {items.map((item) => (
                  <Button
                    key={item.id}
                    className="settingsNavItem"
                    data-active={section === item.id}
                    aria-current={section === item.id ? 'page' : undefined}
                    type="button"
                    ref={section === item.id ? props.initialFocusRef : undefined}
                    disabled={!item.enabled}
                    onClick={() => setSection(item.id)}
                  >
                    <span className="settingsNavGlyph" aria-hidden="true">
                      <item.Icon size={16} />
                    </span>
                    <strong>{item.label}</strong>
                    {item.badge && (
                      <span className="settingsNavBadge" data-badge={item.badge}>
                        {item.badge}
                      </span>
                    )}
                  </Button>
                ))}
              </div>
            ))}
          </nav>
        </div>
      </aside>

      <section className="settingsMainPane agents-content-area" data-agents-view="settings">
        <header className="settingsPageHeader">
          <div className="settingsPageHeaderTitleStack">
            <h2>{activeItem.label}</h2>
            {activeItem.description && (
              <p className="settingsPageHeaderDescription">{activeItem.description}</p>
            )}
          </div>
        </header>

        <OverlayScrollArea
          className="settingsPageContent"
          viewportClassName="settingsPageContentViewport"
          contentClassName="settingsPageContentInner"
        >
          {loading ? (
            <SettingsSkeleton />
          ) : (
            <SettingsPage
              section={section}
              settings={settings}
              usageStats={usageStats}
              connections={props.connections}
              defaultSlug={props.defaultSlug}
              themePref={props.themePref}
              themePalette={props.themePalette}
              onRefreshConnections={props.onRefresh}
              onUpdateSettings={updateSettings}
              onReloadSettings={reloadSettings}
              onReloadUsage={reloadUsage}
              onThemeChange={props.onThemeChange}
              onThemePaletteChange={props.onThemePaletteChange}
              onOpenDailyReview={props.onOpenDailyReview}
              onOpenSession={props.onOpenSession}
            />
          )}
        </OverlayScrollArea>
      </section>
    </main>
  );
}

function SettingsPage(props: {
  section: SettingsSection;
  settings: AppSettings;
  usageStats: UsageStats | null;
  connections: LlmConnection[];
  defaultSlug: string | null;
  themePref: ThemePreference;
  themePalette: ThemePalette;
  onRefreshConnections(): Promise<void>;
  onUpdateSettings(patch: Parameters<typeof window.maka.settings.update>[0]): Promise<UpdateAppSettingsResult>;
  onReloadSettings(): Promise<void>;
  onReloadUsage(range?: UsageRange): Promise<void>;
  onThemeChange(pref: ThemePreference): void;
  onThemePaletteChange(palette: ThemePalette): void;
  onOpenDailyReview?(): void;
  onOpenSession?(sessionId: string): void;
}) {
  // PR-FE-BUG-HUNT-0 (kenji bug-hunt 2026-06-24): the inline `void
  // props.onUpdateSettings(...)` at the privacy toggle below
  // discarded rejection promises, so an IPC failure became an
  // Unhandled Promise Rejection at the renderer level with no user
  // feedback. Toast surface mirrors the rest of the file's catch
  // pattern (PR-STOP-ERROR-SURFACE-0 / PR-BOT-RESTART-RACE-0).
    switch (props.section) {
    case 'models':
      return (
        <div className="settingsStructuredPage settingsModelsPage">
          <ProvidersPanel bridge={window.maka.connections} />
        </div>
      );
    case 'usage':
      return (
        <UsageSettingsPage
          settings={props.settings}
          stats={props.usageStats}
          onUpdate={props.onUpdateSettings}
          onReload={props.onReloadUsage}
          onOpenSession={props.onOpenSession}
        />
      );
    case 'bot-chat':
      return (
        <BotChatSettingsPage
          settings={props.settings}
          onUpdate={props.onUpdateSettings}
          onReload={props.onReloadSettings}
        />
      );
    case 'about':
      return <AboutSettingsPage />;
    case 'general':
      return (
        <GeneralSettingsPage
          settings={props.settings}
          connections={props.connections}
          defaultSlug={props.defaultSlug}
          onUpdate={props.onUpdateSettings}
          onRefreshConnections={props.onRefreshConnections}
        />
      );
    case 'appearance':
      return (
        <AppearanceSettingsPage
          themePref={props.themePref}
          themePalette={props.themePalette}
          settings={props.settings}
          onUpdate={props.onUpdateSettings}
          onThemeChange={props.onThemeChange}
          onThemePaletteChange={props.onThemePaletteChange}
        />
      );
    case 'data':
      return <DataSettingsPage />;
    case 'account':
      return (
        <AccountSettingsPage
          connections={props.connections}
          defaultSlug={props.defaultSlug}
          onRefresh={props.onRefreshConnections}
        />
      );
    case 'permissions':
      return <PermissionCenterPage />;
    case 'health':
      return <HealthCenterPage />;
    case 'memory':
      // PR-SETTINGS-REVIEW-0 (WAWQAQ msg `886f6406`): the merged
      // memory-review page was too dense; 记忆 is its own page again.
      return (
        <MemorySettingsPage
          settings={props.settings}
          onUpdate={props.onUpdateSettings}
          onReloadSettings={props.onReloadSettings}
        />
      );
    case 'daily-review':
      return <DailyReviewSettingsPage connections={props.connections} onOpenDailyReview={props.onOpenDailyReview} />;
    case 'voice':
      // PR-VOICE-GATEWAY-SPLIT-0 (WAWQAQ msg `d3ea9a33` 2026-06-26):
      // 语音 + 网关 是两套独立的功能（一个是本地麦克风/转写管线，
      // 一个是远程 SSE/HTTP 网关），合在一页里读起来既挤又混。
      // 拆成两个独立的 nav 项各自独立呈现。
      return <VoiceModelsSettingsPage />;
    case 'open-gateway':
      return <OpenGatewaySettingsPage settings={props.settings} onUpdate={props.onUpdateSettings} />;
    case 'search':
      return (
        <WebSearchSettingsPage
          settings={props.settings}
          onUpdate={props.onUpdateSettings}
        />
      );
    default:
      return (
        <SettingsRows>
          <SettingRow title={navLabel(props.section)} detail="该设置页已纳入 Maka 设置树，会随对应 runtime 能力一起工作。" value="Ready" />
        </SettingsRows>
      );
  }
}
