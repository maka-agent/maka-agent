# @maka/desktop

The Electron desktop app: `main` (Node/Electron main process) + `preload` (context bridge) + `renderer` (React UI). This file covers the three-layer split and the IPC contract. For build/test commands and the test-layer selection guide, see the top-level `README.md`; for the renderer interior, see `src/renderer/README.md`.

## Three layers

| Layer | Path | Role |
|---|---|---|
| main | `src/main/` | Node/Electron main process. Owns window lifecycle, credentials, attachments, permissions, IPC handlers, and the bridge to `@maka/runtime` + `@maka/storage`. |
| preload | `src/preload/preload.ts` (single file) | `contextBridge.exposeInMainWorld('maka', …)` — the only surface the renderer may call to reach Node/Electron. No Node API is directly exposed. |
| renderer | `src/renderer/` | React UI body. See `src/renderer/README.md`. |

## main process layout

`src/main/` is flat with a naming convention:

| Suffix | Role | Examples |
|---|---|---|
| `*-ipc-main.ts` | Exports a `register*Ipc(...)` that wires `ipcMain.handle` / `ipcMain.on` for one IPC domain | `connections-ipc-main`, `daily-review-ipc-main`, `memory-ipc-main`, `web-search-ipc-main`, `workspace-resources-ipc-main` |
| `*-main.ts` / `*-service.ts` | A service owned by main (no `ipcMain` calls of its own) | `daily-review-main`, `system-prompt-main`, `oauth-model-connections-main`, `local-memory-service` |
| `*-guard.ts` | Validation / security boundary | `external-link-guard`, `open-path-guard`, `permission-response-guard` |
| (other) | Window, state, platform wiring | `main.ts` (entry), `main-window`, `window-state`, `theme-source`, `credential-store`, `skills`, `attachment-*` |

Sub-folders: `browser/` (embedded browser view), `oauth/`, `search/` (thread search), `web-search/`, `types/`. The browser IPC handler itself (`browser-ipc-main.ts`) is flat in `src/main/`, not under `browser/`.

`main.ts` startup order: the stores and the runtime/controller are created at module load (top-level `create*Store` / runtime wiring); `registerIpc()` is then called at top level, **before** `app.whenReady()`; the main window is created last, inside the `app.whenReady()` callback. The renderer fires its onboarding IPC at first mount, so the handlers must be registered before the window exists.

## IPC contract

Three patterns, all rooted in preload's `maka` namespace. Channel names are `<domain>:<action>`.

- **Request/response** — `ipcRenderer.invoke('<domain>:<action>', …args)` in preload ↔ `ipcMain.handle('<domain>:<action>', …)`. The handler lives either inline in `main.ts` (e.g. `sessions:list`, `settings:get`) or in a `*-ipc-main.ts` extracted by domain (e.g. `connections-ipc-main`, `daily-review-ipc-main`). Both forms coexist; prefer extracting a new domain to its own `*-ipc-main.ts`.
- **Main→renderer push** — main calls `webContents.send('<event>')`; preload subscribes via `ipcRenderer.on` and returns an unsubscribe fn (e.g. `sessions:changed`, `plans:changed`, `artifacts:changed`, `gateway:statusChanged`).
- **Renderer→main fire-and-forget** — `ipcRenderer.send('<domain>:<action>', …)` in preload ↔ `ipcMain.on('<domain>:<action>', …)`. Used when no response is needed (e.g. `browser:active-session`, `browser:setViewport`).

Adding a new IPC surface: if extracting, write the `*-ipc-main.ts` exporting a `register*Ipc(...)`, import it in `main.ts`, and call it inside `registerIpc()`; add the matching method to the `maka` namespace in `preload.ts`; keep the `<domain>:<action>` channel naming. A handler file that isn't registered in `registerIpc()` compiles but never mounts.

## Data flow

```
renderer (React)
  └─ window.maka.<ns>.<method>(…)        // typed surface, see preload.ts
      └─ ipcRenderer.invoke / send / on
          └─ main: ipcMain.handle / ipcMain.on / webContents.send
              └─ @maka/runtime (agent runtime) + @maka/storage (JSONL persistence)
```

The renderer never imports `@maka/runtime` or `@maka/storage` at runtime — all Node-side access goes through the preload `maka` bridge. The renderer only pulls `import type` from them for a few shared types. Types shared across the IPC boundary mostly come from `@maka/core`, with some from `@maka/runtime`, `@maka/storage`, and `@maka/ui` (see `preload.ts` imports).

## Convergence note

The renderer side carries the frontend convergence debt (hand-rolled CSS, primitive overrides); see `src/renderer/README.md`. The main process itself is not part of that convergence — its boundaries (IPC channel names, the preload bridge, the `*-guard.ts` files) are stable contract seams.