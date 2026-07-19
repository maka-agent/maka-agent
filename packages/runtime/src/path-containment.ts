import { isAbsolute, relative, sep } from 'node:path';

/**
 * Shared filesystem-containment and identifier guards. This is the single
 * authority for path-containment checks across the runtime, the desktop main
 * process, and headless: both the pure-Node runtime and the desktop main (which
 * already depends on `@maka/runtime`) reach it here without reverse
 * dependencies. The leaf imports only `node:path`.
 *
 * {@link isPathInside} is separator-aware: it rejects only a real
 * parent-reference segment (`..` exactly, or `..${sep}`-prefixed), so a child
 * entry whose own name begins with `..` (e.g. `root/..foo`) is correctly
 * treated as inside. Its `pathApi` parameter makes the Windows cross-drive case
 * and POSIX sandbox paths testable. The bare-`startsWith('..')` variant that
 * preceded it was retired in #1145 because it misclassified such names as
 * escapes; identifier safety is handled separately by {@link isSafeSkillId}.
 */

/**
 * True when `target` is inside (or equal to) `root`. Used by the skill reader,
 * the managed skill-source store, the filesystem worker, and the workspace
 * executor to keep resolved paths inside their approved root.
 */
export function isPathInside(
  root: string,
  target: string,
  pathApi: PathInsideApi = { relative, isAbsolute, sep },
): boolean {
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

/** Path primitives {@link isPathInside} uses, injectable for cross-platform tests. */
export interface PathInsideApi {
  relative: typeof relative;
  isAbsolute: typeof isAbsolute;
  sep: string;
}

/** True when `value` is a safe skill/source identifier (no path or control chars). */
export function isSafeSkillId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(value);
}

/** Relative POSIX path from `root` to `target`, or `.` when they are equal. */
export function toRelative(root: string, target: string): string {
  const rel = relative(root, target);
  return rel === '' ? '.' : rel.split(sep).join('/');
}
