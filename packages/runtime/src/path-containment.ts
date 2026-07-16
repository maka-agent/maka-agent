import { isAbsolute, relative, sep } from 'node:path';

/**
 * Shared filesystem-containment and identifier guards.
 *
 * This leaf module is the single home for the path-safety primitives that were
 * previously kept as private copies across the runtime skill reader and the
 * desktop main process. Centralizing them means a future fix to a containment
 * check lands in one place instead of drifting between byte-identical copies.
 * It imports only `node:path`, so it has no reverse dependency on any heavier
 * module and can be safely reused by both the pure-Node runtime and the desktop
 * main process (which already depends on `@maka/runtime`).
 *
 * Two distinct containment families live here on purpose; they are NOT
 * interchangeable and were verified byte-for-byte before being moved verbatim:
 *
 * - {@link isContainedPath} treats any relative path whose string starts with
 *   `..` as an escape. It is the guard used by the skill reader
 *   (`skills.ts`) and the managed skill-source store.
 * - {@link isInside} is separator-aware: it rejects only an exact `..` or a
 *   `..<sep>`-prefixed relative path, so a sibling entry whose name literally
 *   begins with `..` (e.g. `..foo`) is correctly treated as inside. It is the
 *   guard used by the read-only explore worker.
 *
 * Their `..`-prefix handling differs, so reconciling the two is a deliberate,
 * behavior-changing decision that must not be folded into a mechanical move.
 * Callers must keep using the same guard they used before.
 */

/**
 * True when `child` resolves inside (or equal to) `root`. Any relative path
 * that begins with `..` is rejected as an escape. Used by the skill reader and
 * the managed skill-source store.
 */
export function isContainedPath(root: string, child: string): boolean {
  const rel = relative(root, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
}

/** True when `value` is a safe skill/source identifier (no path or control chars). */
export function isSafeSkillId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(value);
}

/**
 * Separator-aware containment check: true when `target` is inside (or equal to)
 * `root`. Rejects only an exact `..` or a `..<sep>`-prefixed relative path, so
 * a sibling whose name starts with `..` stays inside. Used by the read-only
 * explore worker. See the module note on why this differs from
 * {@link isContainedPath}.
 */
export function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Relative POSIX path from `root` to `target`, or `.` when they are equal. */
export function toRelative(root: string, target: string): string {
  const rel = relative(root, target);
  return rel === '' ? '.' : rel.split(sep).join('/');
}
