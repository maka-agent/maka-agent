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
import type { AutomationManager } from './automation-state.js';
import {
  createAutomationManagerToolService,
  type AutomationToolProjection,
  type AutomationToolService,
} from './automation-tool-service.js';

export const AUTOMATION_TOOL_NAME = 'Automation';

export interface AutomationToolDeps {
  automationManager: AutomationManager;
  onAutomationChange?: () => void;
  /** Whether the host can run cron (fresh-session) automations. When false, the
   *  cron kind is not advertised and is rejected at creation. */
  cronEnabled?: boolean;
}

export interface AutomationServiceToolDeps {
  automationService: AutomationToolService;
  /** Whether the host can run cron (fresh-session) automations. */
  cronEnabled?: boolean;
}

const scheduleSchema = z.union([
  z.object({
    type: z.literal('cron'),
    expression: z
      .string()
      .min(9)
      .max(100)
      .describe(
        '5-field cron expression: "minute hour day-of-month month day-of-week". Example: "*/5 * * * *" = every 5 min, "0 9 * * 1-5" = weekdays at 9am.',
      ),
  }),
  z.object({
    type: z.literal('interval'),
    seconds: z
      .number()
      .int()
      .min(10)
      .max(86400)
      .describe('Repeat interval in seconds (10s to 24h).'),
  }),
  z.object({
    type: z.literal('once'),
    delay_seconds: z
      .number()
      .int()
      .min(5)
      .max(86400)
      .describe('One-shot delay in seconds (5s to 24h). Fires once then auto-completes.'),
  }),
]);

// A SINGLE top-level object schema (Anthropic tool input_schema.type must be
// "object" — a discriminated union serializes as anyOf with no top-level type
// and the API rejects it). Per-mode fields are optional here and validated in
// impl(). mode selects the operation.
function makeAutomationSchema(kindSchema: z.ZodType) {
  return z.object({
    mode: z
      .enum(['create', 'delete', 'list', 'pause', 'resume'])
      .describe(
        "Operation: create a new automation, delete/pause/resume one by id, or list this session's automations.",
      ),
    kind: kindSchema.optional(),
    name: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .optional()
      .describe('[create] Short human-readable name.'),
    prompt: z
      .string()
      .trim()
      .min(1)
      .max(2000)
      .optional()
      .describe('[create] The prompt to execute on each fire.'),
    schedule: scheduleSchema
      .optional()
      .describe(
        '[create] When to fire. Use "interval" for simple repeats, "cron" for complex schedules, "once" for one-shot.',
      ),
    max_fires: z
      .number()
      .int()
      .min(1)
      .max(10000)
      .optional()
      .describe(
        '[create] Maximum fires before auto-completing. Omit for unlimited (7-day expiry still applies).',
      ),
    durable: z
      .boolean()
      .optional()
      .describe(
        '[create] When true, persists across app restarts. Cron defaults to true (standalone scheduled task); heartbeat defaults to false (bound to this session).',
      ),
    id: z.string().min(1).max(64).optional().describe('[delete/pause/resume] Automation id.'),
  });
}

const AUTOMATION_SCHEMA_WITH_CRON = makeAutomationSchema(
  z
    .enum(['heartbeat', 'cron'])
    .describe(
      '[create] heartbeat = resume into current session (polling/monitoring). cron = create fresh session each run (standalone scheduled tasks).',
    ),
);
const AUTOMATION_SCHEMA_HEARTBEAT_ONLY = makeAutomationSchema(
  z
    .enum(['heartbeat'])
    .describe(
      '[create] heartbeat = resume into current session. This host supports heartbeat only.',
    ),
);

// Type from the broadest (cron-enabled) schema so kind can be 'heartbeat'|'cron'.
type AutomationInput = z.infer<typeof AUTOMATION_SCHEMA_WITH_CRON>;

export function buildAutomationTool(deps: AutomationToolDeps): MakaTool<AutomationInput, string> {
  return buildAutomationToolFromService({
    automationService: createAutomationManagerToolService(deps),
    cronEnabled: deps.cronEnabled,
  });
}

export function buildAutomationToolFromService(
  deps: AutomationServiceToolDeps,
): MakaTool<AutomationInput, string> {
  const cronEnabled = deps.cronEnabled === true;
  return {
    name: AUTOMATION_TOOL_NAME,
    displayName: 'Automation',
    description:
      'Create, manage, and list recurring automations. ' +
      'Use kind "heartbeat" for session-internal polling (resumes into this conversation). ' +
      (cronEnabled
        ? 'Use kind "cron" for standalone scheduled tasks (creates a fresh session each run). '
        : '') +
      'Automations auto-expire after 7 days unless deleted earlier.',
    parameters: cronEnabled ? AUTOMATION_SCHEMA_WITH_CRON : AUTOMATION_SCHEMA_HEARTBEAT_ONLY,
    permissionRequired: false,
    impl: async (input, ctx) => {
      try {
        return await executeAutomationTool(
          deps.automationService,
          input,
          ctx.sessionId,
          cronEnabled,
        );
      } catch {
        return 'Error: Automation service request failed.';
      }
    },
  };
}

async function executeAutomationTool(
  service: AutomationToolService,
  input: AutomationInput,
  sessionId: string,
  cronEnabled: boolean,
): Promise<string> {
  const requester = { sessionId };
  switch (input.mode) {
    case 'create': {
      if (!input.kind) return 'Error: "kind" is required for create.';
      if (!input.name) return 'Error: "name" is required for create.';
      if (!input.prompt) return 'Error: "prompt" is required for create.';
      if (!input.schedule) return 'Error: "schedule" is required for create.';
      if (input.kind === 'cron' && !cronEnabled) {
        return 'Error: cron automations are not supported on this host. Use kind "heartbeat".';
      }
      const schedule =
        input.schedule.type === 'once'
          ? { type: 'once' as const, delaySeconds: input.schedule.delay_seconds }
          : input.schedule;
      const result = await service.create({
        requester,
        kind: input.kind as 'heartbeat' | 'cron',
        name: input.name,
        prompt: input.prompt,
        schedule,
        maxFires: input.max_fires,
        durable: input.durable,
      });
      return result.outcome === 'created'
        ? formatCreatedAutomation(result.automation)
        : `Error: ${result.error}`;
    }
    case 'delete': {
      if (!input.id) return 'Error: "id" is required for delete/pause/resume.';
      const result = await service.delete({ requester, id: input.id });
      return result.outcome === 'deleted'
        ? `Automation "${input.id}" deleted.`
        : `Automation "${input.id}" not found or not owned by this session.`;
    }
    case 'list': {
      const automations = await service.list({ requester });
      return automations.length === 0
        ? 'No automations for this session.'
        : automations.map(formatAutomation).join('\n---\n');
    }
    case 'pause': {
      if (!input.id) return 'Error: "id" is required for delete/pause/resume.';
      const result = await service.pause({ requester, id: input.id });
      return result.outcome === 'paused'
        ? `Automation "${result.automation.name}" paused. Use mode "resume" to reactivate.`
        : `Cannot pause "${input.id}": not found, not owned, or not active.`;
    }
    case 'resume': {
      if (!input.id) return 'Error: "id" is required for delete/pause/resume.';
      const result = await service.resume({ requester, id: input.id });
      if (result.outcome === 'resumed') {
        return `Automation "${result.automation.name}" resumed. Next fire: ${result.automation.nextFireAt ? new Date(result.automation.nextFireAt).toLocaleString() : 'N/A'}`;
      }
      if (result.outcome === 'fire_budget_exhausted') {
        const automation = result.automation;
        return `Cannot resume "${input.id}": its fire budget is exhausted (fired ${automation.fireCount}${automation.maxFires != null ? `/${automation.maxFires}` : ''} time(s)). Create a new automation instead.`;
      }
      return `Cannot resume "${input.id}": not found, not owned, or not paused.`;
    }
  }
}

function formatCreatedAutomation(automation: AutomationToolProjection): string {
  return [
    `Automation created: "${automation.name}" (${automation.kind}${automation.durable ? ', durable' : ''})`,
    `ID: ${automation.id}`,
    `Schedule: ${describeSchedule(automation.schedule)}`,
    `Next fire: ${automation.nextFireAt ? new Date(automation.nextFireAt).toLocaleString() : 'N/A'}`,
    automation.kind === 'heartbeat'
      ? 'Fires into this session. Stops when session ends or after 7 days.'
      : 'Creates a fresh session each run. Expires after 7 days.',
  ].join('\n');
}

function formatAutomation(a: AutomationToolProjection): string {
  // Fire attempts (fireCount) + idle-gate deferrals are model-facing
  // observability, mirroring the old CronList's fire_attempts/deferred_fires.
  const deferred = a.deferredFireCount;
  const lines = [
    `[${a.status.toUpperCase()}] ${a.name} (${a.kind}${a.durable ? ', durable' : ''})`,
    `  ID: ${a.id}`,
    `  Schedule: ${describeSchedule(a.schedule)}`,
    `  Fires: ${a.fireCount}${a.maxFires ? `/${a.maxFires}` : ''}${deferred > 0 ? ` (deferred ${deferred} attempt(s) while busy)` : ''}`,
  ];
  if (a.nextFireAt) lines.push(`  Next: ${new Date(a.nextFireAt).toLocaleString()}`);
  if (a.lastFireAt) lines.push(`  Last: ${new Date(a.lastFireAt).toLocaleString()}`);
  if (a.lastError) lines.push(`  Error: ${a.lastError}`);
  if (a.consecutiveFailures > 0) lines.push(`  Consecutive failures: ${a.consecutiveFailures}`);
  return lines.join('\n');
}

function describeSchedule(schedule: AutomationToolProjection['schedule']): string {
  switch (schedule.type) {
    case 'cron':
      return `cron "${schedule.expression}"`;
    case 'interval':
      return `every ${schedule.seconds}s`;
    case 'once':
      return `once after ${schedule.delaySeconds}s`;
  }
}
