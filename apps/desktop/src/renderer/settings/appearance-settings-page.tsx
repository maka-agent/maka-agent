import { useEffect, useId, useRef, useState } from 'react';
import type {
  AppSettings,
  PersonalizationSettingsWarning,
  ThemePalette,
  ThemePreference,
  UpdateAppSettingsResult,
} from '@maka/core';
import { Button, ChoiceCard, ChoiceCardGroup, Input, SettingsSegmented as Segmented, Textarea, useToast } from '@maka/ui';
import { applyUiLocale, type UiLocalePreference } from '../theme';
import { settingsActionErrorMessage } from './settings-error-copy';

const THEME_OPTIONS: Array<{ value: ThemePreference; label: string; help: string }> = [
  { value: 'light', label: '浅色', help: '始终使用浅色界面。' },
  { value: 'dark', label: '深色', help: '始终使用深色界面。' },
  { value: 'auto', label: '跟随系统', help: '匹配 macOS 当前浅色或深色偏好。' },
];

export function AppearanceSettingsPage(props: {
  themePref: ThemePreference;
  themePalette: ThemePalette;
  settings: AppSettings;
  onUpdate(patch: Parameters<typeof window.maka.settings.update>[0]): Promise<UpdateAppSettingsResult>;
  onThemeChange(pref: ThemePreference): void;
  onThemePaletteChange(palette: ThemePalette): void;
}) {
  return (
    <div className="settingsStructuredPage">
      <h2 className="settingsSectionHeading">个性化</h2>
      <PersonalizationSettingsPage settings={props.settings} onUpdate={props.onUpdate} />
      <h2 className="settingsSectionHeading">主题</h2>
      <ThemeSettingsPage
        themePref={props.themePref}
        themePalette={props.themePalette}
        settings={props.settings}
        onUpdate={props.onUpdate}
        onThemeChange={props.onThemeChange}
        onThemePaletteChange={props.onThemePaletteChange}
      />
    </div>
  );
}

function PersonalizationSettingsPage(props: {
  settings: AppSettings;
  onUpdate(patch: Parameters<typeof window.maka.settings.update>[0]): Promise<UpdateAppSettingsResult>;
}) {
  const value = props.settings.personalization;
  const [displayName, setDisplayName] = useState(value.displayName);
  const [assistantTone, setAssistantTone] = useState(value.assistantTone);
  const [uiLocale, setUiLocale] = useState<UiLocalePreference>(value.uiLocale);
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const personalizationMountedRef = useRef(false);
  const personalizationSaveHelpId = useId();

  useEffect(() => {
    personalizationMountedRef.current = true;
    return () => {
      personalizationMountedRef.current = false;
      savingRef.current = false;
    };
  }, []);

  // PR-PERSONALIZATION-SYNC-0: sync form state when the persisted
  // personalization changes externally. Two real scenarios:
  //   1. Server-side sanitization (control chars, secret-shaped
  //      patterns) rewrites the input on save — local state would
  //      otherwise keep showing the raw typed value while the
  //      persisted store has the sanitized version.
  //   2. Another agent / background sync mutates settings while the
  //      panel is open.
  // The user's in-progress edits aren't blown away — this only
  // fires when the persisted reference identity actually changes.
  useEffect(() => {
    setDisplayName(value.displayName);
    setAssistantTone(value.assistantTone);
    setUiLocale(value.uiLocale);
  }, [value.displayName, value.assistantTone, value.uiLocale]);

  async function save() {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      const result = await props.onUpdate({
        personalization: {
          displayName: displayName.trim().slice(0, 60),
          assistantTone: assistantTone.trim().slice(0, 500),
          uiLocale,
        },
      });
      if (!personalizationMountedRef.current) return;
      // PR-LANG-PREF-0: apply the chosen locale to <html> right
      // after save so the change takes effect immediately in the
      // current window. The persisted value also drives next-boot
      // detection (main.tsx applies it on settings load).
      applyUiLocale(uiLocale);
      // Single toast either way. With warnings, surface generic policy
      // statements (no raw user text echoed back, no specific keyword
      // disclosed) per kenji's personalization-prompt-contract.
      const warnings = collectPersonalizationWarningCopy(result.warnings?.personalization ?? []);
      if (warnings) {
        if (personalizationMountedRef.current) {
          toast.warning('已保存并做安全清理', warnings);
        }
      } else {
        if (personalizationMountedRef.current) {
          toast.success('个性化已保存');
        }
      }
    } catch (error) {
      if (personalizationMountedRef.current) {
        toast.error('保存失败', settingsActionErrorMessage(error));
      }
    } finally {
      savingRef.current = false;
      if (personalizationMountedRef.current) {
        setSaving(false);
      }
    }
  }

  return (
    <div className="settingsStructuredPage">
      {/* PR-S2 (2026-06-23): single-control rows use the
          reference-style horizontal layout — label + description on
          the left, control aligned right, 1 px hairline between
          rows. Vertical layout is reserved for full-width controls
          like the Textarea below. */}
      <label className="settingsField" data-orient="horizontal">
        <span>显示名称</span>
        <small>Maka 在聊天里会以这个名字称呼你。留空就用默认的「你」。</small>
        <Input
          type="text"
          value={displayName}
          onChange={(event) => setDisplayName(event.currentTarget.value)}
          placeholder="例如：JK"
          maxLength={60}
          autoComplete="off"
          spellCheck={false}
          disabled={saving}
          aria-label="显示名称"
        />
      </label>

      {/*
        PR-LANG-PREF-0 (WAWQAQ msg `edc9cb41` + kenji `7e532892`
        acceptance criteria): 自动 / 中文 / English. User explicit
        choice wins over navigator.language; visual-smoke override
        wins over both (deterministic baselines).
      */}
      <div className="settingsField" data-orient="horizontal">
        <span>界面语言</span>
        <small>选择 Maka 界面的显示语言。保存后立即生效，重启后保持。</small>
        <Segmented
          value={uiLocale}
          options={[
            ['auto', '跟随系统'],
            ['zh', '中文'],
            ['en', 'English'],
          ]}
          onChange={(next) => setUiLocale(next as UiLocalePreference)}
          ariaLabel="界面语言"
          disabled={saving}
        />
      </div>

      <label className="settingsField">
        <span>助手语气偏好</span>
        <Textarea
          value={assistantTone}
          onChange={(event) => setAssistantTone(event.currentTarget.value)}
          placeholder="一句话告诉助手期望的语气，比如：技术严谨 / 偏简洁 / 不要 emoji / 多反问。"
          rows={4}
          maxLength={500}
          spellCheck={false}
          disabled={saving}
          aria-label="助手语气偏好"
          className="min-h-21"
        />
        {/* Designer audit P1-8: was engineering-speak ("以低优先级拼到
            system prompt"、"Runtime 独立判定") — user copy shouldn't require
            understanding the implementation. */}
        <small>
          最多 500 字，只影响回答的语气和风格。权限确认与安全规则不受它影响——
          写"跳过确认"这类指令不会生效。
        </small>
      </label>

      <div className="settingsActionRow">
        <Button
          type="button"
          disabled={saving}
          aria-busy={saving}
          aria-describedby={personalizationSaveHelpId}
          data-pending={saving ? 'true' : undefined}
          onClick={() => void save()}
        >
          {saving ? '保存中…' : '保存'}
        </Button>
        <p id={personalizationSaveHelpId} className="settingsHelpText">保存后立即生效，下一次发送对话时模型会拿到新偏好。</p>
      </div>
    </div>
  );
}

function collectPersonalizationWarningCopy(warnings: PersonalizationSettingsWarning[]): string | undefined {
  if (warnings.length === 0) return undefined;
  // Copy per kenji's personalization-prompt-contract: enum -> generic policy
  // statement. Never quote, name, or echo the matched phrase / keyword;
  // each line describes the action taken + the invariant that still holds.
  const copy: Record<PersonalizationSettingsWarning, string> = {
    'override-attempt':
      '检测到可能尝试改变助手行为的内容，已按低优先级偏好处理；权限策略不受影响。',
    'sensitive-pattern': '检测到疑似敏感凭据，已避免在提示或日志中回显原文。',
    'control-chars': '已清理不可见控制字符，避免影响提示结构。',
  };
  return warnings.map((warning) => copy[warning]).join('\n');
}

/**
 * Mini chat-surface mockup rendered inside each theme radio tile. Replaces
 * the generic gradient swatch with a representative preview so the user
 * can see roughly what light vs dark looks like before clicking. The mock
 * uses hardcoded color values per variant (deliberately not tokenized) so
 * the preview tiles don't all shift to match the *currently active* theme
 * — that would defeat the comparison.
 *
 * Per @kenji's PR79 review: preview is purely visual; click commits. We
 * deliberately do not do a "hover to apply globally" flow because it
 * makes Settings feel like it's mutating state on idle pointer movement.
 */
function ThemePreviewMock(props: { variant: ThemePreference }) {
  if (props.variant === 'auto') {
    return (
      <div className="settingsThemePreview settingsThemePreviewSplit" aria-hidden="true">
        <ThemePreviewPane mode="light" />
        <ThemePreviewPane mode="dark" />
      </div>
    );
  }
  return (
    <div className="settingsThemePreview" aria-hidden="true">
      <ThemePreviewPane mode={props.variant} />
    </div>
  );
}

function ThemePreviewPane(props: { mode: 'light' | 'dark' }) {
  return (
    <div className="settingsThemePreviewPane" data-mode={props.mode}>
      <div className="settingsThemePreviewSidebar" />
      <div className="settingsThemePreviewChat">
        <div className="settingsThemePreviewLine settingsThemePreviewLine-assistant" />
        <div className="settingsThemePreviewLine settingsThemePreviewLine-assistant settingsThemePreviewLine-short" />
        <div className="settingsThemePreviewBubble" />
      </div>
    </div>
  );
}

// PR-THEME-PRODUCT-PALETTES-0: user-facing labels + short description
// for each palette. Kept inline (not in i18n strings) so the picker
// label and accessibility text live next to the palette token.
const PALETTE_LABEL: Record<ThemePalette, string> = {
  'default': '默认',
  'onedark': 'One Dark',
  'catppuccin-mocha': 'Catppuccin Mocha',
  'tokyo-night': 'Tokyo Night',
  'nord': 'Nord',
  'coral': '珊瑚',
  'azure': '湖蓝',
  'forest': '森林',
  'dusk': '暮光',
  'sand': '沙金',
  'mono': '极简灰',
};

const PALETTE_HELP: Record<ThemePalette, string> = {
  'default': 'Maka 原本的紫色强调色',
  'onedark': '编辑器经典深色',
  'catppuccin-mocha': '紫调柔和深色',
  'tokyo-night': '深蓝主题',
  'nord': '北欧冷色',
  'coral': '暖粉 / 珊瑚强调色',
  'azure': '湖蓝强调色，干净冷静',
  'forest': '深苔绿 + 暖蜂蜜强调色，自然感',
  'dusk': '深紫罗兰 + 冷调画布，黄昏感',
  'sand': '琥珀沙金 + 暖奶白，复古暖调',
  'mono': '纯灰阶，无彩色干扰',
};

/**
 * PR-PALETTE-PICKER-GROUPS-0: 11 palettes need grouping so the
 * picker scans cleanly. `default` + the 4 community editor themes
 * land in 编辑器主题; the 6 color-family product accents land in
 * 产品色调. Order within each group is preserved for stable
 * keyboard navigation.
 */
const PALETTE_GROUPS: ReadonlyArray<{ id: string; label: string; palettes: ReadonlyArray<ThemePalette> }> = [
  { id: 'editor', label: '编辑器主题', palettes: ['default', 'onedark', 'catppuccin-mocha', 'tokyo-night', 'nord'] },
  { id: 'product', label: '产品色调', palettes: ['coral', 'azure', 'forest', 'dusk', 'sand', 'mono'] },
];

function ThemeSettingsPage(props: {
  themePref: ThemePreference;
  themePalette: ThemePalette;
  settings: AppSettings;
  onUpdate(patch: Parameters<typeof window.maka.settings.update>[0]): Promise<UpdateAppSettingsResult>;
  onThemeChange(pref: ThemePreference): void;
  onThemePaletteChange(palette: ThemePalette): void;
}) {
  const toast = useToast();
  const themePageMountedRef = useRef(false);
  const themePersistTicketRef = useRef(0);

  useEffect(() => {
    themePageMountedRef.current = true;
    return () => {
      themePageMountedRef.current = false;
      themePersistTicketRef.current += 1;
    };
  }, []);

  async function persistAppearance(patch: NonNullable<Parameters<typeof window.maka.settings.update>[0]['appearance']>) {
    const ticket = ++themePersistTicketRef.current;
    try {
      await props.onUpdate({ appearance: patch });
    } catch (error) {
      if (themePageMountedRef.current && ticket === themePersistTicketRef.current) {
        toast.error('保存外观设置失败', settingsActionErrorMessage(error));
      }
    }
  }

  async function setTheme(next: ThemePreference) {
    // Apply immediately for instant feedback, then persist. If persistence
    // fails the visual stays — the next app start will re-read whatever
    // landed on disk.
    props.onThemeChange(next);
    await persistAppearance({ theme: next });
  }

  // PR-THEME-PRODUCT-PALETTES-0 (WAWQAQ msg `4472ee95`) + PR-THEME-APPLY-
  // AND-DONE-POLISH-0 (WAWQAQ msg `dec85e5b`): apply the palette
  // synchronously on click for instant feedback, then persist. Same
  // pattern as setTheme above. The original comment claimed
  // the IPC round-trip would re-apply on its own, but main.tsx had no
  // listener for palette changes — only ran applyThemePalette once at
  // mount — so switches were invisible until the next app start.
  const currentPalette: ThemePalette = props.themePalette;
  async function setPalette(next: ThemePalette) {
    props.onThemePaletteChange(next);
    await persistAppearance({ palette: next });
  }

  return (
    <div className="settingsStructuredPage">
      <h3 className="settingsSubheading">主题</h3>
      <ChoiceCardGroup
        className="settingsThemeOptions settingsThemeOptionsPreview"
        aria-label="主题"
        value={props.themePref}
        onValueChange={(next) => void setTheme(next as typeof props.themePref)}
      >
        {THEME_OPTIONS.map((option) => (
          // Base UI Radio.Root via ChoiceCard primitive (Round C,
          // PR round-c-choice-card-primitive). Keyboard arrow nav,
          // focus management, and `data-checked` are owned by the
          // primitive; the card chrome stays in `.settingsThemeOption*`
          // CSS so the regression test that catches `<Button>` shrinking
          // the card to a 36px black pill is no longer needed.
          <ChoiceCard
            key={option.value}
            value={option.value}
            className="settingsThemeOption settingsThemeOptionPreview"
          >
            <ThemePreviewMock variant={option.value} />
            <span className="settingsThemeLabel">
              <strong>{option.label}</strong>
              <small>{option.help}</small>
            </span>
          </ChoiceCard>
        ))}
      </ChoiceCardGroup>

      <h3 className="settingsSubheading">调色板</h3>
      {/* PR-PALETTE-PICKER-GROUPS-0: 11 palettes in a flat grid is
          cramped. Split into 编辑器主题 (default + 4 community editor
          themes) and 产品色调 (6 product accents) so the picker is
          easier to scan. Each subgroup is its own radiogroup so
          arrow-key navigation stays scoped. */}
      {PALETTE_GROUPS.map((group) => (
        <div key={group.id} className="settingsPaletteGroup">
          <h4 className="settingsPaletteGroupHeading">{group.label}</h4>
          <ChoiceCardGroup
            className="settingsThemeOptions settingsPaletteOptions"
            aria-label={group.label}
            value={currentPalette}
            onValueChange={(next) => void setPalette(next as ThemePalette)}
          >
            {group.palettes.map((palette) => (
              <ChoiceCard
                key={palette}
                value={palette}
                data-palette={palette}
                className="settingsThemeOption settingsPaletteOption"
              >
                <span className={`settingsPaletteSwatch settingsPaletteSwatch-${palette}`} aria-hidden="true" />
                <span className="settingsThemeLabel">
                  <strong>{PALETTE_LABEL[palette]}</strong>
                  <small>{PALETTE_HELP[palette]}</small>
                </span>
              </ChoiceCard>
            ))}
          </ChoiceCardGroup>
        </div>
      ))}

      <p className="settingsHelpText">
        切换会立即生效，并保存在本地外观设置里下次启动延续。通知统一显示在屏幕右下角。
      </p>
    </div>
  );
}
