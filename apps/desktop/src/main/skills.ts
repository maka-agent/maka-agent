import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  isPathInside,
  isRecord,
  isSafeSkillId,
  parseSkillFrontMatter,
  readContainedRegularTextFile,
  readSkillRuntimeState,
  scanWorkspaceSkills,
  writeContainedRegularTextFile,
  writeSkillRuntimeState,
  type RuntimeSkillDefinition,
  type ScannedSkill,
  type SkillRuntimeStatus,
} from '@maka/runtime';
import {
  MANAGED_SKILL_CATEGORIES,
  type ManagedSkillCategory,
  readManagedSkillSource,
  resolveManagedSkillSourcesRoot,
} from './managed-skill-sources.js';
import { BUNDLED_REVERSE_ENGINEERED_SKILLS } from './bundled-skill-catalog.generated.js';

// Re-export runtime-facing skill exports so existing call sites and tests
// keep importing from './skills.js' unchanged. Governance (lock, provenance,
// managed-source status, Office seeding) stays defined below.
export {
  buildSkillAgentTool,
  buildSkillsPromptFragment,
  loadSkillInstructions,
  parseSkillFrontMatter,
  MAX_SKILL_BODY_CHARS,
  MAX_SKILL_TOOL_BODY_CHARS,
  MAX_SKILLS_PROMPT_CHARS,
} from '@maka/runtime';
export type { LoadSkillInstructionsResult, LoadedSkillInstructions, SkillRuntimeStatus } from '@maka/runtime';

export type SkillSourceType = 'workspace' | 'bundled' | 'managed' | 'unknown';
export type SkillValidationStatus = 'ok' | 'missing_lock' | 'modified' | 'metadata_error';
export type ManagedSkillUpdateStatus =
  | 'not_managed'
  | 'source_missing'
  | 'up_to_date'
  | 'update_available'
  | 'local_modified'
  | 'metadata_error';
export type SkillValidationCode =
  | 'missing_lock'
  | 'modified'
  | 'invalid_json'
  | 'id_mismatch'
  | 'unsupported_schema'
  | 'invalid_hash'
  | 'write_failed'
  | 'lock_symlink';

export interface InstalledSkill extends RuntimeSkillDefinition {
  sourceType: SkillSourceType;
  sourceName?: string;
  sourceVersion?: string;
  contentSha256?: string;
  installedAt?: string;
  userModified: boolean;
  validationStatus: SkillValidationStatus;
  validationCodes: SkillValidationCode[];
  validationMessages?: string[];
  managedSourceId?: string;
  managedUpdateStatus?: ManagedSkillUpdateStatus;
  sourceContentSha256?: string;
}

export interface SkillEntry {
  id: string;
  name: string;
  description: string;
  path: string;
  declaredTools: string[];
  sourceType: 'workspace' | 'bundled' | 'managed' | 'unknown';
  userModified: boolean;
  validationStatus: SkillValidationStatus;
  managedUpdateStatus?: ManagedSkillUpdateStatus;
  enabled: boolean;
  runtimeStatus: SkillRuntimeStatus;
}

export interface SkillGovernanceDetails {
  id: string;
  name: string;
  description: string;
  path: string;
  declaredTools: string[];
  sourceType: SkillSourceType;
  userModified: boolean;
  validationStatus: SkillValidationStatus;
  enabled: boolean;
  runtimeStatus: SkillRuntimeStatus;
  validationCodes: SkillValidationCode[];
  validationMessages: string[];
  managedSourceId?: string;
  managedUpdateStatus?: ManagedSkillUpdateStatus;
  hasManagedBaseline: boolean;
  sourceAvailable?: boolean;
  sourceChanged?: boolean;
}

export interface ManagedSkillUpdatePreview {
  skill: SkillGovernanceDetails;
  currentContent: string;
  sourceContent: string;
  baselineContent?: string;
  expectedCurrentSha256: string;
  expectedSourceSha256: string;
  summary: {
    currentLineCount: number;
    sourceLineCount: number;
    changedLineCount: number;
  };
}

export type CreateStarterSkillResult =
  | { ok: true; created: boolean; skill: InstalledSkill; filePath: string }
  | { ok: false; reason: 'blocked_path' | 'already_exists' | 'write_failed' };

export type DeleteSkillResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'blocked_path' | 'delete_failed' };

export type SkillOpenTarget = 'file' | 'directory';
export type ResolveSkillOpenPathResult =
  | { ok: true; path: string; target: SkillOpenTarget }
  | { ok: false; reason: 'invalid_id' | 'missing' | 'blocked_path' | 'not_file' | 'not_directory' };

export type SetSkillEnabledResult =
  | { ok: true; skill: SkillEntry }
  | { ok: false; reason: 'not_found' | 'blocked_path' | 'state_error' | 'write_failed' };

interface InstalledSkillDefinition extends InstalledSkill {
  content: string;
}

interface SkillLockFile {
  schemaVersion: 1;
  id: string;
  sourceType: 'bundled' | 'managed';
  sourceName?: string;
  sourceVersion?: string;
  contentSha256: string;
  installedAt: string;
  sourceId?: string;
  sourceContentSha256?: string;
}

interface SkillReadOptions {
  managedSourceRoot?: string;
}

interface ManagedSkillUpdateOptions {
  force?: boolean;
  expectedCurrentSha256?: string;
  expectedSourceSha256?: string;
}

const BUNDLED_OFFICE_SKILLS: Array<{ id: string; body: string }> = [
  { id: 'officecli-docx', body: officeCliDocxSkillTemplate() },
  { id: 'officecli-xlsx', body: officeCliXlsxSkillTemplate() },
  { id: 'officecli-pptx', body: officeCliPptxSkillTemplate() },
];
const BUNDLED_OFFICE_SKILL_IDS = new Set(BUNDLED_OFFICE_SKILLS.map((skill) => skill.id));
const BUNDLED_OFFICE_SKILL_HASH_BY_ID = new Map(
  BUNDLED_OFFICE_SKILLS.map((skill) => [skill.id, `sha256:${sha256(skill.body)}`]),
);

const BUNDLED_OFFICE_SKILL_SOURCE_NAME = 'maka-officecli';
const BUNDLED_OFFICE_SKILL_SOURCE_VERSION = '1';

// Reverse-engineered built-in skills (shipped, install-on-demand). Distinct
// from the auto-seeded Office skills above: these never auto-install — the 内置
// tab offers a per-skill install action (installBundledSkill). Their installed
// copies carry a trusted `bundled` lock (sourceName maka-bundled) validated
// against these hashes.
const BUNDLED_CATALOG_SOURCE_NAME = 'maka-bundled';
const BUNDLED_CATALOG_SOURCE_VERSION = '1';
const BUNDLED_CATALOG_BODY_BY_ID = new Map(BUNDLED_REVERSE_ENGINEERED_SKILLS.map((skill) => [skill.id, skill.body]));
const BUNDLED_CATALOG_HASH_BY_ID = new Map(
  BUNDLED_REVERSE_ENGINEERED_SKILLS.map((skill) => [skill.id, `sha256:${sha256(skill.body)}`]),
);
const BUNDLED_CATALOG_CATEGORY_DEFAULT: ManagedSkillCategory = '效率工具';

const LEGACY_BUNDLED_OFFICE_SKILL_SHA256: Record<string, string[]> = {
  // v1 (legacy `officecli open/close` template) — migrated by the first tool-routed release.
  'officecli-docx': [
    '63f1690d1e9dea0a4e574bc3644222279fcfee336371d842c9669fbc91e89821',
    // v2 (tool-routed template without required-tools) — migrated to v3 so the
    // host-compatibility gate can see the Office tool requirement.
    'c0bcc16adcaa10329b4f3bbc7679f9e1c7bf99368af7fcbec8e870f5c0c5c039',
  ],
  'officecli-xlsx': [
    'dca3471c36da0628b6764711bde714958fcced13008cd8dfd4d548a5f02eda82',
    'cc13a4c0f17bb73d1fee6a0797cd4befa34ef1d8abcb7d6ea57bce26f5abd218',
  ],
  'officecli-pptx': [
    '21a933a459c921c3d7b14c7fc1cad59c7f72b7752903cd7d4e9083a1c835d302',
    'b9845739f855250fe55fb44efc4019856d566c7f8b299741df5c5c0fd70d6e5c',
  ],
};

/**
 * Scan `{workspaceRoot}/skills/` for directories that contain a SKILL.md.
 * Parse the YAML front-matter for `name`, `description`, and `allowed-tools`.
 * Errors per skill fall through silently so one malformed folder can't blank
 * the listing.
 *
 * `allowed-tools` is intentionally surfaced as "declared/requested" - never
 * granted. PermissionEngine remains the only authority over tool calls.
 */
export async function listInstalledSkills(root: string, options: SkillReadOptions = {}): Promise<InstalledSkill[]> {
  const definitions = await readInstalledSkillDefinitions(root, options);
  return definitions.map(({ content: _content, ...skill }) => skill);
}

export async function listSkillEntries(root: string): Promise<SkillEntry[]> {
  return (await listInstalledSkills(root)).map(toSkillEntry);
}

export function toSkillEntry(skill: InstalledSkill): SkillEntry {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    path: skill.path,
    declaredTools: skill.declaredTools,
    sourceType: skill.sourceType === 'bundled' || skill.sourceType === 'managed' || skill.sourceType === 'unknown'
      ? skill.sourceType
      : 'workspace',
    userModified: skill.userModified,
    validationStatus: skill.validationStatus,
    enabled: skill.enabled,
    runtimeStatus: skill.runtimeStatus,
    ...(skill.sourceType === 'managed' && skill.managedUpdateStatus ? { managedUpdateStatus: skill.managedUpdateStatus } : {}),
  };
}

export async function ensureBundledOfficeSkills(root: string): Promise<{ created: string[]; updated: string[]; skipped: string[]; failed: string[] }> {
  const created: string[] = [];
  const updated: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];
  const skillsDir = join(root, 'skills');

  let rootReal: string;
  let skillsReal: string;
  try {
    await mkdir(skillsDir, { recursive: true, mode: 0o700 });
    const skillsStat = await lstat(skillsDir);
    if (!skillsStat.isDirectory() || skillsStat.isSymbolicLink()) {
      return { created, updated, skipped, failed: BUNDLED_OFFICE_SKILLS.map((skill) => skill.id) };
    }
    [rootReal, skillsReal] = await Promise.all([realpath(root), realpath(skillsDir)]);
    if (!isPathInside(rootReal, skillsReal)) {
      return { created, updated, skipped, failed: BUNDLED_OFFICE_SKILLS.map((skill) => skill.id) };
    }
  } catch {
    return { created, updated, skipped, failed: BUNDLED_OFFICE_SKILLS.map((skill) => skill.id) };
  }

  for (const skill of BUNDLED_OFFICE_SKILLS) {
    const skillDir = join(skillsDir, skill.id);
    const skillFile = join(skillDir, 'SKILL.md');
    try {
      await mkdir(skillDir, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      });
      const skillReal = await realpath(skillDir);
      if (!isPathInside(skillsReal, skillReal)) {
        failed.push(skill.id);
        continue;
      }
      await writeFile(skillFile, skill.body, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      if (!await writeBundledSkillLock(skillDir, skill.id, skill.body)) {
        throw new Error('failed to write bundled skill lock');
      }
      created.push(skill.id);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        const migration = await migrateLegacyBundledOfficeSkill(skill.id, skillFile, skill.body);
        if (migration === 'updated') {
          updated.push(skill.id);
          continue;
        }
        if (migration === 'failed') {
          failed.push(skill.id);
          continue;
        }
        skipped.push(skill.id);
        continue;
      }
      failed.push(skill.id);
    }
  }

  return { created, updated, skipped, failed };
}

async function migrateLegacyBundledOfficeSkill(id: string, skillFile: string, currentBody: string): Promise<'updated' | 'skipped' | 'failed'> {
  const legacyHashes = LEGACY_BUNDLED_OFFICE_SKILL_SHA256[id] ?? [];
  if (legacyHashes.length === 0) return 'skipped';
  try {
    const existingStat = await lstat(skillFile);
    if (!existingStat.isFile() || existingStat.isSymbolicLink()) return 'skipped';
    const existing = await readFile(skillFile, 'utf8');
    if (!legacyHashes.includes(sha256(existing))) {
      if (sha256(existing) === sha256(currentBody)) {
        if (!await writeBundledSkillLock(dirname(skillFile), id, currentBody)) return 'failed';
      }
      return 'skipped';
    }
    await writeFile(skillFile, currentBody, { encoding: 'utf8', mode: 0o600 });
    if (!await writeBundledSkillLock(dirname(skillFile), id, currentBody)) return 'failed';
    return 'updated';
  } catch {
    return 'failed';
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

async function writeBundledSkillLock(skillDir: string, id: string, body: string): Promise<boolean> {
  const lockPath = join(skillDir, 'skill.lock.json');
  const contentSha256 = BUNDLED_OFFICE_SKILL_HASH_BY_ID.get(id) ?? `sha256:${sha256(body)}`;
  const existing = await readExistingRegularFile(lockPath);
  if (existing.kind === 'blocked') return false;
  if (existing.kind === 'file') {
    try {
      const parsed = JSON.parse(existing.content);
      if (isMatchingBundledSkillLock(parsed, id, contentSha256)) return true;
    } catch {
      // Invalid lock metadata is replaced by the trusted bundled writer.
    }
  }

  return writeSkillLock(skillDir, {
    schemaVersion: 1,
    id,
    sourceType: 'bundled',
    sourceName: BUNDLED_OFFICE_SKILL_SOURCE_NAME,
    sourceVersion: BUNDLED_OFFICE_SKILL_SOURCE_VERSION,
    contentSha256,
    installedAt: new Date().toISOString(),
  });
}

async function writeSkillLock(skillDir: string, lock: SkillLockFile): Promise<boolean> {
  const lockPath = join(skillDir, 'skill.lock.json');
  const tempPath = join(skillDir, `.skill.lock.json.${process.pid}.${Date.now()}.tmp`);
  try {
    await writeFile(tempPath, `${JSON.stringify(lock, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    const tempStat = await lstat(tempPath);
    if (!tempStat.isFile() || tempStat.isSymbolicLink()) {
      await unlink(tempPath).catch(() => {});
      return false;
    }
    await rename(tempPath, lockPath);
    return true;
  } catch {
    await unlink(tempPath).catch(() => {});
    return false;
  }
}

async function readExistingRegularFile(path: string): Promise<{ kind: 'missing' } | { kind: 'blocked' } | { kind: 'file'; content: string }> {
  try {
    const existingStat = await lstat(path);
    if (!existingStat.isFile() || existingStat.isSymbolicLink()) return { kind: 'blocked' };
    return { kind: 'file', content: await readFile(path, 'utf8') };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'blocked' };
  }
}

function isMatchingBundledSkillLock(value: unknown, id: string, contentSha256: string): boolean {
  if (!isRecord(value)) return false;
  return value.schemaVersion === 1 &&
    value.id === id &&
    value.sourceType === 'bundled' &&
    value.sourceName === BUNDLED_OFFICE_SKILL_SOURCE_NAME &&
    value.sourceVersion === BUNDLED_OFFICE_SKILL_SOURCE_VERSION &&
    typeof value.installedAt === 'string' &&
    value.installedAt.length > 0 &&
    typeof value.contentSha256 === 'string' &&
    value.contentSha256.toLowerCase() === contentSha256.toLowerCase();
}

const STARTER_SKILL_ID_PATTERN = /^starter-skill(?:-(\d+))?$/;

export async function createStarterSkill(root: string): Promise<CreateStarterSkillResult> {
  const skillsDir = join(root, 'skills');
  try {
    await mkdir(skillsDir, { recursive: true, mode: 0o700 });
    const skillsStat = await lstat(skillsDir);
    if (!skillsStat.isDirectory() || skillsStat.isSymbolicLink()) {
      return { ok: false, reason: 'blocked_path' };
    }
  } catch {
    return { ok: false, reason: 'write_failed' };
  }

  let skillsReal: string;
  try {
    skillsReal = await realpath(skillsDir);
  } catch {
    return { ok: false, reason: 'blocked_path' };
  }

  // Idempotent seeding: if a starter-skill (or starter-skill-N) already exists,
  // reuse the lowest-ordinal one instead of minting another. Clicking 添加 used
  // to spawn a fresh starter-skill-N per click, leaving duplicate 示例技能 rows
  // the user could not tell apart. Reuse the shared loader so the returned skill
  // carries the same parsed metadata every other surface sees.
  const existingStarter = (await listInstalledSkills(root))
    .map((skill) => {
      const match = STARTER_SKILL_ID_PATTERN.exec(skill.id);
      return match ? { skill, ordinal: match[1] ? Number(match[1]) : 1 } : null;
    })
    .filter((entry): entry is { skill: InstalledSkill; ordinal: number } => entry !== null)
    .sort((a, b) => a.ordinal - b.ordinal)[0];
  if (existingStarter) {
    return {
      ok: true,
      created: false,
      skill: existingStarter.skill,
      filePath: join(existingStarter.skill.path, 'SKILL.md'),
    };
  }

  for (let index = 1; index <= 99; index += 1) {
    const id = index === 1 ? 'starter-skill' : `starter-skill-${index}`;
    // Display name follows the id's ordinal — three clicks used to mint
    // three IDENTICAL 「示例技能」 rows (ids differed, names didn't, and the
    // slug lives in the tooltip), leaving the list visually indistinguishable.
    const name = index === 1 ? '示例技能' : `示例技能 ${index}`;
    const skillDir = join(skillsDir, id);
    try {
      await mkdir(skillDir, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      return { ok: false, reason: 'write_failed' };
    }

    try {
      const skillReal = await realpath(skillDir);
      if (!isPathInside(skillsReal, skillReal)) {
        return { ok: false, reason: 'blocked_path' };
      }

      const filePath = join(skillDir, 'SKILL.md');
      await writeFile(filePath, starterSkillTemplate(id, name), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      return {
        ok: true,
        created: true,
        filePath,
        skill: {
          id,
          name,
          description: '把常用工作流写成可复用的本地指令。',
          path: skillDir,
          declaredTools: ['Read'],
          requiredTools: [],
          requiredCapabilities: [],
          sourceType: 'workspace',
          userModified: false,
          validationStatus: 'missing_lock',
          validationCodes: ['missing_lock'],
          enabled: true,
          runtimeStatus: 'enabled',
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      return { ok: false, reason: 'write_failed' };
    }
  }

  return { ok: false, reason: 'already_exists' };
}

/**
 * Delete an installed skill directory under {root}/skills/<id>. Path-hardened
 * exactly like createStarterSkill / installManagedSkill: the skills dir and the
 * skill dir must both be real, contained directories (no symlinks, no escape
 * outside the workspace) before anything is removed. The recursive rm also
 * clears any managed-skill baseline metadata under the skill's .maka/ subtree.
 */
export async function deleteSkill(root: string, id: string): Promise<DeleteSkillResult> {
  if (!isSafeSkillId(id)) return { ok: false, reason: 'not_found' };

  const skillsDir = join(root, 'skills');
  let skillsReal: string;
  try {
    const [rootReal, skillsStat] = await Promise.all([realpath(root), lstat(skillsDir)]);
    if (!skillsStat.isDirectory() || skillsStat.isSymbolicLink()) return { ok: false, reason: 'blocked_path' };
    skillsReal = await realpath(skillsDir);
    if (!isPathInside(rootReal, skillsReal)) return { ok: false, reason: 'blocked_path' };
  } catch {
    return { ok: false, reason: 'not_found' };
  }

  const skillDir = join(skillsDir, id);
  let skillReal: string;
  try {
    const skillStat = await lstat(skillDir);
    if (!skillStat.isDirectory() || skillStat.isSymbolicLink()) return { ok: false, reason: 'blocked_path' };
    skillReal = await realpath(skillDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: false, reason: 'not_found' };
    return { ok: false, reason: 'blocked_path' };
  }
  if (!isPathInside(skillsReal, skillReal)) return { ok: false, reason: 'blocked_path' };

  try {
    await rm(skillReal, { recursive: true });
    return { ok: true };
  } catch {
    return { ok: false, reason: 'delete_failed' };
  }
}

export async function installManagedSkill(
  root: string,
  sourceId: string,
  sourceRoot = resolveManagedSkillSourcesRoot(),
): Promise<
  | { ok: true; skill: InstalledSkill }
  | { ok: false; reason: 'not_found' | 'already_exists' | 'blocked_path' | 'write_failed' }
> {
  if (!isSafeSkillId(sourceId)) return { ok: false, reason: 'not_found' };
  const source = await readManagedSkillSource(sourceRoot, sourceId);
  if (!source.ok) {
    if (source.reason === 'blocked_path') return { ok: false, reason: 'blocked_path' };
    return { ok: false, reason: 'not_found' };
  }

  const skillsDir = join(root, 'skills');
  let skillsReal: string;
  try {
    await mkdir(skillsDir, { recursive: true, mode: 0o700 });
    const skillsStat = await lstat(skillsDir);
    if (!skillsStat.isDirectory() || skillsStat.isSymbolicLink()) return { ok: false, reason: 'blocked_path' };
    const rootReal = await realpath(root);
    skillsReal = await realpath(skillsDir);
    if (!isPathInside(rootReal, skillsReal)) return { ok: false, reason: 'blocked_path' };
  } catch {
    return { ok: false, reason: 'write_failed' };
  }

  const skillDir = join(skillsDir, sourceId);
  const skillFile = join(skillDir, 'SKILL.md');
  let createdSkillDir = false;
  try {
    await mkdir(skillDir, { mode: 0o700 });
    createdSkillDir = true;
    const skillReal = await realpath(skillDir);
    if (!isPathInside(skillsReal, skillReal)) {
      if (createdSkillDir) await rm(skillDir, { recursive: true, force: true }).catch(() => {});
      return { ok: false, reason: 'blocked_path' };
    }
    await writeFile(skillFile, source.content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    if (!await writeSkillLock(skillDir, managedSkillLock(sourceId, source.contentSha256, source.contentSha256))) {
      if (createdSkillDir) await rm(skillDir, { recursive: true, force: true }).catch(() => {});
      return { ok: false, reason: 'write_failed' };
    }
    if (!await writeManagedSkillBaseline(skillDir, source.content)) {
      if (createdSkillDir) await rm(skillDir, { recursive: true, force: true }).catch(() => {});
      return { ok: false, reason: 'write_failed' };
    }
    const installed = await listInstalledSkills(root, { managedSourceRoot: sourceRoot });
    const skill = installed.find((candidate) => candidate.id === sourceId);
    if (!skill) {
      if (createdSkillDir) await rm(skillDir, { recursive: true, force: true }).catch(() => {});
      return { ok: false, reason: 'write_failed' };
    }
    return { ok: true, skill };
  } catch (error) {
    if (createdSkillDir) await rm(skillDir, { recursive: true, force: true }).catch(() => {});
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return { ok: false, reason: 'already_exists' };
    return { ok: false, reason: 'write_failed' };
  }
}

export interface BundledSkillCatalogEntry {
  id: string;
  name: string;
  description: string;
  category: ManagedSkillCategory;
  declaredTools: string[];
  installed: boolean;
}

export type InstallBundledSkillResult =
  | { ok: true; skill: InstalledSkill }
  | { ok: false; reason: 'not_found' | 'already_exists' | 'blocked_path' | 'write_failed' };

function parseBundledSkillCategory(body: string): ManagedSkillCategory {
  if (!body.startsWith('---')) return BUNDLED_CATALOG_CATEGORY_DEFAULT;
  const close = body.indexOf('\n---', 3);
  if (close < 0) return BUNDLED_CATALOG_CATEGORY_DEFAULT;
  for (const raw of body.slice(3, close).split(/\r?\n/)) {
    const match = raw.match(/^category:\s*(.*)$/);
    if (!match) continue;
    const value = match[1].trim().replace(/^['"]|['"]$/g, '');
    return (MANAGED_SKILL_CATEGORIES as readonly string[]).includes(value)
      ? (value as ManagedSkillCategory)
      : BUNDLED_CATALOG_CATEGORY_DEFAULT;
  }
  return BUNDLED_CATALOG_CATEGORY_DEFAULT;
}

/**
 * The built-in (内置) catalog: the auto-seeded Office skills plus the
 * reverse-engineered skills. `installed` reflects whether the current workspace
 * already has skills/<id>. The renderer surfaces this under the 内置 tab with a
 * per-entry install action that calls `installBundledSkill`.
 */
export async function listBundledSkillCatalog(root: string): Promise<BundledSkillCatalogEntry[]> {
  const installedIds = new Set((await listInstalledSkills(root)).map((skill) => skill.id));
  return [...BUNDLED_OFFICE_SKILLS, ...BUNDLED_REVERSE_ENGINEERED_SKILLS]
    .map(({ id, body }) => {
      const { name, description, allowedTools } = parseSkillFrontMatter(body);
      return {
        id,
        name: name ?? id,
        description: description ?? '',
        category: parseBundledSkillCategory(body),
        declaredTools: allowedTools,
        installed: installedIds.has(id),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function writeBundledCatalogLock(skillDir: string, id: string, body: string): Promise<boolean> {
  const contentSha256 = BUNDLED_CATALOG_HASH_BY_ID.get(id) ?? `sha256:${sha256(body)}`;
  return writeSkillLock(skillDir, {
    schemaVersion: 1,
    id,
    sourceType: 'bundled',
    sourceName: BUNDLED_CATALOG_SOURCE_NAME,
    sourceVersion: BUNDLED_CATALOG_SOURCE_VERSION,
    contentSha256,
    installedAt: new Date().toISOString(),
  });
}

/**
 * Install a built-in catalog skill into {root}/skills/<id> on demand. Mirrors
 * installManagedSkill's hardened write path (containment checks, fail-if-exists)
 * but sources the body from the shipped catalog. Office ids get the Office
 * bundled lock; reverse-engineered ids get the maka-bundled catalog lock.
 */
export async function installBundledSkill(root: string, id: string): Promise<InstallBundledSkillResult> {
  if (!isSafeSkillId(id)) return { ok: false, reason: 'not_found' };
  const officeBody = BUNDLED_OFFICE_SKILLS.find((skill) => skill.id === id)?.body;
  const body = officeBody ?? BUNDLED_CATALOG_BODY_BY_ID.get(id);
  if (body === undefined) return { ok: false, reason: 'not_found' };

  const skillsDir = join(root, 'skills');
  let skillsReal: string;
  try {
    await mkdir(skillsDir, { recursive: true, mode: 0o700 });
    const skillsStat = await lstat(skillsDir);
    if (!skillsStat.isDirectory() || skillsStat.isSymbolicLink()) return { ok: false, reason: 'blocked_path' };
    const rootReal = await realpath(root);
    skillsReal = await realpath(skillsDir);
    if (!isPathInside(rootReal, skillsReal)) return { ok: false, reason: 'blocked_path' };
  } catch {
    return { ok: false, reason: 'write_failed' };
  }

  const skillDir = join(skillsDir, id);
  const skillFile = join(skillDir, 'SKILL.md');
  let createdSkillDir = false;
  try {
    await mkdir(skillDir, { mode: 0o700 });
    createdSkillDir = true;
    const skillReal = await realpath(skillDir);
    if (!isPathInside(skillsReal, skillReal)) {
      await rm(skillDir, { recursive: true, force: true }).catch(() => {});
      return { ok: false, reason: 'blocked_path' };
    }
    await writeFile(skillFile, body, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    const lockWritten = officeBody !== undefined
      ? await writeBundledSkillLock(skillDir, id, body)
      : await writeBundledCatalogLock(skillDir, id, body);
    if (!lockWritten) {
      await rm(skillDir, { recursive: true, force: true }).catch(() => {});
      return { ok: false, reason: 'write_failed' };
    }
    const installed = await listInstalledSkills(root);
    const skill = installed.find((candidate) => candidate.id === id);
    if (!skill) {
      await rm(skillDir, { recursive: true, force: true }).catch(() => {});
      return { ok: false, reason: 'write_failed' };
    }
    return { ok: true, skill };
  } catch (error) {
    if (createdSkillDir) await rm(skillDir, { recursive: true, force: true }).catch(() => {});
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return { ok: false, reason: 'already_exists' };
    return { ok: false, reason: 'write_failed' };
  }
}

export async function updateManagedSkill(
  root: string,
  skillId: string,
  sourceRoot = resolveManagedSkillSourcesRoot(),
  options: ManagedSkillUpdateOptions = {},
): Promise<
  | { ok: true; skill: InstalledSkill }
  | { ok: false; reason: 'not_managed' | 'source_missing' | 'local_modified' | 'metadata_error' | 'blocked_path' | 'write_failed' }
> {
  if (!isSafeSkillId(skillId)) return { ok: false, reason: 'not_managed' };
  const updateTarget = await resolveSkillFileUpdateTarget(root, skillId);
  if (!updateTarget.ok && updateTarget.reason === 'blocked_path') return { ok: false, reason: 'blocked_path' };
  const installed = await listInstalledSkills(root, { managedSourceRoot: sourceRoot });
  const skill = installed.find((candidate) => candidate.id === skillId);
  if (!skill) return { ok: false, reason: 'not_managed' };
  if (skill.validationStatus === 'metadata_error' || skill.managedUpdateStatus === 'metadata_error') {
    return { ok: false, reason: 'metadata_error' };
  }
  if (skill.sourceType !== 'managed' || !skill.managedSourceId) return { ok: false, reason: 'not_managed' };
  if (skill.managedUpdateStatus === 'local_modified' && !options.force) return { ok: false, reason: 'local_modified' };
  if (skill.managedUpdateStatus === 'source_missing') return { ok: false, reason: 'source_missing' };

  const source = await readManagedSkillSource(sourceRoot, skill.managedSourceId);
  if (!source.ok) {
    if (source.reason === 'blocked_path') return { ok: false, reason: 'blocked_path' };
    return { ok: false, reason: 'source_missing' };
  }

  const skillDir = join(root, 'skills', skillId);
  const skillFile = join(skillDir, 'SKILL.md');
  const lockFile = join(skillDir, 'skill.lock.json');
  try {
    const [skillsReal, skillReal, current, currentLock] = await Promise.all([
      realpath(join(root, 'skills')),
      realpath(skillDir),
      readContainedRegularTextFile(skillDir, skillFile),
      readContainedRegularTextFile(skillDir, lockFile),
    ]);
    if (!isPathInside(skillsReal, skillReal)) return { ok: false, reason: 'blocked_path' };
    if (!current.ok) return { ok: false, reason: current.reason === 'blocked_path' ? 'blocked_path' : 'write_failed' };
    if (!currentLock.ok) return { ok: false, reason: currentLock.reason === 'blocked_path' ? 'blocked_path' : 'write_failed' };

    const hasExpectedHashes = options.expectedCurrentSha256 !== undefined || options.expectedSourceSha256 !== undefined;
    if (options.force || hasExpectedHashes) {
      if (
        !isSha256(options.expectedCurrentSha256) ||
        !isSha256(options.expectedSourceSha256) ||
        current.sha256.toLowerCase() !== options.expectedCurrentSha256.toLowerCase() ||
        source.contentSha256.toLowerCase() !== options.expectedSourceSha256.toLowerCase()
      ) {
        return { ok: false, reason: 'local_modified' };
      }
    }
    const previousBaseline = await readManagedSkillBaseline(skillDir);
    const restorePrevious = async () => {
      await writeContainedRegularTextFile(skillDir, skillFile, current.content).catch(() => {});
      await writeContainedRegularTextFile(skillDir, lockFile, currentLock.content).catch(() => {});
      if (previousBaseline !== undefined) {
        await writeManagedSkillBaseline(skillDir, previousBaseline).catch(() => {});
      } else {
        await removeManagedSkillBaseline(skillDir).catch(() => {});
      }
    };

    if (!await writeContainedRegularTextFile(skillDir, skillFile, source.content)) {
      return { ok: false, reason: 'write_failed' };
    }
    if (!await writeSkillLock(skillDir, managedSkillLock(skillId, source.contentSha256, source.contentSha256, skill.managedSourceId))) {
      await restorePrevious();
      return { ok: false, reason: 'write_failed' };
    }
    if (!await writeManagedSkillBaseline(skillDir, source.content)) {
      await restorePrevious();
      return { ok: false, reason: 'write_failed' };
    }
    const refreshed = await listInstalledSkills(root, { managedSourceRoot: sourceRoot });
    const updated = refreshed.find((candidate) => candidate.id === skillId);
    if (!updated) {
      await restorePrevious();
      return { ok: false, reason: 'write_failed' };
    }
    return { ok: true, skill: updated };
  } catch {
    return { ok: false, reason: 'write_failed' };
  }
}

async function resolveSkillFileUpdateTarget(root: string, skillId: string): Promise<
  | { ok: true }
  | { ok: false; reason: 'missing' | 'blocked_path' }
> {
  const skillsDir = join(root, 'skills');
  const skillDir = join(skillsDir, skillId);
  const skillFile = join(skillDir, 'SKILL.md');
  try {
    const [rootReal, skillsStat] = await Promise.all([realpath(root), lstat(skillsDir)]);
    if (!skillsStat.isDirectory() || skillsStat.isSymbolicLink()) return { ok: false, reason: 'blocked_path' };
    const skillsReal = await realpath(skillsDir);
    if (!isPathInside(rootReal, skillsReal)) return { ok: false, reason: 'blocked_path' };

    const skillStat = await lstat(skillDir);
    if (!skillStat.isDirectory() || skillStat.isSymbolicLink()) return { ok: false, reason: 'blocked_path' };
    const skillReal = await realpath(skillDir);
    if (!isPathInside(skillsReal, skillReal)) return { ok: false, reason: 'blocked_path' };

    const fileStat = await lstat(skillFile);
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) return { ok: false, reason: 'blocked_path' };
    const fileReal = await realpath(skillFile);
    if (!isPathInside(skillReal, fileReal)) return { ok: false, reason: 'blocked_path' };
    return { ok: true };
  } catch {
    return { ok: false, reason: 'missing' };
  }
}

export async function getSkillGovernanceDetails(
  root: string,
  skillId: string,
  sourceRoot = resolveManagedSkillSourcesRoot(),
): Promise<
  | { ok: true; details: SkillGovernanceDetails }
  | { ok: false; reason: 'not_found' | 'invalid_id' }
> {
  if (!isSafeSkillId(skillId)) return { ok: false, reason: 'invalid_id' };
  const installed = await listInstalledSkills(root, { managedSourceRoot: sourceRoot });
  const skill = installed.find((candidate) => candidate.id === skillId);
  if (!skill) return { ok: false, reason: 'not_found' };
  return { ok: true, details: await toSkillGovernanceDetails(skill, sourceRoot) };
}

export async function previewManagedSkillUpdate(
  root: string,
  skillId: string,
  sourceRoot = resolveManagedSkillSourcesRoot(),
): Promise<
  | { ok: true; preview: ManagedSkillUpdatePreview }
  | { ok: false; reason: 'not_managed' | 'source_missing' | 'metadata_error' | 'blocked_path' | 'read_failed' }
> {
  if (!isSafeSkillId(skillId)) return { ok: false, reason: 'not_managed' };
  const updateTarget = await resolveSkillFileUpdateTarget(root, skillId);
  if (!updateTarget.ok && updateTarget.reason === 'blocked_path') return { ok: false, reason: 'blocked_path' };
  const installed = await listInstalledSkills(root, { managedSourceRoot: sourceRoot });
  const skill = installed.find((candidate) => candidate.id === skillId);
  if (!skill || skill.sourceType !== 'managed' || !skill.managedSourceId) return { ok: false, reason: 'not_managed' };
  if (skill.validationStatus === 'metadata_error' || skill.managedUpdateStatus === 'metadata_error') {
    return { ok: false, reason: 'metadata_error' };
  }
  if (skill.managedUpdateStatus === 'source_missing') return { ok: false, reason: 'source_missing' };

  const source = await readManagedSkillSource(sourceRoot, skill.managedSourceId);
  if (!source.ok) {
    if (source.reason === 'blocked_path') return { ok: false, reason: 'blocked_path' };
    return { ok: false, reason: 'source_missing' };
  }

  const skillDir = join(root, 'skills', skillId);
  const skillFile = join(skillDir, 'SKILL.md');
  try {
    const [skillsReal, skillReal, current] = await Promise.all([
      realpath(join(root, 'skills')),
      realpath(skillDir),
      readContainedRegularTextFile(skillDir, skillFile),
    ]);
    if (!isPathInside(skillsReal, skillReal)) return { ok: false, reason: 'blocked_path' };
    if (!current.ok) return { ok: false, reason: current.reason === 'blocked_path' ? 'blocked_path' : 'read_failed' };
    const baselineContent = await readManagedSkillBaseline(skillDir);
    return {
      ok: true,
      preview: {
        skill: await toSkillGovernanceDetails(skill, sourceRoot),
        currentContent: current.content,
        sourceContent: source.content,
        ...(baselineContent !== undefined ? { baselineContent } : {}),
        expectedCurrentSha256: current.sha256,
        expectedSourceSha256: source.contentSha256,
        summary: diffSummary(current.content, source.content),
      },
    };
  } catch {
    return { ok: false, reason: 'read_failed' };
  }
}

async function toSkillGovernanceDetails(skill: InstalledSkill, sourceRoot: string): Promise<SkillGovernanceDetails> {
  const baselineContent = skill.sourceType === 'managed'
    ? await readManagedSkillBaseline(skill.path)
    : undefined;
  let sourceAvailable: boolean | undefined;
  let sourceChanged: boolean | undefined;
  if (skill.sourceType === 'managed' && skill.managedSourceId) {
    const source = await readManagedSkillSource(sourceRoot, skill.managedSourceId);
    sourceAvailable = source.ok;
    sourceChanged = source.ok && skill.sourceContentSha256 !== undefined
      ? source.contentSha256.toLowerCase() !== skill.sourceContentSha256.toLowerCase()
      : undefined;
  }
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    path: skill.path,
    declaredTools: skill.declaredTools,
    sourceType: skill.sourceType,
    userModified: skill.userModified,
    validationStatus: skill.validationStatus,
    enabled: skill.enabled,
    runtimeStatus: skill.runtimeStatus,
    validationCodes: skill.validationCodes,
    validationMessages: skill.validationMessages ?? [],
    ...(skill.managedSourceId ? { managedSourceId: skill.managedSourceId } : {}),
    ...(skill.managedUpdateStatus ? { managedUpdateStatus: skill.managedUpdateStatus } : {}),
    hasManagedBaseline: baselineContent !== undefined,
    ...(sourceAvailable !== undefined ? { sourceAvailable } : {}),
    ...(sourceChanged !== undefined ? { sourceChanged } : {}),
  };
}

async function writeManagedSkillBaseline(skillDir: string, content: string): Promise<boolean> {
  try {
    const metadataDir = join(skillDir, '.maka');
    await mkdir(metadataDir, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
    const baselineDir = join(metadataDir, 'baseline');
    await mkdir(baselineDir, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });

    const resolved = await resolveManagedSkillBaselineDir(skillDir);
    if (!resolved.ok) return false;
    return writeContainedRegularTextFile(resolved.baselineDir, join(resolved.baselineDir, 'SKILL.md'), content);
  } catch {
    return false;
  }
}

async function readManagedSkillBaseline(skillDir: string): Promise<string | undefined> {
  const resolved = await resolveManagedSkillBaselineDir(skillDir);
  if (!resolved.ok) return undefined;
  const baselineFile = join(resolved.baselineDir, 'SKILL.md');
  const baseline = await readContainedRegularTextFile(resolved.baselineDir, baselineFile);
  return baseline.ok ? baseline.content : undefined;
}

async function removeManagedSkillBaseline(skillDir: string): Promise<void> {
  const resolved = await resolveManagedSkillBaselineDir(skillDir);
  if (!resolved.ok) return;
  const baselineFile = join(resolved.baselineDir, 'SKILL.md');
  const [baselineReal, fileStat] = await Promise.all([
    realpath(resolved.baselineDir),
    lstat(baselineFile).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    }),
  ]);
  if (fileStat === null) return;
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) return;
  const fileReal = await realpath(baselineFile);
  if (!isPathInside(baselineReal, fileReal)) return;
  await unlink(baselineFile);
}

async function resolveManagedSkillBaselineDir(skillDir: string): Promise<
  | { ok: true; baselineDir: string }
  | { ok: false }
> {
  try {
    const metadataDir = join(skillDir, '.maka');
    const baselineDir = join(metadataDir, 'baseline');
    const [skillReal, metadataStat, baselineStat] = await Promise.all([
      realpath(skillDir),
      lstat(metadataDir),
      lstat(baselineDir),
    ]);
    if (
      !metadataStat.isDirectory() ||
      metadataStat.isSymbolicLink() ||
      !baselineStat.isDirectory() ||
      baselineStat.isSymbolicLink()
    ) {
      return { ok: false };
    }
    const [metadataReal, baselineReal] = await Promise.all([realpath(metadataDir), realpath(baselineDir)]);
    if (!isPathInside(skillReal, metadataReal) || !isPathInside(metadataReal, baselineReal)) return { ok: false };
    return { ok: true, baselineDir };
  } catch {
    return { ok: false };
  }
}

export async function setSkillEnabled(root: string, skillId: string, enabled: boolean): Promise<SetSkillEnabledResult> {
  if (!isSafeSkillId(skillId)) return { ok: false, reason: 'not_found' };
  const openPath = await resolveSkillOpenPath(root, skillId, 'file');
  if (!openPath.ok) {
    return { ok: false, reason: openPath.reason === 'blocked_path' ? 'blocked_path' : 'not_found' };
  }

  const current = await readSkillRuntimeState(root);
  if (!current.ok) {
    return { ok: false, reason: current.reason === 'blocked_path' ? 'blocked_path' : 'state_error' };
  }
  current.states.set(skillId, enabled);
  const written = await writeSkillRuntimeState(root, current.states);
  if (!written.ok) return written;

  const refreshed = await listSkillEntries(root);
  const skill = refreshed.find((candidate) => candidate.id === skillId);
  if (!skill) return { ok: false, reason: 'not_found' };
  return { ok: true, skill };
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/i.test(value);
}

function diffSummary(currentContent: string, sourceContent: string): ManagedSkillUpdatePreview['summary'] {
  const currentLines = splitLines(currentContent);
  const sourceLines = splitLines(sourceContent);
  const max = Math.max(currentLines.length, sourceLines.length);
  let changedLineCount = 0;
  for (let index = 0; index < max; index += 1) {
    if (currentLines[index] !== sourceLines[index]) changedLineCount += 1;
  }
  return {
    currentLineCount: currentLines.length,
    sourceLineCount: sourceLines.length,
    changedLineCount,
  };
}

function splitLines(content: string): string[] {
  if (content.length === 0) return [];
  return content.replace(/\r\n/g, '\n').split('\n');
}

function managedSkillLock(
  id: string,
  contentSha256: string,
  sourceContentSha256: string,
  sourceId = id,
): SkillLockFile {
  return {
    schemaVersion: 1,
    id,
    sourceType: 'managed',
    sourceName: 'local-library',
    sourceVersion: '1',
    contentSha256,
    installedAt: new Date().toISOString(),
    sourceId,
    sourceContentSha256,
  };
}

export async function resolveSkillOpenPath(
  root: string,
  id: string,
  target: SkillOpenTarget,
): Promise<ResolveSkillOpenPathResult> {
  if (!isSafeSkillId(id)) return { ok: false, reason: 'invalid_id' };
  if (target !== 'file' && target !== 'directory') return { ok: false, reason: 'missing' };

  const skillsDir = join(root, 'skills');
  let rootReal: string;
  let skillsReal: string;
  try {
    [rootReal, skillsReal] = await Promise.all([realpath(root), realpath(skillsDir)]);
  } catch {
    return { ok: false, reason: 'missing' };
  }
  if (!isPathInside(rootReal, skillsReal)) return { ok: false, reason: 'blocked_path' };

  const skillDir = join(skillsDir, id);
  const candidate = target === 'file' ? join(skillDir, 'SKILL.md') : skillDir;
  let openedPath: string;
  try {
    openedPath = await realpath(candidate);
  } catch {
    return { ok: false, reason: 'missing' };
  }
  if (!isPathInside(skillsReal, openedPath)) return { ok: false, reason: 'blocked_path' };

  const openedStat = await stat(openedPath).catch(() => null);
  if (!openedStat) return { ok: false, reason: 'missing' };
  if (target === 'file' && !openedStat.isFile()) return { ok: false, reason: 'not_file' };
  if (target === 'directory' && !openedStat.isDirectory()) return { ok: false, reason: 'not_directory' };
  return { ok: true, path: openedPath, target };
}

async function readInstalledSkillDefinitions(root: string, options: SkillReadOptions = {}): Promise<InstalledSkillDefinition[]> {
  const scanned = await scanWorkspaceSkills(root);
  const out: InstalledSkillDefinition[] = [];
  for (const skill of scanned) {
    const status = await readSkillLockStatus(skill.path, skill.id, skill.contentSha256, options);
    out.push({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      path: skill.path,
      declaredTools: skill.declaredTools,
      requiredTools: skill.requiredTools,
      requiredCapabilities: skill.requiredCapabilities,
      enabled: skill.enabled,
      runtimeStatus: skill.runtimeStatus,
      content: skill.content,
      ...status,
    });
  }
  return out;
}

async function readSkillLockStatus(skillPath: string, id: string, currentHash: string, options: SkillReadOptions = {}): Promise<Pick<
  InstalledSkill,
  | 'sourceType'
  | 'sourceName'
  | 'sourceVersion'
  | 'contentSha256'
  | 'installedAt'
  | 'userModified'
  | 'validationStatus'
  | 'validationCodes'
  | 'validationMessages'
  | 'managedSourceId'
  | 'managedUpdateStatus'
  | 'sourceContentSha256'
>> {
  const lockPath = join(skillPath, 'skill.lock.json');
  let lockStat: Awaited<ReturnType<typeof lstat>>;
  try {
    lockStat = await lstat(lockPath);
  } catch {
    return {
      sourceType: 'workspace',
      userModified: false,
      validationStatus: 'missing_lock',
      validationCodes: ['missing_lock'],
      managedUpdateStatus: 'not_managed',
    };
  }

  if (!lockStat.isFile() || lockStat.isSymbolicLink()) {
    return metadataError(['lock_symlink'], 'Skill lock is not a regular file.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(lockPath, 'utf8'));
  } catch {
    return metadataError(['invalid_json'], 'Skill lock JSON is invalid.');
  }

  if (!isRecord(parsed)) return metadataError(['invalid_json'], 'Skill lock JSON must be an object.');
  if (parsed.schemaVersion !== 1) return metadataError(['unsupported_schema'], 'Skill lock schema is unsupported.');
  if (parsed.id !== id) return metadataError(['id_mismatch'], 'Skill lock id does not match the skill directory.');
  if (parsed.sourceType !== 'bundled' && parsed.sourceType !== 'managed') {
    return metadataError(['unsupported_schema'], 'Skill lock source type is unsupported.');
  }
  if (typeof parsed.contentSha256 !== 'string' || !/^sha256:[a-f0-9]{64}$/i.test(parsed.contentSha256)) {
    return metadataError(['invalid_hash'], 'Skill lock hash is invalid.');
  }
  if (parsed.sourceType === 'bundled' && !isTrustedBundledSkillLockSource(parsed, id)) {
    return metadataError(['unsupported_schema'], 'Skill lock source is not trusted in this Maka version.');
  }

  const userModified = parsed.contentSha256.toLowerCase() !== currentHash.toLowerCase();
  const managed = parsed.sourceType === 'managed'
    ? await managedStatusForLock(parsed, userModified, options.managedSourceRoot)
    : { managedUpdateStatus: 'not_managed' as const };
  if (managed.managedUpdateStatus === 'metadata_error') {
    return metadataError(['unsupported_schema'], 'Managed skill lock source metadata is invalid.');
  }
  return {
    sourceType: parsed.sourceType,
    ...(typeof parsed.sourceName === 'string' && parsed.sourceName ? { sourceName: parsed.sourceName } : {}),
    ...(typeof parsed.sourceVersion === 'string' && parsed.sourceVersion ? { sourceVersion: parsed.sourceVersion } : {}),
    ...(typeof parsed.installedAt === 'string' && parsed.installedAt ? { installedAt: parsed.installedAt } : {}),
    contentSha256: parsed.contentSha256,
    userModified,
    validationStatus: userModified ? 'modified' : 'ok',
    validationCodes: userModified ? ['modified'] : [],
    ...managed,
  };
}

async function managedStatusForLock(
  lock: Record<string, unknown>,
  userModified: boolean,
  managedSourceRoot = resolveManagedSkillSourcesRoot(),
): Promise<Pick<InstalledSkill, 'managedSourceId' | 'managedUpdateStatus' | 'sourceContentSha256'>> {
  if (lock.sourceName !== 'local-library' || lock.sourceVersion !== '1') {
    return { managedUpdateStatus: 'metadata_error' };
  }
  const sourceId = typeof lock.sourceId === 'string' && isSafeSkillId(lock.sourceId) ? lock.sourceId : undefined;
  const sourceContentSha256 = typeof lock.sourceContentSha256 === 'string' && /^sha256:[a-f0-9]{64}$/i.test(lock.sourceContentSha256)
    ? lock.sourceContentSha256
    : undefined;
  if (!sourceId || !sourceContentSha256) {
    return {
      ...(sourceId ? { managedSourceId: sourceId } : {}),
      managedUpdateStatus: 'metadata_error',
      ...(sourceContentSha256 ? { sourceContentSha256 } : {}),
    };
  }
  if (
    typeof lock.contentSha256 !== 'string' ||
    lock.contentSha256.toLowerCase() !== sourceContentSha256.toLowerCase()
  ) {
    return { managedSourceId: sourceId, managedUpdateStatus: 'metadata_error', sourceContentSha256 };
  }
  if (userModified) {
    return { managedSourceId: sourceId, managedUpdateStatus: 'local_modified', sourceContentSha256 };
  }
  const source = await readManagedSkillSource(managedSourceRoot, sourceId);
  if (!source.ok) {
    return { managedSourceId: sourceId, managedUpdateStatus: 'source_missing', sourceContentSha256 };
  }
  return {
    managedSourceId: sourceId,
    managedUpdateStatus: source.contentSha256 === sourceContentSha256 ? 'up_to_date' : 'update_available',
    sourceContentSha256,
  };
}

function isTrustedBundledSkillLockSource(lock: Record<string, unknown>, id: string): boolean {
  if (lock.sourceType !== 'bundled' || typeof lock.contentSha256 !== 'string') return false;
  const lockHash = lock.contentSha256.replace(/^sha256:/i, '').toLowerCase();

  if (BUNDLED_OFFICE_SKILL_IDS.has(id)) {
    if (lock.sourceName !== BUNDLED_OFFICE_SKILL_SOURCE_NAME || lock.sourceVersion !== BUNDLED_OFFICE_SKILL_SOURCE_VERSION) return false;
    // A bundled lock is trusted if its content hash matches the current bundled
    // template or any legacy bundled template that desktop still migrates from.
    // This keeps user-modified legacy skills at validationStatus 'modified'
    // instead of 'metadata_error' across a template bump.
    const newHash = BUNDLED_OFFICE_SKILL_HASH_BY_ID.get(id)?.replace(/^sha256:/i, '').toLowerCase();
    const trusted = new Set<string>([
      ...(newHash ? [newHash] : []),
      ...(LEGACY_BUNDLED_OFFICE_SKILL_SHA256[id] ?? []),
    ]);
    return trusted.has(lockHash);
  }

  // Reverse-engineered built-in catalog skills.
  const catalogHash = BUNDLED_CATALOG_HASH_BY_ID.get(id)?.replace(/^sha256:/i, '').toLowerCase();
  if (!catalogHash) return false;
  return lock.sourceName === BUNDLED_CATALOG_SOURCE_NAME &&
    lock.sourceVersion === BUNDLED_CATALOG_SOURCE_VERSION &&
    lockHash === catalogHash;
}

function metadataError(validationCodes: SkillValidationCode[], message: string): Pick<
  InstalledSkill,
  'sourceType' | 'userModified' | 'validationStatus' | 'validationCodes' | 'validationMessages' | 'managedUpdateStatus'
> {
  return {
    sourceType: 'unknown',
    userModified: false,
    validationStatus: 'metadata_error',
    validationCodes,
    validationMessages: [message],
    managedUpdateStatus: 'metadata_error',
  };
}

function starterSkillTemplate(id: string, name: string): string {
  return `---
name: ${name}
description: 把常用工作流写成可复用的本地指令。
allowed-tools:
  - Read
---

# ${name}

当用户要求你按固定流程完成某类任务时，先加载这个技能。

## 使用方式

1. 先确认用户的目标、输入材料和交付格式。
2. 阅读必要的本地文件或上下文，只收集完成任务需要的信息。
3. 按步骤输出结果；如果需要改文件，先说明要改哪里和原因。

## 边界

- 这个技能声明的工具只是需求提示，不会自动获得权限。
- 不要把敏感内容写进这里；它会作为本地技能指令进入模型上下文。
- 如果这个模板不适合你的工作流，可以直接改名或删除 ${id}。
`;
}

function officeCliDocxSkillTemplate(): string {
  return `---
name: OfficeCLI DOCX
description: Use when a .docx, Word document, report, memo, proposal, letter, tracked changes, comments, header/footer, table of contents, or Word template is involved.
allowed-tools:
  - OfficeDocument
  - OfficeDocumentEdit
  - Read
required-tools:
  - OfficeDocument
  - OfficeDocumentEdit
---

# OfficeCLI DOCX

Use this skill for Word document work. Route document inspection and edits through Maka's bounded Office document tools.

## Boundary

- Use \`OfficeDocument\` for read-only inspection: \`help\`, \`view\`, \`get\`, \`query\`, and \`validate\`.
- Use \`OfficeDocumentEdit\` only for supported writes: \`create\`, \`add\`, \`set\`, and \`remove\`. It is permission-gated and path-bound to the session cwd.
- Do not call Bash or raw \`officecli\` directly unless the user explicitly asks for shell-level debugging and the normal permission flow allows it.
- Prefer \`OfficeDocument\` \`help\` with \`topic: "docx"\` before guessing selectors or properties. Installed help is authoritative.
- Quote semantic paths: \`"/body/p[1]"\`, \`"/footer[1]"\`.
- Unsupported paths stay unsupported: no resident \`open\`/\`close\`, \`html\` view, \`raw\`, \`watch\`, or \`batch\`.

## Workflow

1. Orient with \`OfficeDocument\` \`view\` \`outline\`, then \`view\` \`text\` or \`get\` the needed paths.
2. For edits, use \`OfficeDocumentEdit\` in small steps and verify each structural step with \`OfficeDocument\` \`get\` or \`view\`.
3. For generated documents, build hierarchy first: Title, Heading 1, Heading 2, body; then tables/images/fields; then headers/footers.
4. Use explicit typography. Body 11-12pt; H1 at least 18pt; H2 around 14pt; spacing via paragraph properties, not blank paragraphs.
5. Add live page-number fields for documents longer than one page when the installed adapter supports the needed field properties. Verify fields with \`OfficeDocument\` \`get\` on \`"/footer[1]"\` at bounded depth.
6. Final QA: \`OfficeDocument\` \`validate\` plus \`view\` \`outline\`, \`stats\`, \`issues\`, or \`annotated\`. Fix placeholder tokens, clipped tables, empty-paragraph spacing, static page numbers, and missing TOC on heading-heavy documents before reporting done.
`;
}

function officeCliXlsxSkillTemplate(): string {
  return `---
name: OfficeCLI XLSX
description: Use when a .xlsx, Excel workbook, spreadsheet, CSV/TSV import, tracker, dashboard, financial model, formula, chart, pivot table, or worksheet template is involved.
allowed-tools:
  - OfficeDocument
  - OfficeDocumentEdit
  - Read
required-tools:
  - OfficeDocument
  - OfficeDocumentEdit
---

# OfficeCLI XLSX

Use this skill for spreadsheet work. Route workbook inspection and edits through Maka's bounded Office document tools.

## Boundary

- Use \`OfficeDocument\` for read-only inspection: \`help\`, \`view\`, \`get\`, \`query\`, and \`validate\`.
- Use \`OfficeDocumentEdit\` only for supported writes: \`create\`, \`add\`, \`set\`, and \`remove\`. It is permission-gated and path-bound to the session cwd.
- Do not call Bash or raw \`officecli\` directly unless the user explicitly asks for shell-level debugging and the normal permission flow allows it.
- Prefer \`OfficeDocument\` \`help\` with \`topic: "xlsx"\` before guessing selectors or properties. Installed help is authoritative.
- Quote paths such as \`"/Sheet1/A1"\`, \`"/Sheet1/col[B]"\`, and \`"/Sheet1/row[1]"\`.
- Single-quote values containing \`$\`, especially number formats: \`--prop numFmt='$#,##0'\`.
- Unsupported paths stay unsupported: no resident \`open\`/\`close\`, \`html\` view, \`raw\`, \`watch\`, or \`batch\`.

## Workflow

1. Orient with \`OfficeDocument\` \`view\` \`outline\`; use \`view\` \`text\`, \`get\`, and \`query\` for targeted inspection.
2. For CSV/TSV, prefer native import, then set widths and number formats.
3. For generated workbooks, create sheets, enter assumptions, formulas, formats, charts, then validate.
4. Use formulas rather than hardcoded derived values. Put assumptions in cells and cite sources in adjacent notes or comments.
5. Set readable widths explicitly; default Excel widths often render as \`###\`.
6. Financial-model convention: blue font for hardcoded inputs, black for formulas, green for same-workbook links, red for external links, yellow fill for assumptions needing review.
7. Final QA: \`OfficeDocument\` \`validate\` plus \`view\` \`outline\`, \`stats\`, \`issues\`, or \`annotated\`. Fix formula errors, \`###\`, truncated headers, hidden assumptions, placeholder tokens, and chart labels before reporting done.
`;
}

function officeCliPptxSkillTemplate(): string {
  return `---
name: OfficeCLI PPTX
description: Use when a .pptx, slide deck, presentation, pitch deck, speaker notes, layout, chart, template, or slides file is involved.
allowed-tools:
  - OfficeDocument
  - OfficeDocumentEdit
  - Read
required-tools:
  - OfficeDocument
  - OfficeDocumentEdit
---

# OfficeCLI PPTX

Use this skill for presentation work. Route deck inspection and edits through Maka's bounded Office document tools.

## Boundary

- Use \`OfficeDocument\` for read-only inspection: \`help\`, \`view\`, \`get\`, \`query\`, and \`validate\`.
- Use \`OfficeDocumentEdit\` only for supported writes: \`create\`, \`add\`, \`set\`, and \`remove\`. It is permission-gated and path-bound to the session cwd.
- Do not call Bash or raw \`officecli\` directly unless the user explicitly asks for shell-level debugging and the normal permission flow allows it.
- Prefer \`OfficeDocument\` \`help\` with \`topic: "pptx"\` before guessing selectors or properties. Installed help is authoritative.
- Quote paths such as \`"/slide[1]"\` and \`"/slide[1]/shape[2]"\`.
- Single-quote text containing \`$\`: \`--prop text='$15M ARR'\`.
- Unsupported paths stay unsupported: no resident \`open\`/\`close\`, \`html\` view, \`raw\`, \`watch\`, or \`batch\`.

## Workflow

1. Orient with \`OfficeDocument\` \`view\` \`outline\`, \`view\` \`text\`, and targeted \`get\` calls.
2. For generated decks, use one idea per slide. Dense multi-topic slides should be split.
3. Set explicit type hierarchy: titles at least 36pt, body text at least 18pt, captions 10-12pt.
4. Use two fonts max and one coherent palette. Every content slide should carry a non-text visual: chart, shape, icon, screenshot, or image region.
5. Add speaker notes to content slides.
6. Check layout math. For 16:9 slides, keep shapes inside 33.87cm x 19.05cm and maintain edge margins.
7. Final QA: \`OfficeDocument\` \`validate\` plus \`view\` \`outline\`, \`stats\`, \`issues\`, or \`annotated\`. Fix placeholders, overflow, clipped text, low contrast, bullet-only slides, and missing notes before reporting done.
`;
}
