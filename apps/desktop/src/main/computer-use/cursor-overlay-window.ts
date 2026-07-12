/**
 * Cursor overlay window (main-process half) — the Maka-owned, Codex-style agent
 * cursor. A transparent, always-on-top, click-through BrowserWindow that hosts a
 * Canvas running the ported CursorEngine (Dubins glide + spring). MAIN drives it
 * with per-action coordinates; the window persists across actions and repositions
 * the cursor live over a one-way `overlay:move` channel (no teardown-per-move).
 *
 * Path 18 gates:
 *  - S13: action/session-scoped lifecycle; teardown is synchronous + event-driven,
 *    no timer keeps it alive.
 *  - S14 (load-bearing): `focusable:false` + `setIgnoreMouseEvents(true,{forward:true})`
 *    armed BEFORE show + `showInactive()` (never `.focus()`). The preload is
 *    RECEIVE-ONLY (main→renderer), so the overlay can never call back / inject.
 *  - S15: MAIN owns coordinates; the renderer only paints what MAIN sends.
 *  - S18: teardown is a single synchronous `destroy()`.
 *
 * Electron is required lazily so the module loads under `node --test`; tests
 * inject a fake window factory + bounds resolver.
 */
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserWindowConstructorOptions, Rectangle } from 'electron';

const requireElectron = createRequire(import.meta.url);

// Shared cursor-move contract lives in @maka/computer-use so the CLI can drive the
// same hook against a headless sink. This controller is the Electron implementation
// of that sink (it also satisfies OverlayCursorSink structurally via ensure/move).
export type { CursorActionKind, CursorMoveInput } from '@maka/computer-use';
import type { CursorMoveInput } from '@maka/computer-use';

/** Minimal window surface the controller drives (fake-able in node --test). */
export interface CursorOverlayWindowLike {
  setIgnoreMouseEvents(ignore: boolean, options?: { forward?: boolean }): void;
  setAlwaysOnTop(flag: boolean, level?: string): void;
  setVisibleOnAllWorkspaces(visible: boolean, options?: { visibleOnFullScreen?: boolean }): void;
  loadFile(path: string): Promise<void>;
  showInactive(): void;
  isDestroyed(): boolean;
  destroy(): void;
  /** webContents.send — the one-way main→renderer push. */
  send(channel: string, payload: unknown): void;
  /** Fire cb once the page has loaded (webContents 'did-finish-load'). */
  onReady(cb: () => void): void;
}

export interface CreateCursorOverlayControllerDeps {
  createOverlayWindow?: (options: BrowserWindowConstructorOptions) => CursorOverlayWindowLike;
  resolveOverlayBounds?: () => Rectangle;
  /** Absolute path to the built overlay preload (dist/overlay/cursor-overlay-preload.cjs). */
  preloadPath?: string;
  /** Absolute path to the built overlay html (dist/overlay/cursor-overlay.html). */
  htmlPath?: string;
}

export interface CursorOverlayController {
  /** Lazily create/refresh the overlay for a session (palette from sessionId). */
  ensure(sessionId: string): void;
  /** Move the cursor to a per-action screen coordinate (creates the window if needed). */
  move(input: CursorMoveInput): void;
  /** Per-session teardown (the clearComputerUseOverlay(sessionId) bag). */
  clearForSession(sessionId: string): void;
  /** User abort (Esc) — tears down when actionId matches the live overlay. */
  abort(actionId: string): void;
  /** Unconditional teardown (window close / quit). */
  destroyAll(): void;
  isActive(): boolean;
  getSessionId(): string | null;
}

/** S14 window options — the focus/click-through contract surface, one literal. */
export function cursorOverlayWindowOptions(bounds: Rectangle, preloadPath: string): BrowserWindowConstructorOptions {
  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    focusable: false, // S14: never take keyboard focus from the driven app
    transparent: true,
    frame: false,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    acceptFirstMouse: false,
    show: false, // shown via showInactive() only after click-through is armed
    backgroundColor: '#00000000',
    enableLargerThanScreen: true,
    webPreferences: {
      // Receive-only preload: exposes ipcRenderer.on callbacks, never send/invoke.
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  };
}

function defaultOverlayDistDir(): string {
  // Robust to BOTH layouts: prod tsc compiles this to dist/main/computer-use/*.js,
  // while `npm run dev` esbuild-bundles it into dist/main/main.js — either way the
  // overlay lives at <dist>/overlay. Walk up to the 'dist' root and join 'overlay'.
  const start = dirname(fileURLToPath(import.meta.url));
  let dir = start;
  for (let i = 0; i < 6; i++) {
    if (basename(dir) === 'dist') return join(dir, 'overlay');
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return join(start, '..', '..', 'overlay'); // fallback: assume dist/main/computer-use
}

export function createCursorOverlayController(
  deps: CreateCursorOverlayControllerDeps = {},
): CursorOverlayController {
  const createOverlayWindow = deps.createOverlayWindow ?? defaultCreateOverlayWindow;
  const resolveOverlayBounds = deps.resolveOverlayBounds ?? defaultResolveOverlayBounds;
  const preloadPath = deps.preloadPath ?? join(defaultOverlayDistDir(), 'cursor-overlay-preload.cjs');
  const htmlPath = deps.htmlPath ?? join(defaultOverlayDistDir(), 'cursor-overlay.html');

  let win: CursorOverlayWindowLike | null = null;
  let sessionId: string | null = null;
  let actionId: string | null = null;
  let bounds: Rectangle = { x: 0, y: 0, width: 0, height: 0 };
  let ready = false;
  let queue: Array<{ channel: string; payload: unknown }> = [];

  function teardown(): void {
    const w = win;
    win = null;
    sessionId = null;
    actionId = null;
    ready = false;
    queue = [];
    if (w && !w.isDestroyed()) w.destroy();
  }

  function push(channel: string, payload: unknown): void {
    if (!win) return;
    if (ready) win.send(channel, payload);
    else queue.push({ channel, payload });
  }

  function ensure(nextSessionId: string): void {
    if (typeof nextSessionId !== 'string' || nextSessionId.length === 0) return;
    if (win && !win.isDestroyed() && sessionId === nextSessionId) return;
    // Different session (or dead window) → supersede so no orphan survives.
    if (win) teardown();

    bounds = resolveOverlayBounds();
    const w = createOverlayWindow(cursorOverlayWindowOptions(bounds, preloadPath));
    // S14 (load-bearing): arm click + focus pass-through BEFORE the window shows.
    w.setIgnoreMouseEvents(true, { forward: true });
    w.setAlwaysOnTop(true, 'screen-saver');
    try {
      w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    } catch {
      /* not supported everywhere; best-effort */
    }
    win = w;
    sessionId = nextSessionId;
    ready = false;
    queue = [];
    w.onReady(() => {
      if (win !== w) return; // superseded during load
      ready = true;
      w.send('overlay:reset', { sessionColorId: nextSessionId });
      for (const m of queue) w.send(m.channel, m.payload);
      queue = [];
    });
    void w.loadFile(htmlPath).catch(() => {
      /* fast teardown mid-load — ignore */
    });
    w.showInactive();
  }

  function move(input: CursorMoveInput): void {
    if (typeof input.sessionId !== 'string' || input.sessionId.length === 0) return;
    if (!Number.isFinite(input.screenX) || !Number.isFinite(input.screenY)) return;
    ensure(input.sessionId);
    actionId = input.actionId;
    // Screen → window-local so the renderer paints at origin (0,0).
    push('overlay:move', {
      x: input.screenX - bounds.x,
      y: input.screenY - bounds.y,
      kind: input.kind,
      pressed: input.pressed === true,
    });
  }

  function clearForSession(id: string): void {
    if (typeof id !== 'string' || id.length === 0) return;
    if (id !== sessionId) return;
    teardown();
  }
  function abort(id: string): void {
    if (typeof id !== 'string' || id.length === 0) return;
    if (id !== actionId) return;
    teardown();
  }

  return {
    ensure,
    move,
    clearForSession,
    abort,
    destroyAll: teardown,
    isActive: () => win !== null,
    getSessionId: () => sessionId,
  };
}

function defaultCreateOverlayWindow(options: BrowserWindowConstructorOptions): CursorOverlayWindowLike {
  const { BrowserWindow } = requireElectron('electron') as typeof import('electron');
  const bw = new BrowserWindow(options);
  return {
    setIgnoreMouseEvents: (ignore, opts) => bw.setIgnoreMouseEvents(ignore, opts),
    setAlwaysOnTop: (flag, level) => bw.setAlwaysOnTop(flag, level as Parameters<typeof bw.setAlwaysOnTop>[1]),
    setVisibleOnAllWorkspaces: (visible, opts) => bw.setVisibleOnAllWorkspaces(visible, opts),
    loadFile: (path) => bw.loadFile(path),
    showInactive: () => bw.showInactive(),
    isDestroyed: () => bw.isDestroyed(),
    destroy: () => bw.destroy(),
    send: (channel, payload) => { if (!bw.isDestroyed()) bw.webContents.send(channel, payload); },
    onReady: (cb) => bw.webContents.once('did-finish-load', cb),
  };
}

function defaultResolveOverlayBounds(): Rectangle {
  const { screen } = requireElectron('electron') as typeof import('electron');
  return screen.getPrimaryDisplay().bounds;
}
