import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import {
  isPathInside,
  isRecord,
  isSafeSkillId,
  writeContainedRegularTextFile,
} from './path-containment.js';

/**
 * Per-workspace skill enablement state — reading and writing
 * `skills-state.json` under the `.maka/` directory.
 *
 * Schema v2 stores per-skill preferences (`enabled`, `pinned`, `updatedAt`)
 * keyed by stable `ref`; schema v1 (legacy) stored bare boolean `enabled`
 * keyed by id. The reader handles both; the writer always writes v2.
 */

// ── Types ─────────────────────────────────────────────────────────────────

export type SkillRuntimeStatus = 'enabled' | 'disabled' | 'state_error';

export interface SkillRuntimePreference {
  enabled: boolean;
  pinned: boolean;
  updatedAt?: string;
}

export type SkillRuntimeStateReadResult =
  | {
      ok: true;
      states: Map<string, boolean>;
      preferences: Map<string, SkillRuntimePreference>;
      /** Legacy ids that matched more than one scope and require explicit ref choices. */
      needsReview: Set<string>;
      schemaVersion: 1 | 2;
    }
  | { ok: false; reason: 'blocked_path' | 'read_failed' | 'invalid_json' };

// ── Internal types ────────────────────────────────────────────────────────

interface SkillStateFileV2 {
  schemaVersion: 2;
  skills: Record<string, SkillRuntimePreference>;
  migration?: { needsReview: string[] };
}

// ── Public API ────────────────────────────────────────────────────────────

export async function readSkillRuntimeState(root: string): Promise<SkillRuntimeStateReadResult> {
  const metadataDir = join(root, '.maka');
  const stateFile = join(metadataDir, 'skills-state.json');
  try {
    const rootReal = await realpath(root);
    const metadataStat = await lstat(metadataDir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (metadataStat === null) {
      return {
        ok: true,
        states: new Map(),
        preferences: new Map(),
        needsReview: new Set(),
        schemaVersion: 2,
      };
    }
    if (!metadataStat.isDirectory() || metadataStat.isSymbolicLink())
      return { ok: false, reason: 'blocked_path' };
    const metadataReal = await realpath(metadataDir);
    if (!isPathInside(rootReal, metadataReal)) return { ok: false, reason: 'blocked_path' };

    const stateStat = await lstat(stateFile).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (stateStat === null) {
      return {
        ok: true,
        states: new Map(),
        preferences: new Map(),
        needsReview: new Set(),
        schemaVersion: 2,
      };
    }
    if (!stateStat.isFile() || stateStat.isSymbolicLink())
      return { ok: false, reason: 'blocked_path' };

    const stateReal = await realpath(stateFile);
    if (!isPathInside(metadataReal, stateReal)) return { ok: false, reason: 'blocked_path' };

    const parsed = JSON.parse(await readFile(stateFile, 'utf8')) as unknown;
    if (
      !isRecord(parsed) ||
      (parsed.schemaVersion !== 1 && parsed.schemaVersion !== 2) ||
      !isRecord(parsed.skills)
    ) {
      return { ok: false, reason: 'invalid_json' };
    }
    const states = new Map<string, boolean>();
    const preferences = new Map<string, SkillRuntimePreference>();
    for (const [key, value] of Object.entries(parsed.skills)) {
      if (
        !isSafeSkillPreferenceKey(key) ||
        !isRecord(value) ||
        typeof value.enabled !== 'boolean' ||
        (parsed.schemaVersion === 2 && typeof value.pinned !== 'boolean') ||
        (value.updatedAt !== undefined && typeof value.updatedAt !== 'string')
      ) {
        return { ok: false, reason: 'invalid_json' };
      }
      const preference: SkillRuntimePreference = {
        enabled: value.enabled,
        pinned: parsed.schemaVersion === 2 ? value.pinned === true : false,
        ...(typeof value.updatedAt === 'string' ? { updatedAt: value.updatedAt } : {}),
      };
      states.set(key, preference.enabled);
      preferences.set(key, preference);
    }
    const needsReview = new Set<string>();
    if (parsed.schemaVersion === 2 && parsed.migration !== undefined) {
      if (
        !isRecord(parsed.migration) ||
        !Array.isArray(parsed.migration.needsReview) ||
        !parsed.migration.needsReview.every((id) => typeof id === 'string' && isSafeSkillId(id))
      ) {
        return { ok: false, reason: 'invalid_json' };
      }
      for (const id of parsed.migration.needsReview) needsReview.add(id);
    }
    return { ok: true, states, preferences, needsReview, schemaVersion: parsed.schemaVersion };
  } catch (error) {
    if (error instanceof SyntaxError) return { ok: false, reason: 'invalid_json' };
    return { ok: false, reason: 'read_failed' };
  }
}

export async function writeSkillRuntimeState(
  root: string,
  states: Map<string, boolean>,
): Promise<{ ok: true } | { ok: false; reason: 'blocked_path' | 'write_failed' }> {
  const preferences = new Map<string, SkillRuntimePreference>();
  for (const [key, enabled] of states) preferences.set(key, { enabled, pinned: false });
  return writeSkillRuntimePreferences(root, preferences);
}

export async function writeSkillRuntimePreferences(
  root: string,
  preferences: Map<string, SkillRuntimePreference>,
  options: { needsReview?: ReadonlySet<string> } = {},
): Promise<{ ok: true } | { ok: false; reason: 'blocked_path' | 'write_failed' }> {
  const resolved = await resolveSkillRuntimeStateDirForWrite(root);
  if (!resolved.ok) return resolved;
  const sortedPreferences = [...preferences.entries()]
    .filter(([key]) => isSafeSkillPreferenceKey(key))
    .sort(([a], [b]) => a.localeCompare(b));
  const file: SkillStateFileV2 = {
    schemaVersion: 2,
    skills: Object.fromEntries(
      sortedPreferences.map(([key, preference]) => [
        key,
        {
          enabled: preference.enabled,
          pinned: preference.pinned,
          updatedAt: preference.updatedAt ?? new Date().toISOString(),
        },
      ]),
    ),
    ...(options.needsReview && options.needsReview.size > 0
      ? { migration: { needsReview: [...options.needsReview].filter(isSafeSkillId).sort() } }
      : {}),
  };
  const ok = await writeContainedRegularTextFile(
    resolved.metadataDir,
    join(resolved.metadataDir, 'skills-state.json'),
    `${JSON.stringify(file, null, 2)}\n`,
  );
  return ok ? { ok: true } : { ok: false, reason: 'write_failed' };
}

// ── Internal helpers ─────────────────────────────────────────────────────

function isSafeSkillPreferenceKey(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 512 &&
    !/[\u0000-\u001F\u007F]/.test(value) &&
    value !== '__proto__' &&
    value !== 'constructor' &&
    value !== 'prototype'
  );
}

async function resolveSkillRuntimeStateDirForWrite(
  root: string,
): Promise<
  { ok: true; metadataDir: string } | { ok: false; reason: 'blocked_path' | 'write_failed' }
> {
  const metadataDir = join(root, '.maka');
  try {
    const rootReal = await realpath(root);
    await mkdir(metadataDir, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
    const metadataStat = await lstat(metadataDir);
    if (!metadataStat.isDirectory() || metadataStat.isSymbolicLink())
      return { ok: false, reason: 'blocked_path' };
    const metadataReal = await realpath(metadataDir);
    if (!isPathInside(rootReal, metadataReal)) return { ok: false, reason: 'blocked_path' };
    return { ok: true, metadataDir };
  } catch {
    return { ok: false, reason: 'write_failed' };
  }
}