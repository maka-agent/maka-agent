/**
 * Unified Automation tool — single tool with mode parameter.
 *
 * Modes: create, delete, list, pause, resume
 * Kinds: heartbeat (session-internal polling) | cron (standalone scheduled runs)
 *
 * Follows Codex Desktop's pattern: one tool, parameters decide behavior.
 */

import { z } from 'zod';
import type { MakaTool } from './tool-runtime.js';
import type { AutomationManager, AutomationDefinition } from './automation-state.js';

export const AUTOMATION_TOOL_NAME = 'Automation';

export interface AutomationToolDeps {
  automationManager: AutomationManager;
  onAutomationChange?: () => void;
  /** Whether the host can run cron (fresh-session) automations. When false, the
   *  cron kind is not advertised and is rejected at creation. */
  cronEnabled?: boolean;
}

function buildCreateSchema(cronEnabled: boolean) {
  const kind = cronEnabled
    ? z.enum(['heartbeat', 'cron']).describe('heartbeat = resume into current session (polling/monitoring). cron = create fresh session each run (standalone scheduled tasks).')
    : z.literal('heartbeat').describe('heartbeat = resume into current session (polling/monitoring). This host supports heartbeat automations only.');
  return z.object({
    mode: z.literal('create'),
    kind,
    name: z.string().trim().min(1).max(100)
      .describe('Short human-readable name for this automation.'),
    prompt: z.string().trim().min(1).max(2000)
      .describe('The prompt to execute on each fire.'),
    schedule: z.union([
      z.object({
        type: z.literal('cron'),
        expression: z.string().min(9).max(100)
          .describe('5-field cron expression: "minute hour day-of-month month day-of-week". Example: "*/5 * * * *" = every 5 min, "0 9 * * 1-5" = weekdays at 9am.'),
      }),
      z.object({
        type: z.literal('interval'),
        seconds: z.number().int().min(10).max(86400)
          .describe('Repeat interval in seconds (10s to 24h).'),
      }),
      z.object({
        type: z.literal('once'),
        delay_seconds: z.number().int().min(5).max(86400)
          .describe('One-shot delay in seconds (5s to 24h). Fires once then auto-completes.'),
      }),
    ]).describe('When to fire. Use "interval" for simple repeats, "cron" for complex schedules, "once" for one-shot delays.'),
    max_fires: z.number().int().min(1).max(10000).optional()
      .describe('Maximum number of fires before auto-completing. Omit for unlimited (7-day expiry still applies).'),
    durable: z.boolean().optional()
      .describe('When true, this automation persists across app restarts. Default: false (session-scoped only).'),
  });
}

const deleteSchema = z.object({
  mode: z.literal('delete'),
  id: z.string().min(1).max(64)
    .describe('Automation ID to delete.'),
});

const listSchema = z.object({
  mode: z.literal('list'),
});

const pauseSchema = z.object({
  mode: z.literal('pause'),
  id: z.string().min(1).max(64)
    .describe('Automation ID to pause.'),
});

const resumeSchema = z.object({
  mode: z.literal('resume'),
  id: z.string().min(1).max(64)
    .describe('Automation ID to resume.'),
});

function buildAutomationSchema(cronEnabled: boolean) {
  return z.discriminatedUnion('mode', [
    buildCreateSchema(cronEnabled),
    deleteSchema,
    listSchema,
    pauseSchema,
    resumeSchema,
  ]);
}

// Broad input type (covers both cron-enabled and heartbeat-only schemas).
type AutomationInput = z.infer<ReturnType<typeof buildAutomationSchema>>;
type CreateInput = z.infer<ReturnType<typeof buildCreateSchema>>;
type DeleteInput = z.infer<typeof deleteSchema>;
type PauseInput = z.infer<typeof pauseSchema>;
type ResumeInput = z.infer<typeof resumeSchema>;

export function buildAutomationTool(deps: AutomationToolDeps): MakaTool<AutomationInput, string> {
  const cronEnabled = deps.cronEnabled === true;
  return {
    name: AUTOMATION_TOOL_NAME,
    displayName: 'Automation',
    description:
      'Create, manage, and list recurring automations. '
      + 'Use kind "heartbeat" for session-internal polling (resumes into this conversation). '
      + (cronEnabled ? 'Use kind "cron" for standalone scheduled tasks (creates a fresh session each run). ' : '')
      + 'Automations auto-expire after 7 days unless deleted earlier.',
    parameters: buildAutomationSchema(cronEnabled),
    permissionRequired: false,
    impl: (input, ctx) => {
      let result: string;
      switch (input.mode) {
        case 'create':
          result = handleCreate(deps, input, ctx.sessionId);
          break;
        case 'delete':
          result = handleDelete(deps, input, ctx.sessionId);
          break;
        case 'list':
          return handleList(deps, ctx.sessionId);
        case 'pause':
          result = handlePause(deps, input, ctx.sessionId);
          break;
        case 'resume':
          result = handleResume(deps, input, ctx.sessionId);
          break;
      }
      deps.onAutomationChange?.();
      return result;
    },
  };
}

function handleCreate(
  deps: AutomationToolDeps,
  input: CreateInput,
  sessionId: string,
): string {
  const schedule = input.schedule.type === 'once'
    ? { type: 'once' as const, delaySeconds: input.schedule.delay_seconds }
    : input.schedule;

  const result = deps.automationManager.create({
    kind: input.kind,
    name: input.name,
    prompt: input.prompt,
    sessionId,
    schedule,
    maxFires: input.max_fires,
    durable: input.durable,
  });

  if ('error' in result) {
    return `Error: ${result.error}`;
  }

  const scheduleDesc = describeSchedule(result.schedule);
  return [
    `Automation created: "${result.name}" (${result.kind}${result.durable ? ', durable' : ''})`,
    `ID: ${result.id}`,
    `Schedule: ${scheduleDesc}`,
    `Next fire: ${result.nextFireAt ? new Date(result.nextFireAt).toLocaleString() : 'N/A'}`,
    result.kind === 'heartbeat'
      ? 'Fires into this session. Stops when session ends or after 7 days.'
      : 'Creates a fresh session each run. Expires after 7 days.',
  ].join('\n');
}

function handleDelete(
  deps: AutomationToolDeps,
  input: DeleteInput,
  sessionId: string,
): string {
  const deleted = deps.automationManager.delete(input.id, sessionId);
  if (!deleted) return `Automation "${input.id}" not found or not owned by this session.`;
  return `Automation "${input.id}" deleted.`;
}

function handleList(deps: AutomationToolDeps, sessionId: string): string {
  const automations = deps.automationManager.listForSession(sessionId);
  if (automations.length === 0) return 'No automations for this session.';

  return automations.map(a => formatAutomation(a)).join('\n---\n');
}

function handlePause(
  deps: AutomationToolDeps,
  input: PauseInput,
  sessionId: string,
): string {
  const result = deps.automationManager.pause(input.id, sessionId);
  if (!result) return `Cannot pause "${input.id}": not found, not owned, or not active.`;
  return `Automation "${result.name}" paused. Use mode "resume" to reactivate.`;
}

function handleResume(
  deps: AutomationToolDeps,
  input: ResumeInput,
  sessionId: string,
): string {
  const result = deps.automationManager.resume(input.id, sessionId);
  if (!result) return `Cannot resume "${input.id}": not found, not owned, or not paused.`;
  return `Automation "${result.name}" resumed. Next fire: ${result.nextFireAt ? new Date(result.nextFireAt).toLocaleString() : 'N/A'}`;
}

function formatAutomation(a: AutomationDefinition): string {
  const lines = [
    `[${a.status.toUpperCase()}] ${a.name} (${a.kind})`,
    `  ID: ${a.id}`,
    `  Schedule: ${describeSchedule(a.schedule)}`,
    `  Fires: ${a.fireCount}${a.maxFires ? `/${a.maxFires}` : ''}`,
  ];
  if (a.nextFireAt) lines.push(`  Next: ${new Date(a.nextFireAt).toLocaleString()}`);
  if (a.lastFireAt) lines.push(`  Last: ${new Date(a.lastFireAt).toLocaleString()}`);
  if (a.lastError) lines.push(`  Error: ${a.lastError}`);
  if (a.consecutiveFailures > 0) lines.push(`  Consecutive failures: ${a.consecutiveFailures}`);
  return lines.join('\n');
}

function describeSchedule(schedule: AutomationDefinition['schedule']): string {
  switch (schedule.type) {
    case 'cron': return `cron "${schedule.expression}"`;
    case 'interval': return `every ${schedule.seconds}s`;
    case 'once': return `once after ${schedule.delaySeconds}s`;
  }
}
