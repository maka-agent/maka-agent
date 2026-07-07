import { app, BrowserWindow, dialog, Menu, nativeTheme, screen, shell } from 'electron';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppSettings } from '@maka/core';
import { isExternalUrl } from './external-link-guard.js';
import { errorMessage } from './chat-readiness.js';
import { readSavedBounds, writeSavedBounds, type SavedBounds } from './window-state.js';
import { BrowserViewController } from './browser/controller.js';
import { BrowserViewManager } from './browser/view-manager.js';
import type { VisualSmokeFixture } from './visual-smoke-fixture.js';
import { isThemePreference, toNativeThemeSource } from './theme-source.js';

type SettingsReader = {
  get(): Promise<AppSettings>;
};

export interface MainWindowController {
  createWindow(): Promise<void>;
  send(channel: string, ...args: unknown[]): void;
  setTitlebarControlsVisible(sender: Electron.WebContents, visible: unknown): void;
  setThemeSource(sender: Electron.WebContents, themePref: unknown): void;
  setTitleBarOverlayTheme(sender: Electron.WebContents, isDark: unknown): void;
  showOpenDialog(options: Electron.OpenDialogOptions): Promise<Electron.OpenDialogReturnValue>;
  showSaveDialog(options: Electron.SaveDialogOptions): Promise<Electron.SaveDialogReturnValue>;
  capturePage(): Promise<Electron.NativeImage | null>;
  getBrowserViews(): BrowserViewManager<BrowserViewController>;
  disposeBrowserViews(): Promise<void>;
  hasOpenWindows(): boolean;
  focus(): void;
}

interface MainWindowControllerDeps {
  workspaceRoot: string;
  visualSmokeFixture: VisualSmokeFixture | null;
  settingsStore: SettingsReader;
  // main.ts computes this from the same isE2e gate that also guards userData
  // and the fake backend, so main-window.ts owns no env policy of its own.
  startHidden: boolean;
}

let mainWindow: BrowserWindow | null = null;
let browserViews: BrowserViewManager<BrowserViewController> | undefined;

/**
 * Guarded `webContents.send` for `mainWindow`. The `mainWindow?.` optional
 * chain only covers a null reference — it does NOT catch the case where the
 * BrowserWindow has been destroyed (window closed, renderer crashed,
 * teardown raced) while the variable still points at the freed object.
 * Calling `.webContents.send` in that state throws `TypeError: Object has
 * been destroyed`, surfacing as a main-process JS-error dialog.
 *
 * Use this helper anywhere a timer / IPC / menu accelerator might race
 * window teardown. No-op when the window is gone — callers that need
 * delivery confirmation should observe their own state.
 */
export function safeSendToRenderer(channel: string, ...args: unknown[]): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const wc = mainWindow.webContents;
  if (wc.isDestroyed()) return;
  wc.send(channel, ...args);
}

const MAIN_WINDOW_TRAFFIC_LIGHT_POSITION = { x: 14, y: 14 } as const;
const HIDDEN_TRAFFIC_LIGHT_POSITION = { x: -100, y: -100 } as const;

// PR-WINDOW-TITLEBAR-0: the Windows titleBarOverlay height matches the
// renderer `--h-titlebar: 36px` token so the native control strip and the
// in-app top chrome share a baseline. The overlay color/symbolColor are
// reused both at window creation (to avoid a first-frame flash against the
// window `backgroundColor`) and on runtime theme changes via
// `setTitleBarOverlayTheme`.
const TITLEBAR_OVERLAY_HEIGHT = 36;
const titleBarOverlayOptions = (isDark: boolean): { color: string; symbolColor: string; height: number } => ({
  color: isDark ? '#1c1d21' : '#f3f3f5',
  symbolColor: isDark ? '#e6e6e8' : '#1c1d21',
  height: TITLEBAR_OVERLAY_HEIGHT,
});

export function createMainWindowController(deps: MainWindowControllerDeps): MainWindowController {
  const { workspaceRoot, visualSmokeFixture, settingsStore, startHidden } = deps;

  function getBrowserViews(): BrowserViewManager<BrowserViewController> {
    if (!browserViews) {
      browserViews = new BrowserViewManager<BrowserViewController>({
        create: (sessionId) => {
          if (!mainWindow) throw new Error('Embedded browser used before the window is ready.');
          return new BrowserViewController(mainWindow, sessionId, (sid, state) => {
            safeSendToRenderer('browser:state', { sessionId: sid, state });
          });
        },
        onLiveChange: (sessionIds) => safeSendToRenderer('browser:live', { sessionIds }),
      });
    }
    return browserViews;
  }

  async function disposeBrowserViews(): Promise<void> {
    await browserViews?.disposeAll();
  }

  async function createWindow(): Promise<void> {
    await mkdir(workspaceRoot, { recursive: true });
    installApplicationMenu();
    // Restore previously-saved bounds when available; first launch and
    // legacy installs both fall back to the default 1240x820 frame. After
    // load, validate the saved x/y against the current display layout — if
    // the previous external monitor is gone, drop x/y so Electron centers
    // the window on the primary display instead of opening it off-screen.
    const defaults = visualSmokeWindowBounds(visualSmokeFixture, { width: 1240, height: 820 });
    const savedBounds = visualSmokeFixture
      ? defaults
      : await readSavedBounds(workspaceRoot, defaults);
    const bounds = clampBoundsToVisibleDisplay(savedBounds);

    // @kenji PR103 follow-up: complete the FOUC fix at the window-chrome layer.
    // The renderer applies `.dark` synchronously before React mounts (PR103),
    // but the BrowserWindow's `backgroundColor` shows during the first frame
    // before the renderer paints. Pick the right initial bg by reading the
    // persisted theme + system preference.
    // PR-IR-01b: visual smoke theme override wins over the persisted user
    // pref. This guarantees the BrowserWindow backgroundColor matches the
    // theme variant we're about to screenshot, so the very first frame
    // doesn't capture a light-on-dark or dark-on-light flash.
    const persistedTheme = (await settingsStore.get()).appearance?.theme ?? 'auto';
    const themePref = visualSmokeFixture?.theme ?? persistedTheme;
    const isDark =
      themePref === 'dark' ||
      (themePref === 'auto' && nativeTheme.shouldUseDarkColors);
    const initialBg = isDark ? '#1c1d21' : '#f3f3f5';
    // Astro-Han review (#493): sync nativeTheme here too, not only via the
    // renderer's later setThemeSource() IPC call -- otherwise the vibrancy
    // material behind the sidebar can still flash the *system* theme's tint
    // for the first frame or two on a cold start where the OS appearance
    // disagrees with the persisted in-app preference.
    nativeTheme.themeSource = toNativeThemeSource(themePref);

    mainWindow = new BrowserWindow({
      width: bounds.width,
      height: bounds.height,
      ...(bounds.x !== undefined && bounds.y !== undefined ? { x: bounds.x, y: bounds.y } : {}),
      title: 'Maka',
      // PR-GRAY-CARD-LIFT-0 (WAWQAQ msg `0eb99429` 2026-06-20): the
      // app icon ships as a 1024px PNG under apps/desktop/assets/icon.png.
      // BrowserWindow accepts a PNG path directly on macOS for the dock
      // / window title bar; .icns / .ico packaging will come with the
      // installer build pass. The asset path resolves from the built
      // dist/main/main.js (two levels up to apps/desktop, then assets).
      icon: join(import.meta.dirname, '..', '..', 'assets', 'icon.png'),
      // PR-WINDOW-TITLEBAR-0: hide the native title bar so the renderer
      // chrome can extend to the top edge on every platform. macOS keeps
      // `hiddenInset` + traffic-light buttons (top-left); Windows uses
      // `hidden` + `titleBarOverlay` so the OS draws native min/max/close
      // buttons flush against the top-right corner. The overlay color is
      // seeded from the initial window background to avoid a first-frame
      // flash; `setTitleBarOverlayTheme` re-syncs it when the theme
      // changes at runtime. Linux falls back to the default frame (no
      // overlay support is wired up yet).
      ...(process.platform === 'darwin'
        ? {
            titleBarStyle: 'hiddenInset' as const,
            trafficLightPosition: MAIN_WINDOW_TRAFFIC_LIGHT_POSITION,
          }
        : process.platform === 'win32'
          ? {
              titleBarStyle: 'hidden' as const,
              titleBarOverlay: titleBarOverlayOptions(isDark),
            }
          : {}),
      // PR-SIDEBAR-IA-0 Phase 3 P0 fixup v5 (WAWQAQ msg `5b85fdb1`,
      // xuan `eea556cd`): explicit `resizable: true` so a future
      // patch can't silently disable window edge resize. Default is
      // already `true`, but pinning it here removes the ambiguity
      // and makes the intent obvious to reviewers; CSS-level fixes
      // (see `app-region-hygiene-contract.test.ts`) cover the
      // renderer side of the same gate.
      resizable: true,
      backgroundColor: initialBg,
      // PR-VISUAL-SMOKE-HEADLESS: under visual-smoke capture, never show the
      // window or let the app take foreground — captures run while the
      // developer keeps working in another app. `webContents.capturePage()`
      // still returns a painted frame on a hidden window because
      // `paintWhenInitiallyHidden` defaults to true. Real runs keep the
      // default `show: true`.
      ...(!app.isPackaged && startHidden ? { show: false } : {}),
      // Glass material — reference-atlas §1 + §12.1 documents the upstream
      // reference layout's `light-glass` / `dark-glass` themes that paint
      // the sidebar against native macOS vibrancy material. Enabling
      // `vibrancy: 'sidebar'` here lets the CSS-side sidebar render
      // transparent and inherit the system's blurred window material
      // (Big Sur+). Renderer CSS gates the transparency on
      // `[data-vibrancy="active"]` so non-macOS builds (where vibrancy is
      // a no-op) keep their opaque chrome.
      // Skip vibrancy under MAKA_VISUAL_SMOKE_FIXTURE — capture environments
      // can't paint native window material reliably, and the auto-capture
      // renderer would stall waiting for compositor frames that never settle.
      ...(process.platform === 'darwin' && !process.env.MAKA_VISUAL_SMOKE_FIXTURE
        ? { vibrancy: 'sidebar' as const }
        : {}),
      webPreferences: {
        preload: join(import.meta.dirname, '..', 'preload', 'preload.cjs'),
        // Defense-in-depth flags (@kenji PR96 review). The external-link guard
        // is the perimeter; these settings keep a hostile page from reaching
        // Node primitives even if it somehow loaded inside the BrowserWindow:
        contextIsolation: true,    // window.maka via contextBridge only
        nodeIntegration: false,    // no `require` in renderer
        sandbox: true,             // preload runs in the renderer sandbox
        webSecurity: true,         // enforce CSP / same-origin policy
        allowRunningInsecureContent: false,
      },
    });

    // Two-layer external-link hygiene: assistant markdown often emits `<a href>`
    // links to docs / GitHub / provider sign-up pages. Without these guards
    // clicking such a link would either replace the renderer view with the
    // remote page (breaking the app) or open a new BrowserWindow with full
    // Node integration.
    //
    // 1. `setWindowOpenHandler` intercepts `target="_blank"` and JS `window.open`,
    //    hands the URL to the OS, denies the in-app open.
    // 2. `will-navigate` blocks plain `<a>` clicks that would replace the
    //    renderer location with a non-file:// URL, opening externally instead.
    //
    // Both are gated on the URL using `http(s):` or `mailto:` — everything else
    // (file://, electron internal, etc.) is allowed/denied per Electron defaults.
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (isExternalUrl(url)) {
        void shell.openExternal(url);
      }
      return { action: 'deny' };
    });
    mainWindow.webContents.on('will-navigate', (event, url) => {
      // The initial Vite dev-server / packaged file:// load is allowed through
      // (current URL equals navigation target while the renderer is settling).
      // Every subsequent navigation is blocked: external URLs (http/https/
      // mailto) get handed off to the OS, internal/file:// (including dropped
      // files attempting to navigate to `file:///…`) are dropped entirely so
      // the renderer never loses its React tree.
      const current = mainWindow?.webContents.getURL() ?? '';
      if (current === url) return;
      event.preventDefault();
      if (isExternalUrl(url)) {
        void shell.openExternal(url);
      }
    });

    // Block in-window file drops. Without this, dropping a file onto the
    // BrowserWindow tries to navigate to its `file://` URL; the `will-navigate`
    // handler above stops the navigation, but the visual flash + dropEffect
    // ambiguity is still confusing. Suppressing dragover/drop at the document
    // level keeps the chat surface immutable to accidental drops.
    mainWindow.webContents.on('did-finish-load', () => {
      mainWindow?.webContents.executeJavaScript(`
        (() => {
          const block = (e) => {
            const target = e.target instanceof Element ? e.target : e.target?.parentElement;
            if (target?.closest('[data-maka-file-drop-target="true"]')) return;
            e.preventDefault();
            e.stopPropagation();
          };
          window.addEventListener('dragover', block, true);
          window.addEventListener('drop', block, true);
        })();
      `).catch(() => { /* renderer may not be ready; ignore */ });
    });

    // Restore maximized state after construction (BrowserWindow constructor
    // doesn't accept it directly; calling here keeps the unmaximized bounds
    // accurate for the next save).
    if (bounds.isMaximized) {
      mainWindow.maximize();
    }

    // Persist bounds across launches. Debounce so a continuous resize drag
    // doesn't write the file on every frame; flush on close.
    let saveTimer: NodeJS.Timeout | undefined;
    const scheduleSave = () => {
      if (!mainWindow) return;
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        if (!mainWindow) return;
        const next: SavedBounds = mainWindow.isMaximized()
          ? { ...mainWindow.getNormalBounds(), isMaximized: true }
          : { ...mainWindow.getBounds(), isMaximized: false };
        void writeSavedBounds(workspaceRoot, next);
      }, 400);
    };
    mainWindow.on('resize', scheduleSave);
    mainWindow.on('move', scheduleSave);
    mainWindow.on('maximize', scheduleSave);
    mainWindow.on('unmaximize', scheduleSave);
    mainWindow.on('close', () => {
      if (saveTimer) clearTimeout(saveTimer);
      // The window owns the embedded-browser views (children of its contentView);
      // tear them down so their WebContents close with it instead of leaking.
      void browserViews?.disposeAll();
      if (!mainWindow) return;
      const final: SavedBounds = mainWindow.isMaximized()
        ? { ...mainWindow.getNormalBounds(), isMaximized: true }
        : { ...mainWindow.getBounds(), isMaximized: false };
      void writeSavedBounds(workspaceRoot, final);
    });

    if (process.env.VITE_DEV_SERVER_URL) {
      await mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
    } else {
      await mainWindow.loadFile(join(import.meta.dirname, '..', '..', 'dist-renderer', 'index.html'));
    }
    if (process.env.MAKA_REAL_WINDOW_SMOKE === '1') {
      emitRealWindowSmokeDiagnostic('after-load');
      setTimeout(() => emitRealWindowSmokeDiagnostic('settled-1000ms'), 1000);
    }
  }

  return {
    createWindow,
    send: safeSendToRenderer,
    setTitlebarControlsVisible(sender, visible) {
      const target = BrowserWindow.fromWebContents(sender);
      if (!target || target !== mainWindow || process.platform !== 'darwin') return;
      const shouldShow = visible === true;
      target.setWindowButtonVisibility(shouldShow);
      target.setWindowButtonPosition(
        shouldShow ? MAIN_WINDOW_TRAFFIC_LIGHT_POSITION : HIDDEN_TRAFFIC_LIGHT_POSITION,
      );
    },
    setThemeSource(sender, themePref) {
      const target = BrowserWindow.fromWebContents(sender);
      if (!target || target !== mainWindow) return;
      if (!isThemePreference(themePref)) return;
      nativeTheme.themeSource = toNativeThemeSource(themePref);
    },
    setTitleBarOverlayTheme(sender, isDark) {
      const target = BrowserWindow.fromWebContents(sender);
      if (!target || target !== mainWindow || process.platform !== 'win32') return;
      if (typeof isDark !== 'boolean') return;
      mainWindow.setTitleBarOverlay(titleBarOverlayOptions(isDark));
    },
    showOpenDialog(options) {
      return mainWindow
        ? dialog.showOpenDialog(mainWindow, options)
        : dialog.showOpenDialog(options);
    },
    showSaveDialog(options) {
      return mainWindow
        ? dialog.showSaveDialog(mainWindow, options)
        : dialog.showSaveDialog(options);
    },
    async capturePage() {
      if (!mainWindow) return null;
      return mainWindow.webContents.capturePage();
    },
    getBrowserViews,
    disposeBrowserViews,
    hasOpenWindows() {
      return BrowserWindow.getAllWindows().length > 0;
    },
    focus() {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    },
  };
}

/**
 * Guard against saved x/y referencing a display that no longer exists
 * (laptop docked → undocked, external monitor unplugged). Walks the
 * current display workAreas; if no display contains a meaningful
 * overlap with the saved bounds, strip x/y so Electron centers the
 * window on the primary display.
 *
 * "Meaningful overlap" = at least a 100×100 corner of the saved
 * rectangle lies inside some display's workArea. Tighter than "any
 * pixel intersects" so a 1px sliver still flagged-as-off-screen
 * doesn't leave a tiny visible nub the user has to grab.
 */
function clampBoundsToVisibleDisplay(bounds: SavedBounds): SavedBounds {
  if (bounds.x === undefined || bounds.y === undefined) return bounds;
  const displays = screen.getAllDisplays();
  if (displays.length === 0) return { width: bounds.width, height: bounds.height };
  const visible = displays.some((display) => {
    const wa = display.workArea;
    const overlapX = Math.max(0, Math.min(bounds.x! + bounds.width, wa.x + wa.width) - Math.max(bounds.x!, wa.x));
    const overlapY = Math.max(0, Math.min(bounds.y! + bounds.height, wa.y + wa.height) - Math.max(bounds.y!, wa.y));
    return overlapX >= 100 && overlapY >= 100;
  });
  if (visible) return bounds;
  // Off-screen: keep the size but drop the position so Electron centers.
  return { width: bounds.width, height: bounds.height, isMaximized: bounds.isMaximized };
}

function visualSmokeWindowBounds(
  visualSmokeFixture: VisualSmokeFixture | null,
  defaults: SavedBounds,
): SavedBounds {
  if (!visualSmokeFixture) return defaults;
  const width = Number(process.env.MAKA_VISUAL_SMOKE_WIDTH);
  const height = Number(process.env.MAKA_VISUAL_SMOKE_HEIGHT);
  if (
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    width >= 480 &&
    height >= 320
  ) {
    return { width: Math.floor(width), height: Math.floor(height) };
  }
  return defaults;
}

function emitRealWindowSmokeDiagnostic(stage: string): void {
  const target = mainWindow;
  if (!target) {
    console.log(`[real-window-smoke] diagnostic ${JSON.stringify({ stage, windowExists: false })}`);
    return;
  }
  const windowState = {
    stage,
    windowExists: true,
    title: target.getTitle(),
    bounds: target.getBounds(),
    normalBounds: target.getNormalBounds(),
    isVisible: target.isVisible(),
    isFocused: target.isFocused(),
    isMinimized: target.isMinimized(),
    isMaximized: target.isMaximized(),
    isResizable: target.isResizable(),
    isMovable: target.isMovable(),
    isModal: target.isModal(),
    webContentsUrl: target.webContents.getURL(),
  };
  target.webContents
    .executeJavaScript(
      `(() => ({
        readyState: document.readyState,
        title: document.title,
        appFramePresent: Boolean(document.querySelector('.appFrame')),
        searchModalPresent: Boolean(document.querySelector('.maka-search-modal')),
        searchModalBackdropPresent: Boolean(document.querySelector('.maka-dialog-backdrop')),
        errorBoundaryPresent: Boolean(document.querySelector('.maka-error-surface')),
        bodyTextLength: document.body?.innerText?.trim().length ?? 0,
        bodyTextSample: document.body?.innerText?.trim().slice(0, 240) ?? '',
        stylesheetCount: document.styleSheets.length,
        rootChildren: document.getElementById('root')?.children.length ?? 0,
        elements: ['body', '#root', '.appFrame', '.app', '.maka-panel-list', '.maka-panel-detail', '.mainColumn', '.maka-onboarding-loading'].map((selector) => {
          const element = document.querySelector(selector);
          if (!element) return { selector, present: false };
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return {
            selector,
            present: true,
            textLength: (element.textContent ?? '').trim().length,
            rect: {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            },
            display: style.display,
            visibility: style.visibility,
            opacity: style.opacity,
            color: style.color,
            backgroundColor: style.backgroundColor,
          };
        }),
        centerElement: (() => {
          const element = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
          if (!element) return null;
          const style = getComputedStyle(element);
          return {
            tagName: element.tagName,
            className: typeof element.className === 'string' ? element.className : '',
            text: (element.textContent ?? '').trim().slice(0, 120),
            color: style.color,
            backgroundColor: style.backgroundColor,
          };
        })(),
        activeElementInSearchModal: Boolean(document.activeElement && document.activeElement.closest && document.activeElement.closest('.maka-search-modal')),
        activeElement: document.activeElement ? {
          tagName: document.activeElement.tagName,
          className: typeof document.activeElement.className === 'string' ? document.activeElement.className : '',
          ariaLabel: document.activeElement.getAttribute('aria-label'),
        } : null,
      }))()`,
      true,
    )
    .then((rendererState) => {
      console.log(`[real-window-smoke] diagnostic ${JSON.stringify({ ...windowState, renderer: rendererState })}`);
    })
    .catch((err: unknown) => {
      console.log(`[real-window-smoke] diagnostic ${JSON.stringify({ ...windowState, rendererError: errorMessage(err) })}`);
    });
}

function installApplicationMenu(): void {
  Menu.setApplicationMenu(null);
}
