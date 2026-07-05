/**
 * Agent-facing cron tools aligned with Claude Code's CronCreate/CronDelete/CronList.
 *
 * CronCreate schedules a prompt to fire at a future time — either recurring
 * (cron expression) or one-shot. Session-only by default (v1: no durable mode).
 */
import { z } from 'zod';
import type { MakaTool } from './tool-runtime.js';
import type { WakeupScheduler } from './wakeup-scheduler.js';

export const CRON_CREATE_TOOL_NAME = 'CronCreate';
export const CRON_DELETE_TOOL_NAME = 'CronDelete';
export const CRON_LIST_TOOL_NAME = 'CronList';

export function buildCronCreateTool(scheduler: WakeupScheduler): MakaTool<
  { delay_seconds?: number; cron?: string; prompt: string; reason: string; recurring?: boolean },
  unknown
> {
  return {
    name: CRON_CREATE_TOOL_NAME,
    displayName: '定时任务',
    description:
      'Schedule a prompt to run at a future time within this session. ' +
      'When the timer fires, the prompt is injected as a new turn and the agent continues working. ' +
      'Use for polling, monitoring, periodic checks, or delayed actions. ' +
      'Provide either delay_seconds (one-shot/fixed-interval) or cron (5-field cron expression). ' +
      'Uses standard 5-field cron in the user\'s local timezone. ' +
      'Jobs are session-only (in-memory, gone when the session ends). ' +
      'Max 5 pending jobs per session, delay 1-86400 seconds.',
    parameters: z.object({
      delay_seconds: z.number().int().min(1).max(86400).optional()
        .describe('Seconds from now to fire. Min 1, max 86400 (24h). Either this or cron must be provided.'),
      cron: z.string().max(100).optional()
        .describe('Standard 5-field cron expression (minute hour day-of-month month day-of-week). Uses the user\'s local timezone. Either this or delay_seconds must be provided.'),
      prompt: z.string().min(1).max(10000)
        .describe('The prompt/instruction to execute when the timer fires.'),
      reason: z.string().min(1).max(200)
        .describe('One short sentence explaining the chosen schedule. Shown to the user.'),
      recurring: z.boolean().optional()
        .describe('If true, re-schedule the same job after each fire. Default false (one-shot).'),
    }).refine(
      data => data.delay_seconds !== undefined || (data.cron !== undefined && data.cron.length > 0),
      { message: 'Either delay_seconds or cron must be provided.' },
    ),
    categoryHint: 'custom_tool',
    impl: async (input, ctx) => {
      try {
        const record = scheduler.schedule(ctx.sessionId, {
          delaySeconds: input.delay_seconds,
          cronExpression: input.cron,
          message: input.prompt,
          reason: input.reason,
          recurring: input.recurring,
        });
        return {
          ok: true,
          job_id: record.id,
          fires_at: record.firesAt,
          fires_in_seconds: record.delaySeconds,
          recurring: input.recurring ?? false,
          cron: input.cron ?? null,
        };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

export function buildCronDeleteTool(scheduler: WakeupScheduler): MakaTool<{ job_id: string }, unknown> {
  return {
    name: CRON_DELETE_TOOL_NAME,
    displayName: '取消定时任务',
    description: 'Cancel a scheduled cron job by its ID. Use CronList to find job IDs.',
    parameters: z.object({
      job_id: z.string().min(1).describe('The job_id returned by CronCreate.'),
    }),
    categoryHint: 'custom_tool',
    impl: async ({ job_id }) => {
      const cancelled = scheduler.cancel(job_id);
      return { ok: true, cancelled };
    },
  };
}

export function buildCronListTool(scheduler: WakeupScheduler): MakaTool<Record<string, never>, unknown> {
  return {
    name: CRON_LIST_TOOL_NAME,
    displayName: '列出定时任务',
    description: 'List all active (pending) cron jobs in this session.',
    parameters: z.object({}),
    categoryHint: 'custom_tool',
    impl: async (_input, ctx) => {
      const records = scheduler.listForSession(ctx.sessionId, { activeOnly: true });
      return {
        ok: true,
        count: records.length,
        jobs: records.map(r => ({
          job_id: r.id,
          status: r.status,
          prompt: r.message.slice(0, 100),
          reason: r.reason,
          fires_at: r.firesAt,
          recurring: r.recurring ?? false,
          cron: r.cronExpression ?? null,
          fire_attempts: r.fireAttempts,
        })),
      };
    },
  };
}

export function buildCronTools(scheduler: WakeupScheduler): MakaTool[] {
  return [
    buildCronCreateTool(scheduler),
    buildCronDeleteTool(scheduler),
    buildCronListTool(scheduler),
  ] as MakaTool[];
}
