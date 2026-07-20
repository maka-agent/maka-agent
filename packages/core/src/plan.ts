export const PLAN_PROPOSAL_STATUSES = ['pending_approval', 'stale', 'approved'] as const;
export type PlanProposalStatus = (typeof PLAN_PROPOSAL_STATUSES)[number];

export const PLAN_EXECUTION_STATUSES = ['active', 'completed', 'cancelled', 'interrupted'] as const;
export type PlanExecutionStatus = (typeof PLAN_EXECUTION_STATUSES)[number];

export const PLAN_STEP_STATUSES = ['pending', 'in_progress', 'completed', 'skipped'] as const;
export type PlanStepStatus = (typeof PLAN_STEP_STATUSES)[number];

export interface PlanStepDefinition {
  id: string;
  description: string;
  files?: string[];
  complexity?: 'low' | 'medium' | 'high';
}

export interface PlanProposal {
  planId: string;
  proposalId: string;
  sessionId: string;
  turnId: string;
  revision: number;
  supersedesProposalId?: string;
  title: string;
  overview?: string;
  steps: PlanStepDefinition[];
  risks?: string[];
  status: PlanProposalStatus;
  submittedAt: number;
}

export interface PlanExecutionStep extends PlanStepDefinition {
  status: PlanStepStatus;
  note?: string;
  updatedAt: number;
}

export interface PlanExecution {
  executionId: string;
  planId: string;
  proposalId: string;
  sessionId: string;
  status: PlanExecutionStatus;
  steps: PlanExecutionStep[];
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  cancelledAt?: number;
  interruptedAt?: number;
  cancelReason?: string;
  interruptionReason?: string;
}

export interface PlanSessionState {
  schemaVersion: 1;
  sessionId: string;
  storeVersion: number;
  proposals: PlanProposal[];
  executions: PlanExecution[];
  latestProposalId?: string;
  activeExecutionId?: string;
}

interface PlanEventBase {
  id: string;
  sessionId: string;
  ts: number;
  storeVersion: number;
}

export type PlanEvent =
  | (PlanEventBase & {
      type: 'plan_submitted';
      proposal: PlanProposal;
    })
  | (PlanEventBase & {
      type: 'plan_revision_requested';
      proposalId: string;
    })
  | (PlanEventBase & {
      type: 'plan_approved';
      proposalId: string;
      execution: PlanExecution;
    })
  | (PlanEventBase & {
      type: 'plan_progress_updated';
      executionId: string;
      steps: PlanExecutionStep[];
      explanation?: string;
    })
  | (PlanEventBase & {
      type: 'plan_execution_completed';
      executionId: string;
      steps: PlanExecutionStep[];
    })
  | (PlanEventBase & {
      type: 'plan_execution_cancelled';
      executionId: string;
      reason: string;
    })
  | (PlanEventBase & {
      type: 'plan_execution_interrupted';
      executionId: string;
      reason: string;
    })
  | (PlanEventBase & {
      type: 'plan_execution_resumed';
      executionId: string;
    });

export interface SubmitPlanProposalInput {
  sessionId: string;
  turnId: string;
  title: string;
  overview?: string;
  steps: PlanStepDefinition[];
  risks?: string[];
}

export interface ApprovePlanProposalInput {
  sessionId: string;
  proposalId: string;
  expectedRevision: number;
  expectedStoreVersion?: number;
}

export interface RequestPlanRevisionInput {
  sessionId: string;
  proposalId: string;
}

export interface UpdatePlanExecutionInput {
  sessionId: string;
  executionId: string;
  steps: Array<{
    id: string;
    status: PlanStepStatus;
    note?: string;
  }>;
  explanation?: string;
}

export interface CancelPlanExecutionInput {
  sessionId: string;
  executionId: string;
  reason: string;
}

export interface PlanMutationResult {
  event: PlanEvent;
  state: PlanSessionState;
}

export interface PlanStore {
  readState(sessionId: string): Promise<PlanSessionState>;
  submitProposal(input: SubmitPlanProposalInput): Promise<PlanMutationResult>;
  requestRevision(input: RequestPlanRevisionInput): Promise<PlanMutationResult>;
  approveProposal(input: ApprovePlanProposalInput): Promise<PlanMutationResult>;
  updateExecution(input: UpdatePlanExecutionInput): Promise<PlanMutationResult>;
  cancelExecution(input: CancelPlanExecutionInput): Promise<PlanMutationResult>;
  interruptActiveExecution(sessionId: string, reason: string): Promise<PlanMutationResult | null>;
  resumeExecution(sessionId: string, executionId: string): Promise<PlanMutationResult>;
}

export class PlanConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanConflictError';
  }
}

export function emptyPlanSessionState(sessionId: string): PlanSessionState {
  return {
    schemaVersion: 1,
    sessionId,
    storeVersion: 0,
    proposals: [],
    executions: [],
  };
}

export function activePlanExecution(state: PlanSessionState): PlanExecution | undefined {
  if (!state.activeExecutionId) return undefined;
  return state.executions.find((execution) => execution.executionId === state.activeExecutionId);
}

export function latestPlanProposal(state: PlanSessionState): PlanProposal | undefined {
  if (!state.latestProposalId) return undefined;
  return state.proposals.find((proposal) => proposal.proposalId === state.latestProposalId);
}
