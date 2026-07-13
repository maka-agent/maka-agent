import { ipcMain } from 'electron';
import {
  buildConnectionModelCatalogEntries,
  generalizedErrorMessageChinese,
  normalizeConnectionBaseUrl,
} from '@maka/core';
import type {
  CreateConnectionInput,
  UpdateConnectionInput,
} from '@maka/core';
import { PROVIDER_DEFAULTS, providerAuthRequiresSecret } from '@maka/core/llm-connections';
import { fetchProviderModels, testConnection } from '@maka/runtime';
import { createConnectionStore } from '@maka/storage';
import { createFileCredentialStore } from './credential-store.js';
import { connectionTestStatusPatch } from './connection-test-status.js';

type ConnectionStore = ReturnType<typeof createConnectionStore>;
type CredentialStore = ReturnType<typeof createFileCredentialStore>;

interface ConnectionInputNormalizerDeps {
  connectionStore: ConnectionStore;
}

interface ConnectionsIpcDeps extends ConnectionInputNormalizerDeps {
  credentialStore: CredentialStore;
  syncOAuthModelConnections: () => Promise<void>;
  resolveConnectionSecret: (slug: string) => Promise<string | null>;
  emitConnectionListChanged: () => void;
}

const IPC_CONNECTION_SLUG_MAX_LENGTH = 64;
const IPC_CONNECTION_SECRET_MAX_LENGTH = 4096;
const IPC_CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F]/;
const IPC_CONNECTION_SLUG_PATTERN = /^[A-Za-z0-9._-]+$/;

function hasTraversalLookingSlugSegment(value: string): boolean {
  return value.split('.').some((segment) => segment.length === 0);
}

function normalizeConnectionSlugForIpc(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string`);
  }
  if (value.length === 0) {
    throw new Error(`${label} is required`);
  }
  if (value.length > IPC_CONNECTION_SLUG_MAX_LENGTH) {
    throw new Error(`${label} must be ${IPC_CONNECTION_SLUG_MAX_LENGTH} characters or fewer`);
  }
  if (!IPC_CONNECTION_SLUG_PATTERN.test(value) || IPC_CONTROL_CHARACTER_PATTERN.test(value)) {
    throw new Error(`${label} contains invalid characters`);
  }
  if (hasTraversalLookingSlugSegment(value)) {
    throw new Error(`${label} contains invalid path traversal segments`);
  }
  return value;
}

function normalizeConnectionApiKeyForIpc(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string`);
  }
  if (value.length > IPC_CONNECTION_SECRET_MAX_LENGTH) {
    throw new Error(`${label} must be ${IPC_CONNECTION_SECRET_MAX_LENGTH} characters or fewer`);
  }
  if (IPC_CONTROL_CHARACTER_PATTERN.test(value)) {
    throw new Error(`${label} contains invalid characters`);
  }
  return value;
}

function normalizeCreateConnectionInput(input: CreateConnectionInput): CreateConnectionInput {
  const apiKey = input.apiKey === undefined
    ? undefined
    : normalizeConnectionApiKeyForIpc(input.apiKey, 'apiKey');
  const slug = normalizeConnectionSlugForIpc(input.slug, 'connection slug');
  const normalizedInput = { ...input, slug, ...(apiKey !== undefined ? { apiKey } : {}) };
  const defaults = PROVIDER_DEFAULTS[normalizedInput.providerType];
  if (defaults.authKind === 'oauth_token') {
    return { ...normalizedInput, baseUrl: defaults.baseUrl };
  }
  if (normalizedInput.baseUrl === undefined) return normalizedInput;
  const result = normalizeConnectionBaseUrl(normalizedInput.baseUrl);
  if (!result.ok) {
    throw new Error(result.error);
  }
  return { ...normalizedInput, baseUrl: result.value };
}

function normalizeConnectionPatchSecretsForIpc(patch: UpdateConnectionInput): UpdateConnectionInput {
  if (!Object.prototype.hasOwnProperty.call(patch, 'apiKey')) return patch;
  if (patch.apiKey === undefined) return patch;
  return {
    ...patch,
    apiKey: normalizeConnectionApiKeyForIpc(patch.apiKey, 'apiKey'),
  };
}

async function normalizeUpdateConnectionInput(
  deps: ConnectionInputNormalizerDeps,
  slug: string,
  patch: UpdateConnectionInput,
): Promise<UpdateConnectionInput> {
  const normalizedPatch = normalizeConnectionPatchSecretsForIpc(patch);
  const { connectionStore } = deps;
  const existing = await connectionStore.get(slug);
  const providerType = existing?.providerType;
  if (providerType && PROVIDER_DEFAULTS[providerType].authKind === 'oauth_token') {
    return { ...normalizedPatch, baseUrl: PROVIDER_DEFAULTS[providerType].baseUrl };
  }
  if (normalizedPatch.baseUrl === undefined) return normalizedPatch;
  const result = normalizeConnectionBaseUrl(normalizedPatch.baseUrl);
  if (!result.ok) {
    throw new Error(result.error);
  }
  return { ...normalizedPatch, baseUrl: result.value };
}

export function registerConnectionsIpc(deps: ConnectionsIpcDeps): void {
  const {
    connectionStore,
    credentialStore,
    syncOAuthModelConnections,
    resolveConnectionSecret,
    emitConnectionListChanged,
  } = deps;

  ipcMain.handle('connections:list', async () => {
    await syncOAuthModelConnections();
    return connectionStore.list();
  });
  ipcMain.handle('connections:getDefault', () => connectionStore.getDefault());
  ipcMain.handle('connections:setDefault', async (_event, slug: string | null) => {
    const normalizedSlug = slug === null ? null : normalizeConnectionSlugForIpc(slug, 'connection slug');
    if (normalizedSlug && !(await connectionStore.get(normalizedSlug))) {
      throw new Error(`No such connection: ${normalizedSlug}`);
    }
    await connectionStore.setDefault(normalizedSlug);
    emitConnectionListChanged();
  });
  ipcMain.handle('connections:setDefaultModel', async (_event, input: { slug: string; model: string } | null) => {
    if (input === null) {
      await connectionStore.setDefault(null);
      emitConnectionListChanged();
      return;
    }
    if (!input || typeof input !== 'object' || typeof input.slug !== 'string' || typeof input.model !== 'string') {
      throw new Error('Default model input must include slug and model');
    }
    const slug = normalizeConnectionSlugForIpc(input.slug, 'connection slug');
    const model = input.model.trim();
    if (!model) throw new Error('Default model must not be empty');
    const connection = await connectionStore.get(slug);
    if (!connection) throw new Error(`No such connection: ${slug}`);
    if (!connection.enabled) throw new Error(`Connection is disabled: ${slug}`);
    const selectable = buildConnectionModelCatalogEntries({ connection })
      .some((entry) => entry.id === model && entry.canUseAsChatDefault);
    if (!selectable) {
      throw new Error(`Model is not available for chat default: ${model}`);
    }
    if (connection.defaultModel !== model) {
      await connectionStore.update(slug, { defaultModel: model });
    }
    await connectionStore.setDefault(slug);
    emitConnectionListChanged();
  });
  ipcMain.handle('connections:create', async (_event, input: CreateConnectionInput) => {
    // baseUrl is a credentials-exfiltration boundary. Normalize before any
    // store or credential write; OAuth-token providers must keep their
    // canonical provider endpoint.
    const normalizedInput = normalizeCreateConnectionInput(input);
    const connection = await connectionStore.create(normalizedInput);
    if (normalizedInput.apiKey) {
      await credentialStore.setSecret(connection.slug, 'api_key', normalizedInput.apiKey);
    }
    emitConnectionListChanged();
    return connection;
  });
  ipcMain.handle('connections:update', async (_event, slug: string, patch: UpdateConnectionInput) => {
    slug = normalizeConnectionSlugForIpc(slug, 'connection slug');
    const normalizedPatch = await normalizeUpdateConnectionInput(deps, slug, patch);
    const connection = await connectionStore.update(slug, normalizedPatch);
    if (normalizedPatch.apiKey !== undefined) {
      if (normalizedPatch.apiKey) await credentialStore.setSecret(slug, 'api_key', normalizedPatch.apiKey);
      else await credentialStore.deleteSecret(slug, 'api_key');
    }
    emitConnectionListChanged();
    return connection;
  });
  ipcMain.handle('connections:delete', async (_event, slug: string) => {
    slug = normalizeConnectionSlugForIpc(slug, 'connection slug');
    await connectionStore.delete(slug);
    await credentialStore.deleteSecret(slug);
    emitConnectionListChanged();
  });
  ipcMain.handle('connections:test', async (_event, slug: string, opts?: { model?: string }) => {
    slug = normalizeConnectionSlugForIpc(slug, 'connection slug');
    const connection = await connectionStore.get(slug);
    if (!connection) return { ok: false, errorMessage: `找不到模型连接：${slug}` };
    const apiKey = await resolveConnectionSecret(slug);
    if (providerAuthRequiresSecret(connection.providerType) && !apiKey) {
      return {
        ok: false,
        errorMessage: PROVIDER_DEFAULTS[connection.providerType].authKind === 'oauth_token'
          ? '这个 OAuth 模型连接还没有登录'
          : '这个模型连接还没有保存 API key',
        errorClass: 'auth',
      };
    }
    const result = await testConnection(connection, apiKey ?? '', opts?.model);
    await connectionStore.update(slug, connectionTestStatusPatch(result));
    emitConnectionListChanged();
    return result;
  });
  ipcMain.handle('connections:fetchModels', async (_event, slug: string) => {
    slug = normalizeConnectionSlugForIpc(slug, 'connection slug');
    const connection = await connectionStore.get(slug);
    if (!connection) throw new Error(`找不到模型连接：${slug}`);
    const apiKey = await resolveConnectionSecret(slug);
    if (providerAuthRequiresSecret(connection.providerType) && !apiKey) {
      throw new Error(PROVIDER_DEFAULTS[connection.providerType].authKind === 'oauth_token'
        ? '这个 OAuth 模型连接还没有登录'
        : '这个模型连接还没有保存 API key');
    }
    try {
      const fetchedAt = Date.now();
      const models = await fetchProviderModels(connection, apiKey ?? '');
      await connectionStore.update(slug, {
        models,
        modelSource: 'fetched',
        modelsFetchedAt: fetchedAt,
      });
      emitConnectionListChanged();
      return {
        models,
        source: 'fetched',
        fetchedAt,
      };
    } catch (error) {
      throw new Error(generalizedErrorMessageChinese(error, '拉取模型列表失败'));
    }
  });
  ipcMain.handle('connections:hasSecret', async (_event, slug: string) => {
    slug = normalizeConnectionSlugForIpc(slug, 'connection slug');
    return Boolean(await resolveConnectionSecret(slug));
  });
}
