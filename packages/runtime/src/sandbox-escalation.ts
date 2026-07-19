import { isAbsolute } from 'node:path';

import type {
  PermissionMode,
  SandboxEscalationRiskSummary,
  ToolCategory,
} from '@maka/core/permission';

import { stableHash } from './request-shape.js';

export const MAX_SANDBOX_ESCALATION_JUSTIFICATION_CHARS = 500;
export const DEFAULT_SANDBOX_ESCALATION_GRANT_TTL_MS = 300_000;

export type SandboxEscalationErrorReason =
  | 'invalid_sandbox_escalation'
  | 'sandbox_escalation_disallowed_by_mode'
  | 'sandbox_escalation_denied'
  | 'sandbox_escalation_timeout'
  | 'sandbox_escalation_aborted'
  | 'sandbox_escalation_grant_expired'
  | 'sandbox_escalation_grant_consumed'
  | 'sandbox_escalation_intent_mismatch'
  | 'sandbox_escalation_command_mismatch'
  | 'sandbox_escalation_cwd_mismatch';

export class SandboxEscalationError extends Error {
  readonly code = 'SANDBOX_ESCALATION_FAILED';
  readonly domain = 'permission' as const;
  readonly stage: 'planning' | 'approval' | 'validation' | 'consume';
  readonly reason: SandboxEscalationErrorReason;
  readonly recoverable: boolean;

  constructor(input: {
    stage: SandboxEscalationError['stage'];
    reason: SandboxEscalationErrorReason;
    message?: string;
    recoverable?: boolean;
  }) {
    super(input.message ?? `Sandbox escalation failed: ${input.reason}.`);
    this.name = 'SandboxEscalationError';
    this.stage = input.stage;
    this.reason = input.reason;
    this.recoverable = input.recoverable ?? false;
  }
}

export interface SandboxEscalationProposal {
  readonly command: string;
  readonly cwd: string;
  readonly justification: string;
  readonly intentHash: string;
  readonly commandHash: string;
  readonly trigger: 'proactive' | 'sandbox_denial';
  readonly risk: SandboxEscalationRiskSummary;
}

export type SandboxEscalationPlanResult =
  | { kind: 'not_required' }
  | { kind: 'request'; proposal: SandboxEscalationProposal }
  | { kind: 'block'; reason: SandboxEscalationErrorReason; message: string };

export interface SandboxEscalationGrant {
  readonly grantId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly toolUseId: string;
  readonly toolName: 'Bash';
  readonly intentHash: string;
  readonly commandHash: string;
  readonly command: string;
  readonly cwd: string;
  readonly risk: SandboxEscalationRiskSummary;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface SandboxEscalationPlannerContext {
  readonly sessionId: string;
  readonly turnId: string;
  readonly toolUseId: string;
  readonly toolName: string;
  readonly category: ToolCategory;
  readonly cwd: string;
  readonly mode: PermissionMode;
  readonly args: unknown;
  readonly recentSandboxDenial?: boolean;
}

export function planDeclaredBashSandboxEscalation(input: {
  declaration: unknown;
  command: string;
  cwd: string;
  mode: PermissionMode;
  args: unknown;
  recentSandboxDenial?: boolean;
}): SandboxEscalationPlanResult {
  if (!isRecord(input.declaration) || input.declaration.mode !== 'require_escalated') {
    return { kind: 'not_required' };
  }
  if (hasUnexpectedKeys(input.declaration, ['mode', 'justification'])) {
    return blockInvalid('require_escalated contains unsupported fields.');
  }
  if (input.mode === 'explore') {
    return {
      kind: 'block',
      reason: 'sandbox_escalation_disallowed_by_mode',
      message: 'Sandbox escalation is not available in explore mode.',
    };
  }
  if (input.mode === 'bypass') return { kind: 'not_required' };
  const justification =
    typeof input.declaration.justification === 'string'
      ? input.declaration.justification.trim()
      : '';
  if (
    justification.length === 0 ||
    justification.length > MAX_SANDBOX_ESCALATION_JUSTIFICATION_CHARS
  ) {
    return blockInvalid('require_escalated requires a justification of at most 500 characters.');
  }
  if (input.command.length === 0 || !isAbsolute(input.cwd)) {
    return blockInvalid('require_escalated requires a non-empty command and canonical cwd.');
  }
  return {
    kind: 'request',
    proposal: freezeSandboxEscalationProposal({
      command: input.command,
      cwd: input.cwd,
      justification,
      intentHash: stableHash({ toolName: 'Bash', args: input.args }),
      commandHash: sandboxEscalationCommandHash(input.command, input.cwd),
      trigger: input.recentSandboxDenial ? 'sandbox_denial' : 'proactive',
      risk: Object.freeze({
        unsandboxedExecution: true,
        unrestrictedFileSystem: true,
        unrestrictedNetwork: true,
        protectedMetadataExposed: true,
      }),
    }),
  };
}

export function assertSandboxEscalationProposal(input: {
  proposal: SandboxEscalationProposal;
  toolName: string;
  args: unknown;
  cwd: string;
}): void {
  const { proposal } = input;
  if (
    input.toolName !== 'Bash' ||
    !isAbsolute(proposal.cwd) ||
    proposal.command.length === 0 ||
    proposal.cwd !== input.cwd ||
    proposal.intentHash !== stableHash({ toolName: input.toolName, args: input.args }) ||
    proposal.commandHash !== sandboxEscalationCommandHash(proposal.command, proposal.cwd) ||
    proposal.justification.trim().length === 0 ||
    proposal.justification.length > MAX_SANDBOX_ESCALATION_JUSTIFICATION_CHARS ||
    (proposal.trigger !== 'proactive' && proposal.trigger !== 'sandbox_denial')
  ) {
    throw invalidEscalation('Sandbox escalation proposal integrity validation failed.');
  }
}

export function freezeSandboxEscalationProposal(
  proposal: SandboxEscalationProposal,
): SandboxEscalationProposal {
  return Object.freeze({ ...proposal, risk: Object.freeze({ ...proposal.risk }) });
}

export function freezeSandboxEscalationGrant(
  grant: SandboxEscalationGrant,
): SandboxEscalationGrant {
  return Object.freeze({ ...grant, risk: Object.freeze({ ...grant.risk }) });
}

export function sandboxEscalationCommandHash(command: string, cwd: string): string {
  return stableHash({ command, cwd });
}

export function assertSandboxEscalationGrantForExecution(input: {
  grant: SandboxEscalationGrant;
  command: string;
  cwd: string;
}): void {
  if (
    input.grant.command !== input.command ||
    input.grant.cwd !== input.cwd ||
    input.grant.commandHash !== sandboxEscalationCommandHash(input.command, input.cwd)
  ) {
    throw new SandboxEscalationError({
      stage: 'consume',
      reason:
        input.grant.cwd !== input.cwd
          ? 'sandbox_escalation_cwd_mismatch'
          : 'sandbox_escalation_command_mismatch',
      message: 'Sandbox escalation grant does not match the command being executed.',
    });
  }
}

function invalidEscalation(message: string): SandboxEscalationError {
  return new SandboxEscalationError({
    stage: 'validation',
    reason: 'invalid_sandbox_escalation',
    message,
  });
}

function blockInvalid(message: string): SandboxEscalationPlanResult {
  return { kind: 'block', reason: 'invalid_sandbox_escalation', message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasUnexpectedKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const allowed = new Set(expected);
  return Object.keys(value).some((key) => !allowed.has(key));
}
