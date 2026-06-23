/**
 * PR-PERMISSION-PAGE-REDESIGN — actionable side of the Permission Center.
 *
 * The old `permissions:getSnapshot` is purely read-only; the user could
 * see status pills but couldn't actually do anything. This module adds
 * two side-effectful IPC handlers:
 *
 *   - `openSystemPermissionPane(id)` — deep-links into macOS System
 *     Settings → Privacy & Security at the right pane. On non-macOS
 *     platforms the request resolves with a structured "unsupported"
 *     failure so the renderer can hide the button.
 *   - `requestPermissionAccess(id)` — when the OS exposes a programmatic
 *     consent dialog (microphone, notifications) we ask directly;
 *     otherwise we fall back to the same deep-link path so the user is
 *     still moved one step closer to granting.
 *
 * No state is persisted here — the renderer refreshes the snapshot
 * after either action, so the new status comes back through the
 * existing read path.
 */

import { Notification, shell, systemPreferences } from 'electron';
import type { OsPermissionId } from '@maka/core';
import { OS_PERMISSION_IDS } from '@maka/core';

export type PermissionActionResult =
  | { ok: true }
  | { ok: false; reason: 'invalid_id' | 'unsupported_platform' | 'unsupported_permission' | 'failed'; message?: string };

/**
 * macOS x-apple.systempreferences deep-link targets. The format changed
 * across macOS versions; the strings below are the "modern" (Ventura+)
 * Privacy & Security pane URIs which are also still accepted on
 * Monterey. We do not include a Sequoia-only fallback because Electron
 * passes the URL through `shell.openExternal` either way.
 */
const MACOS_DEEP_LINKS: Record<OsPermissionId, string | null> = {
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  screen_recording: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  automation: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
  notifications: 'x-apple.systempreferences:com.apple.preference.notifications',
};

function normalizePermissionId(input: unknown): OsPermissionId | null {
  if (typeof input !== 'string') return null;
  return (OS_PERMISSION_IDS as readonly string[]).includes(input)
    ? (input as OsPermissionId)
    : null;
}

export async function openSystemPermissionPane(input: unknown): Promise<PermissionActionResult> {
  const id = normalizePermissionId(input);
  if (!id) return { ok: false, reason: 'invalid_id' };
  if (process.platform !== 'darwin') {
    return { ok: false, reason: 'unsupported_platform' };
  }
  const url = MACOS_DEEP_LINKS[id];
  if (!url) return { ok: false, reason: 'unsupported_permission' };
  try {
    await shell.openExternal(url);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: 'failed', message: errorMessage(err) };
  }
}

export async function requestPermissionAccess(input: unknown): Promise<PermissionActionResult> {
  const id = normalizePermissionId(input);
  if (!id) return { ok: false, reason: 'invalid_id' };
  if (process.platform !== 'darwin') {
    return { ok: false, reason: 'unsupported_platform' };
  }
  try {
    switch (id) {
      case 'microphone': {
        const granted = await systemPreferences.askForMediaAccess('microphone');
        return granted
          ? { ok: true }
          : { ok: false, reason: 'failed', message: '用户拒绝了麦克风访问。' };
      }
      case 'notifications': {
        if (!Notification.isSupported()) {
          return { ok: false, reason: 'unsupported_permission', message: '当前 Electron 不支持通知。' };
        }
        // macOS shows the consent prompt the first time a Notification
        // is created; sending a silent ping is the supported pattern.
        const probe = new Notification({ title: 'Maka 通知权限自检', body: '已尝试请求通知权限。' });
        probe.show();
        return { ok: true };
      }
      case 'accessibility':
      case 'screen_recording':
      case 'automation':
        // macOS does not expose a programmatic consent dialog for these
        // three; we deep-link into the relevant System Settings pane
        // instead so the action button is never inert.
        return openSystemPermissionPane(id);
    }
  } catch (err) {
    return { ok: false, reason: 'failed', message: errorMessage(err) };
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error ?? '');
}
