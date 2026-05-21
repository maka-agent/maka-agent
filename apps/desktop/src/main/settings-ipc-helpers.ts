import type {
  AppSettings,
  BotProvider,
  SettingsTestResult,
  UpdateAppSettingsInput,
  UpdateAppSettingsResult,
} from '@maka/core';
import { generalizedErrorMessage } from '@maka/core';
import { SENSITIVE_PLACEHOLDER, maskSensitive } from '@maka/core/settings/network-settings';
import type { BotTestResult } from '@maka/runtime';
import { collectPersonalizationWarnings } from './personalization-prompt.js';

export function preserveSensitivePlaceholders(
  patch: UpdateAppSettingsInput,
  current: AppSettings,
): UpdateAppSettingsInput {
  const botChannels = patch.botChat?.channels
    ? Object.fromEntries(
        Object.entries(patch.botChat.channels).map(([provider, channelPatch]) => {
          const currentChannel = current.botChat.channels[provider as BotProvider];
          return [
            provider,
            {
              ...channelPatch,
              ...(channelPatch?.token === SENSITIVE_PLACEHOLDER ? { token: currentChannel.token } : {}),
              ...(channelPatch?.appSecret === SENSITIVE_PLACEHOLDER ? { appSecret: currentChannel.appSecret } : {}),
            },
          ];
        }),
      )
    : undefined;

  return {
    ...patch,
    ...(patch.network?.proxy?.password === SENSITIVE_PLACEHOLDER
      ? {
          network: {
            ...patch.network,
            proxy: {
              ...patch.network.proxy,
              password: current.network.proxy.password,
            },
          },
        }
      : {}),
    ...(botChannels
      ? {
          botChat: {
            ...patch.botChat,
            channels: botChannels,
          },
        }
      : {}),
  };
}

export function maskAppSettings(settings: AppSettings, revealPatch: UpdateAppSettingsInput = {}): AppSettings {
  return {
    ...settings,
    network: {
      ...settings.network,
      proxy: {
        ...settings.network.proxy,
        password: shouldReveal(revealPatch.network?.proxy?.password)
          ? settings.network.proxy.password
          : maskSensitive(settings.network.proxy.password) ?? '',
      },
    },
    botChat: {
      ...settings.botChat,
      channels: Object.fromEntries(
        Object.entries(settings.botChat.channels).map(([provider, channel]) => [
          provider,
          {
            ...channel,
            token: shouldReveal(revealPatch.botChat?.channels?.[provider as BotProvider]?.token)
              ? channel.token
              : maskSensitive(channel.token) ?? '',
            appSecret: shouldReveal(revealPatch.botChat?.channels?.[provider as BotProvider]?.appSecret)
              ? channel.appSecret
              : maskSensitive(channel.appSecret) ?? '',
          },
        ]),
      ) as AppSettings['botChat']['channels'],
    },
  };
}

export function buildSettingsUpdateResult(
  settings: AppSettings,
  patch: UpdateAppSettingsInput,
): UpdateAppSettingsResult {
  const personalization = collectPersonalizationWarnings(patch.personalization);
  return {
    settings: maskAppSettings(settings, patch),
    ...(personalization.length ? { warnings: { personalization } } : {}),
  };
}

function shouldReveal(value: string | undefined): boolean {
  return typeof value === 'string' && value.length > 0 && value !== SENSITIVE_PLACEHOLDER;
}

export function toSettingsTestResult(provider: BotProvider, result: BotTestResult): SettingsTestResult {
  return {
    ok: result.ok,
    message: result.ok
      ? `${provider} 连接测试成功${result.identity?.username ? `：${result.identity.username}` : ''}`
      : generalizedErrorMessage(result.error ?? '', `${provider} 连接测试失败`),
    details: {
      ...(result.identity ? { identity: result.identity } : {}),
      ...(result.capabilities ? { capabilities: result.capabilities } : {}),
      ...(result.hint ? { hint: result.hint } : {}),
    },
  };
}
