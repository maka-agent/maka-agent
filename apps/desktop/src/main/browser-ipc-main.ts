import { ipcMain } from 'electron';
import { createBrowserViewHost } from './browser/automation-host.js';
import { provideBrowserViewHost } from './browser/browser-host.js';
import { releaseBrowserSession, revokeHiddenBrowserActions } from './browser/session.js';
import type { BrowserViewRect } from './browser/logic.js';
import type { createMainWindowController } from './main-window.js';

interface BrowserIpcDeps {
  mainWindowController: ReturnType<typeof createMainWindowController>;
}

export function registerBrowserIpc(deps: BrowserIpcDeps): void {
  let shownBrowserSessionId: string | null = null;
  provideBrowserViewHost(createBrowserViewHost(deps.mainWindowController.getBrowserViews(), () => shownBrowserSessionId));

  const browserTargetOk = (target: unknown): target is string =>
    typeof target === 'string' && target.length > 0 && target === shownBrowserSessionId;

  ipcMain.on('browser:active-session', (_event, sessionId: unknown) => {
    shownBrowserSessionId = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null;
    deps.mainWindowController.getBrowserViews().hideAllExcept(shownBrowserSessionId);
    revokeHiddenBrowserActions(shownBrowserSessionId);
  });

  ipcMain.on('browser:setViewport', (_event, input: { sessionId?: unknown; rect?: BrowserViewRect | null }) => {
    if (!browserTargetOk(input?.sessionId)) return;
    deps.mainWindowController.getBrowserViews().setViewport(input.sessionId, input.rect ?? null);
  });

  ipcMain.handle('browser:navigate', async (_event, target: unknown, url: unknown) => {
    if (!browserTargetOk(target)) return;
    await deps.mainWindowController.getBrowserViews().getOrCreate(target).navigate(String(url ?? ''));
  });
  ipcMain.handle('browser:back', (_event, target: unknown) => {
    if (browserTargetOk(target)) deps.mainWindowController.getBrowserViews().get(target)?.goBack();
  });
  ipcMain.handle('browser:forward', (_event, target: unknown) => {
    if (browserTargetOk(target)) deps.mainWindowController.getBrowserViews().get(target)?.goForward();
  });
  ipcMain.handle('browser:reload', (_event, target: unknown) => {
    if (browserTargetOk(target)) deps.mainWindowController.getBrowserViews().get(target)?.reload();
  });
  ipcMain.handle('browser:stop', (_event, target: unknown) => {
    if (browserTargetOk(target)) deps.mainWindowController.getBrowserViews().get(target)?.stop();
  });
  ipcMain.handle('browser:get-state', (_event, target: unknown) =>
    typeof target === 'string' && target.length > 0
      ? deps.mainWindowController.getBrowserViews().get(target)?.state() ?? null
      : null,
  );
  ipcMain.handle('browser:close-page', async (_event, target: unknown) => {
    if (browserTargetOk(target)) await releaseBrowserSession(target);
  });
}
