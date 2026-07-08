import { redactSecrets, type PersonalizationSettings } from '@maka/core';
import {
  buildPersonalizationPromptFragment,
  buildSessionEnvironmentPromptFragment,
  buildWorkspaceInstructionsPromptFragment,
  resolveProjectGitInfo,
  type AutomationManager,
} from '@maka/runtime';

/**
 * CLI/TUI system-prompt assembly.
 *
 * The durable system prompt is built from the personalization fragment and the
 * gated workspace-instructions fragment (AGENTS.md / CLAUDE.md / GEMINI.md from
 * the session cwd). The per-turn tail carries the session environment (cwd /
 * git / platform / date), which must stay volatile to avoid churning the system
 * prefix hash.
 *
 * The fragment builders themselves live in @maka/runtime and are shared with the
 * desktop app. This module owns only the CLI's choice of which fragments to
 * assemble; settings are read by the caller (runtime-bootstrap) and injected
 * here so @maka/runtime does not need to depend on @maka/storage.
 */

export interface BuildCliSystemPromptInput {
  settings: {
    personalization?: Partial<PersonalizationSettings>;
    workspaceInstructions: { enabled: boolean };
  };
  cwd: string;
}

export async function buildCliSystemPrompt(input: BuildCliSystemPromptInput): Promise<string | undefined> {
  const personalization = buildPersonalizationPromptFragment(input.settings.personalization);
  const workspaceInstructions = input.settings.workspaceInstructions.enabled
    ? await buildWorkspaceInstructionsPromptFragment(input.cwd)
    : undefined;
  const fragments = [personalization.text, workspaceInstructions].filter((v): v is string => Boolean(v));
  return fragments.length > 0 ? fragments.join('\n\n') : undefined;
}

export async function buildCliTurnTailPrompt(input: {
  cwd: string;
  sessionId?: string;
  automationManager?: AutomationManager;
}): Promise<string> {
  const projectGit = await resolveProjectGitInfo(input.cwd);
  const fragments = [buildSessionEnvironmentPromptFragment({ cwd: input.cwd, projectGit })];

  if (input.sessionId && input.automationManager) {
    const automationFragment = buildAutomationTailFragment(input.sessionId, input.automationManager);
    if (automationFragment) fragments.push(automationFragment);
  }

  return fragments.join('\n\n');
}

function buildAutomationTailFragment(sessionId: string, manager: AutomationManager): string | undefined {
  const automations = manager.listForSession(sessionId).filter(a => a.status === 'active' || a.status === 'paused');
  if (automations.length === 0) return undefined;
  const lines = [
    'Active automations (use Automation tool with mode "list" for full details):',
    '<automations>',
    ...automations.map(a => {
      const schedule = a.schedule.type === 'cron' ? `cron "${a.schedule.expression}"`
        : a.schedule.type === 'interval' ? `every ${a.schedule.seconds}s`
        : `once`;
      return `  ${a.status} id="${a.id}" name="${a.name}" kind=${a.kind} schedule=${schedule} fires=${a.fireCount}`;
    }),
    '</automations>',
  ];
  return lines.join('\n');
}