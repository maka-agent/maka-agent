import { chmod, copyFile, mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import {
  defaultLocalMemoryMarkdown,
  parseLocalMemoryMarkdown,
  type AppSettings,
  type LocalMemoryState,
} from '@maka/core';
import type { WorkspacePrivacyContext } from '@maka/core/incognito';

export interface LocalMemoryServiceDeps {
  workspaceRoot: string;
  getSettings(): Promise<AppSettings>;
  updateSettings(patch: { localMemory: Partial<AppSettings['localMemory']> }): Promise<AppSettings>;
  getPrivacyContext(): Promise<WorkspacePrivacyContext>;
  now?(): number;
}

export class LocalMemoryService {
  readonly dir: string;
  readonly file: string;
  private readonly now: () => number;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: LocalMemoryServiceDeps) {
    this.dir = join(deps.workspaceRoot, 'memory');
    this.file = join(this.dir, 'MEMORY.md');
    this.now = deps.now ?? Date.now;
  }

  async getState(): Promise<LocalMemoryState> {
    const settings = await this.deps.getSettings();
    if ((await this.deps.getPrivacyContext()).incognitoActive) {
      return {
        path: this.file,
        enabled: settings.localMemory.enabled,
        agentReadEnabled: false,
        status: 'incognito_blocked',
        content: '',
        entryCount: 0,
        activeEntryCount: 0,
        archivedEntryCount: 0,
        reason: '隐身模式下禁用本地记忆读写。',
      };
    }
    if (!settings.localMemory.enabled) {
      return {
        path: this.file,
        enabled: false,
        agentReadEnabled: settings.localMemory.agentReadEnabled,
        status: 'disabled',
        content: '',
        entryCount: 0,
        activeEntryCount: 0,
        archivedEntryCount: 0,
      };
    }
    try {
      await this.ensure();
      const content = await readFile(this.file, 'utf8');
      const parsed = parseLocalMemoryMarkdown(content);
      if (parsed.safeMode) {
        return {
          path: this.file,
          enabled: true,
          agentReadEnabled: settings.localMemory.agentReadEnabled,
          status: 'safe_mode',
          content,
          entryCount: 0,
          activeEntryCount: 0,
          archivedEntryCount: 0,
          reason: parsed.reason,
        };
      }
      return {
        path: this.file,
        enabled: true,
        agentReadEnabled: settings.localMemory.agentReadEnabled,
        status: 'ok',
        content,
        entryCount: parsed.entries.length,
        activeEntryCount: parsed.activeEntries.length,
        archivedEntryCount: parsed.archivedEntries.length,
        latestEntry: parsed.activeEntries.at(-1),
      };
    } catch (error) {
      return {
        path: this.file,
        enabled: true,
        agentReadEnabled: settings.localMemory.agentReadEnabled,
        status: 'error',
        content: '',
        entryCount: 0,
        activeEntryCount: 0,
        archivedEntryCount: 0,
        reason: error instanceof Error ? error.message : 'memory read failed',
      };
    }
  }

  async save(content: string): Promise<LocalMemoryState> {
    if ((await this.deps.getPrivacyContext()).incognitoActive) {
      return this.getState();
    }
    const parsed = parseLocalMemoryMarkdown(content);
    if (parsed.safeMode) {
      return {
        path: this.file,
        enabled: true,
        agentReadEnabled: (await this.deps.getSettings()).localMemory.agentReadEnabled,
        status: 'safe_mode',
        content,
        entryCount: 0,
        activeEntryCount: 0,
        archivedEntryCount: 0,
        reason: parsed.reason,
      };
    }
    await this.enqueue(async () => {
      await this.ensure();
      await this.backup('bak');
      const tmp = `${this.file}.${this.now()}.tmp`;
      await writeFile(tmp, content, { mode: 0o600 });
      await rename(tmp, this.file);
      await chmod(this.file, 0o600);
    });
    return this.getState();
  }

  async reset(): Promise<LocalMemoryState> {
    if ((await this.deps.getPrivacyContext()).incognitoActive) {
      return this.getState();
    }
    await this.enqueue(async () => {
      await this.ensure();
      await this.backup('reset.bak');
      await writeFile(this.file, defaultLocalMemoryMarkdown(this.now()), { mode: 0o600 });
      await chmod(this.file, 0o600);
    });
    return this.getState();
  }

  async setEnabled(enabled: boolean): Promise<LocalMemoryState> {
    await this.deps.updateSettings({ localMemory: { enabled } });
    if (enabled) await this.ensure();
    return this.getState();
  }

  async setAgentReadEnabled(agentReadEnabled: boolean): Promise<LocalMemoryState> {
    await this.deps.updateSettings({ localMemory: { agentReadEnabled } });
    return this.getState();
  }

  async resolveFileForOpen(): Promise<
    | { ok: true; path: string }
    | { ok: false; reason: 'incognito_blocked' | 'disabled' | 'missing' | 'not-allowed' | 'not-a-file' }
  > {
    const settings = await this.deps.getSettings();
    if ((await this.deps.getPrivacyContext()).incognitoActive) {
      return { ok: false, reason: 'incognito_blocked' };
    }
    if (!settings.localMemory.enabled) return { ok: false, reason: 'disabled' };

    await this.ensure();

    let root: string;
    let target: string;
    try {
      [root, target] = await Promise.all([
        realpath(this.deps.workspaceRoot),
        realpath(this.file),
      ]);
    } catch {
      return { ok: false, reason: 'missing' };
    }

    if (!isInsideOrSamePath(root, target)) return { ok: false, reason: 'not-allowed' };

    const targetStat = await stat(target).catch(() => null);
    if (!targetStat) return { ok: false, reason: 'missing' };
    if (!targetStat.isFile()) return { ok: false, reason: 'not-a-file' };

    return { ok: true, path: target };
  }

  private async ensure(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const root = await realpath(this.deps.workspaceRoot);
    const dir = await realpath(this.dir);
    if (!isInsideOrSamePath(root, dir)) {
      throw new Error('MEMORY.md directory is outside the workspace.');
    }
    await chmod(dir, 0o700);
    try {
      await stat(this.file);
    } catch {
      await writeFile(this.file, defaultLocalMemoryMarkdown(this.now()), { mode: 0o600 });
    }
    const file = await realpath(this.file);
    if (!isInsideOrSamePath(root, file)) {
      throw new Error('MEMORY.md file is outside the workspace.');
    }
    const fileStat = await stat(file);
    if (!fileStat.isFile()) {
      throw new Error('MEMORY.md is not a file.');
    }
    await chmod(file, 0o600);
  }

  private async backup(suffix: string): Promise<void> {
    try {
      await copyFile(this.file, `${this.file}.${suffix}`);
      await chmod(`${this.file}.${suffix}`, 0o600);
    } catch {
      // No prior file to back up.
    }
  }

  private async enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.catch(() => undefined).then(task);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

function isInsideOrSamePath(root: string, target: string): boolean {
  if (target === root) return true;
  const rel = relative(root, target);
  return rel !== '' && !rel.startsWith('..') && rel !== '..' && !rel.includes(`..${sep}`) && !rel.startsWith(sep);
}

export function localMemoryDirForWorkspace(workspaceRoot: string): string {
  return dirname(join(workspaceRoot, 'memory', 'MEMORY.md'));
}
