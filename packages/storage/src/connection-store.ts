import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  PROVIDER_DEFAULTS,
  migrateConnectionV1ToV2,
  validateSlug,
  type CreateConnectionInput,
  type LlmConnection,
  type UpdateConnectionInput,
} from '@maka/core/llm-connections';

export interface ConnectionStore {
  list(): Promise<LlmConnection[]>;
  get(slug: string): Promise<LlmConnection | null>;
  create(input: CreateConnectionInput): Promise<LlmConnection>;
  update(slug: string, patch: UpdateConnectionInput): Promise<LlmConnection>;
  delete(slug: string): Promise<void>;
  save(connection: LlmConnection): Promise<LlmConnection>;
  remove(slug: string): Promise<void>;
  getDefault(): Promise<string | null>;
  setDefault(slug: string | null): Promise<void>;
}

interface ConnectionsFile {
  defaultSlug: string | null;
  connections: LlmConnection[];
}

const emptyConnectionsFile = (): ConnectionsFile => ({ defaultSlug: null, connections: [] });

export function createConnectionStore(workspaceRoot: string): ConnectionStore {
  return new FileConnectionStore(workspaceRoot);
}

class FileConnectionStore implements ConnectionStore {
  private readonly path: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(workspaceRoot: string) {
    this.path = join(workspaceRoot, 'llm-connections.json');
  }

  async list(): Promise<LlmConnection[]> {
    return (await this.read()).connections;
  }

  async get(slug: string): Promise<LlmConnection | null> {
    return (await this.read()).connections.find((connection) => connection.slug === slug) ?? null;
  }

  async create(input: CreateConnectionInput): Promise<LlmConnection> {
    const err = validateSlug(input.slug);
    if (err) throw new Error(err);

    let created: LlmConnection | null = null;
    await this.withQueue(async () => {
      const file = await this.readUnlocked();
      if (file.connections.some((connection) => connection.slug === input.slug)) {
        throw new Error(`Connection slug already exists: ${input.slug}`);
      }
      const defaults = PROVIDER_DEFAULTS[input.providerType];
      const now = Date.now();
      const next: LlmConnection = {
        slug: input.slug,
        name: input.name || defaults.label,
        providerType: input.providerType,
        ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
        defaultModel: input.defaultModel || defaults.fallbackModels[0] || '',
        enabled: true,
        createdAt: now,
        updatedAt: now,
      };
      file.connections.push(next);
      if (!file.defaultSlug) file.defaultSlug = next.slug;
      created = next;
      await this.write(file);
    });
    if (!created) throw new Error(`Failed to create connection: ${input.slug}`);
    return created;
  }

  async update(slug: string, patch: UpdateConnectionInput): Promise<LlmConnection> {
    let updated: LlmConnection | null = null;
    await this.withQueue(async () => {
      const file = await this.readUnlocked();
      const index = file.connections.findIndex((connection) => connection.slug === slug);
      if (index < 0) throw new Error(`No such connection: ${slug}`);
      const current = file.connections[index]!;
      const updatesTestStatus =
        Object.prototype.hasOwnProperty.call(patch, 'lastTestStatus')
        || Object.prototype.hasOwnProperty.call(patch, 'lastTestAt')
        || Object.prototype.hasOwnProperty.call(patch, 'lastTestMessage');
      const clearsTestStatus =
        !updatesTestStatus
        && (
          patch.apiKey !== undefined
          || patch.baseUrl !== undefined
          || patch.defaultModel !== undefined
          || patch.models !== undefined
        );
      const next: LlmConnection = {
        ...current,
        name: patch.name ?? current.name,
        baseUrl: patch.baseUrl !== undefined ? patch.baseUrl || undefined : current.baseUrl,
        defaultModel: patch.defaultModel ?? current.defaultModel,
        enabled: patch.enabled ?? current.enabled,
        models: patch.models ?? current.models,
        lastTestStatus: updatesTestStatus ? patch.lastTestStatus : (clearsTestStatus ? undefined : current.lastTestStatus),
        lastTestAt: updatesTestStatus ? patch.lastTestAt : (clearsTestStatus ? undefined : current.lastTestAt),
        lastTestMessage: updatesTestStatus ? patch.lastTestMessage : (clearsTestStatus ? undefined : current.lastTestMessage),
        updatedAt: Date.now(),
      };
      file.connections[index] = next;
      updated = next;
      await this.write(file);
    });
    if (!updated) throw new Error(`Failed to update connection: ${slug}`);
    return updated;
  }

  async delete(slug: string): Promise<void> {
    await this.remove(slug);
  }

  async save(connection: LlmConnection): Promise<LlmConnection> {
    await this.withQueue(async () => {
      const file = await this.readUnlocked();
      const index = file.connections.findIndex((item) => item.slug === connection.slug);
      const now = Date.now();
      const next: LlmConnection = {
        ...connection,
        enabled: connection.enabled ?? true,
        createdAt: connection.createdAt ?? now,
        updatedAt: connection.updatedAt ?? now,
      };
      if (index >= 0) file.connections[index] = next;
      else file.connections.push(next);
      if (!file.defaultSlug) file.defaultSlug = connection.slug;
      await this.write(file);
    });
    return connection;
  }

  async remove(slug: string): Promise<void> {
    await this.withQueue(async () => {
      const file = await this.readUnlocked();
      file.connections = file.connections.filter((connection) => connection.slug !== slug);
      if (file.defaultSlug === slug) file.defaultSlug = null;
      await this.write(file);
    });
  }

  async getDefault(): Promise<string | null> {
    return (await this.read()).defaultSlug;
  }

  async setDefault(slug: string | null): Promise<void> {
    await this.withQueue(async () => {
      const file = await this.readUnlocked();
      file.defaultSlug = slug;
      await this.write(file);
    });
  }

  private async read(): Promise<ConnectionsFile> {
    return this.readUnlocked();
  }

  private async readUnlocked(): Promise<ConnectionsFile> {
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8')) as ConnectionsFile;
      return {
        defaultSlug: raw.defaultSlug ?? null,
        connections: (raw.connections ?? []).map((connection) => migrateConnectionV1ToV2(connection)),
      };
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return emptyConnectionsFile();
      throw error;
    }
  }

  private async write(file: ConnectionsFile): Promise<void> {
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
