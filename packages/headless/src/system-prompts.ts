import { createHash } from 'node:crypto';
import type { Config, HeadlessSystemPromptMode } from './contracts.js';
import {
  appendEconomyTaskPolicyToSystemPrompt,
  type EconomyTaskModeSelection,
} from './economy-task-policy.js';
import {
  appendHeavyTaskPolicyToSystemPrompt,
  type HeavyTaskModeSelection,
} from './heavy-task-policy.js';

export const DEFAULT_HEADLESS_SYSTEM_PROMPT = [
  'Complete the task by acting with the available tools, not by narrating.',
  'Prefer Read, Glob, and Grep for inspection, Edit and Write for file changes, and Bash for shell commands and tests.',
  'Verify the result when practical.',
  'Stop when the task is complete.',
].join('\n');

export interface ResolvedHeadlessSystemPrompt {
  mode: HeadlessSystemPromptMode;
  systemPrompt: string;
  systemPromptHash: string;
}

export interface ResolveHeadlessSystemPromptOptions {
  heavyTaskMode?: HeavyTaskModeSelection;
  economyTaskMode?: EconomyTaskModeSelection;
}

export function resolveHeadlessSystemPrompt(
  config: Pick<Config, 'systemPrompt'>,
  options: ResolveHeadlessSystemPromptOptions = {},
): ResolvedHeadlessSystemPrompt {
  let mode: HeadlessSystemPromptMode;
  let systemPrompt: string;
  if (config.systemPrompt === undefined) {
    mode = 'default';
    systemPrompt = DEFAULT_HEADLESS_SYSTEM_PROMPT;
  } else if (config.systemPrompt.trim().length === 0) {
    throw new Error('Config.systemPrompt must contain non-whitespace text');
  } else {
    mode = 'custom';
    systemPrompt = config.systemPrompt;
  }
  if (options.heavyTaskMode) {
    systemPrompt =
      appendHeavyTaskPolicyToSystemPrompt(systemPrompt, options.heavyTaskMode) ?? systemPrompt;
  }
  if (options.economyTaskMode) {
    systemPrompt =
      appendEconomyTaskPolicyToSystemPrompt(systemPrompt, options.economyTaskMode) ?? systemPrompt;
  }
  return {
    mode,
    systemPrompt,
    systemPromptHash: hashHeadlessSystemPrompt(systemPrompt),
  };
}

export function hashHeadlessSystemPrompt(systemPrompt: string): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(systemPrompt)).digest('hex')}`;
}
