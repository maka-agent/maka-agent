import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative } from 'node:path';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';

export interface ManagedSkillSourceRegistry {
  schemaVersion: 1;
  sources: ManagedSkillSourceRecord[];
}

export interface ManagedSkillSourceRecord {
  id: string;
  name: string;
  description: string;
  sourceType: 'local';
  sourcePath: string;
  contentSha256: string;
  createdAt: string;
  updatedAt: string;
}

export type ImportManagedSkillSourceResult =
  | { ok: true; source: ManagedSkillSourceRecord }
  | { ok: false; reason: 'cancelled' | 'invalid_skill' | 'already_exists' | 'blocked_path' | 'write_failed' };

export type ReadManagedSkillSourceResult =
  | { ok: true; source: ManagedSkillSourceRecord; content: string; contentSha256: string }
  | { ok: false; reason: 'not_found' | 'blocked_path' | 'read_failed' };

export function resolveManagedSkillSourcesRoot(homeDir = homedir()): string {
  return join(homeDir, '.maka', 'skill-sources');
}

export async function listManagedSkillSources(root = resolveManagedSkillSourcesRoot()): Promise<ManagedSkillSourceRecord[]> {
  const registry = await readRegistry(root);
  return registry.sources.slice().sort((a, b) => a.name.localeCompare(b.name));
}

export async function importManagedSkillSource(input: {
  root?: string;
  sourceFile: string;
}): Promise<ImportManagedSkillSourceResult> {
  const root = input.root ?? resolveManagedSkillSourcesRoot();
  let sourceStat: Awaited<ReturnType<typeof lstat>>;
  try {
    sourceStat = await lstat(input.sourceFile);
  } catch {
    return { ok: false, reason: 'invalid_skill' };
  }
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) return { ok: false, reason: 'blocked_path' };

  let bytes: Buffer;
  try {
    bytes = await readFile(input.sourceFile);
  } catch {
    return { ok: false, reason: 'invalid_skill' };
  }

  const content = bytes.toString('utf8');
  const parsed = parseSkillFrontMatterForSource(content);
  if (!parsed.name) return { ok: false, reason: 'invalid_skill' };

  const id = sourceIdFromPath(input.sourceFile);
  if (!id) return { ok: false, reason: 'invalid_skill' };

  const sourceDir = join(root, id);
  const managedSkillPath = join(sourceDir, 'SKILL.md');
  const now = new Date().toISOString();
  const contentSha256 = `sha256:${sha256(bytes)}`;

  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const registry = await readRegistry(root);
    if (registry.sources.some((source) => source.id === id)) return { ok: false, reason: 'already_exists' };

    await mkdir(sourceDir, { mode: 0o700 });
    await writeFile(managedSkillPath, bytes, { flag: 'wx', mode: 0o600 });

    const source: ManagedSkillSourceRecord = {
      id,
      name: parsed.name,
      description: parsed.description ?? '',
      sourceType: 'local',
      sourcePath: managedSkillPath,
      contentSha256,
      createdAt: now,
      updatedAt: now,
    };
    await writeFile(join(sourceDir, 'source.json'), `${JSON.stringify(source, null, 2)}\n`, { mode: 0o600 });
    await writeRegistry(root, {
      schemaVersion: 1,
      sources: [...registry.sources, source],
    });
    return { ok: true, source };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return { ok: false, reason: 'already_exists' };
    return { ok: false, reason: 'write_failed' };
  }
}

export async function readManagedSkillSource(
  root: string,
  sourceId: string,
): Promise<ReadManagedSkillSourceResult> {
  if (!isSafeSkillId(sourceId)) return { ok: false, reason: 'not_found' };

  const sourcePath = join(root, sourceId, 'SKILL.md');
  try {
    const [rootReal, sourceReal] = await Promise.all([realpath(root), realpath(sourcePath)]);
    if (!isContainedPath(rootReal, sourceReal)) return { ok: false, reason: 'blocked_path' };
  } catch {
    return { ok: false, reason: 'not_found' };
  }

  try {
    const sourceStat = await lstat(sourcePath);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) return { ok: false, reason: 'blocked_path' };
    const bytes = await readFile(sourcePath);
    const registry = await readRegistry(root);
    const registryRecord = registry.sources.find((source) => source.id === sourceId);
    const contentSha256 = `sha256:${sha256(bytes)}`;
    const content = bytes.toString('utf8');
    const parsed = parseSkillFrontMatterForSource(content);
    const source: ManagedSkillSourceRecord = registryRecord ?? {
      id: sourceId,
      name: parsed.name ?? sourceId,
      description: parsed.description ?? '',
      sourceType: 'local',
      sourcePath,
      contentSha256,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    return { ok: true, source: { ...source, contentSha256, sourcePath }, content, contentSha256 };
  } catch {
    return { ok: false, reason: 'read_failed' };
  }
}

async function readRegistry(root: string): Promise<ManagedSkillSourceRegistry> {
  try {
    const parsed = JSON.parse(await readFile(join(root, 'registry.json'), 'utf8')) as Partial<ManagedSkillSourceRegistry>;
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.sources)) return { schemaVersion: 1, sources: [] };
    return {
      schemaVersion: 1,
      sources: parsed.sources.filter(isManagedSkillSourceRecord),
    };
  } catch {
    return { schemaVersion: 1, sources: [] };
  }
}

async function writeRegistry(root: string, registry: ManagedSkillSourceRegistry): Promise<void> {
  await writeFile(join(root, 'registry.json'), `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
}

function sourceIdFromPath(filePath: string): string | undefined {
  const fileName = basename(filePath).toLowerCase() === 'skill.md'
    ? basename(dirname(filePath))
    : basename(filePath, extname(filePath));
  const normalized = fileName
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return isSafeSkillId(normalized) ? normalized : undefined;
}

function parseSkillFrontMatterForSource(text: string): { name?: string; description?: string } {
  if (!text.startsWith('---')) return {};
  const close = text.indexOf('\n---', 3);
  if (close < 0) return {};
  const block = text.slice(3, close);
  const result: { name?: string; description?: string } = {};
  for (const raw of block.split(/\r?\n/)) {
    const match = raw.match(/^(name|description):\s*(.*)$/);
    if (!match) continue;
    const value = match[2].trim().replace(/^['"]|['"]$/g, '');
    if (value) result[match[1] as 'name' | 'description'] = value;
  }
  return result;
}

function isManagedSkillSourceRecord(value: unknown): value is ManagedSkillSourceRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Partial<ManagedSkillSourceRecord>;
  return typeof record.id === 'string' &&
    typeof record.name === 'string' &&
    typeof record.description === 'string' &&
    record.sourceType === 'local' &&
    typeof record.sourcePath === 'string' &&
    typeof record.contentSha256 === 'string' &&
    typeof record.createdAt === 'string' &&
    typeof record.updatedAt === 'string';
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function isSafeSkillId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(value);
}

function isContainedPath(root: string, child: string): boolean {
  const rel = relative(root, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
}
