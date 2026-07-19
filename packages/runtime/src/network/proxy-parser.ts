import {
  PROXY_DEFAULTS,
  type ProxySettings,
  type ProxyType,
} from '@maka/core/settings/network-settings';

export function parseProxyConfig(input: unknown): ProxySettings {
  if (!input || typeof input !== 'object') return { ...PROXY_DEFAULTS };
  const value = input as Record<string, unknown>;
  const rawPort = typeof value.port === 'number' ? value.port : Number(value.port);
  const port =
    Number.isInteger(rawPort) && rawPort > 0 && rawPort <= 65_535 ? rawPort : PROXY_DEFAULTS.port;
  const typeRaw = value.type;
  const type: ProxyType = typeRaw === 'https' || typeRaw === 'socks5' ? typeRaw : 'http';

  return {
    enabled: Boolean(value.enabled),
    type,
    host: typeof value.host === 'string' ? value.host.trim() : '',
    port,
    username:
      typeof value.username === 'string' && value.username.length > 0 ? value.username : undefined,
    password:
      typeof value.password === 'string' && value.password.length > 0 ? value.password : undefined,
    bypassList: Array.isArray(value.bypassList)
      ? value.bypassList.filter(
          (entry): entry is string => typeof entry === 'string' && entry.trim().length > 0,
        )
      : [...PROXY_DEFAULTS.bypassList],
  };
}

export function buildProxyUrl(proxy: ProxySettings): string {
  const scheme = proxy.type === 'https' ? 'https' : 'http';
  const auth = proxy.username
    ? `${encodeURIComponent(proxy.username)}${
        proxy.password ? `:${encodeURIComponent(proxy.password)}` : ''
      }@`
    : '';
  return `${scheme}://${auth}${bracketIfIpv6(proxy.host)}:${proxy.port}`;
}

export function bracketIfIpv6(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}
