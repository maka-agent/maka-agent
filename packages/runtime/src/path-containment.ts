import { isAbsolute, relative, sep } from 'node:path';

/**
 * Shared filesystem-containment and identifier guards, moved verbatim from
 * previously duplicated private copies in the runtime skill reader and the
 * desktop main process. This leaf module imports only `node:path`, so both the
 * pure-Node runtime and the desktop main process (which already depends on
 * `@maka/runtime`) can use it without reverse dependencies.
 *
 * Two behavior variants live here and are NOT interchangeable — their
 * `..`-prefix handling diverges on a child entry whose own name begins with
 * `..` (e.g. `root/..foo`): {@link isContainedPath} rejects it as an escape,
 * while the separator-aware {@link isInside} correctly treats it as inside.
 * Reconciling them is a behavior-changing decision, not a mechanical move;
 * callers must keep the guard they used before.
 *
 * This module is not yet the single home of containment logic, and function
 * names elsewhere do not reliably indicate which variant they implement.
 * Known remaining variants pending a follow-up consolidation:
 * - `workspace-executor.ts`, `filesystem-worker/operations.ts`, and
 *   `additional-permissions.ts` each define a local `isInside`-style check
 *   with bare-`startsWith('..')` ({@link isContainedPath}) semantics.
 * - {@link isPathInside} (moved here from `system-prompt/workspace-instructions.ts`)
 *   is the cross-platform-tested, `pathApi`-injectable form of this check and
 *   the intended single home for the separator-aware family once the bare-
 *   `startsWith('..')` variants below migrate to it.
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
 * a child entry whose own name starts with `..` stays inside. See the module
 * note on why this differs from {@link isContainedPath}.
 *
 * Prefer {@link isPathInside} for new code: it is the same check with an
 * injectable `pathApi` and an explicit cross-drive guard, and is intended to
 * replace both this and {@link isContainedPath} once callers migrate.
 */
export function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Path primitives {@link isPathInside} uses, injectable for cross-platform tests. */
export interface PathInsideApi {
  relative: typeof relative;
  isAbsolute: typeof isAbsolute;
  sep: string;
}

/**
 * Separator-aware containment check with an injectable `pathApi`: true when
 * `target` is inside (or equal to) `root`. Moved here from
 * `system-prompt/workspace-instructions.ts` so the separator-aware family has
 * one home; defaults use the host `node:path`. The injectable primitives make
 * the Windows cross-drive case and POSIX sandbox paths testable.
 */
export function isPathInside(root: string, target: string, pathApi: PathInsideApi = { relative, isAbsolute, sep }): boolean {
  const rel = pathApi.relative(root, target);
  // path.relative returns the target path unchanged (absolute) when root and
  // target are on different drives on Windows. An absolute result means the
  // target is not reachable from root via a relative path, so reject it before
  // the `..` escape check.
  if (pathApi.isAbsolute(rel)) return false;
  // Reject only a real parent-reference segment: the exact ".." or a path
  // starting with `..${sep}`. A leading ".." followed by anything else (e.g.
  // "..rules") is a legitimate directory name, not an escape.
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${pathApi.sep}`));
}

/** Relative POSIX path from `root` to `target`, or `.` when they are equal. */
export function toRelative(root: string, target: string): string {
  const rel = relative(root, target);
  return rel === '' ? '.' : rel.split(sep).join('/');
}
