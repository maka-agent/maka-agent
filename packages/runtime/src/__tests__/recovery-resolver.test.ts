import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import { resolveRuntimeRecovery } from '../recovery-resolver.js';
import { ToolRecoveryContractRegistry } from '../tool-recovery-contract.js';

describe('RecoveryResolver', () => {
  it('proves a new-protocol call without dispatch was never dispatched', () => {
    const resolution = resolveRuntimeRecovery([
      initialEvent('t1_after_preflight_v1'),
      functionCallEvent(),
    ]);

    assert.deepEqual(resolution.decisions, [
      {
        toolCallId: 'call-1',
        toolName: 'Bash',
        disposition: 'definitely_not_dispatched',
        reasonCode: 'new_protocol_before_dispatch',
        callRuntimeEventId: 'function-call-1',
        automaticActionAllowed: true,
        evidenceEventIds: ['function-call-1'],
      },
    ]);
    assert.equal(resolution.hasCorruption, false);
    assert.equal(resolution.requiresReconciliation, false);
  });

  it('parks a dispatched operation when the current runtime has no recovery contract', () => {
    const resolution = resolveRuntimeRecovery([
      initialEvent('t1_after_preflight_v1'),
      functionCallEvent(),
      toolDispatchEvent(),
    ]);

    assert.deepEqual(resolution.decisions, [
      {
        toolCallId: 'call-1',
        toolName: 'Bash',
        operationId: 'operation-1',
        disposition: 'parked',
        reasonCode: 'recovery_contract_unavailable',
        callRuntimeEventId: 'function-call-1',
        dispatchRuntimeEventId: 'dispatch-1',
        automaticActionAllowed: false,
        evidenceEventIds: ['function-call-1', 'dispatch-1'],
      },
    ]);
    assert.equal(resolution.hasCorruption, false);
    assert.equal(resolution.requiresReconciliation, false);
  });

  it('parks a dispatched manual-only operation without authorizing an automatic action', () => {
    const contracts = new ToolRecoveryContractRegistry([
      {
        toolName: 'Bash',
        contract: {
          id: 'maka.tool.bash.manual',
          version: 1,
          mode: 'manual_only',
        },
      },
    ]);
    const resolution = resolveRuntimeRecovery(
      [initialEvent('t1_after_preflight_v1'), functionCallEvent(), toolDispatchEvent()],
      { contracts },
    );

    assert.equal(resolution.decisions[0]?.disposition, 'parked');
    assert.equal(resolution.decisions[0]?.reasonCode, 'manual_recovery_required');
    assert.equal(resolution.decisions[0]?.recoveryContractId, 'maka.tool.bash.manual@1');
    assert.equal(resolution.decisions[0]?.automaticActionAllowed, false);
    assert.equal(resolution.requiresReconciliation, false);
  });

  it('requires reconciliation when a matching non-manual contract is available', () => {
    const contracts = new ToolRecoveryContractRegistry([
      {
        toolName: 'Bash',
        contract: {
          id: 'maka.tool.bash.status',
          version: 2,
          mode: 'reconcile_then_decide',
        },
      },
    ]);
    const dispatch = toolDispatchEvent({ recoveryMode: 'reconcile' });

    const resolution = resolveRuntimeRecovery(
      [initialEvent('t1_after_preflight_v1'), functionCallEvent(), dispatch],
      { contracts },
    );

    assert.equal(resolution.decisions[0]?.disposition, 'reconcile_required');
    assert.equal(resolution.decisions[0]?.reasonCode, 'recovery_contract_available');
    assert.equal(resolution.decisions[0]?.recoveryContractId, 'maka.tool.bash.status@2');
    assert.equal(resolution.decisions[0]?.automaticActionAllowed, true);
    assert.equal(resolution.requiresReconciliation, true);
  });

  it('associates one prepared file checkpoint with its dispatched operation', () => {
    const contracts = new ToolRecoveryContractRegistry([
      {
        toolName: 'Write',
        contract: {
          id: 'maka.tool.write.prepared-file',
          version: 1,
          mode: 'reconcile_then_decide',
        },
      },
    ]);
    const call = functionCallEvent();
    call.content = {
      kind: 'function_call',
      id: 'call-1',
      name: 'Write',
      args: { path: 'notes.txt', content: 'expected' },
    };
    call.refs = { operationId: 'operation-1', toolCallId: 'call-1' };
    const resolution = resolveRuntimeRecovery(
      [
        initialEvent('t1_after_preflight_v1'),
        call,
        preparedMutationEvent(),
        toolDispatchEvent({ toolName: 'Write', recoveryMode: 'reconcile' }),
      ],
      { contracts },
    );

    assert.equal(resolution.hasCorruption, false);
    assert.equal(resolution.decisions[0]?.preparedFileMutation?.operationId, 'operation-1');
    assert.deepEqual(resolution.decisions[0]?.evidenceEventIds, [
      'function-call-1',
      'dispatch-1',
      'prepared-file-1',
    ]);
  });

  it('treats duplicate prepared checkpoints for one operation as corruption', () => {
    const resolution = resolveRuntimeRecovery([
      initialEvent('t1_after_preflight_v1'),
      functionCallEvent(),
      preparedMutationEvent(),
      { ...preparedMutationEvent(), id: 'prepared-file-2' },
      toolDispatchEvent(),
    ]);

    assert.equal(resolution.hasCorruption, true);
    assert.deepEqual(resolution.issues, [
      {
        code: 'recovery_fact_corruption',
        eventId: 'prepared-file-2',
        reason: 'duplicate_prepared_mutation',
      },
    ]);
  });

  it('returns the same decision and evidence for the same canonical facts', () => {
    const contracts = new ToolRecoveryContractRegistry([
      {
        toolName: 'Write',
        contract: {
          id: 'maka.tool.write.reconcile',
          version: 1,
          mode: 'reconcile_then_decide',
        },
      },
    ]);
    const events = [
      initialEvent('t1_after_preflight_v1'),
      functionCallEvent(),
      toolDispatchEvent({ toolName: 'Write', recoveryMode: 'reconcile' }),
    ];

    const first = resolveRuntimeRecovery(events, { contracts });
    const second = resolveRuntimeRecovery(events, { contracts });

    assert.deepEqual(second, first);
    assert.deepEqual(first.decisions[0]?.evidenceEventIds, ['function-call-1', 'dispatch-1']);
  });

  it('parks when the registered contract conflicts with the durable recovery mode', () => {
    const contracts = new ToolRecoveryContractRegistry([
      {
        toolName: 'Bash',
        contract: {
          id: 'maka.tool.bash.status',
          version: 1,
          mode: 'reconcile_then_decide',
        },
      },
    ]);
    const resolution = resolveRuntimeRecovery(
      [initialEvent('t1_after_preflight_v1'), functionCallEvent(), toolDispatchEvent()],
      { contracts },
    );

    assert.equal(resolution.decisions[0]?.disposition, 'parked');
    assert.equal(resolution.decisions[0]?.reasonCode, 'recovery_contract_mismatch');
    assert.equal(resolution.decisions[0]?.recoveryContractId, 'maka.tool.bash.status@1');
    assert.equal(resolution.decisions[0]?.automaticActionAllowed, false);
    assert.equal(resolution.requiresReconciliation, false);
  });

  it('treats a matching response without dispatch as a completed pre-T1 result', () => {
    const resolution = resolveRuntimeRecovery([
      initialEvent('t1_after_preflight_v1'),
      functionCallEvent(),
      functionResponseEvent(true),
    ]);

    assert.deepEqual(resolution.decisions, [
      {
        toolCallId: 'call-1',
        toolName: 'Bash',
        disposition: 'completed',
        reasonCode: 'matching_response',
        callRuntimeEventId: 'function-call-1',
        responseRuntimeEventId: 'function-response-1',
        responseIsError: true,
        automaticActionAllowed: true,
        evidenceEventIds: ['function-call-1', 'function-response-1'],
      },
    ]);
    assert.equal(resolution.requiresReconciliation, false);
  });

  it('classifies a dispatch without its canonical function call as corruption', () => {
    const resolution = resolveRuntimeRecovery([
      initialEvent('t1_after_preflight_v1'),
      toolDispatchEvent(),
    ]);

    assert.deepEqual(resolution.decisions, [
      {
        toolCallId: 'call-1',
        toolName: 'Bash',
        operationId: 'operation-1',
        disposition: 'corruption',
        reasonCode: 'orphan_dispatch',
        dispatchRuntimeEventId: 'dispatch-1',
        automaticActionAllowed: false,
        evidenceEventIds: ['dispatch-1'],
      },
    ]);
    assert.equal(resolution.hasCorruption, true);
    assert.equal(resolution.requiresReconciliation, false);
  });

  it('classifies repeated canonical function calls for one provider id as corruption', () => {
    const resolution = resolveRuntimeRecovery([
      initialEvent('t1_after_preflight_v1'),
      functionCallEvent(),
      { ...functionCallEvent(), id: 'function-call-2' },
    ]);

    assert.equal(resolution.decisions.length, 1);
    assert.equal(resolution.decisions[0]?.disposition, 'corruption');
    assert.equal(resolution.decisions[0]?.reasonCode, 'duplicate_call');
    assert.equal(resolution.hasCorruption, true);
  });

  it('keeps corruption sticky across dispatch and later recovery facts', () => {
    const contracts = new ToolRecoveryContractRegistry([
      {
        toolName: 'Bash',
        contract: {
          id: 'maka.tool.bash.status',
          version: 1,
          mode: 'reconcile_then_decide',
        },
      },
    ]);
    const resolution = resolveRuntimeRecovery(
      [
        initialEvent('t1_after_preflight_v1'),
        functionCallEvent(),
        { ...functionCallEvent(), id: 'function-call-2' },
        toolDispatchEvent({ recoveryMode: 'reconcile' }),
        event({
          id: 'reconcile-result-1',
          actions: {
            runtimeFact: {
              kind: 'maka.tool.reconcile_result',
              version: 1,
              legacyProjection: 'invisible',
              payload: {
                protocol: 'tool_reconcile_v1',
                operationId: 'operation-1',
                result: 'applied',
                observationDigest: 'sha256:observation-1',
                observedAt: '2026-07-21T00:00:00.000Z',
                nextAction: 'synthesize_response',
              },
            },
          },
          refs: { operationId: 'operation-1', toolCallId: 'call-1' },
        }),
        event({
          id: 'recovery-decision-1',
          actions: {
            runtimeFact: {
              kind: 'maka.tool.recovery_decision',
              version: 1,
              legacyProjection: 'invisible',
              payload: {
                protocol: 'tool_recovery_v1',
                operationId: 'operation-1',
                disposition: 'completed',
                reasonCode: 'reconcile_applied',
                evidenceEventIds: ['function-call-1', 'dispatch-1', 'reconcile-result-1'],
              },
            },
          },
          refs: { operationId: 'operation-1', toolCallId: 'call-1' },
        }),
      ],
      { contracts },
    );

    assert.equal(resolution.decisions[0]?.disposition, 'corruption');
    assert.equal(resolution.decisions[0]?.reasonCode, 'duplicate_call');
    assert.equal(resolution.decisions[0]?.automaticActionAllowed, false);
    assert.equal(resolution.hasCorruption, true);
    assert.equal(resolution.requiresReconciliation, false);
    assert.deepEqual(resolution.decisions[0]?.evidenceEventIds, [
      'function-call-1',
      'function-call-2',
      'dispatch-1',
      'reconcile-result-1',
      'recovery-decision-1',
    ]);
  });

  it('classifies a canonical call whose reference names another provider call as corruption', () => {
    const call = functionCallEvent();
    call.refs = { toolCallId: 'different-call' };

    const resolution = resolveRuntimeRecovery([initialEvent('t1_after_preflight_v1'), call]);

    assert.equal(resolution.decisions[0]?.disposition, 'corruption');
    assert.equal(resolution.decisions[0]?.reasonCode, 'identity_conflict');
    assert.equal(resolution.decisions[0]?.automaticActionAllowed, false);
    assert.equal(resolution.hasCorruption, true);
  });

  it('classifies one operation id claimed by different canonical calls as corruption', () => {
    const first = functionCallEvent();
    first.refs = { operationId: 'operation-1', toolCallId: 'call-1' };
    const second = functionCallEvent('call-2', 'function-call-2');
    second.refs = { operationId: 'operation-1', toolCallId: 'call-2' };

    const resolution = resolveRuntimeRecovery([
      initialEvent('t1_after_preflight_v1'),
      first,
      second,
    ]);

    assert.deepEqual(
      resolution.decisions.map(({ toolCallId, disposition, reasonCode }) => ({
        toolCallId,
        disposition,
        reasonCode,
      })),
      [
        { toolCallId: 'call-1', disposition: 'corruption', reasonCode: 'duplicate_operation_id' },
        { toolCallId: 'call-2', disposition: 'corruption', reasonCode: 'duplicate_operation_id' },
      ],
    );
  });

  it('classifies a response without its canonical function call as corruption', () => {
    const resolution = resolveRuntimeRecovery([
      initialEvent('t1_after_preflight_v1'),
      functionResponseEvent(),
    ]);

    assert.deepEqual(resolution.decisions, [
      {
        toolCallId: 'call-1',
        toolName: 'Bash',
        disposition: 'corruption',
        reasonCode: 'orphan_response',
        responseRuntimeEventId: 'function-response-1',
        responseIsError: false,
        automaticActionAllowed: false,
        evidenceEventIds: ['function-response-1'],
      },
    ]);
    assert.equal(resolution.hasCorruption, true);
  });

  it('classifies dispatch identity drift as corruption', () => {
    const resolution = resolveRuntimeRecovery([
      initialEvent('t1_after_preflight_v1'),
      functionCallEvent(),
      toolDispatchEvent({ toolName: 'Write' }),
    ]);

    assert.deepEqual(resolution.decisions, [
      {
        toolCallId: 'call-1',
        toolName: 'Bash',
        operationId: 'operation-1',
        disposition: 'corruption',
        reasonCode: 'identity_conflict',
        callRuntimeEventId: 'function-call-1',
        dispatchRuntimeEventId: 'dispatch-1',
        automaticActionAllowed: false,
        evidenceEventIds: ['function-call-1', 'dispatch-1'],
      },
    ]);
    assert.equal(resolution.hasCorruption, true);
  });

  it('classifies a dispatch operation that conflicts with the canonical call ref as corruption', () => {
    const call = functionCallEvent();
    call.refs = { operationId: 'operation-from-call', toolCallId: 'call-1' };
    const resolution = resolveRuntimeRecovery([
      initialEvent('t1_after_preflight_v1'),
      call,
      toolDispatchEvent(),
    ]);

    assert.equal(resolution.decisions[0]?.disposition, 'corruption');
    assert.equal(resolution.decisions[0]?.reasonCode, 'identity_conflict');
    assert.equal(resolution.hasCorruption, true);
  });

  it('classifies repeated dispatch for one operation as corruption', () => {
    const resolution = resolveRuntimeRecovery([
      initialEvent('t1_after_preflight_v1'),
      functionCallEvent(),
      toolDispatchEvent(),
      { ...toolDispatchEvent(), id: 'dispatch-2' },
    ]);

    assert.deepEqual(resolution.decisions, [
      {
        toolCallId: 'call-1',
        toolName: 'Bash',
        operationId: 'operation-1',
        disposition: 'corruption',
        reasonCode: 'duplicate_dispatch',
        callRuntimeEventId: 'function-call-1',
        dispatchRuntimeEventId: 'dispatch-1',
        automaticActionAllowed: false,
        evidenceEventIds: ['function-call-1', 'dispatch-1', 'dispatch-2'],
      },
    ]);
    assert.equal(resolution.hasCorruption, true);
    assert.equal(resolution.requiresReconciliation, false);
  });

  it('classifies one operation id dispatched for different tool calls as corruption', () => {
    const resolution = resolveRuntimeRecovery([
      initialEvent('t1_after_preflight_v1'),
      functionCallEvent(),
      functionCallEvent('call-2', 'function-call-2'),
      toolDispatchEvent(),
      toolDispatchEvent({
        id: 'dispatch-2',
        providerToolCallId: 'call-2',
        operationId: 'operation-1',
      }),
    ]);

    assert.deepEqual(
      resolution.decisions.map(({ toolCallId, disposition, reasonCode }) => ({
        toolCallId,
        disposition,
        reasonCode,
      })),
      [
        { toolCallId: 'call-1', disposition: 'corruption', reasonCode: 'duplicate_operation_id' },
        { toolCallId: 'call-2', disposition: 'corruption', reasonCode: 'duplicate_operation_id' },
      ],
    );
    assert.equal(resolution.hasCorruption, true);
  });

  it('classifies repeated response for one operation as corruption', () => {
    const resolution = resolveRuntimeRecovery([
      initialEvent('t1_after_preflight_v1'),
      functionCallEvent(),
      toolDispatchEvent(),
      functionResponseEvent(false, 'operation-1'),
      { ...functionResponseEvent(false, 'operation-1'), id: 'function-response-2' },
    ]);

    assert.deepEqual(resolution.decisions, [
      {
        toolCallId: 'call-1',
        toolName: 'Bash',
        operationId: 'operation-1',
        disposition: 'corruption',
        reasonCode: 'duplicate_response',
        callRuntimeEventId: 'function-call-1',
        dispatchRuntimeEventId: 'dispatch-1',
        responseRuntimeEventId: 'function-response-1',
        responseIsError: false,
        automaticActionAllowed: false,
        evidenceEventIds: [
          'function-call-1',
          'dispatch-1',
          'function-response-1',
          'function-response-2',
        ],
      },
    ]);
    assert.equal(resolution.hasCorruption, true);
    assert.equal(resolution.requiresReconciliation, false);
  });

  it('rejects a protocol marker added after the first canonical event', () => {
    const resolution = resolveRuntimeRecovery([
      initialEvent(),
      event({
        id: 'late-marker',
        actions: { runtimeProtocol: { toolBoundary: 't1_after_preflight_v1' } },
      }),
    ]);

    assert.deepEqual(resolution.issues, [
      {
        code: 'protocol_marker_invalid',
        eventId: 'late-marker',
      },
    ]);
    assert.equal(resolution.toolBoundaryProtocol, undefined);
    assert.equal(resolution.hasCorruption, true);
  });

  it('evaluates the protocol marker against the first non-partial canonical event', () => {
    const partial = event({
      id: 'stream-partial',
      partial: true,
      role: 'model',
      author: 'agent',
      content: { kind: 'text', text: 'streaming' },
    });
    const resolution = resolveRuntimeRecovery([
      partial,
      initialEvent('t1_after_preflight_v1'),
      functionCallEvent(),
    ]);

    assert.equal(resolution.toolBoundaryProtocol, 't1_after_preflight_v1');
    assert.deepEqual(resolution.issues, []);
    assert.equal(resolution.decisions[0]?.disposition, 'definitely_not_dispatched');
  });

  it('reports an unknown runtime fact as unsupported without calling the ledger corrupt', () => {
    const resolution = resolveRuntimeRecovery([
      initialEvent('t1_after_preflight_v1'),
      event({
        id: 'future-runtime-fact',
        actions: {
          runtimeFact: {
            kind: 'maka.test.future_fact',
            version: 7,
            legacyProjection: 'invisible',
            payload: { checkpointId: 'checkpoint-1' },
          },
        },
      }),
    ]);

    assert.deepEqual(resolution.issues, [
      {
        code: 'runtime_fact_unsupported',
        eventId: 'future-runtime-fact',
        kind: 'maka.test.future_fact',
        version: 7,
      },
    ]);
    assert.equal(resolution.hasUnsupportedFacts, true);
    assert.equal(resolution.hasCorruption, false);
  });

  it('uses a canonical recovery decision fact instead of treating it as unsupported', () => {
    const resolution = resolveRuntimeRecovery([
      initialEvent('t1_after_preflight_v1'),
      functionCallEvent(),
      toolDispatchEvent(),
      event({
        id: 'recovery-decision-1',
        actions: {
          runtimeFact: {
            kind: 'maka.tool.recovery_decision',
            version: 1,
            legacyProjection: 'invisible',
            payload: {
              protocol: 'tool_recovery_v1',
              operationId: 'operation-1',
              disposition: 'parked',
              reasonCode: 'manual_recovery_required',
              evidenceEventIds: ['function-call-1', 'dispatch-1'],
              recoveryContractId: 'maka.tool.bash.manual@1',
            },
          },
        },
      }),
    ]);

    assert.deepEqual(resolution.issues, []);
    assert.equal(resolution.decisions[0]?.disposition, 'parked');
    assert.equal(resolution.decisions[0]?.reasonCode, 'manual_recovery_required');
    assert.equal(resolution.decisions[0]?.recoveryContractId, 'maka.tool.bash.manual@1');
    assert.deepEqual(resolution.decisions[0]?.evidenceEventIds, [
      'function-call-1',
      'dispatch-1',
      'recovery-decision-1',
    ]);
  });

  it('uses a canonical reconcile result to select the next restricted recovery action', () => {
    const resolution = resolveRuntimeRecovery([
      initialEvent('t1_after_preflight_v1'),
      functionCallEvent(),
      toolDispatchEvent({ recoveryMode: 'reconcile' }),
      event({
        id: 'reconcile-result-1',
        actions: {
          runtimeFact: {
            kind: 'maka.tool.reconcile_result',
            version: 1,
            legacyProjection: 'invisible',
            payload: {
              protocol: 'tool_reconcile_v1',
              operationId: 'operation-1',
              result: 'applied',
              observationDigest: 'sha256:observation-1',
              observedAt: '2026-07-21T00:00:00.000Z',
              nextAction: 'synthesize_response',
            },
          },
        },
      }),
    ]);

    assert.deepEqual(resolution.issues, []);
    assert.equal(resolution.decisions[0]?.disposition, 'reconcile_required');
    assert.equal(resolution.decisions[0]?.reasonCode, 'reconcile_applied');
    assert.equal(resolution.decisions[0]?.automaticActionAllowed, true);
    assert.deepEqual(resolution.decisions[0]?.evidenceEventIds, [
      'function-call-1',
      'dispatch-1',
      'reconcile-result-1',
    ]);
  });

  it('parks a canonical reconcile conflict', () => {
    const resolution = resolveRuntimeRecovery([
      initialEvent('t1_after_preflight_v1'),
      functionCallEvent(),
      toolDispatchEvent({ recoveryMode: 'reconcile' }),
      event({
        id: 'reconcile-result-1',
        actions: {
          runtimeFact: {
            kind: 'maka.tool.reconcile_result',
            version: 1,
            legacyProjection: 'invisible',
            payload: {
              protocol: 'tool_reconcile_v1',
              operationId: 'operation-1',
              result: 'conflict',
              observationDigest: 'sha256:observation-1',
              observedAt: '2026-07-21T00:00:00.000Z',
              nextAction: 'park',
            },
          },
        },
      }),
    ]);

    assert.equal(resolution.decisions[0]?.disposition, 'parked');
    assert.equal(resolution.decisions[0]?.reasonCode, 'reconcile_conflict');
    assert.equal(resolution.decisions[0]?.automaticActionAllowed, false);
  });

  it('rejects a reconcile result whose result and next action are inconsistent', () => {
    const resolution = resolveRuntimeRecovery([
      initialEvent('t1_after_preflight_v1'),
      functionCallEvent(),
      toolDispatchEvent({ recoveryMode: 'reconcile' }),
      event({
        id: 'reconcile-result-1',
        actions: {
          runtimeFact: {
            kind: 'maka.tool.reconcile_result',
            version: 1,
            legacyProjection: 'invisible',
            payload: {
              protocol: 'tool_reconcile_v1',
              operationId: 'operation-1',
              result: 'conflict',
              observationDigest: 'sha256:observation-1',
              observedAt: '2026-07-21T00:00:00.000Z',
              nextAction: 'retry_allowed',
            },
          },
        },
      }),
    ]);

    assert.deepEqual(resolution.issues, [
      {
        code: 'recovery_fact_corruption',
        eventId: 'reconcile-result-1',
        reason: 'invalid_payload',
      },
    ]);
    assert.equal(resolution.hasCorruption, true);
  });

  it('rejects a reconcile result appended after the final recovery decision', () => {
    const resolution = resolveRuntimeRecovery([
      initialEvent('t1_after_preflight_v1'),
      functionCallEvent(),
      toolDispatchEvent({ recoveryMode: 'reconcile' }),
      event({
        id: 'recovery-decision-1',
        actions: {
          runtimeFact: {
            kind: 'maka.tool.recovery_decision',
            version: 1,
            legacyProjection: 'invisible',
            payload: {
              protocol: 'tool_recovery_v1',
              operationId: 'operation-1',
              disposition: 'parked',
              reasonCode: 'manual_recovery_required',
              evidenceEventIds: ['function-call-1', 'dispatch-1'],
            },
          },
        },
      }),
      event({
        id: 'reconcile-result-1',
        actions: {
          runtimeFact: {
            kind: 'maka.tool.reconcile_result',
            version: 1,
            legacyProjection: 'invisible',
            payload: {
              protocol: 'tool_reconcile_v1',
              operationId: 'operation-1',
              result: 'applied',
              observationDigest: 'sha256:observation-1',
              observedAt: '2026-07-21T00:00:00.000Z',
              nextAction: 'synthesize_response',
            },
          },
        },
      }),
    ]);

    assert.deepEqual(resolution.issues, [
      {
        code: 'recovery_fact_corruption',
        eventId: 'reconcile-result-1',
        reason: 'fact_after_decision',
      },
    ]);
    assert.equal(resolution.decisions[0]?.disposition, 'corruption');
  });

  it('rejects a recovery decision that cites evidence from after the decision event', () => {
    const recoveryDecision = event({
      id: 'recovery-decision-1',
      actions: {
        runtimeFact: {
          kind: 'maka.tool.recovery_decision',
          version: 1,
          legacyProjection: 'invisible',
          payload: {
            protocol: 'tool_recovery_v1',
            operationId: 'operation-1',
            disposition: 'parked',
            reasonCode: 'manual_recovery_required',
            evidenceEventIds: ['future-evidence'],
          },
        },
      },
    });
    const resolution = resolveRuntimeRecovery([
      initialEvent('t1_after_preflight_v1'),
      functionCallEvent(),
      toolDispatchEvent(),
      recoveryDecision,
      event({ id: 'future-evidence' }),
    ]);

    assert.equal(resolution.hasCorruption, true);
    assert.deepEqual(resolution.issues, [
      {
        code: 'recovery_fact_corruption',
        eventId: 'recovery-decision-1',
        reason: 'invalid_evidence',
      },
    ]);
  });

  it('rejects an unknown protocol marker on the first canonical event', () => {
    const resolution = resolveRuntimeRecovery([
      initialEvent('future_protocol' as 't1_after_preflight_v1'),
      functionCallEvent(),
    ]);

    assert.equal(resolution.toolBoundaryProtocol, undefined);
    assert.deepEqual(resolution.issues, [
      {
        code: 'protocol_marker_invalid',
        eventId: 'initial-1',
      },
    ]);
    assert.equal(resolution.decisions[0]?.disposition, 'parked');
    assert.equal(resolution.decisions[0]?.reasonCode, 'legacy_dispatch_unknown');
    assert.equal(resolution.decisions[0]?.automaticActionAllowed, false);
    assert.equal(resolution.hasCorruption, true);
    assert.equal(resolution.requiresReconciliation, false);
  });

  it('classifies a response linked to a different operation as corruption', () => {
    const resolution = resolveRuntimeRecovery([
      initialEvent('t1_after_preflight_v1'),
      functionCallEvent(),
      toolDispatchEvent(),
      functionResponseEvent(false, 'another-operation'),
    ]);

    assert.equal(resolution.decisions[0]?.disposition, 'corruption');
    assert.equal(resolution.decisions[0]?.reasonCode, 'identity_conflict');
    assert.equal(resolution.decisions[0]?.responseRuntimeEventId, 'function-response-1');
    assert.equal(resolution.hasCorruption, true);
  });
});

function initialEvent(toolBoundary?: 't1_after_preflight_v1'): RuntimeEvent {
  return event({
    id: 'initial-1',
    role: 'user',
    author: 'user',
    content: { kind: 'text', text: 'run it' },
    ...(toolBoundary ? { actions: { runtimeProtocol: { toolBoundary } } } : {}),
  });
}

function functionCallEvent(toolCallId = 'call-1', eventId = 'function-call-1'): RuntimeEvent {
  return event({
    id: eventId,
    role: 'model',
    author: 'agent',
    content: { kind: 'function_call', id: toolCallId, name: 'Bash', args: { command: 'do-it' } },
  });
}

function toolDispatchEvent(
  overrides: {
    toolName?: string;
    recoveryMode?: 'replay_safe' | 'idempotent' | 'reconcile' | 'reattach' | 'never_auto_retry';
    id?: string;
    operationId?: string;
    providerToolCallId?: string;
  } = {},
): RuntimeEvent {
  const operationId = overrides.operationId ?? 'operation-1';
  const providerToolCallId = overrides.providerToolCallId ?? 'call-1';
  return event({
    id: overrides.id ?? 'dispatch-1',
    actions: {
      toolDispatch: {
        protocol: 't1_after_preflight_v1',
        operationId,
        providerToolCallId,
        toolName: overrides.toolName ?? 'Bash',
        canonicalArgsHash: 'args-hash-1',
        recoveryMode: overrides.recoveryMode ?? 'never_auto_retry',
      },
    },
    refs: { operationId, toolCallId: providerToolCallId },
  });
}

function functionResponseEvent(isError = false, operationId?: string): RuntimeEvent {
  return event({
    id: 'function-response-1',
    role: 'tool',
    author: 'tool',
    content: {
      kind: 'function_response',
      id: 'call-1',
      name: 'Bash',
      result: isError ? 'permission denied' : 'ok',
      ...(isError ? { isError: true } : {}),
    },
    ...(operationId ? { refs: { operationId, toolCallId: 'call-1' } } : {}),
  });
}

function preparedMutationEvent(): RuntimeEvent {
  return event({
    id: 'prepared-file-1',
    actions: {
      runtimeFact: {
        kind: 'maka.file.prepared_mutation',
        version: 1,
        legacyProjection: 'invisible',
        payload: {
          protocol: 'prepared_file_mutation_v1',
          operationId: 'operation-1',
          workspaceRoot: '/workspace',
          canonicalPath: '/workspace/notes.txt',
          relativePath: 'notes.txt',
          before: { kind: 'missing' },
          expectedAfter: {
            kind: 'file',
            sha256: 'a'.repeat(64),
            blobOid: 'b'.repeat(40),
            byteLength: 8,
            mode: 0o100644,
          },
          transform: { id: 'maka.write.utf8', version: 1, argsHash: 'c'.repeat(64) },
          carrier: {
            kind: 'git_object_v1',
            repositoryCommonDir: '/workspace/.git',
            retentionRef: 'refs/maka/checkpoints/operations/operation-1',
          },
        },
      },
    },
    refs: { operationId: 'operation-1', toolCallId: 'call-1' },
  });
}

function event(overrides: Partial<RuntimeEvent>): RuntimeEvent {
  return {
    id: 'event-1',
    invocationId: 'invocation-1',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 1,
    partial: false,
    role: 'system',
    author: 'system',
    ...overrides,
  };
}
