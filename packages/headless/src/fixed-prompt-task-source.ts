import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FixedPromptTask } from './fixed-prompt-controller.js';

export function resolveFixedPromptRunRoot(outDir: string, runId: string, envName = 'MAKA_PROMPT_RUN_ID'): string {
  if (!/^[A-Za-z0-9._-]+$/.test(runId) || runId === '.' || runId === '..') {
    throw new Error(`${envName} must contain only letters, numbers, dot, underscore, or hyphen`);
  }
  return join(outDir, runId);
}

/** Scan a Harbor task cache (`<root>/<hash>/<task-name>/task.toml`) into a
 * deterministic, id-sorted task list. */
export async function discoverCachedHarborTasks(tasksRoot: string): Promise<FixedPromptTask[]> {
  const byId = new Map<string, FixedPromptTask>();
  let hashDirs;
  try {
    hashDirs = await readdir(tasksRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const hashDir of hashDirs) {
    if (!hashDir.isDirectory()) continue;
    const hashPath = join(tasksRoot, hashDir.name);
    let inner;
    try {
      inner = await readdir(hashPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const taskDir of inner) {
      if (!taskDir.isDirectory()) continue;
      const taskPath = join(hashPath, taskDir.name);
      let taskToml: string;
      try {
        taskToml = await readFile(join(taskPath, 'task.toml'), 'utf8');
      } catch {
        continue;
      }
      // The controller keys events by task id, so two cached versions of the same
      // task name would silently collide and pollute scoring. Fail loud instead.
      const existing = byId.get(taskDir.name);
      if (existing) {
        throw new Error(`duplicate cached task id "${taskDir.name}": ${existing.path} and ${taskPath}`);
      }
      byId.set(taskDir.name, {
        id: taskDir.name,
        path: taskPath,
        ...metadataField(parseTaskTomlMetadata(taskToml)),
      });
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function parseTaskTomlMetadata(text: string): FixedPromptTask['metadata'] {
  return {
    ...stringField('difficulty', sectionField(text, 'metadata', 'difficulty')),
    ...numberField('estimatedDurationSec', sectionField(text, 'metadata', 'estimated_duration_sec')),
    ...numberField('expertTimeEstimateMin', sectionField(text, 'metadata', 'expert_time_estimate_min')),
    ...numberField('juniorTimeEstimateMin', sectionField(text, 'metadata', 'junior_time_estimate_min')),
    ...numberField('agentTimeoutSec', sectionField(text, 'agent', 'timeout_sec')),
    ...numberField('verifierTimeoutSec', sectionField(text, 'verifier', 'timeout_sec')),
  };
}

function sectionField(text: string, sectionName: string, fieldName: string): string | undefined {
  let inSection = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, '').trim();
    if (line.length === 0) continue;
    const section = line.match(/^\[([^\]]+)\]$/);
    if (section) {
      inSection = section[1] === sectionName;
      continue;
    }
    if (!inSection) continue;
    const field = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (field?.[1] !== fieldName) continue;
    return field[2]?.trim();
  }
  return undefined;
}

function stringField(key: 'difficulty', raw: string | undefined): Pick<NonNullable<FixedPromptTask['metadata']>, 'difficulty'> | {} {
  if (raw === undefined) return {};
  const value = raw.match(/^"([^"]*)"$/)?.[1] ?? raw;
  return value.length > 0 ? { [key]: value } : {};
}

function numberField<K extends Exclude<keyof NonNullable<FixedPromptTask['metadata']>, 'difficulty'>>(
  key: K,
  raw: string | undefined,
): Pick<NonNullable<FixedPromptTask['metadata']>, K> | {} {
  if (raw === undefined) return {};
  const value = Number(raw);
  return Number.isFinite(value) ? { [key]: value } as Pick<NonNullable<FixedPromptTask['metadata']>, K> : {};
}

function metadataField(metadata: FixedPromptTask['metadata']): Pick<FixedPromptTask, 'metadata'> | {} {
  return metadata && Object.keys(metadata).length > 0 ? { metadata } : {};
}
