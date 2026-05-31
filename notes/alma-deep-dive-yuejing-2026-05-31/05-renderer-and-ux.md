# 05 — Renderer & UX: 8-window Electron, IPC Bridge, Modal Patterns

**TL;DR.** Yetone ships 8 HTML entries (1 SPA with 4 hash-routed windows + 7 specialized windows) wired by 30 preload `contextBridge` namespaces and 144 `ipcMain.handle` channels. Standout patterns: macOS `electron-liquid-glass` corner radius 26, prewarmed off-screen "more menu" panel, click-through notifications that flip to interactive on hover, hidden BrowserWindows for stealth web scraping that can flip opacity when CAPTCHA hits, and `tool-approval-dialog-respond` IPC for permission flows. Maka has a single window today. The borrows: prewarming for sub-windows, the click-through notification pattern, hash-routed sub-windows on one SPA, and the IPC channel naming convention (`namespace:action`).

---

## 1. The 8 HTML entries

Per `~/Downloads/alma-re/docs/12-renderer.md §1`:

| HTML file | Title | Window singleton var | Purpose |
|---|---|---|---|
| `index.html` | "Alma" | `rS` (main), `lS` (quick-chat), `mS` (more-menu), `gS` (perm-overlay) | Main chat + 3 hash-routed siblings |
| `settings.html` | "Alma Settings" | `cS` | Settings window |
| `gallery.html` | "Alma Gallery" | `dS` | Selfie album / image grid |
| `lightbox.html` | "Alma Image Viewer" | `uS` | Standalone image viewer |
| `livecoding.html` | "Alma Live Coding" | `hS` | Strudel/Tidal live coding |
| `share.html` | "Share Conversation" | `pS` | Public share-link viewer |
| `prompt-app-runner.html` | "Prompt App" | per-instance Map `kS` | Prompt-app execution UI |
| `notifications.html` | "Alma Notifications" | per `NotificationCenter` instance | Toast overlay |

**`index.html` is multi-purpose** — same Vite bundle handles 4 distinct windows dispatched by URL hash:

| Hash route | Window | Purpose |
|---|---|---|
| `#/` (no hash) | Main | Chat UI |
| `#/quick-chat` | QuickChat | macOS-style popup chat (panel, alwaysOnTop, skipTaskbar) |
| `#/more-menu` | MoreMenu | Hovering popover anchor (prewarmed off-screen) |
| `#/permission-overlay?key=accessibility` | PermissionOverlay | Accessibility-permission inset overlay |

The renderer chooses what to mount based on `location.hash`. One Vite bundle, four windows. Same pattern for `additionalArguments: ["--alma-window-role=notifications"]` (`main.js` notification window).

### 1.1 Window configuration table

Per `~/Downloads/alma-re/docs/12-renderer.md §2.2`:

| Window | Default size | Frame | macOS style | Special flags |
|---|---|---|---|---|
| Main `rS` | 1200×800 persisted | `frame: false` | `hiddenInset` | `webviewTag: true`, traffic lights at `(-100,-100)` |
| Quick Chat `lS` | 600×400 persisted, centered, 50px above bottom | `frame: false` | `type: "panel"` | `alwaysOnTop: true`, `skipTaskbar`, no minimize/maximize/fullscreen |
| Settings `cS` | 980×740, centered on main's display | normal frame | `hiddenInset` | `show: false` until `ready-to-show`, traffic lights `{20,20}` |
| Lightbox `uS` | 1000×700 | `autoHideMenuBar` | `hiddenInset` | Initial payload via `lightbox-window-get-initial-params` |
| More Menu `mS` | 280×440 | `frame: false` | `type: "panel"` | `alwaysOnTop("pop-up-menu")`, `hasShadow: false`, hides on `blur`, **prewarmed at `-10000,-10000`** |
| Permission Overlay `gS` | 530×109 | `frame: false`, `transparent: true` | `type: "panel"` | `focusable: false`, `alwaysOnTop("screen-saver")`, `visibleOnAllWorkspaces`, tracks System Settings privacy pane via 200ms interval |
| Notifications | 400×320 | `frame: false`, `transparent: true`, `hasShadow: false` | `type: "panel"` | `setIgnoreMouseEvents(true, {forward: true})` — click-through until pointer enters, position re-anchored to cursor display top-right (`+12 y`, `-16 x`), auto-destroyed after 1.5s idle |
| WebSearch debug | 1280×800 hidden off-screen | — | — | `opacity: 0`, audio muted, anti-detection JS injected on `did-start-navigation` |

### 1.2 Maka has none of this

Maka has a single main window. From `apps/desktop/src/main/main.ts:2722` lines, there's no settings window, no gallery, no quick-chat. Per the Maka README, the design is "single-window IDE-style desktop client."

This is *fine* for Phase 1 — fewer surfaces = less bug surface. The borrows below are conditional on Maka growing more windows.

---

## 2. `electron-liquid-glass` integration (macOS 26 only)

Per `~/Downloads/alma-re/docs/12-renderer.md §3`:

```js
function tS(e) {
  if (process.platform !== "darwin") return null;
  const lib = require("electron-liquid-glass");
  if (typeof lib.isGlassSupported === "function" && !lib.isGlassSupported()) {
    console.warn("Liquid glass is not supported on this system. Skipping effect.");
    return;
  }
  console.log("Applying liquid glass effect");
  lib.addView(e.getNativeWindowHandle(), { cornerRadius: 26 });
  console.log("Liquid glass added");
}
```

- macOS-only.
- Module is lazily required and cached; missing native addon → standard window with warning.
- `cornerRadius: 26` matches the rounded-window aesthetic with traffic-light-positioned windows.
- Applied to main, settings, gallery, lightbox, livecoding, share, prompt-app windows.
- **Skipped for** notification, more-menu, permission-overlay, quick-chat (those use panel types or transparent painting).

**B-UX-01**: If Maka targets macOS 26+ users, `cornerRadius: 26` is a free polish bump. Estimate: S (3 lines + a dep). Risk: low (graceful fallback already).

---

## 3. Preload `contextBridge` surface — 30 namespaces

Per `~/Downloads/alma-re/docs/12-renderer.md §4`:

| `window.*` namespace | Methods |
|---|---|
| `ipcRenderer` | `on/off/send/invoke` raw passthrough |
| `windowControls` | `minimize, maximize, fullscreen, close, isMaximized, isFullScreen, isFocused, onFocusChange(cb)` |
| `platform` | `get()` |
| `apiServer` | `getInfo()` → `{ port, baseURL }` |
| `settingsWindow` | `open(initialTab), close, getInitialTab, onTabChange(cb), navigateToThread(id)` |
| `promptAppRunner` | `open(promptApp), close, getPromptApp, navigateToThread, saveWindowSize(id,w,h), registerShortcut(id,{name,shortcut}), unregisterShortcut(id)` |
| `quickChatWindow` | 18 methods including `setClickThrough`, `getClickThrough`, `onClickThroughChanged`, `onNeedsAccessibilityPermission`, `onFrontAppContext`, `onTraversedContent`, `onAppIcon`, `getCachedContext`, `recaptureContext`, `getFrontAppContext`, `traverseApp(pid)` |
| `moreMenu` | `open(rect+state), close, cancelClose, scheduleClose, reportSize(w,h), emit(event,data), prewarm, onSetAnchor, onHide, onAction, onState` |
| `permissions` | `getAll, request(perm), openSettings(perm), onStatusChanged(cb)` — macOS TCC |
| `accessibility` | `getStatus, triggerSystemPrompt, openSettings, startFlow(opts), closeOverlay, onStatusChanged, startDrag(opts)` |
| `systemFile` | `openInPreview, openExternal, showItemInFolder, readAsDataUrl` |
| `electronClipboard` | `writeText, readText, writeImage, write` |
| `galleryWindow` | `open(imageId), close, navigateToThread, onNavigateToImage(cb)` |
| `lightboxWindow` | `open({images,currentIndex,...}), getInitialParams, close, navigateToThread, onUpdate` |
| `liveCodingWindow` | `open(code), close, sendToChat(code), onCodeReceived, onShareCodeReceived` |
| `almaApp` | `getInfo, checkForUpdates, getUpdateInfo, downloadUpdate, quitAndInstall, onAutoUpdateStatus, setAutoStart, getAutoStart, setDockVisibility, setAppIcon` |
| `pluginCommands` | `getAll, execute(id, ...args)` |
| `playwright` | `getStatus, install, onStatusChange` |
| (function) `selectDirectory` | `()` |
| (function) `getPathForFile` | `(file)` — wraps `webUtils.getPathForFile` for Electron 32+ drag-drop |
| (function) `selectAndReadFile` | `(opts)` |
| `copilot` | 10 methods for GitHub Copilot multi-account auth |
| `claudeSubscription` | 11 methods for Anthropic Claude Max subscription flow |
| `mcpOAuth` | `getStatus(server), startAuth(server, opts), revoke(server), onAuthCallback, onNeedsReauth` |
| `whisper` | `getStatus, initialize(modelPath, opts), transcribe(audioFloat32, opts), dispose, getMicrophoneStatus, requestMicrophonePermission, openMicrophoneSettings` |
| `webSearch` | `openDebugWindow, openXiaohongshuDebugWindow, exportXiaohongshuCookies, importXiaohongshuCookies, clearXiaohongshuCookies` |
| `webFetch` | `openBrowser(url)` |
| `pluginTheme` | `onApply(cb), onClear(cb)` |
| `pluginStatusBar` | `onUpdate(cb), getState, executeCommand(id, args)` |
| `pluginInputBox` | `onShow, onDismiss, respond(id, value)` |
| `pluginQuickPick` | `onShow, onDismiss, respond(id, value)` |
| `pluginConfirmDialog` | `onShow, onDismiss, respond(id, value)` |
| `toolApprovalDialog` | `onShow(cb), onResolved(cb), respond(id, action)` |
| `pluginNotification` | `onShow(cb)` |
| `almaNotifications` | `notify(payload), clearAll, test, setTheme(theme)` |
| `notificationWindow` | own bridge for the notifications window |
| `snapshot` | `create, snapshotFile, list, get, diff, rollback, rollbackFile, cleanup` — per-thread file versioning |

Maka's `apps/desktop/src/preload/preload.ts` is much smaller. The Maka renderer surface is intentionally minimal — most work flows through `ipcRenderer.invoke`.

### 3.1 Tool approval dialog pattern

`toolApprovalDialog` (`window.toolApprovalDialog.onShow(cb)`, `onResolved(cb)`, `respond(id, action)`) is the pre-baked pattern for permission UI.

**B-UX-02**: Maka has a permission flow (`PermissionEngine` parks promises) but the renderer-side UX is custom. Adopting Yetone's `toolApprovalDialog.{onShow, onResolved, respond}` shape would standardize the IPC surface so plugins (when added) can hook into permission flows uniformly. Estimate: S to match the API shape; M to actually consolidate.

### 3.2 Plugin modal patterns

`pluginInputBox`, `pluginQuickPick`, `pluginConfirmDialog` — three single-channel modal dialogs that plugins can request. Each has `onShow`, `onDismiss`, `respond(id, value)`. This is the VS Code-inspired API.

**B-UX-03**: When/if Maka adds plugins, mirror these three (especially `pluginQuickPick` — it's `vscode.window.showQuickPick` translated to Electron). Estimate: M each.

### 3.3 Settings window pattern

`window.settingsWindow.open(initialTab)` opens centered on the main window's display, accepts an initial tab name. Maka could benefit from this when settings grow beyond what fits in the chat sidebar.

**B-UX-04**: Sub-window pattern (separate BrowserWindow for settings vs in-main-window route). Modulo platform/style differences, this is a one-day project. Estimate: M.

---

## 4. IPC channel naming convention

Per `~/Downloads/alma-re/docs/12-renderer.md §5`, 144 `ipcMain.handle(...)` registrations. The naming convention is **`namespace:action`** with hyphens-in-words and colons-between-parts:

```
window-minimize             (no namespace, legacy)
api-server-info             (no namespace, legacy)
settings-window-open
settings-window-close
settings-navigate-to-thread
gallery-window-open
quick-chat-window-toggle
quick-chat:get-cached-context     ← colon-separated
more-menu:open
more-menu:close
more-menu:prewarm
permissions:get-all
permissions:request
accessibility:get-status
accessibility:trigger-system-prompt
```

The newer code uses `namespace:action`; older code uses `namespace-action-words`. Mixed convention.

Maka's `apps/desktop/src/main/main.ts` uses `dot.separated.actions` (per the spec) which is also reasonable. No strong borrow needed; mostly an observation.

---

## 5. Sub-window orchestration patterns

### 5.1 Prewarming

Per `~/Downloads/alma-re/docs/12-renderer.md §2`:

> More Menu `mS`: prewarmed (created off-screen at `-10000,-10000`).

The window is created early, hidden off-screen. When the user clicks the trigger, the IPC `more-menu:open` moves it on-screen with the position computed below the trigger element. Avoids the ~150ms `loadURL` cost.

**B-UX-05**: When Maka adds quick-toggle UI (command palette, etc.), prewarm. Estimate: S.

### 5.2 Singleton instance variables

Yetone uses one module-scope variable per window (`rS, cS, lS, mS, gS, uS, dS, hS, pS`). No `WindowManager` class.

**Don't borrow** — it's terse but un-discoverable. Maka should have a `WindowRegistry` class if/when it grows multiple windows.

### 5.3 `webContentsId → config` Map for per-instance windows

For prompt-apps, Yetone keeps `Map<number, PromptApp>` (`SS` at `main.js`) keyed by `webContentsId`. Each launch creates a new BrowserWindow. Window size is persisted via `AS.updatePromptAppWindowSize(id, w, h)`.

**B-UX-06**: If Maka adds "open this skill as a quick popup," use this exact pattern. Estimate: S.

### 5.4 Navigation pattern

Every secondary window has a `*-navigate-to-thread` channel that closes itself and surfaces a chat thread on main:

```js
if (rS && !rS.isDestroyed()) {
  rS.isMinimized() && rS.restore();
  rS.show();
  rS.focus();
  rS.webContents.send("navigate-to-thread", threadId);
  return "navigated";
}
return "failed";
```

**B-UX-07**: Standardize the "from sub-window, open thread in main" plumb. Maka doesn't have this yet because there are no sub-windows. Estimate: S each.

---

## 6. Notification panel pattern

Per `~/Downloads/alma-re/docs/12-renderer.md §2.2` (notifications row):

- 400×320, `frame: false`, `transparent: true`, `hasShadow: false`.
- macOS `type: "panel"`.
- `setIgnoreMouseEvents(true, {forward: true})` — click-through until pointer enters → switches to interactive.
- Position re-anchored to cursor display top-right (`+12 y`, `-16 x`).
- `additionalArguments: ["--alma-window-role=notifications"]` — the renderer uses this to detect "I'm the notification window" without checking URL.
- Auto-destroyed after 1.5s idle.

The body of the notifications.html *forces* `body { background: transparent }` inline — it's the only HTML entry designed for transparent overlay rendering.

**B-UX-08**: Native-looking toast pattern. When Maka adds notifications (e.g. "build succeeded in background", "permission requested"), this is the canonical macOS-aware shape. Estimate: M.

**B-UX-09**: `additionalArguments: ["--app-window-role=X"]` for renderer-side role detection. Cleaner than parsing URL hash. Estimate: S per role.

---

## 7. Stealth web scraping windows (probably not borrow-worthy)

Per `~/Downloads/alma-re/docs/12-renderer.md §2.2`:

> Web-search/Xiaohongshu debug windows: 1280×800 hidden off-screen at `-99999,-99999`, `opacity: 0`, `show: false`. Stealth scraping windows; muted audio, `setIgnoreMouseEvents(true)`, injects an anti-detection script on `did-start-navigation` (overrides `navigator.webdriver`, `window.chrome`, etc.).

When a CAPTCHA is detected on the page (poll for reCAPTCHA / Cloudflare challenge / "unusual traffic" copy), the window is **flipped to full opacity so the user can solve it** (`main.js:26784`).

This is impressive engineering but probably not for Maka — we should not be in the "drive a stealth browser to scrape Google" business. The graceful-CAPTCHA-fallback UX *pattern* is borrowable to other contexts, though:

**B-UX-10** (concept): "Hidden until something requires user input, then surface." For long-running background tasks that might need a user prompt (e.g. password input mid-build), this pattern is reasonable. Don't implement now.

---

## 8. Accessibility / permission overlay

Per `~/Downloads/alma-re/docs/12-renderer.md §2.2` (Permission Overlay row):

> 530×109, `frame: false`, `transparent: true`, mac `type: "panel"`. `focusable: false`, `alwaysOnTop("screen-saver")`, `visibleOnAllWorkspaces`. Loads `#/permission-overlay?key=accessibility`. Tracks the macOS System Settings privacy pane via 200 ms interval.

The flow: user clicks "Grant Accessibility" → app `shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility')` → the overlay appears next to the System Settings pane with an arrow pointing at "Add" → polling tells when the user has actually granted permission → overlay closes automatically.

This is the **gold-standard macOS permission UX**. Whenever Maka needs ScreenRecord / Accessibility / Mic, this is the template.

**B-UX-11**: Whenever Maka requires macOS TCC permissions, use the overlay+polling pattern. Estimate: M per permission type. Risk: low (pure UX polish).

---

## 9. Sentry signing per release

Per `~/Downloads/alma-re/docs/15-renderer-chunks.md §1`:

> The build is signed with Sentry (release id `alma@0.0.798`) — every chunk emits a `SENTRY_RELEASE` / `_sentryDebugIds` IIFE at the top.

This is the standard Sentry-Electron release-binding pattern. Maka uses or could use the same. Not a borrow opportunity per se.

---

## 10. Bundle accounting

Per `~/Downloads/alma-re/docs/15-renderer-chunks.md §1`, the 37 MB of `assets/` distributes as:

- 2.6 MB main chat app `index-DabP8x52.js`
- 2.4 MB mermaid
- 2.3 MB `ThemeContext-Ufod9JHC.js` (vendor + theme + i18n + settings store — misnamed "core")
- 1.6 MB settings window + plugin UI + JSZip
- 936 K cytoscape (mermaid layout)
- 836 K streamdown (markdown-it/rehype)
- 816 K pdf.js viewer
- 264 KB framer-motion
- 220 KB livecoding (Strudel + CodeMirror)
- 216 KB React + ReactDOM + jsxRuntime
- ~260 Shiki language tokenizers (lazy-loaded)
- ~60 Shiki themes (lazy-loaded)

**B-UX-12**: Shiki language/theme lazy-loading. Maka uses Shiki for markdown rendering; verify we're lazy-loading languages on demand. Estimate: verification.

---

## 11. Liquid coding window

Per `~/Downloads/alma-re/docs/12-renderer.md §2`:

> Live Coding `hS`: 900×700, livecoding.html. Strudel TidalCycles editor.

Out of scope for Maka.

---

## 12. Summary of borrowable items in this doc

| ID | Mechanic | Cite | Maka file | Scope | Risk |
|---|---|---|---|---|---|
| B-UX-01 | `electron-liquid-glass` macOS 26 corner radius 26 | `main.js:71598-71628` | `apps/desktop/src/main/main.ts` window creation | S | low |
| B-UX-02 | `toolApprovalDialog` IPC shape | `preload.js` `toolApprovalDialog` | `apps/desktop/src/preload/preload.ts` | S | low |
| B-UX-03 | `pluginInputBox`/`pluginQuickPick`/`pluginConfirmDialog` modal API | `preload.js` | future plugin system | M each | low |
| B-UX-04 | Dedicated settings window | `main.js:settings-window-open` | future | M | low |
| B-UX-05 | Window prewarming for sub-windows | `main.js` more-menu prewarm | future sub-windows | S | low |
| B-UX-06 | `Map<webContentsId, config>` for per-instance windows | `main.js:kS, SS` | future skill-popup windows | S | low |
| B-UX-07 | Standardized `*-navigate-to-thread` plumbing | `main.js:72062-72074` | future sub-windows | S | low |
| B-UX-08 | Click-through notification panel pattern | `main.js` notifications row | new feature | M | low |
| B-UX-09 | `additionalArguments: ["--app-window-role=X"]` | `main.js` notifications creation | future sub-windows | S | low |
| B-UX-10 | Hidden window that surfaces on CAPTCHA-style detection | `main.js:26784` | concept only | — | — |
| B-UX-11 | macOS TCC overlay + System Settings polling | `main.js` permission overlay | future feature | M | low |
| B-UX-12 | Verify Shiki lazy-load | `~/Downloads/alma-re/docs/15-renderer-chunks.md` | renderer | verification | — |
