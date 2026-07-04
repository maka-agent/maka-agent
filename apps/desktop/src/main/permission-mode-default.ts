import type { AppSettings, PermissionMode } from '@maka/core';

/**
 * Reads the configured chat-default permission mode (Settings → 通用 →
 * 默认权限模式). Hardened: session creation must never fail because
 * settings.json is unreadable/corrupted — the store's `get()` rethrows
 * anything but ENOENT, so a corrupted file would otherwise reject the
 * whole create path. Falls back to the safest mode on any error.
 *
 * This is the SINGLE authority for a new session's default: the renderer
 * intentionally omits `permissionMode` unless the user explicitly picked
 * one, so this resolver reads the source of truth (settingsStore) at
 * create time. Kept as an injected pure function so the never-rejects
 * fallback can be unit-tested without a settings.json on disk.
 */
export async function resolveDefaultPermissionMode(
  readSettings: () => Promise<AppSettings>,
): Promise<PermissionMode> {
  try {
    return (await readSettings()).chatDefaults.permissionMode;
  } catch {
    return 'ask';
  }
}
