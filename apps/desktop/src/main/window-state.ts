/**
 * Persist BrowserWindow bounds across launches.
 *
 * Writes `{x, y, width, height, isMaximized}` to a JSON file in the
 * workspace root after a debounced settle, restores them on next launch.
 * Restoring goes through `sanitizeBounds()` to guard against:
 *   - missing displays (laptop docked → undocked)
 *   - corrupted file (returns defaults)
 *   - obviously bogus values (zero-width, negative dimensions)
 *
 * Deliberately tiny — no third-party `electron-window-state` dep — so the
 * shape is auditable and the test surface is one pure function.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface SavedBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
  isMaximized?: boolean;
}

export interface DefaultBounds {
  width: number;
  height: number;
}

/**
 * Pure sanitization for restored bounds. Returns either valid bounds or the
 * provided defaults — no half-applied state.
 *
 * Rules:
 *   - width/height must be positive integers >= the safe minimum (480x320)
 *   - x/y are optional; if present, both must be finite numbers
 *   - isMaximized is forwarded as-is if boolean
 */
export function sanitizeBounds(
  candidate: unknown,
  defaults: DefaultBounds,
): SavedBounds {
  if (!candidate || typeof candidate !== 'object') return defaults;
  const c = candidate as Record<string, unknown>;
  const width = typeof c.width === 'number' && c.width >= 480 ? Math.floor(c.width) : null;
  const height = typeof c.height === 'number' && c.height >= 320 ? Math.floor(c.height) : null;
  if (width === null || height === null) return defaults;

  const out: SavedBounds = { width, height };
  if (typeof c.x === 'number' && typeof c.y === 'number' && Number.isFinite(c.x) && Number.isFinite(c.y)) {
    out.x = Math.floor(c.x);
    out.y = Math.floor(c.y);
  }
  if (typeof c.isMaximized === 'boolean') {
    out.isMaximized = c.isMaximized;
  }
  return out;
}

export async function readSavedBounds(
  workspaceRoot: string,
  defaults: DefaultBounds,
): Promise<SavedBounds> {
  try {
    const raw = await readFile(join(workspaceRoot, 'window-state.json'), 'utf8');
    return sanitizeBounds(JSON.parse(raw), defaults);
  } catch {
    // File missing or unreadable — return defaults silently. First-run case.
    return defaults;
  }
}

export async function writeSavedBounds(
  workspaceRoot: string,
  bounds: SavedBounds,
): Promise<void> {
  try {
    await writeFile(
      join(workspaceRoot, 'window-state.json'),
      JSON.stringify(bounds),
      'utf8',
    );
  } catch {
    // Persistence failure is non-fatal; bounds just won't restore next time.
  }
}
