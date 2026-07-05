import type { ProjectGitInfo } from './project-context.js';

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
  now?: Date;
  timeZone?: string;
}

export function buildSessionEnvironmentPromptFragment(input: SessionEnvironmentPromptInput): string {
  const platform = input.platform ?? process.platform;
  const today = formatDate(input.now ?? new Date(), input.timeZone);
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
    `  Today's date: ${today}`,
    '</env>',
  );
  return lines.join('\n');
}

function formatDate(value: Date, timeZone?: string): string {
  if (Number.isNaN(value.getTime())) return 'unknown';
  // Format in the configured timezone (defaults to the process local timezone
  // when undefined) so "Today's date" matches the user's calendar day instead of
  // the UTC day, which can be off by one near local midnight.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function sanitizePromptLine(value: string): string {
  return value.replace(/[\r\n\t]+/g, ' ').trim();
}