import type { ToolRecoveryMode } from '@maka/core';
import type { PreparedFileMutationFact } from './tool-recovery-facts.js';

export const TOOL_RECOVERY_CONTRACT_MODES = [
  'replay_safe_read',
  'reconcile_then_decide',
  'idempotent_with_runtime_key',
  'durable_handle',
  'manual_only',
] as const;

export type ToolRecoveryContractMode = (typeof TOOL_RECOVERY_CONTRACT_MODES)[number];

export interface UnsettledToolOperation {
  operationId?: string;
  toolCallId: string;
  toolName: string;
  args: unknown;
  recoveryMode?: ToolRecoveryMode;
  workspaceCwd?: string;
  preparedFileMutation?: PreparedFileMutationFact;
  evidenceEventIds: readonly string[];
}

export interface ToolReconcileDecision {
  result: 'applied' | 'not_applied' | 'conflict' | 'still_running' | 'unknown';
  reasonCode: string;
  nextAction: 'synthesize_response' | 'retry_allowed' | 'reattach' | 'park';
  synthesizedResult?: unknown;
}

export interface ToolRecoveryContract<TObservation = unknown> {
  id: string;
  version: number;
  mode: ToolRecoveryContractMode;
  observe?(operation: UnsettledToolOperation): Promise<TObservation>;
  decide?(input: {
    operation: UnsettledToolOperation;
    observation: TObservation;
  }): ToolReconcileDecision;
  /**
   * Restricted recovery path for contracts that must perform a checkpoint-
   * authorized action between observation and the final decision.
   */
  reconcile?(operation: UnsettledToolOperation): Promise<{
    observation: TObservation;
    decision: ToolReconcileDecision;
  }>;
}

export interface ToolRecoveryContractRegistration {
  toolName: string;
  contract: ToolRecoveryContract;
}

export type ToolRecoveryContractResolution =
  | { status: 'missing' }
  | { status: 'available'; contract: ToolRecoveryContract }
  | {
      status: 'incompatible';
      contract: ToolRecoveryContract;
      expectedRecoveryMode: ToolRecoveryMode;
      recordedRecoveryMode: ToolRecoveryMode;
    };

export class ToolRecoveryContractRegistry {
  private readonly contractsByToolName: ReadonlyMap<string, ToolRecoveryContract>;

  constructor(registrations: readonly ToolRecoveryContractRegistration[] = []) {
    const contracts = new Map<string, ToolRecoveryContract>();
    for (const { toolName, contract } of registrations) {
      if (
        toolName.trim().length === 0 ||
        contract.id.trim().length === 0 ||
        !Number.isSafeInteger(contract.version) ||
        contract.version < 1 ||
        !TOOL_RECOVERY_CONTRACT_MODES.includes(contract.mode)
      ) {
        throw new Error(`Invalid tool recovery contract registration: ${toolName || '<empty>'}`);
      }
      if (contracts.has(toolName)) {
        throw new Error(`Duplicate tool recovery contract registration: ${toolName}`);
      }
      contracts.set(toolName, Object.freeze({ ...contract }));
    }
    this.contractsByToolName = contracts;
  }

  resolve(
    toolName: string,
    recordedRecoveryMode: ToolRecoveryMode,
  ): ToolRecoveryContractResolution {
    // T1 currently persists recoveryMode, not contract id/version. A version
    // bump with the same mode is therefore accepted and must remain backward
    // compatible with unsettled operations. Persisted contract-version
    // binding is required before introducing an incompatible v2 contract.
    const contract = this.contractsByToolName.get(toolName);
    if (!contract) return { status: 'missing' };
    const expectedRecoveryMode = durableRecoveryModeForContract(contract.mode);
    if (expectedRecoveryMode !== recordedRecoveryMode) {
      return {
        status: 'incompatible',
        contract,
        expectedRecoveryMode,
        recordedRecoveryMode,
      };
    }
    return { status: 'available', contract };
  }
}

export function durableRecoveryModeForContract(mode: ToolRecoveryContractMode): ToolRecoveryMode {
  switch (mode) {
    case 'replay_safe_read':
      return 'replay_safe';
    case 'reconcile_then_decide':
      return 'reconcile';
    case 'idempotent_with_runtime_key':
      return 'idempotent';
    case 'durable_handle':
      return 'reattach';
    case 'manual_only':
      return 'never_auto_retry';
  }
}
