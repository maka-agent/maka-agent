/**
 * Renderer-side helpers for the structured `app:openPath` IPC contract.
 *
 * Backend (see `apps/desktop/src/main/open-path-guard.ts`) returns either
 * `{ ok: true; opened: string }` or `{ ok: false; reason: OpenPathFailureReason }`.
 * The reason is a closed enum — surfaces should not interpolate the raw value
 * into UI; use {@link openPathFailureCopy} for human-facing strings.
 */

export type OpenPathKey = 'workspace' | 'skills' | 'memory' | 'project';

export type OpenPathFailureReason =
  | 'unknown-key'
  | 'not-allowed'
  | 'missing'
  | 'not-a-directory'
  | 'open-failed';

export type OpenPathResult =
  | { ok: true; opened: string }
  | { ok: false; reason: OpenPathFailureReason };

/** Closed-form mapping from enum to renderer-localized copy. */
export function openPathFailureCopy(reason: OpenPathFailureReason | string): string {
  switch (reason) {
    case 'unknown-key':
      return '未知的工作区目录。';
    case 'not-allowed':
      return '路径不在允许打开的工作区范围内。';
    case 'missing':
      return '目录不存在。';
    case 'not-a-directory':
      return '目标不是目录。';
    case 'open-failed':
      return '系统没有打开该目录。';
    default:
      return '无法打开目录。';
  }
}

/**
 * Convenience that maps an `OpenPathKey` to the corresponding action label,
 * used by toast titles so we can show "在 Finder 中打开工作区失败" instead of
 * a generic "打开失败".
 */
export function openPathActionLabel(key: OpenPathKey): string {
  switch (key) {
    case 'workspace':
      return '工作区目录';
    case 'skills':
      return 'Skills 目录';
    case 'memory':
      return '记忆目录';
    case 'project':
      return '项目目录';
  }
}
