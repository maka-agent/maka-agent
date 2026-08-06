import { ipcMain } from 'electron';
import { createBrowserViewHost } from './browser/automation-host.js';
import { provideBrowserViewHost } from './browser/browser-host.js';
import { releaseBrowserSession, revokeHiddenBrowserActions } from './browser/session.js';
import { createBrowserWorkflowService } from './browser/browser-workflow-service.js';
import { isBrowserWorkflowWaitConditionInput } from '@maka/core/browser-workflow';
import type { BrowserWorkflowWaitConditionInput } from '@maka/core/browser-workflow';
import type { BrowserWorkflowStore } from '@maka/storage';
import type { BrowserViewRect } from './browser/logic.js';
import type { createMainWindowController } from './main-window.js';

interface BrowserIpcDeps {
  mainWindowController: ReturnType<typeof createMainWindowController>;
  browserWorkflowStore: BrowserWorkflowStore;
}

const WORKFLOW_ID_MAX_LENGTH = 200;
const SENSITIVE_VALUE_MAX_LENGTH = 100_000;
const SENSITIVE_VALUE_COUNT_MAX = 500;

function requireWorkflowId(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > WORKFLOW_ID_MAX_LENGTH) {
    throw new Error('Invalid browser workflow id.');
  }
  return value;
}

function normalizeSensitiveValues(value: unknown): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid browser workflow sensitive values.');
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > SENSITIVE_VALUE_COUNT_MAX) throw new Error('Too many browser workflow sensitive values.');
  const normalized: Record<string, string> = {};
  for (const [key, raw] of entries) {
    if (key.length === 0 || key.length > 100 || typeof raw !== 'string' || raw.length > SENSITIVE_VALUE_MAX_LENGTH) {
      throw new Error('Invalid browser workflow sensitive value.');
    }
    Object.defineProperty(normalized, key, { value: raw, enumerable: true, configurable: true, writable: true });
  }
  return normalized;
}

export function registerBrowserIpc(deps: BrowserIpcDeps): void {
  let shownBrowserSessionId: string | null = null;
  const browserWorkflows = createBrowserWorkflowService({
    store: deps.browserWorkflowStore,
    views: deps.mainWindowController.getBrowserViews(),
    sendToRenderer: (_channel, payload) => deps.mainWindowController.send('browser:workflow-progress', payload),
  });
  provideBrowserViewHost(createBrowserViewHost(deps.mainWindowController.getBrowserViews(), () => shownBrowserSessionId));

  const browserTargetOk = (target: unknown): target is string =>
    typeof target === 'string' && target.length > 0 && target === shownBrowserSessionId;

  ipcMain.on('browser:active-session', (_event, sessionId: unknown) => {
    const nextSessionId = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null;
    if (shownBrowserSessionId && shownBrowserSessionId !== nextSessionId) {
      void browserWorkflows.cancelRecording(shownBrowserSessionId);
    }
    shownBrowserSessionId = nextSessionId;
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
    if (browserTargetOk(target)) {
      await browserWorkflows.cancelRecording(target);
      await releaseBrowserSession(target);
    }
  });

  ipcMain.handle('browser:workflow-list', () => browserWorkflows.list());
  ipcMain.handle('browser:workflow-start-recording', async (_event, target: unknown) => {
    if (!browserTargetOk(target)) throw new Error('The browser session is not currently visible.');
    return browserWorkflows.startRecording(target);
  });
  ipcMain.handle('browser:workflow-stop-recording', async (_event, target: unknown) => {
    if (!browserTargetOk(target)) throw new Error('The browser session is not currently visible.');
    return browserWorkflows.stopRecording(target);
  });
  ipcMain.handle('browser:workflow-add-wait', async (_event, target: unknown, input: unknown) => {
    if (!browserTargetOk(target)) throw new Error('The browser session is not currently visible.');
    if (!isBrowserWorkflowWaitConditionInput(input)) throw new Error('Invalid browser workflow wait condition.');
    return browserWorkflows.addWaitCondition(target, input as BrowserWorkflowWaitConditionInput);
  });
  ipcMain.handle('browser:workflow-save-recording', (_event, draftId: unknown, name: unknown) => {
    if (typeof draftId !== 'string' || typeof name !== 'string') throw new Error('Invalid browser workflow draft.');
    return browserWorkflows.saveRecording(draftId, name);
  });
  ipcMain.handle('browser:workflow-run', async (_event, workflowId: unknown, target: unknown, values: unknown) => {
    if (!browserTargetOk(target)) throw new Error('The browser session is not currently visible.');
    await browserWorkflows.run(requireWorkflowId(workflowId), target, normalizeSensitiveValues(values));
  });
  ipcMain.on('browser:workflow-cancel', (_event, runId: unknown) => {
    if (typeof runId === 'string') browserWorkflows.cancel(runId);
  });
  ipcMain.handle('browser:workflow-rename', (_event, workflowId: unknown, name: unknown) => {
    if (typeof name !== 'string') throw new Error('Invalid browser workflow.');
    return browserWorkflows.rename(requireWorkflowId(workflowId), name);
  });
  ipcMain.handle('browser:workflow-delete', (_event, workflowId: unknown) => {
    return browserWorkflows.remove(requireWorkflowId(workflowId));
  });
}
