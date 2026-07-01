import type { AppSettings, UpdateAppSettingsInput } from '@maka/core';
import {
  NETWORK_DEFAULTS,
  applySensitivePatch,
  maskSensitive,
  type NetworkSettings as ContractNetworkSettings,
  type ProxySettings,
} from '@maka/core/settings/network-settings';

type StoredNetworkSettings = AppSettings['network'];

export function toContractNetworkSettings(network: StoredNetworkSettings): ContractNetworkSettings {
  const proxy = network.proxy;
  return {
    ...NETWORK_DEFAULTS,
    proxy: {
      ...NETWORK_DEFAULTS.proxy,
      enabled: proxy.enabled,
      type: proxy.protocol,
      host: proxy.host,
      port: proxy.port,
      username: proxy.authEnabled && proxy.username ? proxy.username : undefined,
      password: proxy.authEnabled && proxy.password ? proxy.password : undefined,
      bypassList: proxy.bypassList.length > 0 ? proxy.bypassList : NETWORK_DEFAULTS.proxy.bypassList,
    },
  };
}

export function toAppNetworkPatch(network: ContractNetworkSettings): NonNullable<UpdateAppSettingsInput['network']> {
  return {
    proxy: {
      enabled: network.proxy.enabled,
      protocol: network.proxy.type,
      host: network.proxy.host,
      port: network.proxy.port,
      authEnabled: Boolean(network.proxy.username || network.proxy.password),
      username: network.proxy.username ?? '',
      password: typeof network.proxy.password === 'string' ? network.proxy.password : '',
      bypassList: network.proxy.bypassList,
    },
  };
}

export function applyNetworkPatch(
  prev: ContractNetworkSettings,
  patch: Partial<ContractNetworkSettings>,
): ContractNetworkSettings {
  const proxyPatch: Partial<ProxySettings> = patch.proxy ?? {};
  const nextProxy: ProxySettings = {
    ...prev.proxy,
    ...stripUndefined(proxyPatch),
    password: applySensitivePatch(
      typeof prev.proxy.password === 'string' ? prev.proxy.password : undefined,
      proxyPatch.password,
    ),
    bypassList: Array.isArray(proxyPatch.bypassList) ? proxyPatch.bypassList : prev.proxy.bypassList,
  };
  return {
    ...prev,
    ...stripUndefined(patch),
    proxy: nextProxy,
  };
}

export function maskNetworkSettings(settings: ContractNetworkSettings): ContractNetworkSettings {
  return {
    ...settings,
    proxy: {
      ...settings.proxy,
      password: maskSensitive(typeof settings.proxy.password === 'string' ? settings.proxy.password : undefined),
    },
  };
}

function stripUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}
