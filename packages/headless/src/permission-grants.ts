import { createHash } from 'node:crypto';
import type {
  PermissionResourceScope,
  TaskPermissionGrant,
  TaskPermissionRequest,
} from './task-contracts.js';

export type NormalizedPermissionArgs =
  | null
  | string
  | number
  | boolean
  | NormalizedPermissionArgs[]
  | { [key: string]: NormalizedPermissionArgs };

export function normalizePermissionArgs(value: unknown): NormalizedPermissionArgs {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map((entry) => normalizePermissionArgs(entry));
  if (typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const normalized: { [key: string]: NormalizedPermissionArgs } = {};
    for (const key of Object.keys(source).sort()) {
      const entry = source[key];
      if (entry === undefined || typeof entry === 'function' || typeof entry === 'symbol') continue;
      normalized[key] = normalizePermissionArgs(entry);
    }
    return normalized;
  }
  return null;
}

export function hashNormalizedArgs(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(normalizePermissionArgs(value)))
    .digest('hex');
}

export function commandResourceScope(command: string): PermissionResourceScope {
  const normalized = command.replace(/\s+/g, ' ').trim();
  const digest = createHash('sha256').update(normalized).digest('hex').slice(0, 16);
  return { kind: 'command', value: `bash-command:sha256:${digest}`, mode: 'execute' };
}

export function matchPermissionGrant(
  request: TaskPermissionRequest,
  grants: readonly TaskPermissionGrant[],
  now: number,
): TaskPermissionGrant | undefined {
  return grants.find(
    (grant) =>
      grant.decision === 'allow' &&
      grant.taskRunId === request.taskRunId &&
      (grant.attemptId === undefined || grant.attemptId === request.attemptId) &&
      (grant.toolCallId === undefined || grant.toolCallId === request.toolCallId) &&
      grant.toolName === request.toolName &&
      grant.normalizedArgsHash === request.normalizedArgsHash &&
      resourceScopeEquals(grant.resourceScope, request.resourceScope) &&
      grant.expiresAt > now,
  );
}

export function resourceScopeEquals(
  a: PermissionResourceScope,
  b: PermissionResourceScope,
): boolean {
  return a.kind === b.kind && a.value === b.value && a.mode === b.mode;
}

export function permissionPreview(args: unknown): Record<string, unknown> {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return { argType: Array.isArray(args) ? 'array' : typeof args };
  }
  const keys = Object.keys(args as Record<string, unknown>).sort();
  return {
    argKeys: keys.slice(0, 50),
    truncated: keys.length > 50,
  };
}
