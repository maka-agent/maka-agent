import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { chainWrite } from './write-queue.js';

/** Minimal constraint for records stored by the automation store. */
export interface AutomationRecord {
  id: string;
}

export interface AutomationStore<T extends AutomationRecord = AutomationRecord> {
  loadAll(): Promise<T[]>;
  save(automation: T): Promise<void>;
  remove(id: string): Promise<void>;
  sync(automations: T[]): Promise<void>;
}

interface AutomationFile {
  version: 1;
  automations: AutomationRecord[];
}

export function createAutomationStore<T extends AutomationRecord = AutomationRecord>(
  workspaceRoot: string,
): AutomationStore<T> {
  return new FileAutomationStore<T>(workspaceRoot);
}

class FileAutomationStore<T extends AutomationRecord> implements AutomationStore<T> {
  private readonly filePath: string;
  private readonly writeQueue = new Map<string, Promise<void>>();
  private static readonly QUEUE_KEY = 'automations';

  constructor(workspaceRoot: string) {
    this.filePath = join(workspaceRoot, 'automations.json');
  }

  async loadAll(): Promise<T[]> {
    try {
      const text = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(text) as unknown;
      if (!isAutomationFile(parsed)) {
        console.warn('[automation-store] corrupt automations.json -- returning empty');
        return [];
      }
      return parsed.automations as T[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      console.warn('[automation-store] failed to read automations.json -- returning empty:', error);
      return [];
    }
  }

  async save(automation: T): Promise<void> {
    await chainWrite(this.writeQueue, FileAutomationStore.QUEUE_KEY, async () => {
      const current = await this.loadAll();
      const index = current.findIndex(a => a.id === automation.id);
      if (index >= 0) {
        current[index] = automation;
      } else {
        current.push(automation);
      }
      await this.writeFile(current);
    });
  }

  async remove(id: string): Promise<void> {
    await chainWrite(this.writeQueue, FileAutomationStore.QUEUE_KEY, async () => {
      const current = await this.loadAll();
      const filtered = current.filter(a => a.id !== id);
      if (filtered.length === current.length) return;
      await this.writeFile(filtered);
    });
  }

  async sync(automations: T[]): Promise<void> {
    await chainWrite(this.writeQueue, FileAutomationStore.QUEUE_KEY, async () => {
      await this.writeFile(automations);
    });
  }

  private async writeFile(automations: T[]): Promise<void> {
    const data: AutomationFile = { version: 1, automations };
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
    await rename(tempPath, this.filePath);
  }
}

function isAutomationFile(value: unknown): value is AutomationFile {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return obj.version === 1 && Array.isArray(obj.automations);
}
