import type { PreparedSkillInvocationMessage, SkillInvocationResult } from '@maka/runtime';

export type SessionSendSkillPlan<Resolved> =
  | {
      ok: false;
      reason: 'skill_invocation_failed';
      skillInvocation: SkillInvocationResult;
    }
  | {
      ok: true;
      preparation: Exclude<PreparedSkillInvocationMessage, { disposition: 'blocked' }>;
      resolved: Resolved;
    };

/**
 * Enforces the pre-attachment Skill gate. A blocked invocation never evaluates
 * `resolveSend`, so opaque approvals remain unconsumed and artifacts uncreated.
 */
export async function prepareSessionSendSkillPlan<Resolved>(input: {
  prepare(): Promise<PreparedSkillInvocationMessage>;
  resolveSend(): Promise<Resolved>;
}): Promise<SessionSendSkillPlan<Resolved>> {
  const preparation = await input.prepare();
  if (preparation.disposition === 'blocked') {
    return {
      ok: false,
      reason: 'skill_invocation_failed',
      skillInvocation: preparation.skillInvocation,
    };
  }
  return { ok: true, preparation, resolved: await input.resolveSend() };
}
