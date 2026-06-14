import { safeStorage } from 'electron';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { BotProvider } from '@maka/core';

type StoredCredentialKind =
  | 'apiKey'
  | 'oauthToken'
  | 'botToken'
  | 'botAppSecret'
  | 'proxyPassword'
  | 'gatewayToken'
  | 'tavilyApiKey';
export type CredentialKind =
  | 'api_key'
  | 'oauth_token'
  | 'bot_token'
  | 'app_secret'
  | 'proxy_password'
  | 'gateway_token'
  | 'tavily_api_key';

interface CredentialFile {
  values: Record<string, string>;
}

export interface CredentialStore {
  getSecret(slug: string, kind: CredentialKind): Promise<string | null>;
  setSecret(slug: string, kind: CredentialKind, value: string): Promise<void>;
  deleteSecret(slug: string, kind?: CredentialKind): Promise<void>;
  getBotToken(provider: BotProvider): Promise<string | null>;
  setBotToken(provider: BotProvider, token: string): Promise<void>;
  deleteBotToken(provider: BotProvider): Promise<void>;
  getBotAppSecret(provider: BotProvider): Promise<string | null>;
  setBotAppSecret(provider: BotProvider, secret: string): Promise<void>;
  deleteBotAppSecret(provider: BotProvider): Promise<void>;
  getProxyPassword(): Promise<string | null>;
  setProxyPassword(password: string): Promise<void>;
  deleteProxyPassword(): Promise<void>;
  getGatewayToken(): Promise<string | null>;
  setGatewayToken(token: string): Promise<void>;
  deleteGatewayToken(): Promise<void>;
  getTavilyApiKey(): Promise<string | null>;
  setTavilyApiKey(key: string): Promise<void>;
  deleteTavilyApiKey(): Promise<void>;
  getApiKey(slug: string): Promise<string | null>;
  getOAuthToken(slug: string): Promise<string | null>;
  setApiKey(slug: string, apiKey: string): Promise<void>;
  setOAuthToken(slug: string, token: string): Promise<void>;
  delete(slug: string): Promise<void>;
}

export function createSafeStorageCredentialStore(workspaceRoot: string): CredentialStore {
  return new SafeStorageCredentialStore(join(workspaceRoot, 'credentials.json'));
}

class SafeStorageCredentialStore implements CredentialStore {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  getSecret(slug: string, kind: CredentialKind): Promise<string | null> {
    return this.get(slug, toStoredKind(kind));
  }

  setSecret(slug: string, kind: CredentialKind, value: string): Promise<void> {
    return this.set(slug, toStoredKind(kind), value);
  }

  async deleteSecret(slug: string, kind?: CredentialKind): Promise<void> {
    if (!kind) {
      await this.delete(slug);
      return;
    }
    await this.withQueue(async () => {
      const file = await this.readUnlocked();
      delete file.values[this.key(slug, toStoredKind(kind))];
      await this.write(file);
    });
  }

  getBotToken(provider: BotProvider): Promise<string | null> {
    return this.get(botSecretSlug(provider), 'botToken');
  }

  setBotToken(provider: BotProvider, token: string): Promise<void> {
    return this.set(botSecretSlug(provider), 'botToken', token);
  }

  deleteBotToken(provider: BotProvider): Promise<void> {
    return this.deleteSecret(botSecretSlug(provider), 'bot_token');
  }

  getBotAppSecret(provider: BotProvider): Promise<string | null> {
    return this.get(botSecretSlug(provider), 'botAppSecret');
  }

  setBotAppSecret(provider: BotProvider, secret: string): Promise<void> {
    return this.set(botSecretSlug(provider), 'botAppSecret', secret);
  }

  deleteBotAppSecret(provider: BotProvider): Promise<void> {
    return this.deleteSecret(botSecretSlug(provider), 'app_secret');
  }

  getProxyPassword(): Promise<string | null> {
    return this.get(GLOBAL_PROXY_SECRET_SLUG, 'proxyPassword');
  }

  setProxyPassword(password: string): Promise<void> {
    return this.set(GLOBAL_PROXY_SECRET_SLUG, 'proxyPassword', password);
  }

  deleteProxyPassword(): Promise<void> {
    return this.deleteSecret(GLOBAL_PROXY_SECRET_SLUG, 'proxy_password');
  }

  getGatewayToken(): Promise<string | null> {
    return this.get(GLOBAL_GATEWAY_SECRET_SLUG, 'gatewayToken');
  }

  setGatewayToken(token: string): Promise<void> {
    return this.set(GLOBAL_GATEWAY_SECRET_SLUG, 'gatewayToken', token);
  }

  deleteGatewayToken(): Promise<void> {
    return this.deleteSecret(GLOBAL_GATEWAY_SECRET_SLUG, 'gateway_token');
  }

  getTavilyApiKey(): Promise<string | null> {
    return this.get(GLOBAL_TAVILY_SECRET_SLUG, 'tavilyApiKey');
  }

  setTavilyApiKey(key: string): Promise<void> {
    return this.set(GLOBAL_TAVILY_SECRET_SLUG, 'tavilyApiKey', key);
  }

  deleteTavilyApiKey(): Promise<void> {
    return this.deleteSecret(GLOBAL_TAVILY_SECRET_SLUG, 'tavily_api_key');
  }

  getApiKey(slug: string): Promise<string | null> {
    return this.get(slug, 'apiKey');
  }

  getOAuthToken(slug: string): Promise<string | null> {
    return this.get(slug, 'oauthToken');
  }

  setApiKey(slug: string, apiKey: string): Promise<void> {
    return this.set(slug, 'apiKey', apiKey);
  }

  setOAuthToken(slug: string, token: string): Promise<void> {
    return this.set(slug, 'oauthToken', token);
  }

  async delete(slug: string): Promise<void> {
    await this.withQueue(async () => {
      const file = await this.readUnlocked();
      for (const kind of STORED_CREDENTIAL_KINDS) {
        delete file.values[this.key(slug, kind)];
      }
      await this.write(file);
    });
  }

  private async get(slug: string, kind: StoredCredentialKind): Promise<string | null> {
    const encrypted = (await this.readUnlocked()).values[this.key(slug, kind)];
    if (!encrypted) return null;
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
  }

  private async set(slug: string, kind: StoredCredentialKind, value: string): Promise<void> {
    await this.withQueue(async () => {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('Electron safeStorage encryption is not available on this system.');
      }
      const file = await this.readUnlocked();
      file.values[this.key(slug, kind)] = safeStorage.encryptString(value).toString('base64');
      await this.write(file);
    });
  }

  private key(slug: string, kind: StoredCredentialKind): string {
    return `${slug}:${kind}`;
  }

  private async readUnlocked(): Promise<CredentialFile> {
    try {
      return JSON.parse(await readFile(this.path, 'utf8')) as CredentialFile;
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return { values: {} };
      throw error;
    }
  }

  private async write(file: CredentialFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tempPath = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, JSON.stringify(file, null, 2) + '\n', 'utf8');
    await rename(tempPath, this.path);
  }

  private withQueue(operation: () => Promise<void>): Promise<void> {
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => {});
    return next;
  }
}

const STORED_CREDENTIAL_KINDS = [
  'apiKey',
  'oauthToken',
  'botToken',
  'botAppSecret',
  'proxyPassword',
  'gatewayToken',
  'tavilyApiKey',
] as const satisfies readonly StoredCredentialKind[];

const BOT_SECRET_SLUG_PREFIX = 'settings:bot';
const GLOBAL_PROXY_SECRET_SLUG = 'settings:network-proxy';
const GLOBAL_GATEWAY_SECRET_SLUG = 'settings:open-gateway';
const GLOBAL_TAVILY_SECRET_SLUG = 'settings:web-search:tavily';

function botSecretSlug(provider: BotProvider): string {
  return `${BOT_SECRET_SLUG_PREFIX}:${provider}`;
}

function toStoredKind(kind: CredentialKind): StoredCredentialKind {
  switch (kind) {
    case 'api_key':
      return 'apiKey';
    case 'oauth_token':
      return 'oauthToken';
    case 'bot_token':
      return 'botToken';
    case 'app_secret':
      return 'botAppSecret';
    case 'proxy_password':
      return 'proxyPassword';
    case 'gateway_token':
      return 'gatewayToken';
    case 'tavily_api_key':
      return 'tavilyApiKey';
  }
}
