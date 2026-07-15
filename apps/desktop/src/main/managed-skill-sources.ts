import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative } from 'node:path';
import { lstat, mkdir, readdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { validateSkillMetadata, type SkillValidationIssue } from '@maka/runtime';

/**
 * Fixed marketplace taxonomy. A source's `category:` front-matter is
 * accepted only when it exactly matches one of these buckets; anything
 * else (including a missing field) resolves to the neutral 效率工具
 * default so the market filter never surfaces an unbounded, user-typed
 * label set. Kept in one place so the renderer filter and the seeder
 * agree on the same list.
 */
export const MANAGED_SKILL_CATEGORIES = [
  '内容创作',
  '数据与AI',
  '设计与UI',
  'DevOps与部署',
  '文档与写作',
  '效率工具',
  '研究与分析',
] as const;

export type ManagedSkillCategory = (typeof MANAGED_SKILL_CATEGORIES)[number];

const MANAGED_SKILL_CATEGORY_DEFAULT: ManagedSkillCategory = '效率工具';

function normalizeManagedSkillCategory(raw: string | undefined): ManagedSkillCategory {
  if (raw && (MANAGED_SKILL_CATEGORIES as readonly string[]).includes(raw)) {
    return raw as ManagedSkillCategory;
  }
  return MANAGED_SKILL_CATEGORY_DEFAULT;
}

export interface ManagedSkillSourceRecord {
  id: string;
  name: string;
  description: string;
  category: ManagedSkillCategory;
  sourceType: 'local';
  sourcePath: string;
  contentSha256: string;
  createdAt: string;
  updatedAt: string;
}

export interface ManagedSkillSourceEntry {
  id: string;
  name: string;
  description: string;
  /**
   * Marketplace taxonomy bucket. Always one of MANAGED_SKILL_CATEGORIES —
   * unknown / missing front-matter resolves to 效率工具 at read time, so
   * the renderer can treat this as a required field.
   */
  category: ManagedSkillCategory;
  sourceType: 'local';
}

export type ImportManagedSkillSourceResult =
  | { ok: true; source: ManagedSkillSourceRecord }
  | {
      ok: false;
      reason: 'cancelled' | 'invalid_skill' | 'already_exists' | 'blocked_path' | 'write_failed';
      diagnostics?: SkillValidationIssue[];
    };

export type ReadManagedSkillSourceResult =
  | { ok: true; source: ManagedSkillSourceRecord; content: string; contentSha256: string }
  | { ok: false; reason: 'not_found' | 'blocked_path' | 'read_failed' };

export function resolveManagedSkillSourcesRoot(homeDir = homedir()): string {
  // Dev/test-only override so the visual-smoke fixture can seed a
  // deterministic managed-source catalog without touching the real
  // ~/.maka/skill-sources. Packaged builds ignore this (app.isPackaged
  // gate lives in main.ts, same as the fixture env vars); here we only
  // honor an absolute path so a relative value can never escape.
  const override = process.env.MAKA_SKILL_SOURCES_ROOT;
  if (override && isAbsolute(override) && process.env.MAKA_VISUAL_SMOKE_FIXTURE) {
    return override;
  }
  return join(homeDir, '.maka', 'skill-sources');
}

export async function listManagedSkillSources(root = resolveManagedSkillSourcesRoot()): Promise<ManagedSkillSourceRecord[]> {
  const sourceRoot = await resolveExistingSourceRoot(root);
  if (!sourceRoot.ok) return [];

  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const sources: ManagedSkillSourceRecord[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !isSafeSkillId(entry.name)) continue;
    const source = await readManagedSkillSource(root, entry.name);
    if (source.ok) sources.push(source.source);
  }
  return sources.sort((a, b) => a.name.localeCompare(b.name));
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
  const validation = validateSkillMetadata(content);
  if (!validation.valid) {
    return { ok: false, reason: 'invalid_skill', diagnostics: validation.issues };
  }
  const { name, description, category } = validation.manifest;
  if (!name || !description) {
    return { ok: false, reason: 'invalid_skill', diagnostics: validation.issues };
  }

  const id = sourceIdFromPath(input.sourceFile);
  if (!id) return { ok: false, reason: 'invalid_skill' };

  const sourceDir = join(root, id);
  const managedSkillPath = join(sourceDir, 'SKILL.md');
  const now = new Date().toISOString();
  const contentSha256 = `sha256:${sha256(bytes)}`;

  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const sourceRoot = await resolveExistingSourceRoot(root);
    if (!sourceRoot.ok) return { ok: false, reason: 'blocked_path' };

    await mkdir(sourceDir, { mode: 0o700 });
    const sourceDirReal = await resolveContainedDirectory(sourceRoot.rootReal, sourceDir);
    if (!sourceDirReal.ok) return { ok: false, reason: 'blocked_path' };
    if (!await writeContainedBufferFile(sourceDirReal.path, managedSkillPath, bytes, { failIfExists: true })) {
      return { ok: false, reason: 'write_failed' };
    }

    const source: ManagedSkillSourceRecord = {
      id,
      name,
      description,
      category: normalizeManagedSkillCategory(category),
      sourceType: 'local',
      sourcePath: managedSkillPath,
      contentSha256,
      createdAt: now,
      updatedAt: now,
    };
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

  const sourceRoot = await resolveExistingSourceRoot(root);
  if (!sourceRoot.ok) return { ok: false, reason: sourceRoot.reason };

  const sourceDir = join(root, sourceId);
  const sourcePath = join(root, sourceId, 'SKILL.md');
  const sourceDirReal = await resolveContainedDirectory(sourceRoot.rootReal, sourceDir);
  if (!sourceDirReal.ok) return { ok: false, reason: sourceDirReal.reason };

  try {
    const sourceStat = await lstat(sourcePath);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) return { ok: false, reason: 'blocked_path' };
    const sourceReal = await realpath(sourcePath);
    if (!isContainedPath(sourceDirReal.path, sourceReal)) return { ok: false, reason: 'blocked_path' };
    const bytes = await readFile(sourcePath);
    const contentSha256 = `sha256:${sha256(bytes)}`;
    const content = bytes.toString('utf8');
    const parsed = parseSkillFrontMatterForSource(content);
    const source: ManagedSkillSourceRecord = {
      id: sourceId,
      name: parsed.name ?? sourceId,
      description: parsed.description ?? '',
      category: normalizeManagedSkillCategory(parsed.category),
      sourceType: 'local',
      sourcePath,
      contentSha256,
      createdAt: sourceStat.birthtime.toISOString(),
      updatedAt: sourceStat.mtime.toISOString(),
    };
    return { ok: true, source, content, contentSha256 };
  } catch {
    return { ok: false, reason: 'read_failed' };
  }
}

export function toManagedSkillSourceEntry(source: ManagedSkillSourceRecord): ManagedSkillSourceEntry {
  return {
    id: source.id,
    name: source.name,
    description: source.description,
    category: source.category,
    sourceType: source.sourceType,
  };
}

async function resolveExistingSourceRoot(root: string): Promise<
  | { ok: true; rootReal: string }
  | { ok: false; reason: 'not_found' | 'blocked_path' }
> {
  try {
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return { ok: false, reason: 'blocked_path' };
    return { ok: true, rootReal: await realpath(root) };
  } catch {
    return { ok: false, reason: 'not_found' };
  }
}

async function resolveContainedDirectory(rootReal: string, directory: string): Promise<
  | { ok: true; path: string }
  | { ok: false; reason: 'not_found' | 'blocked_path' }
> {
  try {
    const directoryStat = await lstat(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) return { ok: false, reason: 'blocked_path' };
    const directoryReal = await realpath(directory);
    if (!isContainedPath(rootReal, directoryReal)) return { ok: false, reason: 'blocked_path' };
    return { ok: true, path: directoryReal };
  } catch {
    return { ok: false, reason: 'not_found' };
  }
}

async function writeContainedBufferFile(
  rootDir: string,
  filePath: string,
  bytes: Buffer,
  options: { failIfExists?: boolean } = {},
): Promise<boolean> {
  const tempPath = join(rootDir, `.maka-source-write.${process.pid}.${Date.now()}.tmp`);
  try {
    const rootReal = await realpath(rootDir);
    const existing = await lstat(filePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (existing !== null) {
      if (options.failIfExists) return false;
      if (!existing.isFile() || existing.isSymbolicLink()) return false;
      const fileReal = await realpath(filePath);
      if (!isContainedPath(rootReal, fileReal)) return false;
    }
    await writeFile(tempPath, bytes, { flag: 'wx', mode: 0o600 });
    const tempStat = await lstat(tempPath);
    if (!tempStat.isFile() || tempStat.isSymbolicLink()) {
      await unlink(tempPath).catch(() => {});
      return false;
    }
    const tempReal = await realpath(tempPath);
    if (!isContainedPath(rootReal, tempReal)) {
      await unlink(tempPath).catch(() => {});
      return false;
    }
    await rename(tempPath, filePath);
    return true;
  } catch {
    await unlink(tempPath).catch(() => {});
    return false;
  }
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

function parseSkillFrontMatterForSource(text: string): { name?: string; description?: string; category?: string } {
  if (!text.startsWith('---')) return {};
  const close = text.indexOf('\n---', 3);
  if (close < 0) return {};
  const block = text.slice(3, close);
  const result: { name?: string; description?: string; category?: string } = {};
  for (const raw of block.split(/\r?\n/)) {
    const match = raw.match(/^(name|description|category):\s*(.*)$/);
    if (!match) continue;
    const value = match[2].trim().replace(/^['"]|['"]$/g, '');
    if (value) result[match[1] as 'name' | 'description' | 'category'] = value;
  }
  return result;
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
