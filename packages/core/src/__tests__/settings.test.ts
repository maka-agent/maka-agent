import { describe, test } from 'node:test';
import { expect } from '../test-helpers.js';
import {
  THEME_PALETTES,
  TOAST_POSITIONS,
  createDefaultBotChannel,
  createDefaultSettings,
  isThemePalette,
  isToastPosition,
  mergeSettings,
  normalizeSettings,
} from '../settings.js';

describe('bot readiness settings contract', () => {
  test('default bot channels are scaffolded, not operational', () => {
    const channel = createDefaultBotChannel('telegram');

    expect(channel.connected).toBe(false);
    expect(channel.readiness).toBe('scaffolded');
  });

  test('normalizes legacy connected boolean to credentials_valid, not operational', () => {
    const legacy = createDefaultSettings();
    const telegram = legacy.botChat.channels.telegram as Partial<typeof legacy.botChat.channels.telegram>;
    delete telegram.readiness;
    legacy.botChat.channels.telegram.connected = true;
    legacy.botChat.channels.telegram.enabled = true;
    legacy.botChat.channels.telegram.token = 'telegram-token';

    const normalized = normalizeSettings(legacy);

    expect(normalized.botChat.channels.telegram.connected).toBe(true);
    expect(normalized.botChat.channels.telegram.readiness).toBe('credentials_valid');
  });

  test('does not treat non-boolean legacy connected values as credentials_valid', () => {
    const legacy = createDefaultSettings() as unknown as {
      botChat: { channels: { telegram: { connected: unknown; readiness?: unknown; enabled: boolean; token: string } } };
    };
    delete legacy.botChat.channels.telegram.readiness;
    legacy.botChat.channels.telegram.connected = 'true';
    legacy.botChat.channels.telegram.enabled = true;
    legacy.botChat.channels.telegram.token = 'telegram-token';

    const normalized = normalizeSettings(legacy);

    expect(normalized.botChat.channels.telegram.connected).toBe(false);
    expect(normalized.botChat.channels.telegram.readiness).toBe('configured');
  });

  test('normalizes enabled configured channels to configured, not operational', () => {
    const legacy = createDefaultSettings();
    const discord = legacy.botChat.channels.discord as Partial<typeof legacy.botChat.channels.discord>;
    delete discord.readiness;
    legacy.botChat.channels.discord.enabled = true;
    legacy.botChat.channels.discord.token = 'discord-token';

    const normalized = normalizeSettings(legacy);

    expect(normalized.botChat.channels.discord.readiness).toBe('configured');
  });

  /*
   * PR-HEALTH-1 (xuan msg `e4887ffd`, I1) — write-path single-authority
   * gate: persisted `readiness` must be coerced to be consistent with
   * current credential state. Locks F1 / F3 from the audit catalog
   * (`notes/pr-health-0-audit-report.md`).
   *
   * Without this gate, a `mergeSettings({channels:{telegram:{token:''}}})`
   * over `{readiness:'credentials_valid', token:'X'}` would persist
   * stale `'credentials_valid'` even though credentials no longer
   * exist. Capability snapshot → Health Center then surfaces a
   * "configured / verified" UI for a channel with zero credentials.
   */
  describe('I1 — write-path coerces stale credential-claiming readiness (F1 / F3)', () => {
    test('F1: persisted credentials_valid + token cleared → downgrades to scaffolded', () => {
      const legacy = createDefaultSettings();
      legacy.botChat.channels.telegram.enabled = true;
      legacy.botChat.channels.telegram.token = '';
      legacy.botChat.channels.telegram.appId = undefined;
      legacy.botChat.channels.telegram.appSecret = undefined;
      // Simulate stale persisted state from a previous credential-valid run.
      legacy.botChat.channels.telegram.readiness = 'credentials_valid';

      const normalized = normalizeSettings(legacy);

      expect(normalized.botChat.channels.telegram.readiness).toBe('scaffolded');
    });

    test('F1b: persisted operational + token cleared → downgrades to scaffolded', () => {
      const legacy = createDefaultSettings();
      legacy.botChat.channels.feishu.enabled = true;
      legacy.botChat.channels.feishu.token = '';
      legacy.botChat.channels.feishu.appId = undefined;
      legacy.botChat.channels.feishu.appSecret = undefined;
      legacy.botChat.channels.feishu.readiness = 'operational';

      const normalized = normalizeSettings(legacy);

      expect(normalized.botChat.channels.feishu.readiness).toBe('scaffolded');
    });

    test('F1c: persisted degraded + token cleared → downgrades to scaffolded', () => {
      const legacy = createDefaultSettings();
      legacy.botChat.channels.discord.enabled = true;
      legacy.botChat.channels.discord.token = '';
      legacy.botChat.channels.discord.appId = undefined;
      legacy.botChat.channels.discord.appSecret = undefined;
      legacy.botChat.channels.discord.readiness = 'degraded';

      const normalized = normalizeSettings(legacy);

      expect(normalized.botChat.channels.discord.readiness).toBe('scaffolded');
    });

    test('F1d: persisted configured + token cleared → downgrades to scaffolded', () => {
      const legacy = createDefaultSettings();
      legacy.botChat.channels.wecom.enabled = true;
      legacy.botChat.channels.wecom.token = '';
      legacy.botChat.channels.wecom.appId = undefined;
      legacy.botChat.channels.wecom.appSecret = undefined;
      legacy.botChat.channels.wecom.readiness = 'configured';

      const normalized = normalizeSettings(legacy);

      expect(normalized.botChat.channels.wecom.readiness).toBe('scaffolded');
    });

    test('F1e: appId-only credentials keep credential-claiming readiness', () => {
      // The credential trio is `token` OR `appId` OR `appSecret`. Any one
      // present is enough to keep a credential-claiming readiness.
      const legacy = createDefaultSettings();
      legacy.botChat.channels.feishu.enabled = true;
      legacy.botChat.channels.feishu.token = '';
      legacy.botChat.channels.feishu.appId = 'fei-app-id';
      legacy.botChat.channels.feishu.appSecret = undefined;
      legacy.botChat.channels.feishu.readiness = 'credentials_valid';

      const normalized = normalizeSettings(legacy);

      expect(normalized.botChat.channels.feishu.readiness).toBe('credentials_valid');
    });

    test('F1f: appSecret-only credentials keep credential-claiming readiness', () => {
      const legacy = createDefaultSettings();
      legacy.botChat.channels.feishu.enabled = true;
      legacy.botChat.channels.feishu.token = '';
      legacy.botChat.channels.feishu.appId = undefined;
      legacy.botChat.channels.feishu.appSecret = 'fei-app-secret';
      legacy.botChat.channels.feishu.readiness = 'credentials_valid';

      const normalized = normalizeSettings(legacy);

      expect(normalized.botChat.channels.feishu.readiness).toBe('credentials_valid');
    });

    test('F3: mergeSettings clearing token over operational state then normalize → scaffolded', () => {
      // End-to-end flow: existing settings have a credential-valid channel;
      // user issues a settings update that clears the token. The merge +
      // normalize pipeline must produce a state without the stale
      // credential claim.
      const current = createDefaultSettings();
      current.botChat.channels.telegram.enabled = true;
      current.botChat.channels.telegram.token = 'live-token';
      current.botChat.channels.telegram.readiness = 'operational';

      const merged = mergeSettings(current, {
        botChat: {
          channels: {
            telegram: { token: '' },
          },
        },
      });
      const normalized = normalizeSettings(merged);

      expect(normalized.botChat.channels.telegram.token).toBe('');
      expect(normalized.botChat.channels.telegram.readiness).toBe('scaffolded');
    });

    test('F3b: coerce never UPGRADES scaffolded → configured (write-path stays down-only)', () => {
      // Even when credentials are present, the coerce path does NOT
      // promote a persisted 'scaffolded' to 'configured' — that is the
      // live bridge / explicit-readiness write path's responsibility.
      const legacy = createDefaultSettings();
      legacy.botChat.channels.discord.enabled = true;
      legacy.botChat.channels.discord.token = 'discord-token';
      // Explicit persisted scaffolded should survive coerce (no upgrade).
      legacy.botChat.channels.discord.readiness = 'scaffolded';

      const normalized = normalizeSettings(legacy);

      expect(normalized.botChat.channels.discord.readiness).toBe('scaffolded');
    });

    test('non-credential-claiming readiness (unscaffolded / scaffolded) passes through unchanged', () => {
      const legacy = createDefaultSettings();
      legacy.botChat.channels.qq.enabled = false;
      legacy.botChat.channels.qq.token = '';
      legacy.botChat.channels.qq.readiness = 'unscaffolded';

      const normalized = normalizeSettings(legacy);

      expect(normalized.botChat.channels.qq.readiness).toBe('unscaffolded');
    });
  });
});

describe('theme palette settings contract (PR-UI-D1, @kenji msg 68bf2b13)', () => {
  test('THEME_PALETTES allowlist exposes 7 palettes including default + product borrows', () => {
    // PR-THEME-PRODUCT-PALETTES-0 (WAWQAQ msg `4472ee95`): added
    // `alma` and `niuma` palettes alongside the original 5 editor-style
    // palettes. Update this pin when the palette set legitimately changes.
    expect(THEME_PALETTES.length).toBe(7);
    expect(THEME_PALETTES.includes('default')).toBe(true);
    expect(THEME_PALETTES.includes('onedark')).toBe(true);
    expect(THEME_PALETTES.includes('catppuccin-mocha')).toBe(true);
    expect(THEME_PALETTES.includes('tokyo-night')).toBe(true);
    expect(THEME_PALETTES.includes('nord')).toBe(true);
    expect(THEME_PALETTES.includes('alma')).toBe(true);
    expect(THEME_PALETTES.includes('niuma')).toBe(true);
  });

  test('isThemePalette accepts allowlist values, rejects everything else', () => {
    for (const palette of THEME_PALETTES) {
      expect(isThemePalette(palette)).toBe(true);
    }
    expect(isThemePalette('evil-unknown')).toBe(false);
    expect(isThemePalette('')).toBe(false);
    expect(isThemePalette(undefined)).toBe(false);
    expect(isThemePalette(null)).toBe(false);
    expect(isThemePalette(42)).toBe(false);
    expect(isThemePalette({ palette: 'onedark' })).toBe(false);
    expect(isThemePalette([])).toBe(false);
    // Case-sensitive: TypeScript union is exact-case, runtime guard must agree.
    expect(isThemePalette('Default')).toBe(false);
    expect(isThemePalette('ONEDARK')).toBe(false);
  });

  test('createDefaultSettings seeds palette as `default`', () => {
    const defaults = createDefaultSettings();
    expect(defaults.appearance.palette).toBe('default');
  });

  test('migration: settings.json without `palette` field loads with palette=default', () => {
    // Older settings.json that pre-dates PR-UI-D1 will not have
    // `appearance.palette`. normalizeSettings must seed `default`
    // without touching theme/density.
    const legacy = {
      appearance: {
        theme: 'dark' as const,
        density: 'compact' as const,
        // no palette field
      },
    };
    const normalized = normalizeSettings(legacy);
    expect(normalized.appearance.palette).toBe('default');
    expect(normalized.appearance.theme).toBe('dark');
    expect(normalized.appearance.density).toBe('compact');
  });

  test('fail-closed: unknown palette string falls back to default', () => {
    const malformed = {
      appearance: {
        theme: 'auto' as const,
        density: 'comfortable' as const,
        palette: 'evil-unknown',
      },
    };
    const normalized = normalizeSettings(malformed);
    expect(normalized.appearance.palette).toBe('default');
  });

  test('fail-closed: non-string palette falls back to default', () => {
    for (const bad of [42, true, null, {}, []]) {
      const malformed = {
        appearance: {
          theme: 'auto' as const,
          density: 'comfortable' as const,
          palette: bad,
        },
      };
      const normalized = normalizeSettings(malformed);
      expect(normalized.appearance.palette).toBe('default');
    }
  });

  test('valid palette survives normalize untouched', () => {
    for (const palette of THEME_PALETTES) {
      const input = {
        appearance: {
          theme: 'auto' as const,
          density: 'comfortable' as const,
          palette,
        },
      };
      const normalized = normalizeSettings(input);
      expect(normalized.appearance.palette).toBe(palette);
    }
  });

  test('palette validation does NOT silently reset unrelated settings fields', () => {
    // @kenji gate: "no silent reset of unrelated settings". Even with
    // a malformed palette, all other fields (theme, density,
    // personalization, network, bot channels) must keep their values.
    const input = {
      appearance: {
        theme: 'dark' as const,
        density: 'spacious' as const,
        palette: 'evil-unknown',
      },
      personalization: {
        displayName: 'Yuejing',
        assistantTone: 'concise',
      },
      network: {
        proxy: {
          enabled: true,
          protocol: 'http' as const,
          host: '127.0.0.1',
          port: 7890,
          authEnabled: false,
          username: '',
          password: '',
          bypassList: ['localhost'],
          autoBypassDomains: [],
        },
      },
    };
    const normalized = normalizeSettings(input);
    expect(normalized.appearance.palette).toBe('default');
    expect(normalized.appearance.theme).toBe('dark');
    expect(normalized.appearance.density).toBe('spacious');
    expect(normalized.personalization.displayName).toBe('Yuejing');
    expect(normalized.personalization.assistantTone).toBe('concise');
    expect(normalized.network.proxy.enabled).toBe(true);
    expect(normalized.network.proxy.host).toBe('127.0.0.1');
    expect(normalized.network.proxy.port).toBe(7890);
  });

  test('mergeSettings carries palette through patch surface', () => {
    const current = createDefaultSettings();
    const patched = mergeSettings(current, { appearance: { palette: 'onedark' } });
    expect(patched.appearance.palette).toBe('onedark');
    expect(patched.appearance.theme).toBe('auto'); // unchanged
    expect(patched.appearance.density).toBe('comfortable'); // unchanged
  });

  test('mergeSettings + normalizeSettings: patching with unknown palette ends up at default', () => {
    // Real-world: a UI might submit a misconfigured palette via the
    // patch surface. The normalize pass after mergeSettings catches it.
    const current = createDefaultSettings();
    const patched = mergeSettings(current, {
      appearance: { palette: 'evil-unknown' as 'default' /* coerced for test */ },
    });
    const normalized = normalizeSettings(patched);
    expect(normalized.appearance.palette).toBe('default');
  });
});

describe('toast position settings contract (PR-UI-D2, @kenji msg eef6f7a5)', () => {
  test('TOAST_POSITIONS allowlist has 6 entries (grid corners)', () => {
    expect(TOAST_POSITIONS.length).toBe(6);
    expect(TOAST_POSITIONS.includes('top-left')).toBe(true);
    expect(TOAST_POSITIONS.includes('top-center')).toBe(true);
    expect(TOAST_POSITIONS.includes('top-right')).toBe(true);
    expect(TOAST_POSITIONS.includes('bottom-left')).toBe(true);
    expect(TOAST_POSITIONS.includes('bottom-center')).toBe(true);
    expect(TOAST_POSITIONS.includes('bottom-right')).toBe(true);
  });

  test('isToastPosition accepts allowlist values, rejects everything else', () => {
    for (const pos of TOAST_POSITIONS) {
      expect(isToastPosition(pos)).toBe(true);
    }
    expect(isToastPosition('evil-corner')).toBe(false);
    expect(isToastPosition('')).toBe(false);
    expect(isToastPosition(undefined)).toBe(false);
    expect(isToastPosition(null)).toBe(false);
    expect(isToastPosition(42)).toBe(false);
    expect(isToastPosition({ toastPosition: 'top-left' })).toBe(false);
    expect(isToastPosition([])).toBe(false);
    // Case-sensitive: TypeScript union is exact-case, runtime guard must agree.
    expect(isToastPosition('Top-Left')).toBe(false);
    expect(isToastPosition('TOP-RIGHT')).toBe(false);
    // No abbreviations / no synonyms.
    expect(isToastPosition('top')).toBe(false);
    expect(isToastPosition('center')).toBe(false);
    expect(isToastPosition('topleft')).toBe(false);
  });

  test('createDefaultSettings seeds toastPosition as `bottom-right`', () => {
    const defaults = createDefaultSettings();
    expect(defaults.appearance.toastPosition).toBe('bottom-right');
  });

  test('migration: settings.json without `toastPosition` field loads with bottom-right', () => {
    // Pre-PR-UI-D2 settings.json had no `appearance.toastPosition`.
    // normalizeSettings must seed `bottom-right` (preserves v1
    // behavior) without touching theme/density/palette.
    const legacy = {
      appearance: {
        theme: 'dark' as const,
        density: 'compact' as const,
        palette: 'onedark' as const,
        // no toastPosition field
      },
    };
    const normalized = normalizeSettings(legacy);
    expect(normalized.appearance.toastPosition).toBe('bottom-right');
    expect(normalized.appearance.theme).toBe('dark');
    expect(normalized.appearance.density).toBe('compact');
    expect(normalized.appearance.palette).toBe('onedark');
  });

  test('fail-closed: unknown toastPosition string falls back to bottom-right', () => {
    const malformed = {
      appearance: {
        theme: 'auto' as const,
        density: 'comfortable' as const,
        toastPosition: 'evil-corner',
      },
    };
    const normalized = normalizeSettings(malformed);
    expect(normalized.appearance.toastPosition).toBe('bottom-right');
  });

  test('fail-closed: non-string toastPosition falls back to bottom-right', () => {
    for (const bad of [42, true, null, {}, []]) {
      const malformed = {
        appearance: {
          theme: 'auto' as const,
          density: 'comfortable' as const,
          toastPosition: bad,
        },
      };
      const normalized = normalizeSettings(malformed);
      expect(normalized.appearance.toastPosition).toBe('bottom-right');
    }
  });

  test('valid toastPosition survives normalize untouched', () => {
    for (const pos of TOAST_POSITIONS) {
      const input = {
        appearance: {
          theme: 'auto' as const,
          density: 'comfortable' as const,
          toastPosition: pos,
        },
      };
      const normalized = normalizeSettings(input);
      expect(normalized.appearance.toastPosition).toBe(pos);
    }
  });

  test('toastPosition validation does NOT silently reset unrelated settings fields', () => {
    // @kenji gate: "no silent reset of unrelated settings". Even with
    // a malformed toastPosition, all other fields (theme, density,
    // palette, personalization, network) must keep their values.
    const input = {
      appearance: {
        theme: 'dark' as const,
        density: 'spacious' as const,
        palette: 'tokyo-night' as const,
        toastPosition: 'evil-corner',
      },
      personalization: {
        displayName: 'Yuejing',
        assistantTone: 'concise',
      },
    };
    const normalized = normalizeSettings(input);
    expect(normalized.appearance.toastPosition).toBe('bottom-right');
    expect(normalized.appearance.theme).toBe('dark');
    expect(normalized.appearance.density).toBe('spacious');
    expect(normalized.appearance.palette).toBe('tokyo-night');
    expect(normalized.personalization.displayName).toBe('Yuejing');
    expect(normalized.personalization.assistantTone).toBe('concise');
  });

  test('mergeSettings carries toastPosition through patch surface', () => {
    const current = createDefaultSettings();
    const patched = mergeSettings(current, { appearance: { toastPosition: 'top-center' } });
    expect(patched.appearance.toastPosition).toBe('top-center');
    expect(patched.appearance.theme).toBe('auto'); // unchanged
    expect(patched.appearance.palette).toBe('default'); // unchanged
  });

  test('mergeSettings + normalizeSettings: patching with unknown toastPosition ends up at default', () => {
    const current = createDefaultSettings();
    const patched = mergeSettings(current, {
      appearance: { toastPosition: 'evil-corner' as 'bottom-right' /* coerced for test */ },
    });
    const normalized = normalizeSettings(patched);
    expect(normalized.appearance.toastPosition).toBe('bottom-right');
  });

  test('palette + toastPosition both malformed → both fall back independently to defaults', () => {
    // Cross-contract sanity: D1 + D2 normalizers don't interfere.
    const input = {
      appearance: {
        theme: 'auto' as const,
        density: 'comfortable' as const,
        palette: 'evil-unknown',
        toastPosition: 'evil-corner',
      },
    };
    const normalized = normalizeSettings(input);
    expect(normalized.appearance.palette).toBe('default');
    expect(normalized.appearance.toastPosition).toBe('bottom-right');
  });
});

describe('open gateway settings contract', () => {
  test('createDefaultSettings seeds gateway disabled on localhost with no token', () => {
    const defaults = createDefaultSettings();

    expect(defaults.openGateway.enabled).toBe(false);
    expect(defaults.openGateway.host).toBe('127.0.0.1');
    expect(defaults.openGateway.port).toBe(3939);
    expect(defaults.openGateway.token).toBe('');
  });

  test('normalizes malformed gateway fields fail-closed', () => {
    const normalized = normalizeSettings({
      openGateway: {
        enabled: 'yes',
        host: '::',
        port: 80,
        token: 'x'.repeat(257),
      },
    });

    expect(normalized.openGateway.enabled).toBe(false);
    expect(normalized.openGateway.host).toBe('127.0.0.1');
    expect(normalized.openGateway.port).toBe(3939);
    expect(normalized.openGateway.token).toBe('');
  });

  test('normalizes valid gateway settings without resetting unrelated fields', () => {
    const normalized = normalizeSettings({
      appearance: {
        theme: 'dark',
        density: 'compact',
      },
      openGateway: {
        enabled: true,
        host: '0.0.0.0',
        port: 4939,
        token: 'local-dev-token',
      },
    });

    expect(normalized.appearance.theme).toBe('dark');
    expect(normalized.appearance.density).toBe('compact');
    expect(normalized.openGateway.enabled).toBe(true);
    expect(normalized.openGateway.host).toBe('0.0.0.0');
    expect(normalized.openGateway.port).toBe(4939);
    expect(normalized.openGateway.token).toBe('local-dev-token');
  });

  test('mergeSettings carries partial gateway patches through update surface', () => {
    const current = createDefaultSettings();
    current.openGateway.token = 'stored-token';

    const patched = mergeSettings(current, {
      openGateway: {
        enabled: true,
        port: 4940,
      },
    });

    expect(patched.openGateway.enabled).toBe(true);
    expect(patched.openGateway.host).toBe('127.0.0.1');
    expect(patched.openGateway.port).toBe(4940);
    expect(patched.openGateway.token).toBe('stored-token');
  });

  test('web search credential status persists independently from masked key round-trips', () => {
    const current = mergeSettings(createDefaultSettings(), {
      webSearch: {
        providers: {
          tavily: {
            apiKey: 'stored-key',
            credentialStatus: 'valid',
            credentialCheckedAt: '2026-05-29T00:00:00.000Z',
          },
        },
      },
    });

    const patched = mergeSettings(current, {
      webSearch: {
        providers: {
          tavily: {
            apiKey: '••••••',
          },
        },
      },
    });

    expect(patched.webSearch.providers.tavily.apiKey).toBe('stored-key');
    expect(patched.webSearch.providers.tavily.credentialVersion).toBe(1);
    expect(patched.webSearch.providers.tavily.credentialStatus).toBe('valid');
    expect(patched.webSearch.providers.tavily.credentialCheckedAt).toBe('2026-05-29T00:00:00.000Z');
  });

  test('web search credential status resets when the saved key changes', () => {
    const current = mergeSettings(createDefaultSettings(), {
      webSearch: {
        providers: {
          tavily: {
            apiKey: 'old-key',
            credentialStatus: 'valid',
            credentialCheckedAt: '2026-05-29T00:00:00.000Z',
          },
        },
      },
    });

    const patched = mergeSettings(current, {
      webSearch: {
        providers: {
          tavily: {
            apiKey: 'new-key',
          },
        },
      },
    });

    expect(patched.webSearch.providers.tavily.apiKey).toBe('new-key');
    expect(patched.webSearch.providers.tavily.credentialVersion).toBe(2);
    expect(patched.webSearch.providers.tavily.credentialStatus).toBe('untested');
    expect(patched.webSearch.providers.tavily.credentialCheckedAt).toBeUndefined();
  });

  test('web search credential test result is ignored when it targets a stale key version', () => {
    const current = mergeSettings(createDefaultSettings(), {
      webSearch: {
        providers: {
          tavily: {
            apiKey: 'current-key',
          },
        },
      },
    });
    const updatedKey = mergeSettings(current, {
      webSearch: {
        providers: {
          tavily: {
            apiKey: 'newer-key',
          },
        },
      },
    });

    const staleResult = mergeSettings(updatedKey, {
      webSearch: {
        providers: {
          tavily: {
            credentialVersion: current.webSearch.providers.tavily.credentialVersion,
            credentialStatus: 'invalid_credentials',
            credentialCheckedAt: '2026-05-29T00:00:00.000Z',
          },
        },
      },
    });
    const freshResult = mergeSettings(updatedKey, {
      webSearch: {
        providers: {
          tavily: {
            credentialVersion: updatedKey.webSearch.providers.tavily.credentialVersion,
            credentialStatus: 'valid',
            credentialCheckedAt: '2026-05-29T00:01:00.000Z',
          },
        },
      },
    });

    expect(updatedKey.webSearch.providers.tavily.credentialVersion).toBe(2);
    expect(staleResult.webSearch.providers.tavily.credentialStatus).toBe('untested');
    expect(staleResult.webSearch.providers.tavily.credentialCheckedAt).toBeUndefined();
    expect(freshResult.webSearch.providers.tavily.credentialStatus).toBe('valid');
    expect(freshResult.webSearch.providers.tavily.credentialCheckedAt).toBe('2026-05-29T00:01:00.000Z');
  });

  test('workspace instructions are visible settings and default to enabled', () => {
    const defaults = createDefaultSettings();

    expect(defaults.workspaceInstructions.enabled).toBe(true);
    expect(normalizeSettings({ workspaceInstructions: { enabled: false } }).workspaceInstructions.enabled).toBe(false);
    expect(normalizeSettings({ workspaceInstructions: { enabled: 'yes' } }).workspaceInstructions.enabled).toBe(true);
  });

  test('mergeSettings carries workspace instruction toggle through update surface', () => {
    const patched = mergeSettings(createDefaultSettings(), {
      workspaceInstructions: {
        enabled: false,
      },
    });

    expect(patched.workspaceInstructions.enabled).toBe(false);
  });

  // PR-BOT-USER-ALLOWLIST-0 — settings shape normalization. The runtime gate
  // (isAllowedUser in @maka/runtime/bots/simple-bridge) is covered separately.
  // These tests exercise `normalizeSettings`, which is the boundary that
  // sees on-disk / cross-IPC payloads. `mergeSettings` itself trusts the
  // in-memory shape because the entry from disk went through normalize.
  test('default channel has no allowlist (V0.1 unrestricted)', () => {
    const channel = createDefaultBotChannel('telegram');
    expect(channel.allowedUserIds).toBeUndefined();
  });

  test('normalizes a valid allowlist and trims/dedups entries', () => {
    const legacy = createDefaultSettings() as unknown as {
      botChat: { channels: { telegram: { allowedUserIds?: unknown } } };
    };
    legacy.botChat.channels.telegram.allowedUserIds = ['  123  ', '456', '123', '', '  '];

    const normalized = normalizeSettings(legacy);

    expect(normalized.botChat.channels.telegram.allowedUserIds).toEqual(['123', '456']);
  });

  test('drops non-string entries from a persisted allowlist', () => {
    const legacy = createDefaultSettings() as unknown as {
      botChat: { channels: { telegram: { allowedUserIds?: unknown } } };
    };
    legacy.botChat.channels.telegram.allowedUserIds = ['123', 456, null, '789'];

    const normalized = normalizeSettings(legacy);

    expect(normalized.botChat.channels.telegram.allowedUserIds).toEqual(['123', '789']);
  });

  test('caps the persisted allowlist at 50 entries', () => {
    const overflow = Array.from({ length: 80 }, (_, i) => `user-${i}`);
    const legacy = createDefaultSettings() as unknown as {
      botChat: { channels: { telegram: { allowedUserIds?: unknown } } };
    };
    legacy.botChat.channels.telegram.allowedUserIds = overflow;

    const normalized = normalizeSettings(legacy);

    const list = normalized.botChat.channels.telegram.allowedUserIds!;
    expect(list.length).toBe(50);
    expect(list[0]).toBe('user-0');
    expect(list[49]).toBe('user-49');
  });

  test('an empty / all-blank allowlist normalizes to undefined (no restriction)', () => {
    const legacy = createDefaultSettings() as unknown as {
      botChat: { channels: { telegram: { allowedUserIds?: unknown } } };
    };
    legacy.botChat.channels.telegram.allowedUserIds = ['', '  ', '\t'];

    const normalized = normalizeSettings(legacy);

    expect(normalized.botChat.channels.telegram.allowedUserIds).toBeUndefined();
  });

  test('non-array persisted allowlist normalizes to undefined fail-closed', () => {
    const legacy = createDefaultSettings() as unknown as {
      botChat: { channels: { telegram: { allowedUserIds?: unknown } } };
    };
    legacy.botChat.channels.telegram.allowedUserIds = 'not-an-array';

    const normalized = normalizeSettings(legacy);

    expect(normalized.botChat.channels.telegram.allowedUserIds).toBeUndefined();
  });

  // PR-BOT-USER-ALLOWLIST-UI-0 — mergeSettings normalize gate. The
  // renderer textarea-bound field hands us a dirty array on every save;
  // the IPC merge layer must trim/dedup/cap so the persisted shape
  // matches what `normalizeSettings` would have produced on cold load.
  test('mergeSettings trims and dedups when the patch explicitly sets allowedUserIds', () => {
    const updated = mergeSettings(createDefaultSettings(), {
      botChat: {
        channels: {
          telegram: { allowedUserIds: ['  123  ', '456', '123', ''] as unknown as string[] },
        },
      },
    });

    expect(updated.botChat.channels.telegram.allowedUserIds).toEqual(['123', '456']);
  });

  test('mergeSettings downgrades an all-blank patch to undefined (no restriction)', () => {
    const seeded = mergeSettings(createDefaultSettings(), {
      botChat: { channels: { telegram: { allowedUserIds: ['123'] } } },
    });
    expect(seeded.botChat.channels.telegram.allowedUserIds).toEqual(['123']);

    const cleared = mergeSettings(seeded, {
      botChat: { channels: { telegram: { allowedUserIds: ['', '  '] as string[] } } },
    });

    expect(cleared.botChat.channels.telegram.allowedUserIds).toBeUndefined();
  });

  test('mergeSettings leaves the allowlist untouched when an unrelated field is patched', () => {
    const seeded = mergeSettings(createDefaultSettings(), {
      botChat: { channels: { telegram: { allowedUserIds: ['123', '456'] } } },
    });

    const tokenPatched = mergeSettings(seeded, {
      botChat: { channels: { telegram: { token: 'tg-token', enabled: true } } },
    });

    expect(tokenPatched.botChat.channels.telegram.allowedUserIds).toEqual(['123', '456']);
  });
});
