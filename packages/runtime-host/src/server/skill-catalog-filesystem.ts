import { createHash, randomUUID } from 'node:crypto';
import { constants, type Dirent } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  BUNDLED_SKILL_CATALOG,
  isPathInside,
  isRecord,
  isSafeSkillId,
  validateSkillMetadata,
  type SkillRuntimeStatus,
  type SkillScanDiagnostic,
} from '@maka/runtime';
import { runWithStorageRootLease, type StorageRootLease } from '@maka/storage/root-authority';

const SKILL_DOCUMENT_MAX_BYTES = 24 * 1024;
const SKILL_LOCK_MAX_BYTES = 8 * 1024;
const SKILL_UPDATE_INTENT_MAX_BYTES = 1024;
const SKILL_STATE_MAX_BYTES = 512 * 1024;
const SKILL_STAGING_DIRECTORY = 'skill-catalog-staging';
const SKILL_UPDATE_INTENT_FILE = 'update-intent.json';
const SKILL_UPDATE_EXPECTED_LOCK_FILE = 'expected.skill.lock.json';
const DEFAULT_SKILL_CATEGORY = '效率工具';
const STARTER_SKILL_PATTERN = /^starter-skill(?:-(\d+))?$/i;
const CATALOG_NAME_MAX_LENGTH = 256;
const CATALOG_DESCRIPTION_MAX_LENGTH = 4 * 1024;
const CATALOG_CATEGORY_MAX_LENGTH = 128;
const CATALOG_STRING_LIST_MAX_ITEMS = 64;
const CATALOG_STRING_LIST_ITEM_MAX_LENGTH = 256;

export type HostSkillSourceType = 'workspace' | 'bundled' | 'managed' | 'unknown';
export type HostSkillContentSha256 = `sha256:${string}`;
export type HostSkillValidationStatus = 'ok' | 'missing_lock' | 'modified' | 'metadata_error';
export type HostManagedSkillUpdateStatus =
  | 'not_managed'
  | 'source_missing'
  | 'up_to_date'
  | 'update_available'
  | 'local_modified'
  | 'metadata_error';

type HostOwnedSkillKind = 'starter' | 'bundled' | 'managed';

export interface HostInstalledSkill {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly declaredTools: readonly string[];
  readonly requiredTools: readonly string[];
  readonly requiredCapabilities: readonly string[];
  readonly enabled: boolean;
  readonly runtimeStatus: SkillRuntimeStatus;
  readonly content: string;
  readonly contentSha256: HostSkillContentSha256;
  readonly sourceType: HostSkillSourceType;
  readonly userModified: boolean;
  readonly validationStatus: HostSkillValidationStatus;
  readonly managedUpdateStatus?: HostManagedSkillUpdateStatus;
  readonly ownerKind?: HostOwnedSkillKind;
  readonly sourceId?: string;
  readonly sourceContentSha256?: HostSkillContentSha256;
}

export interface HostSkillSource {
  readonly sourceType: 'bundled' | 'managed';
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly category: string;
  readonly content: string;
  readonly contentSha256: HostSkillContentSha256;
}

export interface HostSkillCatalogDiagnostic {
  readonly scope: 'installed' | 'source';
  readonly id: string;
  readonly codes: readonly string[];
}

export interface HostSkillFilesystemSnapshot {
  readonly installed: readonly HostInstalledSkill[];
  readonly sources: readonly HostSkillSource[];
  readonly diagnostics: readonly HostSkillCatalogDiagnostic[];
}

export type HostSkillMutationFailure =
  | 'not_found'
  | 'already_exists'
  | 'not_managed'
  | 'source_missing'
  | 'source_changed'
  | 'source_invalid'
  | 'local_modified'
  | 'state_error';

export type HostSkillMutationResult =
  | { readonly ok: true; readonly changed: boolean; readonly skillId: string }
  | { readonly ok: false; readonly reason: HostSkillMutationFailure };

export interface HostManagedSkillPreview {
  readonly currentContent: string;
  readonly sourceContent: string;
  readonly currentContentSha256: HostSkillContentSha256;
  readonly sourceContentSha256: HostSkillContentSha256;
}

export type HostManagedSkillPreviewResult =
  | { readonly ok: true; readonly preview: HostManagedSkillPreview }
  | {
      readonly ok: false;
      readonly reason: 'not_found' | 'not_managed' | 'source_missing';
    };

export type HostSkillCatalogFilesystemErrorCode = 'persistence_failed' | 'commit_outcome_unknown';

export class HostSkillCatalogFilesystemError extends Error {
  constructor(
    readonly code: HostSkillCatalogFilesystemErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'HostSkillCatalogFilesystemError';
  }
}

interface HostSkillLock {
  readonly schemaVersion: 1;
  readonly owner: 'maka-runtime-host';
  readonly id: string;
  readonly sourceType: HostOwnedSkillKind;
  readonly contentSha256: HostSkillContentSha256;
  readonly installedAt: string;
  readonly sourceId?: string;
  readonly sourceContentSha256?: HostSkillContentSha256;
}

interface HostSkillUpdateIntent {
  readonly schemaVersion: 1;
  readonly kind: 'managed-skill-update';
  readonly skillId: string;
  readonly expectedCurrentSha256: HostSkillContentSha256;
  readonly nextContentSha256: HostSkillContentSha256;
}

type HostSkillUpdateIntentReadResult =
  | { readonly kind: 'missing' }
  | { readonly kind: 'valid'; readonly intent: HostSkillUpdateIntent }
  | { readonly kind: 'invalid' };

interface MutableSkillStateFile {
  readonly schemaVersion: 1;
  readonly skills: Record<string, { readonly enabled: boolean; readonly updatedAt: string }>;
}

type HostSkillStateReadResult =
  | { readonly ok: true; readonly states: Map<string, boolean> }
  | { readonly ok: false; readonly reason: 'blocked_path' | 'invalid_json' | 'too_large' };

interface ScannedDirectory {
  readonly entries: readonly Dirent[];
  readonly rootReal: string;
  readonly directoryReal: string;
}

type ReadDocumentResult =
  | {
      readonly kind: 'ok';
      readonly content: string;
      readonly sha256: HostSkillContentSha256;
    }
  | { readonly kind: 'missing' }
  | { readonly kind: 'blocked' }
  | { readonly kind: 'too_large' };

/** Lease-bound owner for root Skill files and read-only machine sources. */
export class HostSkillCatalogFilesystem {
  readonly #lease: StorageRootLease<'interactive', 'write'>;
  readonly #managedSourceRoot: string;

  constructor(
    lease: StorageRootLease<'interactive', 'write'>,
    managedSourceRoot = join(homedir(), '.maka', 'skill-sources'),
  ) {
    this.#lease = lease;
    this.#managedSourceRoot = managedSourceRoot;
  }

  recover(): Promise<void> {
    return this.#withRoot((root) => recoverStaging(root));
  }

  scan(): Promise<HostSkillFilesystemSnapshot> {
    return this.#withRoot(async (root) => {
      const [installedScan, managedScan] = await Promise.all([
        scanInstalledSkills(root),
        scanManagedSources(this.#managedSourceRoot),
      ]);
      const bundledScan = scanBundledSources();
      const sources = [...bundledScan.sources, ...managedScan.sources].sort(compareSources);
      const installed = installedScan.installed.map((skill) => enrichManagedStatus(skill, sources));
      return Object.freeze({
        installed: Object.freeze(installed),
        sources: Object.freeze(sources),
        diagnostics: Object.freeze([
          ...installedScan.diagnostics,
          ...bundledScan.diagnostics,
          ...managedScan.diagnostics,
        ]),
      });
    });
  }

  createStarter(snapshot: HostSkillFilesystemSnapshot): Promise<HostSkillMutationResult> {
    return this.#withRoot(async (root) => {
      const existing = snapshot.installed
        .map((skill) => {
          const match = STARTER_SKILL_PATTERN.exec(skill.id);
          if (!match || skill.ownerKind !== 'starter') return undefined;
          return { id: skill.id, ordinal: match[1] ? Number(match[1]) : 1 };
        })
        .filter((entry): entry is { id: string; ordinal: number } => entry !== undefined)
        .sort((left, right) => left.ordinal - right.ordinal)[0];
      if (existing) return { ok: true, changed: false, skillId: existing.id };

      const occupied = new Set(snapshot.installed.map((skill) => canonicalSkillId(skill.id)));
      for (let index = 1; index <= 99; index += 1) {
        const id = index === 1 ? 'starter-skill' : `starter-skill-${index}`;
        if (occupied.has(canonicalSkillId(id))) continue;
        const name = index === 1 ? '示例技能' : `示例技能 ${index}`;
        const content = starterSkillTemplate(name);
        await publishNewSkill(root, id, content, createSkillLock(id, 'starter', content));
        return { ok: true, changed: true, skillId: id };
      }
      return { ok: false, reason: 'already_exists' };
    });
  }

  install(
    snapshot: HostSkillFilesystemSnapshot,
    input: {
      readonly sourceType: 'bundled' | 'managed';
      readonly sourceId: string;
      readonly expectedSourceSha256: string;
    },
  ): Promise<HostSkillMutationResult> {
    return this.#withRoot(async (root) => {
      const sourceCanonicalId = canonicalSkillId(input.sourceId);
      if (snapshot.installed.some((skill) => canonicalSkillId(skill.id) === sourceCanonicalId)) {
        return { ok: false, reason: 'already_exists' };
      }
      const source = snapshot.sources.find(
        (candidate) => candidate.sourceType === input.sourceType && candidate.id === input.sourceId,
      );
      if (!source) return { ok: false, reason: 'source_missing' };
      if (source.contentSha256 !== input.expectedSourceSha256) {
        return { ok: false, reason: 'source_changed' };
      }
      const validation = validateSkillMetadata(source.content);
      if (!validation.valid) return { ok: false, reason: 'source_invalid' };
      await publishNewSkill(
        root,
        source.id,
        source.content,
        createSkillLock(source.id, source.sourceType, source.content, source.id),
      );
      return { ok: true, changed: true, skillId: source.id };
    });
  }

  updateManaged(
    snapshot: HostSkillFilesystemSnapshot,
    input: {
      readonly skillId: string;
      readonly expectedCurrentSha256: string;
      readonly expectedSourceSha256: string;
      readonly force: boolean;
    },
  ): Promise<HostSkillMutationResult> {
    return this.#withRoot(async (root) => {
      const installed = snapshot.installed.find((skill) => skill.id === input.skillId);
      if (!installed) return { ok: false, reason: 'not_found' };
      if (installed.ownerKind !== 'managed' || !installed.sourceId) {
        return { ok: false, reason: 'not_managed' };
      }
      const source = snapshot.sources.find(
        (candidate) => candidate.sourceType === 'managed' && candidate.id === installed.sourceId,
      );
      if (!source) return { ok: false, reason: 'source_missing' };
      if (source.contentSha256 !== input.expectedSourceSha256) {
        return { ok: false, reason: 'source_changed' };
      }
      if (installed.contentSha256 !== input.expectedCurrentSha256) {
        return { ok: false, reason: 'local_modified' };
      }
      if (installed.userModified && !input.force) {
        return { ok: false, reason: 'local_modified' };
      }

      const skillDirectory = await resolveInstalledSkillDirectory(root, input.skillId);
      if (!skillDirectory) return { ok: false, reason: 'not_found' };
      const current = await readBoundedDocument(
        skillDirectory,
        join(skillDirectory, 'SKILL.md'),
        SKILL_DOCUMENT_MAX_BYTES,
      );
      if (current.kind !== 'ok' || current.sha256 !== input.expectedCurrentSha256) {
        return { ok: false, reason: 'local_modified' };
      }
      if (source.content === current.content) {
        if (!installed.userModified && installed.sourceContentSha256 === source.contentSha256) {
          return { ok: true, changed: false, skillId: input.skillId };
        }
        await replaceManagedSkill(
          root,
          skillDirectory,
          input.skillId,
          current.sha256,
          current.content,
          createSkillLock(input.skillId, 'managed', source.content, source.id),
        );
        return { ok: true, changed: true, skillId: input.skillId };
      }

      await replaceManagedSkill(
        root,
        skillDirectory,
        input.skillId,
        current.sha256,
        source.content,
        createSkillLock(input.skillId, 'managed', source.content, source.id),
      );
      return { ok: true, changed: true, skillId: input.skillId };
    });
  }

  delete(snapshot: HostSkillFilesystemSnapshot, skillId: string): Promise<HostSkillMutationResult> {
    return this.#withRoot(async (root) => {
      const skill = snapshot.installed.find((candidate) => candidate.id === skillId);
      if (!skill) return { ok: false, reason: 'not_found' };
      if (!skill.ownerKind) return { ok: false, reason: 'not_managed' };
      const skillDirectory = await resolveInstalledSkillDirectory(root, skillId);
      if (!skillDirectory) return { ok: false, reason: 'not_found' };
      const currentLock = await readHostSkillLock(skillDirectory, skillId);
      if (typeof currentLock === 'string' || currentLock.sourceType !== skill.ownerKind) {
        return { ok: false, reason: 'not_managed' };
      }
      await removePublishedSkill(root, skillId);
      return { ok: true, changed: true, skillId };
    });
  }

  setEnabled(
    snapshot: HostSkillFilesystemSnapshot,
    skillId: string,
    enabled: boolean,
  ): Promise<HostSkillMutationResult> {
    return this.#withRoot(async (root) => {
      const skill = snapshot.installed.find((candidate) => candidate.id === skillId);
      if (!skill) return { ok: false, reason: 'not_found' };
      if (skill.runtimeStatus === 'state_error') return { ok: false, reason: 'state_error' };
      if (skill.enabled === enabled) return { ok: true, changed: false, skillId };

      const state = await readHostSkillState(root);
      if (!state.ok) return { ok: false, reason: 'state_error' };
      state.states.set(skillId, enabled);
      await writeSkillState(root, state.states);
      return { ok: true, changed: true, skillId };
    });
  }

  previewManaged(
    snapshot: HostSkillFilesystemSnapshot,
    skillId: string,
  ): HostManagedSkillPreviewResult {
    const installed = snapshot.installed.find((skill) => skill.id === skillId);
    if (!installed) return { ok: false, reason: 'not_found' };
    if (installed.ownerKind !== 'managed' || !installed.sourceId) {
      return { ok: false, reason: 'not_managed' };
    }
    const source = snapshot.sources.find(
      (candidate) => candidate.sourceType === 'managed' && candidate.id === installed.sourceId,
    );
    if (!source) return { ok: false, reason: 'source_missing' };
    return {
      ok: true,
      preview: {
        currentContent: installed.content,
        sourceContent: source.content,
        currentContentSha256: installed.contentSha256,
        sourceContentSha256: source.contentSha256,
      },
    };
  }

  #withRoot<T>(operation: (root: string) => Promise<T>): Promise<T> {
    return runWithStorageRootLease(this.#lease, 'interactive', 'write', operation);
  }
}

async function scanInstalledSkills(root: string): Promise<{
  installed: HostInstalledSkill[];
  diagnostics: HostSkillCatalogDiagnostic[];
}> {
  const state = await readHostSkillState(root);
  const directory = await readContainedDirectory(root, join(root, 'skills'));
  if (!directory) {
    return {
      installed: [],
      diagnostics: state.ok
        ? []
        : [{ scope: 'installed', id: 'skills-state', codes: [`state_${state.reason}`] }],
    };
  }

  const candidates: HostInstalledSkill[] = [];
  const diagnostics: HostSkillCatalogDiagnostic[] = [];
  if (!state.ok) {
    diagnostics.push({
      scope: 'installed',
      id: 'skills-state',
      codes: [`state_${state.reason}`],
    });
  }
  for (const entry of directory.entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !isSafeSkillId(entry.name)) continue;
    const skillDirectory = join(directory.directoryReal, entry.name);
    const skillDirectoryRead = await readContainedDirectory(
      directory.directoryReal,
      skillDirectory,
    );
    if (!skillDirectoryRead) {
      diagnostics.push({ scope: 'installed', id: entry.name, codes: ['blocked_path'] });
      continue;
    }
    const document = await readBoundedDocument(
      skillDirectoryRead.directoryReal,
      join(skillDirectoryRead.directoryReal, 'SKILL.md'),
      SKILL_DOCUMENT_MAX_BYTES,
    );
    if (document.kind === 'missing') continue;
    if (document.kind !== 'ok') {
      diagnostics.push({
        scope: 'installed',
        id: entry.name,
        codes: [document.kind === 'too_large' ? 'body_too_large' : 'blocked_path'],
      });
      continue;
    }
    const validation = validateSkillMetadata(document.content);
    if (validation.issues.length > 0) {
      diagnostics.push(toDiagnostic('installed', entry.name, validation.issues));
    }
    if (!validation.valid) continue;
    const projectionIssue = catalogProjectionIssue(validation.manifest);
    if (projectionIssue) {
      diagnostics.push({ scope: 'installed', id: entry.name, codes: [projectionIssue] });
      continue;
    }
    const runtimeStatus: SkillRuntimeStatus = state.ok
      ? state.states.get(entry.name) === false
        ? 'disabled'
        : 'enabled'
      : 'state_error';
    const lock = await readHostSkillLock(skillDirectoryRead.directoryReal, entry.name);
    const governance = projectGovernance(lock, document.sha256);
    candidates.push(
      Object.freeze({
        id: entry.name,
        name: validation.manifest.name ?? entry.name,
        description: validation.manifest.description ?? '',
        path: skillDirectoryRead.directoryReal,
        declaredTools: Object.freeze([...validation.manifest.allowedTools]),
        requiredTools: Object.freeze([...validation.manifest.requiredTools]),
        requiredCapabilities: Object.freeze([...validation.manifest.requiredCapabilities]),
        enabled: runtimeStatus === 'enabled',
        runtimeStatus,
        content: document.content,
        contentSha256: document.sha256,
        ...governance,
      }),
    );
    if (governance.validationStatus === 'metadata_error') {
      diagnostics.push({ scope: 'installed', id: entry.name, codes: ['invalid_lock'] });
    } else if (governance.validationStatus === 'modified') {
      diagnostics.push({ scope: 'installed', id: entry.name, codes: ['modified'] });
    }
  }
  candidates.sort(
    (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
  );
  const installed: HostInstalledSkill[] = [];
  const seenIds = new Set<string>();
  for (const candidate of candidates) {
    const canonicalId = canonicalSkillId(candidate.id);
    if (seenIds.has(canonicalId)) {
      diagnostics.push({ scope: 'installed', id: candidate.id, codes: ['duplicate_id'] });
      continue;
    }
    seenIds.add(canonicalId);
    installed.push(candidate);
  }
  return { installed, diagnostics };
}

async function scanManagedSources(root: string): Promise<{
  sources: HostSkillSource[];
  diagnostics: HostSkillCatalogDiagnostic[];
}> {
  const directory = await readContainedDirectory(root, root);
  if (!directory) return { sources: [], diagnostics: [] };
  const sources: HostSkillSource[] = [];
  const diagnostics: HostSkillCatalogDiagnostic[] = [];
  for (const entry of directory.entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !isSafeSkillId(entry.name)) continue;
    const sourceDirectory = await readContainedDirectory(
      directory.directoryReal,
      join(directory.directoryReal, entry.name),
    );
    if (!sourceDirectory) {
      diagnostics.push({ scope: 'source', id: entry.name, codes: ['blocked_path'] });
      continue;
    }
    const document = await readBoundedDocument(
      sourceDirectory.directoryReal,
      join(sourceDirectory.directoryReal, 'SKILL.md'),
      SKILL_DOCUMENT_MAX_BYTES,
    );
    if (document.kind === 'missing') continue;
    if (document.kind !== 'ok') {
      diagnostics.push({
        scope: 'source',
        id: entry.name,
        codes: [document.kind === 'too_large' ? 'body_too_large' : 'blocked_path'],
      });
      continue;
    }
    const validation = validateSkillMetadata(document.content);
    if (validation.issues.length > 0) {
      diagnostics.push(toDiagnostic('source', entry.name, validation.issues));
    }
    if (!validation.valid) continue;
    const projectionIssue = catalogProjectionIssue(validation.manifest);
    if (projectionIssue) {
      diagnostics.push({ scope: 'source', id: entry.name, codes: [projectionIssue] });
      continue;
    }
    sources.push(
      Object.freeze({
        sourceType: 'managed',
        id: entry.name,
        name: validation.manifest.name ?? entry.name,
        description: validation.manifest.description ?? '',
        category: validation.manifest.category ?? DEFAULT_SKILL_CATEGORY,
        content: document.content,
        contentSha256: document.sha256,
      }),
    );
  }
  return { sources, diagnostics };
}

function scanBundledSources(): {
  sources: HostSkillSource[];
  diagnostics: HostSkillCatalogDiagnostic[];
} {
  const sources: HostSkillSource[] = [];
  const diagnostics: HostSkillCatalogDiagnostic[] = [];
  for (const bundled of BUNDLED_SKILL_CATALOG) {
    if (Buffer.byteLength(bundled.body, 'utf8') > SKILL_DOCUMENT_MAX_BYTES) {
      diagnostics.push({ scope: 'source', id: bundled.id, codes: ['body_too_large'] });
      continue;
    }
    const validation = validateSkillMetadata(bundled.body);
    if (validation.issues.length > 0) {
      diagnostics.push(toDiagnostic('source', bundled.id, validation.issues));
    }
    if (!validation.valid) continue;
    const projectionIssue = catalogProjectionIssue(validation.manifest);
    if (projectionIssue) {
      diagnostics.push({ scope: 'source', id: bundled.id, codes: [projectionIssue] });
      continue;
    }
    sources.push(
      Object.freeze({
        sourceType: 'bundled',
        id: bundled.id,
        name: validation.manifest.name ?? bundled.id,
        description: validation.manifest.description ?? '',
        category: validation.manifest.category ?? DEFAULT_SKILL_CATEGORY,
        content: bundled.body,
        contentSha256: sha256(bundled.body),
      }),
    );
  }
  return { sources, diagnostics };
}

function enrichManagedStatus(
  skill: HostInstalledSkill,
  sources: readonly HostSkillSource[],
): HostInstalledSkill {
  if (skill.ownerKind !== 'managed' || !skill.sourceId) return skill;
  if (skill.validationStatus === 'metadata_error') {
    return Object.freeze({ ...skill, managedUpdateStatus: 'metadata_error' });
  }
  if (skill.userModified) {
    return Object.freeze({ ...skill, managedUpdateStatus: 'local_modified' });
  }
  const source = sources.find(
    (candidate) => candidate.sourceType === 'managed' && candidate.id === skill.sourceId,
  );
  if (!source) return Object.freeze({ ...skill, managedUpdateStatus: 'source_missing' });
  return Object.freeze({
    ...skill,
    managedUpdateStatus:
      source.contentSha256 === skill.sourceContentSha256 ? 'up_to_date' : 'update_available',
  });
}

async function readHostSkillLock(
  skillDirectory: string,
  expectedId: string,
): Promise<HostSkillLock | 'missing' | 'invalid'> {
  const document = await readBoundedDocument(
    skillDirectory,
    join(skillDirectory, 'skill.lock.json'),
    SKILL_LOCK_MAX_BYTES,
  );
  if (document.kind === 'missing') return 'missing';
  if (document.kind !== 'ok') return 'invalid';
  return parseHostSkillLock(document.content, expectedId) ?? 'invalid';
}

function parseHostSkillLock(content: string, expectedId: string): HostSkillLock | undefined {
  let value: unknown;
  try {
    value = JSON.parse(content) as unknown;
  } catch {
    return undefined;
  }
  if (!isHostSkillLock(value, expectedId)) return undefined;
  return value;
}

function projectGovernance(
  lock: HostSkillLock | 'missing' | 'invalid',
  contentSha256: HostSkillContentSha256,
): Pick<
  HostInstalledSkill,
  | 'sourceType'
  | 'userModified'
  | 'validationStatus'
  | 'ownerKind'
  | 'sourceId'
  | 'sourceContentSha256'
> {
  if (lock === 'missing') {
    return {
      sourceType: 'workspace',
      userModified: false,
      validationStatus: 'missing_lock',
    };
  }
  if (lock === 'invalid') {
    return {
      sourceType: 'unknown',
      userModified: false,
      validationStatus: 'metadata_error',
    };
  }
  const userModified = lock.contentSha256 !== contentSha256;
  return {
    sourceType: lock.sourceType === 'starter' ? 'workspace' : lock.sourceType,
    userModified,
    validationStatus: userModified ? 'modified' : 'ok',
    ownerKind: lock.sourceType,
    ...(lock.sourceId ? { sourceId: lock.sourceId } : {}),
    ...(lock.sourceContentSha256 ? { sourceContentSha256: lock.sourceContentSha256 } : {}),
  };
}

function isHostSkillLock(value: unknown, expectedId: string): value is HostSkillLock {
  if (!isRecord(value)) return false;
  const sourceType = value.sourceType;
  if (
    value.schemaVersion !== 1 ||
    value.owner !== 'maka-runtime-host' ||
    value.id !== expectedId ||
    (sourceType !== 'starter' && sourceType !== 'bundled' && sourceType !== 'managed') ||
    !isSha256(value.contentSha256) ||
    typeof value.installedAt !== 'string' ||
    value.installedAt.length === 0
  ) {
    return false;
  }
  if (sourceType !== 'managed') {
    return value.sourceId === undefined && value.sourceContentSha256 === undefined;
  }
  return (
    typeof value.sourceId === 'string' &&
    isSafeSkillId(value.sourceId) &&
    isSha256(value.sourceContentSha256)
  );
}

function createSkillLock(
  id: string,
  sourceType: HostOwnedSkillKind,
  content: string,
  sourceId?: string,
): HostSkillLock {
  const contentSha256 = sha256(content);
  return {
    schemaVersion: 1,
    owner: 'maka-runtime-host',
    id,
    sourceType,
    contentSha256,
    installedAt: new Date().toISOString(),
    ...(sourceType === 'managed' && sourceId
      ? { sourceId, sourceContentSha256: contentSha256 }
      : {}),
  };
}

async function publishNewSkill(
  root: string,
  id: string,
  content: string,
  lock: HostSkillLock,
): Promise<void> {
  const { skillsDirectory, stagingDirectory } = await prepareMutationDirectories(root);
  const target = join(skillsDirectory, id);
  const targetStat = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw persistenceFailed('Installed Skill target could not be inspected', error);
  });
  if (targetStat) throw persistenceFailed('Installed Skill target already exists');

  const stage = join(stagingDirectory, `install-${randomUUID()}`);
  let published = false;
  try {
    await mkdir(stage, { mode: 0o700 });
    await writeDurableFile(stage, 'SKILL.md', Buffer.from(content, 'utf8'));
    await writeDurableFile(stage, 'skill.lock.json', serializeJson(lock));
    await syncDirectory(stage);
    await rename(stage, target);
    published = true;
    await syncDirectory(skillsDirectory);
    await syncDirectory(stagingDirectory);
  } catch (error) {
    if (!published) await rm(stage, { recursive: true, force: true }).catch(() => undefined);
    if (error instanceof HostSkillCatalogFilesystemError) throw error;
    if (published) {
      throw commitOutcomeUnknown('Installed Skill publication outcome is unknown', error);
    }
    throw persistenceFailed('Installed Skill could not be published', error);
  }
}

async function replaceManagedSkill(
  root: string,
  skillDirectory: string,
  id: string,
  expectedCurrentSha256: HostSkillContentSha256,
  content: string,
  lock: HostSkillLock,
): Promise<void> {
  const { stagingDirectory } = await prepareMutationDirectories(root);
  const currentLock = await readBoundedDocument(
    skillDirectory,
    join(skillDirectory, 'skill.lock.json'),
    SKILL_LOCK_MAX_BYTES,
  );
  if (currentLock.kind !== 'ok') {
    throw persistenceFailed(`Managed Skill ${id} lock changed before update`);
  }
  const parsedCurrentLock = parseHostSkillLock(currentLock.content, id);
  if (
    !parsedCurrentLock ||
    parsedCurrentLock.sourceType !== 'managed' ||
    parsedCurrentLock.sourceId !== lock.sourceId
  ) {
    throw persistenceFailed(`Managed Skill ${id} ownership changed before update`);
  }

  const stage = join(stagingDirectory, `update-${randomUUID()}`);
  const nextContent = Buffer.from(content, 'utf8');
  const nextLock = serializeJson(lock);
  const intent: HostSkillUpdateIntent = {
    schemaVersion: 1,
    kind: 'managed-skill-update',
    skillId: id,
    expectedCurrentSha256,
    nextContentSha256: sha256(nextContent),
  };
  let intentCommitStarted = false;
  try {
    await mkdir(stage, { mode: 0o700 });
    await writeDurableFile(stage, 'SKILL.md', nextContent);
    await writeDurableFile(stage, 'skill.lock.json', nextLock);
    await writeDurableFile(
      stage,
      SKILL_UPDATE_EXPECTED_LOCK_FILE,
      Buffer.from(currentLock.content),
    );
    await syncDirectory(stage);
    await syncDirectory(stagingDirectory);
    intentCommitStarted = true;
    await writeDurableFile(stage, SKILL_UPDATE_INTENT_FILE, serializeJson(intent));
    await replayManagedSkillUpdate(root, stage, intent);
  } catch (error) {
    if (intentCommitStarted) {
      throw commitOutcomeUnknown(`Managed Skill ${id} update outcome is unknown`, error);
    }
    try {
      await rm(stage, { recursive: true, force: true });
      await syncDirectory(stagingDirectory);
    } catch (cleanupError) {
      throw commitOutcomeUnknown(
        `Managed Skill ${id} staging cleanup outcome is unknown`,
        new AggregateError([error, cleanupError]),
      );
    }
    if (error instanceof HostSkillCatalogFilesystemError) throw error;
    throw persistenceFailed(`Managed Skill ${id} update could not be staged`, error);
  }
}

async function removePublishedSkill(root: string, id: string): Promise<void> {
  const { skillsDirectory, stagingDirectory } = await prepareMutationDirectories(root);
  const target = await resolveInstalledSkillDirectory(root, id);
  if (!target) throw persistenceFailed('Installed Skill disappeared before deletion');
  const tombstone = join(stagingDirectory, `delete-${randomUUID()}`);
  let published = false;
  try {
    await rename(target, tombstone);
    published = true;
    await syncDirectory(skillsDirectory);
    await syncDirectory(stagingDirectory);
  } catch (error) {
    if (published) throw commitOutcomeUnknown('Skill deletion outcome is unknown', error);
    throw persistenceFailed('Skill could not be deleted', error);
  }
  await rm(tombstone, { recursive: true, force: true }).catch(() => undefined);
}

async function readHostSkillState(root: string): Promise<HostSkillStateReadResult> {
  const document = await readBoundedDocument(
    root,
    join(root, '.maka', 'skills-state.json'),
    SKILL_STATE_MAX_BYTES,
  );
  if (document.kind === 'missing') return { ok: true, states: new Map() };
  if (document.kind === 'too_large') return { ok: false, reason: 'too_large' };
  if (document.kind === 'blocked') return { ok: false, reason: 'blocked_path' };

  let value: unknown;
  try {
    value = JSON.parse(document.content) as unknown;
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.skills)) {
    return { ok: false, reason: 'invalid_json' };
  }
  const states = new Map<string, boolean>();
  for (const [id, state] of Object.entries(value.skills)) {
    if (!isSafeSkillId(id) || !isRecord(state) || typeof state.enabled !== 'boolean') {
      return { ok: false, reason: 'invalid_json' };
    }
    states.set(id, state.enabled);
  }
  return { ok: true, states };
}

async function writeSkillState(root: string, states: ReadonlyMap<string, boolean>): Promise<void> {
  const metadataDirectory = await ensureContainedDirectory(root, join(root, '.maka'));
  const entries = [...states.entries()].sort(([left], [right]) => left.localeCompare(right));
  const value: MutableSkillStateFile = {
    schemaVersion: 1,
    skills: Object.fromEntries(
      entries.map(([id, enabled]) => [id, { enabled, updatedAt: new Date().toISOString() }]),
    ),
  };
  const bytes = serializeJson(value);
  if (bytes.byteLength > SKILL_STATE_MAX_BYTES) {
    throw persistenceFailed('Skill enablement state exceeds its size limit');
  }
  await writeDurableFile(metadataDirectory, 'skills-state.json', bytes);
}

async function prepareMutationDirectories(root: string): Promise<{
  skillsDirectory: string;
  stagingDirectory: string;
}> {
  const skillsDirectory = await ensureContainedDirectory(root, join(root, 'skills'));
  const metadataDirectory = await ensureContainedDirectory(root, join(root, '.maka'));
  const stagingDirectory = await ensureContainedDirectory(
    metadataDirectory,
    join(metadataDirectory, SKILL_STAGING_DIRECTORY),
  );
  return { skillsDirectory, stagingDirectory };
}

async function recoverStaging(root: string): Promise<void> {
  const metadata = await readContainedDirectory(root, join(root, '.maka'));
  if (!metadata) return;
  const staging = await readContainedDirectory(
    metadata.directoryReal,
    join(metadata.directoryReal, SKILL_STAGING_DIRECTORY),
  );
  if (!staging) return;
  for (const entry of staging.entries) {
    if (entry.isSymbolicLink()) {
      throw persistenceFailed('Skill staging contains a symbolic link');
    }
    const target = join(staging.directoryReal, entry.name);
    const targetReal = await realpath(target).catch(() => undefined);
    if (!targetReal || !isPathInside(staging.directoryReal, targetReal)) {
      throw persistenceFailed('Skill staging contains an unsafe artifact');
    }
    if (entry.isDirectory() && entry.name.startsWith('update-')) {
      const intentRead = await readSkillUpdateIntent(targetReal);
      if (intentRead.kind === 'invalid') {
        throw persistenceFailed('Managed Skill update intent is invalid');
      }
      if (intentRead.kind === 'valid') {
        await replayManagedSkillUpdate(root, targetReal, intentRead.intent);
        continue;
      }
    }
    try {
      await rm(targetReal, { recursive: true, force: true });
      await syncDirectory(staging.directoryReal);
    } catch (error) {
      throw persistenceFailed('Skill staging could not be recovered', error);
    }
  }
  await syncDirectory(staging.directoryReal).catch((error: unknown) => {
    throw persistenceFailed('Skill staging recovery could not be synchronized', error);
  });
}

async function replayManagedSkillUpdate(
  root: string,
  stage: string,
  intent: HostSkillUpdateIntent,
): Promise<void> {
  const stageDirectory = await readContainedDirectory(stage, stage);
  if (!stageDirectory) throw persistenceFailed('Managed Skill update artifact is missing');
  const nextDocument = await readBoundedDocument(
    stageDirectory.directoryReal,
    join(stageDirectory.directoryReal, 'SKILL.md'),
    SKILL_DOCUMENT_MAX_BYTES,
  );
  const nextLockDocument = await readBoundedDocument(
    stageDirectory.directoryReal,
    join(stageDirectory.directoryReal, 'skill.lock.json'),
    SKILL_LOCK_MAX_BYTES,
  );
  const expectedLockDocument = await readBoundedDocument(
    stageDirectory.directoryReal,
    join(stageDirectory.directoryReal, SKILL_UPDATE_EXPECTED_LOCK_FILE),
    SKILL_LOCK_MAX_BYTES,
  );
  if (
    nextDocument.kind !== 'ok' ||
    nextDocument.sha256 !== intent.nextContentSha256 ||
    nextLockDocument.kind !== 'ok' ||
    expectedLockDocument.kind !== 'ok'
  ) {
    throw persistenceFailed('Managed Skill update artifact is incomplete');
  }
  const nextLock = parseHostSkillLock(nextLockDocument.content, intent.skillId);
  const expectedLock = parseHostSkillLock(expectedLockDocument.content, intent.skillId);
  if (
    !nextLock ||
    nextLock.sourceType !== 'managed' ||
    nextLock.contentSha256 !== intent.nextContentSha256 ||
    !expectedLock ||
    expectedLock.sourceType !== 'managed' ||
    expectedLock.sourceId !== nextLock.sourceId
  ) {
    throw persistenceFailed('Managed Skill update artifact has invalid locks');
  }

  const skillDirectory = await resolveInstalledSkillDirectory(root, intent.skillId);
  if (!skillDirectory) {
    throw persistenceFailed('Managed Skill update target is missing');
  }
  let live = await inspectManagedSkillUpdateState(
    skillDirectory,
    intent,
    expectedLockDocument,
    nextLockDocument,
  );
  if (live.content === 'expected') {
    await writeDurableFile(skillDirectory, 'SKILL.md', Buffer.from(nextDocument.content));
    live = await inspectManagedSkillUpdateState(
      skillDirectory,
      intent,
      expectedLockDocument,
      nextLockDocument,
    );
  }
  if (live.content !== 'next') {
    throw persistenceFailed('Managed Skill content did not reach the staged state');
  }
  if (live.lock === 'expected') {
    await writeDurableFile(
      skillDirectory,
      'skill.lock.json',
      Buffer.from(nextLockDocument.content),
    );
    live = await inspectManagedSkillUpdateState(
      skillDirectory,
      intent,
      expectedLockDocument,
      nextLockDocument,
    );
  }
  if (live.content !== 'next' || live.lock !== 'next') {
    throw persistenceFailed('Managed Skill update did not reach the staged state');
  }

  const stagingDirectory = await realpath(join(root, '.maka', SKILL_STAGING_DIRECTORY));
  if (!isPathInside(stagingDirectory, stageDirectory.directoryReal)) {
    throw persistenceFailed('Managed Skill update artifact escaped staging');
  }
  await rm(stageDirectory.directoryReal, { recursive: true, force: true });
  await syncDirectory(stagingDirectory);
}

async function inspectManagedSkillUpdateState(
  skillDirectory: string,
  intent: HostSkillUpdateIntent,
  expectedLock: Extract<ReadDocumentResult, { kind: 'ok' }>,
  nextLock: Extract<ReadDocumentResult, { kind: 'ok' }>,
): Promise<{ readonly content: 'expected' | 'next'; readonly lock: 'expected' | 'next' }> {
  const [content, lock] = await Promise.all([
    readBoundedDocument(skillDirectory, join(skillDirectory, 'SKILL.md'), SKILL_DOCUMENT_MAX_BYTES),
    readBoundedDocument(
      skillDirectory,
      join(skillDirectory, 'skill.lock.json'),
      SKILL_LOCK_MAX_BYTES,
    ),
  ]);
  const contentState =
    content.kind === 'ok' && content.sha256 === intent.nextContentSha256
      ? 'next'
      : content.kind === 'ok' && content.sha256 === intent.expectedCurrentSha256
        ? 'expected'
        : undefined;
  const lockState =
    lock.kind === 'ok' && lock.sha256 === nextLock.sha256
      ? 'next'
      : lock.kind === 'ok' && lock.sha256 === expectedLock.sha256
        ? 'expected'
        : undefined;
  if (!contentState || !lockState || (contentState === 'expected' && lockState === 'next')) {
    throw persistenceFailed('Managed Skill update conflicts with the live target');
  }
  return { content: contentState, lock: lockState };
}

async function readSkillUpdateIntent(stage: string): Promise<HostSkillUpdateIntentReadResult> {
  const document = await readBoundedDocument(
    stage,
    join(stage, SKILL_UPDATE_INTENT_FILE),
    SKILL_UPDATE_INTENT_MAX_BYTES,
  );
  if (document.kind === 'missing') return { kind: 'missing' };
  if (document.kind !== 'ok') return { kind: 'invalid' };
  let value: unknown;
  try {
    value = JSON.parse(document.content) as unknown;
  } catch {
    return { kind: 'invalid' };
  }
  if (!isRecord(value)) return { kind: 'invalid' };
  const keys = Object.keys(value).sort();
  if (
    keys.length !== 5 ||
    keys[0] !== 'expectedCurrentSha256' ||
    keys[1] !== 'kind' ||
    keys[2] !== 'nextContentSha256' ||
    keys[3] !== 'schemaVersion' ||
    keys[4] !== 'skillId' ||
    value.schemaVersion !== 1 ||
    value.kind !== 'managed-skill-update' ||
    typeof value.skillId !== 'string' ||
    !isSafeSkillId(value.skillId) ||
    !isSha256(value.expectedCurrentSha256) ||
    !isSha256(value.nextContentSha256)
  ) {
    return { kind: 'invalid' };
  }
  return { kind: 'valid', intent: value as unknown as HostSkillUpdateIntent };
}

async function resolveInstalledSkillDirectory(
  root: string,
  id: string,
): Promise<string | undefined> {
  if (!isSafeSkillId(id)) return undefined;
  const skills = await readContainedDirectory(root, join(root, 'skills'));
  if (!skills) return undefined;
  const skill = await readContainedDirectory(skills.directoryReal, join(skills.directoryReal, id));
  return skill?.directoryReal;
}

async function readContainedDirectory(
  containmentRoot: string,
  directory: string,
): Promise<ScannedDirectory | undefined> {
  try {
    const rootReal = await realpath(containmentRoot);
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw persistenceFailed('Skill catalog directory is not a real directory');
    }
    const directoryReal = await realpath(directory);
    if (directoryReal !== rootReal && !isPathInside(rootReal, directoryReal)) {
      throw persistenceFailed('Skill catalog directory escapes its authority root');
    }
    const entries = await readdir(directoryReal, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    return { entries, rootReal, directoryReal };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    if (error instanceof HostSkillCatalogFilesystemError) throw error;
    throw persistenceFailed('Skill catalog directory could not be read', error);
  }
}

async function ensureContainedDirectory(
  containmentRoot: string,
  directory: string,
): Promise<string> {
  try {
    const rootReal = await realpath(containmentRoot);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw persistenceFailed('Skill catalog write directory is not a real directory');
    }
    const directoryReal = await realpath(directory);
    if (directoryReal !== rootReal && !isPathInside(rootReal, directoryReal)) {
      throw persistenceFailed('Skill catalog write directory escapes its authority root');
    }
    await syncDirectoryChain(directoryReal, rootReal);
    return directoryReal;
  } catch (error) {
    if (error instanceof HostSkillCatalogFilesystemError) throw error;
    throw persistenceFailed('Skill catalog write directory could not be prepared', error);
  }
}

async function readBoundedDocument(
  containmentRoot: string,
  path: string,
  maxBytes: number,
): Promise<ReadDocumentResult> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const rootReal = await realpath(containmentRoot);
    const flags =
      process.platform === 'win32'
        ? constants.O_RDONLY
        : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
    try {
      handle = await open(path, flags);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
      return { kind: 'blocked' };
    }
    const metadata = await handle.stat();
    if (!metadata.isFile()) return { kind: 'blocked' };
    if (metadata.size > maxBytes) return { kind: 'too_large' };
    const openedPath = await realpath(path).catch(() => undefined);
    if (!openedPath || !isPathInside(rootReal, openedPath)) return { kind: 'blocked' };
    const bytes = Buffer.allocUnsafe(metadata.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== metadata.size) return { kind: 'blocked' };
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return { kind: 'blocked' };
    }
    return { kind: 'ok', content, sha256: sha256(bytes) };
  } catch {
    return { kind: 'blocked' };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function writeDurableFile(directory: string, fileName: string, bytes: Buffer): Promise<void> {
  const path = join(directory, fileName);
  const temporaryPath = join(directory, `${fileName}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let published = false;
  try {
    const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
      throw persistenceFailed('Skill catalog file target is not a real file');
    }
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
    published = true;
    await syncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (!published) await rm(temporaryPath, { force: true }).catch(() => undefined);
    if (error instanceof HostSkillCatalogFilesystemError) throw error;
    if (published) throw commitOutcomeUnknown('Skill catalog file outcome is unknown', error);
    throw persistenceFailed('Skill catalog file could not be written', error);
  }
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectoryChain(directory: string, containmentRoot: string): Promise<void> {
  if (process.platform === 'win32') return;
  let current = directory;
  while (true) {
    await syncDirectory(current);
    if (current === containmentRoot) return;
    current = dirname(current);
  }
}

function canonicalSkillId(id: string): string {
  return id.toLowerCase();
}

function toDiagnostic(
  scope: HostSkillCatalogDiagnostic['scope'],
  id: string,
  issues: readonly Pick<SkillScanDiagnostic['issues'][number], 'code'>[],
): HostSkillCatalogDiagnostic {
  return {
    scope,
    id,
    codes: Object.freeze([...new Set(issues.map((issue) => issue.code))].sort()),
  };
}

function compareSources(left: HostSkillSource, right: HostSkillSource): number {
  return (
    left.name.localeCompare(right.name) ||
    left.id.localeCompare(right.id) ||
    left.sourceType.localeCompare(right.sourceType)
  );
}

function catalogProjectionIssue(manifest: {
  readonly name?: string;
  readonly description?: string;
  readonly category?: string;
  readonly allowedTools: readonly string[];
  readonly requiredTools: readonly string[];
  readonly requiredCapabilities: readonly string[];
}): string | undefined {
  if ((manifest.name?.length ?? 0) > CATALOG_NAME_MAX_LENGTH) return 'name_too_large';
  if ((manifest.description?.length ?? 0) > CATALOG_DESCRIPTION_MAX_LENGTH) {
    return 'description_too_large';
  }
  if ((manifest.category?.length ?? 0) > CATALOG_CATEGORY_MAX_LENGTH) {
    return 'category_too_large';
  }
  for (const values of [
    manifest.allowedTools,
    manifest.requiredTools,
    manifest.requiredCapabilities,
  ]) {
    if (values.length > CATALOG_STRING_LIST_MAX_ITEMS) return 'tool_list_too_large';
    if (values.some((value) => value.length > CATALOG_STRING_LIST_ITEM_MAX_LENGTH)) {
      return 'tool_name_too_large';
    }
  }
  return undefined;
}

function starterSkillTemplate(name: string): string {
  return `---\nname: ${name}\ndescription: 把常用工作流写成可复用的本地指令。\nallowed-tools: Read\n---\n\n# ${name}\n\n在这里描述什么时候使用这个 Skill，以及应按什么步骤完成任务。\n`;
}

function serializeJson(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function sha256(value: string | Buffer): HostSkillContentSha256 {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function isSha256(value: unknown): value is HostSkillContentSha256 {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
}

function persistenceFailed(message: string, cause?: unknown): HostSkillCatalogFilesystemError {
  return new HostSkillCatalogFilesystemError('persistence_failed', message, { cause });
}

function commitOutcomeUnknown(message: string, cause: unknown): HostSkillCatalogFilesystemError {
  return new HostSkillCatalogFilesystemError('commit_outcome_unknown', message, { cause });
}
