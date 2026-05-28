import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  isPlanReminderDue,
  nextPlanReminderStateAfterTrigger,
  normalizeCreatePlanReminderInput,
  normalizeUpdatePlanReminderInput,
  type PlanReminder,
  type PlanReminderRunRecord,
} from '@maka/core/plan-reminders';

export interface PlanReminderStore {
  list(): Promise<PlanReminder[]>;
  create(input: unknown): Promise<PlanReminder>;
  update(id: string, patch: unknown): Promise<PlanReminder>;
  setEnabled(id: string, enabled: boolean): Promise<PlanReminder>;
  remove(id: string): Promise<void>;
  listDue(now?: number): Promise<PlanReminder[]>;
  markTriggered(id: string, run: Omit<PlanReminderRunRecord, 'id'> & { id?: string }): Promise<PlanReminder>;
  markBlocked(id: string, run: Omit<PlanReminderRunRecord, 'id' | 'status'> & { id?: string }): Promise<PlanReminder>;
}

export function createPlanReminderStore(workspaceRoot: string): PlanReminderStore {
  return new FilePlanReminderStore(workspaceRoot);
}

class FilePlanReminderStore implements PlanReminderStore {
  private readonly filePath: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(workspaceRoot: string) {
    this.filePath = join(workspaceRoot, 'plan-reminders.json');
  }

  async list(): Promise<PlanReminder[]> {
    const reminders = await this.read();
    return reminders
      .filter((reminder) => reminder.status !== 'completed' || reminder.lastRun)
      .sort(comparePlanRemindersForList);
  }

  async create(input: unknown): Promise<PlanReminder> {
    const now = Date.now();
    const normalized = normalizeCreatePlanReminderInput(input, now);
    if (!normalized.ok) throw new Error(normalized.message);
    const value = normalized.value;
    const reminder: PlanReminder = {
      id: randomUUID(),
      title: value.title,
      note: value.note,
      schedule: { kind: 'once', runAt: value.runAt },
      status: 'scheduled',
      enabled: true,
      createdAt: now,
      updatedAt: now,
      nextRunAt: value.runAt,
      runCount: 0,
    };
    await this.mutate((reminders) => [...reminders, reminder]);
    return reminder;
  }

  async update(id: string, patch: unknown): Promise<PlanReminder> {
    const now = Date.now();
    const normalized = normalizeUpdatePlanReminderInput(patch, now);
    if (!normalized.ok) throw new Error(normalized.message);
    let updated: PlanReminder | undefined;
    await this.mutate((reminders) => reminders.map((reminder) => {
      if (reminder.id !== id) return reminder;
      const nextEnabled = normalized.value.enabled ?? reminder.enabled;
      const nextRunAt = normalized.value.runAt ?? reminder.schedule.runAt;
      updated = {
        ...reminder,
        ...(normalized.value.title !== undefined ? { title: normalized.value.title } : {}),
        ...(normalized.value.note !== undefined ? { note: normalized.value.note } : {}),
        schedule: { kind: 'once', runAt: nextRunAt },
        enabled: nextEnabled,
        status: nextEnabled ? 'scheduled' : 'paused',
        nextRunAt: nextEnabled ? nextRunAt : undefined,
        updatedAt: now,
      };
      return updated;
    }));
    if (!updated) throw new Error(`No such plan reminder: ${id}`);
    return updated;
  }

  async setEnabled(id: string, enabled: boolean): Promise<PlanReminder> {
    if (typeof enabled !== 'boolean') throw new Error('Plan reminder enabled must be a boolean');
    const now = Date.now();
    let updated: PlanReminder | undefined;
    await this.mutate((reminders) => reminders.map((reminder) => {
      if (reminder.id !== id) return reminder;
      if (reminder.status === 'completed') {
        updated = reminder;
        return reminder;
      }
      updated = {
        ...reminder,
        enabled,
        status: enabled ? 'scheduled' : 'paused',
        nextRunAt: enabled ? reminder.schedule.runAt : undefined,
        updatedAt: now,
      };
      return updated;
    }));
    if (!updated) throw new Error(`No such plan reminder: ${id}`);
    return updated;
  }

  async remove(id: string): Promise<void> {
    let found = false;
    await this.mutate((reminders) => reminders.filter((reminder) => {
      if (reminder.id === id) {
        found = true;
        return false;
      }
      return true;
    }));
    if (!found) throw new Error(`No such plan reminder: ${id}`);
  }

  async listDue(now = Date.now()): Promise<PlanReminder[]> {
    return (await this.read()).filter((reminder) => isPlanReminderDue(reminder, now));
  }

  async markTriggered(id: string, run: Omit<PlanReminderRunRecord, 'id'> & { id?: string }): Promise<PlanReminder> {
    let updated: PlanReminder | undefined;
    await this.mutate((reminders) => reminders.map((reminder) => {
      if (reminder.id !== id) return reminder;
      const record: PlanReminderRunRecord = {
        id: run.id ?? randomUUID(),
        at: run.at,
        status: 'triggered',
        message: run.message,
      };
      updated = nextPlanReminderStateAfterTrigger(reminder, record);
      return updated;
    }));
    if (!updated) throw new Error(`No such plan reminder: ${id}`);
    return updated;
  }

  async markBlocked(id: string, run: Omit<PlanReminderRunRecord, 'id' | 'status'> & { id?: string }): Promise<PlanReminder> {
    let updated: PlanReminder | undefined;
    await this.mutate((reminders) => reminders.map((reminder) => {
      if (reminder.id !== id) return reminder;
      const record: PlanReminderRunRecord = {
        id: run.id ?? randomUUID(),
        at: run.at,
        status: 'blocked',
        message: run.message,
        ...(run.blockReason ? { blockReason: run.blockReason } : {}),
      };
      updated = nextPlanReminderStateAfterTrigger(reminder, record);
      return updated;
    }));
    if (!updated) throw new Error(`No such plan reminder: ${id}`);
    return updated;
  }

  private async read(): Promise<PlanReminder[]> {
    try {
      const text = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(text) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isPersistedPlanReminder);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  private async mutate(fn: (reminders: PlanReminder[]) => PlanReminder[]): Promise<void> {
    const run = async () => {
      const current = await this.read();
      await this.write(fn(current));
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    await next;
  }

  private async write(reminders: PlanReminder[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, JSON.stringify(reminders, null, 2) + '\n', 'utf8');
    await rename(tempPath, this.filePath);
  }
}

function comparePlanRemindersForList(a: PlanReminder, b: PlanReminder): number {
  const statusDelta = planReminderListPriority(a) - planReminderListPriority(b);
  if (statusDelta !== 0) return statusDelta;
  if (a.status === 'completed' && b.status === 'completed') {
    const aTime = a.lastRun?.at ?? a.updatedAt;
    const bTime = b.lastRun?.at ?? b.updatedAt;
    const delta = bTime - aTime;
    return delta === 0 ? a.id.localeCompare(b.id) : delta;
  }
  const aTime = a.nextRunAt ?? a.schedule.runAt ?? a.updatedAt;
  const bTime = b.nextRunAt ?? b.schedule.runAt ?? b.updatedAt;
  const delta = aTime - bTime;
  return delta === 0 ? a.id.localeCompare(b.id) : delta;
}

function planReminderListPriority(reminder: PlanReminder): number {
  if (reminder.status === 'scheduled') return 0;
  if (reminder.status === 'paused') return 1;
  return 2;
}

function isPersistedPlanReminder(value: unknown): value is PlanReminder {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Partial<PlanReminder>;
  return typeof record.id === 'string' &&
    typeof record.title === 'string' &&
    typeof record.note === 'string' &&
    typeof record.schedule === 'object' &&
    record.schedule !== null &&
    record.schedule.kind === 'once' &&
    typeof record.schedule.runAt === 'number' &&
    (record.status === 'scheduled' || record.status === 'paused' || record.status === 'completed') &&
    typeof record.enabled === 'boolean' &&
    typeof record.createdAt === 'number' &&
    typeof record.updatedAt === 'number' &&
    typeof record.runCount === 'number';
}
