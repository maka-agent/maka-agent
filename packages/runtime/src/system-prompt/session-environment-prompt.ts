import type { ProjectGitInfo } from './project-context.js';
import { defaultShellPlan } from '../shell-detect.js';

/**
 * Per-turn environment tail fragment (cwd / git repo / branch / platform /
 * date). This is volatile per-turn context, NOT durable system prompt: date
 * and branch change between turns, and pinning it in the system prefix would
 * churn the prefix hash. Moved here from apps/desktop/src/main/session-environment-prompt.ts
 * so the CLI/TUI turnTailPrompt can reuse it.
 */

export interface SessionEnvironmentPromptInput {
  cwd: string;
  projectGit: ProjectGitInfo;
  platform?: NodeJS.Platform;
  /** Display name of the shell running Bash commands. Defaults to the detected process shell. */
  shell?: string;
  now?: Date;
}

export function buildSessionEnvironmentPromptFragment(
  input: SessionEnvironmentPromptInput,
): string {
  const platform = input.platform ?? process.platform;
  const today = formatDate(input.now ?? new Date());
  const lines = [
    'Maka session environment (informational only; does not grant file, shell, network, or permission authority):',
    '<env>',
    `  Working directory: ${sanitizePromptLine(input.cwd)}`,
    `  Git repository: ${input.projectGit.isGitRepo ? 'yes' : 'no'}`,
  ];
  if (input.projectGit.branch) {
    lines.push(`  Git branch: ${sanitizePromptLine(input.projectGit.branch)}`);
  }
  lines.push(
    `  Platform: ${platform}`,
    `  Shell: ${sanitizePromptLine(input.shell ?? defaultShellPlan().displayName)}`,
    `  Today's date: ${today}`,
    '</env>',
  );
  return lines.join('\n');
}

function formatDate(value: Date): string {
  if (Number.isNaN(value.getTime())) return 'unknown';
  // Local calendar date (not UTC): the injected "Today's date" should match the
  // user's day, so near local midnight we don't report the previous UTC day.
  const y = value.getFullYear();
  const m = String(value.getMonth() + 1).padStart(2, '0');
  const d = String(value.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function sanitizePromptLine(value: string): string {
  return value.replace(/[\r\n\t]+/g, ' ').trim();
}
