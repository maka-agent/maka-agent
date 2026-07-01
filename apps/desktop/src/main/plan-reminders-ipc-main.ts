import { ipcMain } from 'electron';
import type { WorkspacePrivacyContext } from '@maka/core';
import type { PlanReminderMainService } from './plan-reminders-main.js';

interface PlanReminderIpcDeps {
  planReminders: PlanReminderMainService;
  getWorkspacePrivacyContext: () => Promise<WorkspacePrivacyContext>;
}

export function registerPlanReminderIpc(deps: PlanReminderIpcDeps): void {
  ipcMain.handle('plans:list', () => deps.planReminders.list());
  ipcMain.handle('plans:create', async (_event, input: unknown) => {
    const privacy = await deps.getWorkspacePrivacyContext();
    if (privacy.incognitoActive) {
      throw new Error('隐私模式已开启，不能创建计划提醒。');
    }
    return deps.planReminders.create(input);
  });
  ipcMain.handle('plans:update', (_event, id: string, patch: unknown) =>
    deps.planReminders.update(id, patch),
  );
  ipcMain.handle('plans:setEnabled', (_event, id: string, enabled: boolean) =>
    deps.planReminders.setEnabled(id, enabled),
  );
  ipcMain.handle('plans:triggerNow', (_event, id: string) =>
    deps.planReminders.triggerNow(id),
  );
  ipcMain.handle('plans:snooze', (_event, id: string) =>
    deps.planReminders.snooze(id),
  );
  ipcMain.handle('plans:clearRunHistory', (_event, id: string) =>
    deps.planReminders.clearRunHistory(id),
  );
  ipcMain.handle('plans:delete', async (_event, id: string) => {
    await deps.planReminders.delete(id);
  });
}
