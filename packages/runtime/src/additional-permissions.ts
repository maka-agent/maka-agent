import { promises as fs } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import {
  MAX_ADDITIONAL_FILESYSTEM_ENTRIES,
  MAX_ADDITIONAL_PERMISSION_PATH_CHARS,
  additionalPermissionRequiredForPath,
  serializeAdditionalPermissionProfile,
  validateAdditionalPermissionProfile,
  type AdditionalFileSystemPermission,
  type AdditionalPermissionAccess,
  type AdditionalPermissionProfile,
  type AdditionalPermissionRiskSummary,
  type AdditionalPermissionScope,
} from '@maka/core/additional-permissions';
import {
  isDeniedPath,
  isProtectedMetadataPath,
  type PermissionProfile,
  type PermissionProfileMatchContext,
} from '@maka/core/permission-profile';
import type { PermissionMode } from '@maka/core/permission';

import { hashAdditionalPermissionProfile } from './additional-permission-hash.js';
import { stableHash } from './request-shape.js';

export const MAX_ADDITIONAL_PERMISSION_JUSTIFICATION_CHARS = 500;

export type AdditionalPermissionErrorReason =
  | 'invalid_additional_permissions'
  | 'additional_permissions_disallowed_by_mode'
  | 'additional_permissions_conflict_with_deny'
  | 'grant_path_changed';

export class AdditionalPermissionError extends Error {
  readonly code = 'ADDITIONAL_PERMISSION_FAILED';
  readonly domain = 'permission' as const;
  readonly stage: 'planning' | 'validation';
  readonly reason: AdditionalPermissionErrorReason;
  readonly recoverable: boolean;

  constructor(input: {
    stage: AdditionalPermissionError['stage'];
    reason: AdditionalPermissionErrorReason;
    message?: string;
    recoverable?: boolean;
  }) {
    super(input.message ?? `Additional permission failed: ${input.reason}.`);
    this.name = 'AdditionalPermissionError';
    this.stage = input.stage;
    this.reason = input.reason;
    this.recoverable = input.recoverable ?? false;
  }
}

export interface NormalizedAdditionalPermissionPath {
  readonly displayPath: string;
  readonly enforcementPath: string;
  readonly access: AdditionalPermissionAccess;
  readonly scope: AdditionalPermissionScope;
  readonly targetType: 'file' | 'directory' | 'other' | 'missing';
}

export interface AdditionalPermissionProposal {
  readonly profile: AdditionalPermissionProfile;
  readonly normalizedPaths: readonly NormalizedAdditionalPermissionPath[];
  readonly justification: string;
  readonly intentHash: string;
  readonly permissionsHash: string;
  readonly risk: AdditionalPermissionRiskSummary;
}

export type AdditionalPermissionPlanResult =
  | { kind: 'not_required' }
  | { kind: 'request'; proposal: AdditionalPermissionProposal }
  | { kind: 'block'; reason: AdditionalPermissionErrorReason; message: string };

export interface AdditionalPermissionPlanningContext {
  readonly profile: PermissionProfile;
  readonly workspaceRoots: readonly string[];
  readonly pathContext?: Partial<Omit<PermissionProfileMatchContext, 'workspaceRoots'>>;
}

export function freezeAdditionalPermissionProposal(
  proposal: AdditionalPermissionProposal,
): AdditionalPermissionProposal {
  return Object.freeze({
    ...proposal,
    profile: freezeAdditionalPermissionProfile(proposal.profile),
    normalizedPaths: freezeNormalizedPaths(proposal.normalizedPaths),
    risk: Object.freeze({ ...proposal.risk }),
  });
}

export function assertAdditionalPermissionProposal(input: {
  proposal: AdditionalPermissionProposal;
  toolName: string;
  args: unknown;
}): void {
  const { proposal } = input;
  const validated = validateAdditionalPermissionProfile(proposal.profile);
  if (
    !validated.ok
    || proposal.permissionsHash !== hashAdditionalPermissionProfile(proposal.profile)
    || proposal.intentHash !== stableHash({ toolName: input.toolName, args: input.args })
    || !proposal.justification.trim()
    || proposal.justification.length > MAX_ADDITIONAL_PERMISSION_JUSTIFICATION_CHARS
  ) {
    throw invalidProfile('Additional permission proposal integrity validation failed.');
  }

  const profileEntries = proposal.profile.fileSystem?.entries ?? [];
  if (profileEntries.length !== proposal.normalizedPaths.length) {
    throw invalidProfile('Additional permission proposal path metadata did not match its profile.');
  }
  for (const entry of profileEntries) {
    const normalized = proposal.normalizedPaths.find((candidate) => (
      candidate.enforcementPath === entry.path
      && candidate.access === entry.access
      && candidate.scope === entry.scope
    ));
    if (
      !normalized
      || !isAbsolute(normalized.displayPath)
      || !['file', 'directory', 'other', 'missing'].includes(normalized.targetType)
    ) {
      throw invalidProfile('Additional permission proposal path metadata was invalid.');
    }
  }
}

export async function normalizeAdditionalPermissionProfile(input: {
  profile: unknown;
  cwd: string;
}): Promise<{
  profile: AdditionalPermissionProfile;
  normalizedPaths: readonly NormalizedAdditionalPermissionPath[];
}> {
  if (!isRecord(input.profile)) throw invalidProfile('Additional permission profile must be an object.');
  if (hasUnexpectedKeys(input.profile, ['fileSystem', 'network'])) {
    throw invalidProfile('Additional permission profile contains unsupported fields.');
  }

  const rawEntries = parseRawEntries(input.profile.fileSystem);
  const network = parseRawNetwork(input.profile.network);
  const canonicalCwd = await fs.realpath(input.cwd);
  const normalizedPaths: NormalizedAdditionalPermissionPath[] = [];
  for (const entry of rawEntries) {
    normalizedPaths.push(await normalizeAdditionalPermissionPath({ ...entry, cwd: canonicalCwd }));
  }

  const candidate = {
    ...(normalizedPaths.length > 0
      ? {
          fileSystem: {
            entries: normalizedPaths.map((entry) => ({
              path: entry.enforcementPath,
              access: entry.access,
              scope: entry.scope,
            })),
          },
        }
      : {}),
    ...(network ? { network: { enabled: true as const } } : {}),
  };
  const validated = validateAdditionalPermissionProfile(candidate);
  if (!validated.ok) throw invalidProfile(validated.message);

  const normalizedByKey = new Map(normalizedPaths.map((entry) => [permissionPathKey(entry), entry]));
  return {
    profile: validated.profile,
    normalizedPaths: validated.profile.fileSystem?.entries.map((entry) => (
      normalizedByKey.get(permissionPathKey({
        displayPath: entry.path,
        enforcementPath: entry.path,
        access: entry.access,
        scope: entry.scope,
        targetType: 'missing',
      })) ?? {
        displayPath: entry.path,
        enforcementPath: entry.path,
        access: entry.access,
        scope: entry.scope,
        targetType: 'missing',
      }
    )) ?? [],
  };
}

export async function normalizeAdditionalPermissionPath(input: {
  path: string;
  access: AdditionalPermissionAccess;
  scope: AdditionalPermissionScope;
  cwd: string;
}): Promise<NormalizedAdditionalPermissionPath> {
  validateRawPath(input.path);
  const canonicalCwd = await fs.realpath(input.cwd);
  const displayPath = resolve(canonicalCwd, input.path);
  const enforcementPath = await realpathAllowMissing(displayPath);
  const targetType = await additionalPermissionTargetType(enforcementPath);
  if (input.scope === 'subtree' && targetType !== 'directory') {
    throw invalidProfile('A subtree additional permission must target an existing directory.');
  }
  return {
    displayPath,
    enforcementPath,
    access: input.access,
    scope: input.scope,
    targetType,
  };
}

export async function revalidateAdditionalPermissionProposal(input: {
  proposal: AdditionalPermissionProposal;
  cwd: string;
}): Promise<void> {
  const current = await normalizeAdditionalPermissionProfile({
    profile: {
      ...(input.proposal.normalizedPaths.length > 0
        ? {
            fileSystem: {
              entries: input.proposal.normalizedPaths.map((entry) => ({
                path: entry.displayPath,
                access: entry.access,
                scope: entry.scope,
              })),
            },
          }
        : {}),
      ...(input.proposal.profile.network ? { network: input.proposal.profile.network } : {}),
    },
    cwd: input.cwd,
  });
  if (
    serializeAdditionalPermissionProfile(current.profile)
    !== serializeAdditionalPermissionProfile(input.proposal.profile)
  ) {
    throw pathChanged('An approved additional permission path changed before execution.');
  }

  const currentByKey = new Map(current.normalizedPaths.map((entry) => [permissionPathKey(entry), entry]));
  if (input.proposal.normalizedPaths.some((approved) => (
    currentByKey.get(permissionPathKey(approved))?.targetType !== approved.targetType
  ))) {
    throw pathChanged('An approved additional permission target changed type before execution.');
  }
}

export async function planFileToolAdditionalPermission(input: {
  toolName: 'Read' | 'Write' | 'Edit' | 'FormatJson' | 'Glob' | 'Grep';
  path: string;
  cwd: string;
  mode: PermissionMode;
  args: unknown;
  context: AdditionalPermissionPlanningContext;
}): Promise<AdditionalPermissionPlanResult> {
  const access: AdditionalPermissionAccess = input.toolName === 'Write'
    || input.toolName === 'Edit'
    || input.toolName === 'FormatJson'
    ? 'write'
    : 'read';
  const scope: AdditionalPermissionScope = input.toolName === 'Glob' || input.toolName === 'Grep'
    ? 'subtree'
    : 'exact';

  let normalized: Awaited<ReturnType<typeof normalizeAdditionalPermissionProfile>>;
  try {
    normalized = await normalizeAdditionalPermissionProfile({
      profile: { fileSystem: { entries: [{ path: input.path, access, scope }] } },
      cwd: input.cwd,
    });
  } catch (error) {
    return blockFromError(error);
  }

  const path = normalized.profile.fileSystem!.entries[0]!.path;
  const matchContext: PermissionProfileMatchContext = {
    ...input.context.pathContext,
    workspaceRoots: input.context.workspaceRoots,
  };
  if (!additionalPermissionRequiredForPath({
    profile: input.context.profile,
    path,
    access,
    context: matchContext,
  })) {
    return { kind: 'not_required' };
  }
  if (input.mode === 'explore' || input.mode === 'bypass') {
    return {
      kind: 'block',
      reason: 'additional_permissions_disallowed_by_mode',
      message: `Additional filesystem permissions are not available in ${input.mode} mode.`,
    };
  }
  if (isDeniedPath(input.context.profile, path, matchContext)) {
    return {
      kind: 'block',
      reason: 'additional_permissions_conflict_with_deny',
      message: 'The requested path is protected by an explicit deny rule.',
    };
  }
  return {
    kind: 'request',
    proposal: buildAdditionalPermissionProposal({
      profile: normalized.profile,
      normalizedPaths: normalized.normalizedPaths,
      justification: `${input.toolName} requires access to the requested path.`,
      toolName: input.toolName,
      args: input.args,
      workspaceRoots: input.context.workspaceRoots,
    }),
  };
}

export async function planDeclaredBashAdditionalPermission(input: {
  declaration: unknown;
  cwd: string;
  mode: PermissionMode;
  command: string;
  context: AdditionalPermissionPlanningContext;
}): Promise<AdditionalPermissionPlanResult> {
  if (input.declaration === undefined) return { kind: 'not_required' };
  if (
    !isRecord(input.declaration)
    || hasUnexpectedKeys(input.declaration, ['mode', 'file_system', 'network', 'justification'])
  ) {
    return blockInvalid('Bash sandbox_permissions declaration is invalid.');
  }
  if (input.declaration.mode === 'use_default') {
    if (
      input.declaration.file_system !== undefined
      || input.declaration.network !== undefined
      || input.declaration.justification !== undefined
    ) {
      return blockInvalid('use_default cannot include additional permissions.');
    }
    return { kind: 'not_required' };
  }
  if (input.declaration.mode === 'require_escalated') return { kind: 'not_required' };
  if (input.declaration.mode !== 'with_additional_permissions') {
    return blockInvalid('Bash sandbox_permissions mode is invalid.');
  }
  if (input.mode === 'explore') {
    return {
      kind: 'block',
      reason: 'additional_permissions_disallowed_by_mode',
      message: 'Additional Bash permissions are not available in explore mode.',
    };
  }
  if (input.mode === 'bypass') return { kind: 'not_required' };

  const justification = normalizeJustification(input.declaration.justification);
  if (!justification) return blockInvalid('Bash additional permissions require a justification.');

  let normalized: Awaited<ReturnType<typeof normalizeAdditionalPermissionProfile>>;
  try {
    normalized = await normalizeAdditionalPermissionProfile({
      profile: {
        ...(input.declaration.file_system !== undefined
          ? { fileSystem: input.declaration.file_system }
          : {}),
        ...(input.declaration.network === true ? { network: { enabled: true } } : {}),
      },
      cwd: input.cwd,
    });
  } catch (error) {
    return blockFromError(error);
  }

  const matchContext: PermissionProfileMatchContext = {
    ...input.context.pathContext,
    workspaceRoots: input.context.workspaceRoots,
  };
  for (const entry of normalized.profile.fileSystem?.entries ?? []) {
    if (isDeniedPath(input.context.profile, entry.path, matchContext)) {
      return {
        kind: 'block',
        reason: 'additional_permissions_conflict_with_deny',
        message: 'A requested Bash path is protected by an explicit deny rule.',
      };
    }
  }

  const neededEntries = normalized.profile.fileSystem?.entries.filter((entry) => (
    additionalPermissionRequiredForPath({
      profile: input.context.profile,
      path: entry.path,
      access: entry.access,
      context: matchContext,
    })
  )) ?? [];
  const networkNeeded = Boolean(normalized.profile.network?.enabled)
    && !permissionProfileHasNetwork(input.context.profile);
  if (neededEntries.length === 0 && !networkNeeded) return { kind: 'not_required' };

  const requiredProfile: AdditionalPermissionProfile = {
    ...(neededEntries.length > 0 ? { fileSystem: { entries: neededEntries } } : {}),
    ...(networkNeeded ? { network: { enabled: true } } : {}),
  };
  const neededPathKeys = new Set(neededEntries.map((entry) => permissionEntryKey(entry)));
  const requiredPaths = normalized.normalizedPaths.filter((entry) => (
    neededPathKeys.has(permissionPathKey(entry))
  ));

  return {
    kind: 'request',
    proposal: buildAdditionalPermissionProposal({
      profile: requiredProfile,
      normalizedPaths: requiredPaths,
      justification,
      toolName: 'Bash',
      args: { command: input.command, sandbox_permissions: input.declaration },
      workspaceRoots: input.context.workspaceRoots,
    }),
  };
}

export function buildAdditionalPermissionProposal(input: {
  profile: AdditionalPermissionProfile;
  normalizedPaths: readonly NormalizedAdditionalPermissionPath[];
  justification: string;
  toolName: string;
  args: unknown;
  workspaceRoots: readonly string[];
}): AdditionalPermissionProposal {
  const protectedMetadata = input.profile.fileSystem?.entries.some((entry) => (
    isProtectedMetadataPath(entry.path, input.workspaceRoots)
  )) ?? false;
  const outsideWorkspace = input.profile.fileSystem?.entries.some((entry) => (
    !input.workspaceRoots.some((root) => pathWithinRoot(entry.path, root))
  )) ?? false;
  return freezeAdditionalPermissionProposal({
    profile: input.profile,
    normalizedPaths: input.normalizedPaths,
    justification: normalizeJustification(input.justification) ?? 'Additional permission required.',
    intentHash: stableHash({ toolName: input.toolName, args: input.args }),
    permissionsHash: hashAdditionalPermissionProfile(input.profile),
    risk: {
      outsideWorkspace,
      protectedMetadata,
      networkEnabled: Boolean(input.profile.network?.enabled),
    },
  });
}

function freezeAdditionalPermissionProfile(
  profile: AdditionalPermissionProfile,
): AdditionalPermissionProfile {
  const entries = profile.fileSystem?.entries.map((entry) => Object.freeze({ ...entry })) ?? [];
  return Object.freeze({
    ...(entries.length > 0
      ? { fileSystem: Object.freeze({ entries: Object.freeze(entries) }) }
      : {}),
    ...(profile.network ? { network: Object.freeze({ enabled: true as const }) } : {}),
  });
}

function freezeNormalizedPaths(
  paths: readonly NormalizedAdditionalPermissionPath[],
): readonly NormalizedAdditionalPermissionPath[] {
  return Object.freeze(paths.map((entry) => Object.freeze({ ...entry })));
}

function parseRawEntries(input: unknown): AdditionalFileSystemPermission[] {
  if (input === undefined) return [];
  if (!isRecord(input) || hasUnexpectedKeys(input, ['entries']) || !Array.isArray(input.entries)) {
    throw invalidProfile('fileSystem must contain an entries array.');
  }
  if (input.entries.length > MAX_ADDITIONAL_FILESYSTEM_ENTRIES) {
    throw invalidProfile(
      `Additional filesystem permissions are limited to ${MAX_ADDITIONAL_FILESYSTEM_ENTRIES} entries.`,
    );
  }
  return input.entries.map((candidate) => {
    if (!isRecord(candidate) || hasUnexpectedKeys(candidate, ['path', 'access', 'scope'])) {
      throw invalidProfile('Additional filesystem permission contains unsupported fields.');
    }
    if (
      typeof candidate.path !== 'string'
      || (candidate.access !== 'read' && candidate.access !== 'write')
      || (candidate.scope !== 'exact' && candidate.scope !== 'subtree')
    ) {
      throw invalidProfile('Additional filesystem permission must contain path, access, and scope.');
    }
    validateRawPath(candidate.path);
    return {
      path: candidate.path,
      access: candidate.access,
      scope: candidate.scope,
    };
  });
}

function parseRawNetwork(input: unknown): boolean {
  if (input === undefined) return false;
  if (!isRecord(input) || hasUnexpectedKeys(input, ['enabled']) || input.enabled !== true) {
    throw invalidProfile('network additional permission only supports enabled: true.');
  }
  return true;
}

function validateRawPath(path: string): void {
  if (!path || path.includes('\0') || path.length > MAX_ADDITIONAL_PERMISSION_PATH_CHARS) {
    throw invalidProfile('Additional permission path is invalid or exceeds the length limit.');
  }
}

async function realpathAllowMissing(target: string): Promise<string> {
  let cursor = target;
  const missing: string[] = [];
  while (true) {
    try {
      const realParent = await fs.realpath(cursor);
      return resolve(realParent, ...missing.reverse());
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      missing.push(cursor.slice(parent.length + (parent === '/' ? 0 : 1)));
      cursor = parent;
    }
  }
}

async function additionalPermissionTargetType(
  path: string,
): Promise<NormalizedAdditionalPermissionPath['targetType']> {
  try {
    const stat = await fs.stat(path);
    if (stat.isFile()) return 'file';
    if (stat.isDirectory()) return 'directory';
    return 'other';
  } catch (error) {
    if (isMissingPathError(error)) return 'missing';
    throw error;
  }
}

function normalizeJustification(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  return normalized.slice(0, MAX_ADDITIONAL_PERMISSION_JUSTIFICATION_CHARS);
}

function permissionEntryKey(entry: AdditionalFileSystemPermission): string {
  return `${entry.access}:${entry.scope}:${entry.path}`;
}

function permissionPathKey(entry: NormalizedAdditionalPermissionPath): string {
  return `${entry.access}:${entry.scope}:${entry.enforcementPath}`;
}

function permissionProfileHasNetwork(profile: PermissionProfile): boolean {
  return profile.type !== 'disabled' && profile.network.kind === 'enabled';
}

function pathWithinRoot(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function isMissingPathError(error: unknown): boolean {
  return isRecord(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasUnexpectedKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).some((key) => !allowed.includes(key));
}

function invalidProfile(message: string): AdditionalPermissionError {
  return new AdditionalPermissionError({
    stage: 'planning',
    reason: 'invalid_additional_permissions',
    message,
    recoverable: true,
  });
}

function pathChanged(message: string): AdditionalPermissionError {
  return new AdditionalPermissionError({
    stage: 'validation',
    reason: 'grant_path_changed',
    message,
  });
}

function blockInvalid(message: string): AdditionalPermissionPlanResult {
  return { kind: 'block', reason: 'invalid_additional_permissions', message };
}

function blockFromError(error: unknown): AdditionalPermissionPlanResult {
  if (error instanceof AdditionalPermissionError) {
    return { kind: 'block', reason: error.reason, message: error.message };
  }
  return {
    kind: 'block',
    reason: 'invalid_additional_permissions',
    message: error instanceof Error ? error.message : String(error),
  };
}
