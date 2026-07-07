import { PROTECTED_METADATA_NAMES, type PermissionProfile } from '@maka/core/permission-profile';

import type { SandboxPathContext } from './types.js';

export const MACOS_SEATBELT_EXECUTABLE = '/usr/bin/sandbox-exec';

export const MACOS_SEATBELT_BASE_POLICY = `(version 1)
(deny default)

(allow process*)
(allow signal (target same-sandbox))
(allow sysctl*)
(allow file-read-metadata)
(allow file-read*
  (subpath "/System")
  (subpath "/usr")
  (subpath "/bin")
  (subpath "/sbin")
  (subpath "/Library/Apple")
  (literal "/dev/null")
  (literal "/dev/zero"))`;

export interface BuildSeatbeltPolicyInput {
  profile: PermissionProfile;
  pathContext: SandboxPathContext;
}

export interface BuildSeatbeltPolicyResult {
  policy: string;
  definitionArgs: readonly string[];
}

export interface CreateSeatbeltExecArgsInput extends BuildSeatbeltPolicyInput {
  innerArgv: readonly string[];
}

interface ResolvedRoots {
  readableRoots: readonly string[];
  writableRoots: readonly string[];
  protectedWritableRoots: readonly string[];
}

export function escapeSeatbeltRegex(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

export function buildSeatbeltPolicy(input: BuildSeatbeltPolicyInput): BuildSeatbeltPolicyResult {
  const roots = resolveRoots(input.profile, input.pathContext);
  const definitionArgs = [
    ...roots.readableRoots.map((root, index) => `-DREADABLE_ROOT_${index}=${root}`),
    ...roots.writableRoots.map((root, index) => `-DWRITABLE_ROOT_${index}=${root}`),
  ];

  const sections = [
    MACOS_SEATBELT_BASE_POLICY,
    buildReadableRootsPolicy(roots.readableRoots),
    buildWritableRootsPolicy(roots),
    buildNetworkPolicy(input.profile),
  ].filter(Boolean);

  return {
    policy: `${sections.join('\n\n')}\n`,
    definitionArgs,
  };
}

export function createSeatbeltExecArgs(input: CreateSeatbeltExecArgsInput): readonly string[] {
  const { policy, definitionArgs } = buildSeatbeltPolicy(input);
  return ['-p', policy, ...definitionArgs, '--', ...input.innerArgv];
}

function resolveRoots(profile: PermissionProfile, pathContext: SandboxPathContext): ResolvedRoots {
  if (profile.type !== 'managed' || profile.fileSystem.kind !== 'restricted') {
    return {
      readableRoots: [],
      writableRoots: [],
      protectedWritableRoots: [],
    };
  }

  const readableRoots: string[] = [];
  const writableRoots: string[] = [];
  const protectedWritableRoots: string[] = [];

  for (const entry of profile.fileSystem.entries) {
    if (entry.access === 'deny') continue;

    const roots = rootsForEntry(entry, pathContext);
    if (entry.access === 'read' || entry.access === 'write') {
      addUniqueRoots(readableRoots, roots);
    }
    if (entry.access === 'write') {
      addUniqueRoots(writableRoots, roots);
      if (entry.kind === 'special' && entry.special === ':workspace_roots') {
        addUniqueRoots(protectedWritableRoots, roots);
      }
    }
  }

  return {
    readableRoots,
    writableRoots,
    protectedWritableRoots: profile.fileSystem.protectedMetadata ? protectedWritableRoots : [],
  };
}

function rootsForEntry(
  entry: PermissionProfileManagedEntry,
  pathContext: SandboxPathContext,
): readonly string[] {
  if (entry.kind === 'path') return [entry.path];

  switch (entry.special) {
    case ':root':
      return ['/'];
    case ':workspace_roots':
      return pathContext.workspaceRoots;
    case ':tmpdir':
      return pathContext.tmpdir ? [pathContext.tmpdir] : [];
    case ':slash_tmp':
      return [pathContext.slashTmp ?? '/tmp'];
    case ':minimal':
      return pathContext.minimalRoots ?? [];
  }
}

function addUniqueRoots(target: string[], roots: readonly string[]): void {
  for (const root of roots) {
    if (!target.includes(root)) target.push(root);
  }
}

function buildReadableRootsPolicy(readableRoots: readonly string[]): string {
  if (readableRoots.length === 0) return '';

  const params = readableRoots
    .map((_, index) => `  (subpath (param "READABLE_ROOT_${index}"))`)
    .join('\n');
  return `(allow file-read*\n${params})`;
}

function buildWritableRootsPolicy(roots: ResolvedRoots): string {
  if (roots.writableRoots.length === 0) return '';

  const params = roots.writableRoots
    .map((root, index) => writableRootClause(root, index, roots.protectedWritableRoots))
    .join('\n');
  return `(allow file-write*\n${params})`;
}

function writableRootClause(
  root: string,
  index: number,
  protectedWritableRoots: readonly string[],
): string {
  const rootParam = `(subpath (param "WRITABLE_ROOT_${index}"))`;
  if (!protectedWritableRoots.includes(root)) return `  ${rootParam}`;

  const protectedClauses = PROTECTED_METADATA_NAMES.map(
    (name) => `    ${protectedMetadataRequirement(root, name)}`,
  ).join('\n');

  return `  (require-all ${rootParam}\n${protectedClauses})`;
}

function protectedMetadataRequirement(root: string, name: string): string {
  const escapedRoot = escapeSeatbeltRegex(trimTrailingSlash(root));
  const escapedName = escapeSeatbeltRegex(name);
  return `(require-not (regex #"^${escapedRoot}/(.*/)?${escapedName}(/.*)?$"))`;
}

function trimTrailingSlash(path: string): string {
  if (path === '/') return path;
  return path.replace(/\/+$/g, '');
}

function buildNetworkPolicy(profile: PermissionProfile): string {
  if (profile.type === 'managed' && profile.network.kind === 'enabled') {
    return '(allow network*)';
  }
  if (profile.type === 'external' && profile.network.kind === 'enabled') {
    return '(allow network*)';
  }
  return '(deny network*)';
}

type PermissionProfileManagedEntry = Extract<PermissionProfile, { type: 'managed' }>['fileSystem']['entries'][number];
