import { randomUUID } from 'node:crypto';
import type { ShellRunSnapshotResult, ShellRunUpdate, ToolResultContent } from '@maka/core/events';
import { isTerminalShellRunStatus as isTerminalDomainShellRunStatus } from '@maka/core/shell-run';
import {
  projectPtyOutputForModel,
  ShellRunProcessManager,
  truncateToolOutput,
  type BackgroundTaskStopper,
  type PtyControlWriter,
  type RuntimeResourceReader,
  type ShellRunBashInput,
  type ShellRunLauncher,
  type ShellRunProcessManagerInput,
  type ShellRunWriteInput,
} from '@maka/runtime';
import {
  encodePtyAcquireResult,
  encodePtyControlResult,
  encodePtyReadResult,
  encodePtyReleaseResult,
  encodeRuntimeResourceQueryResult,
  encodeRuntimeResourceReadResult,
  encodeRuntimeResourceStopResult,
  isTerminalRuntimeResourceStatus,
  RUNTIME_RESOURCE_COMMAND_MAX_BYTES,
  RUNTIME_RESOURCE_CWD_MAX_BYTES,
  RUNTIME_RESOURCE_FAILURE_MAX_BYTES,
  RUNTIME_RESOURCE_OUTPUT_FIELD_MAX_BYTES,
  RUNTIME_RESOURCE_RESULT_MAX_BYTES,
  type OperationOutcome,
  type PtyControlInput,
  type PtyReadInput,
  type PtyReleaseInput,
  type RuntimeResourceMetadata,
  type RuntimeResourceRefInput,
  type RuntimeResourceSnapshot,
  type RuntimeResourceStopResult,
} from '../protocol/index.js';
import type {
  ConnectionContext,
  RuntimeResourceOperationHandlerMap,
} from './operation-dispatcher.js';

const PIPE_TRUNCATION_MARKER_HEADROOM_BYTES = 1024;

type ShellRunSettlementEvent = Parameters<
  NonNullable<ShellRunProcessManagerInput['onShellRunSettled']>
>[0];

interface ResidencyToken {
  release(): void;
}

interface BackgroundResidency {
  readonly token: ResidencyToken;
  terminal: boolean;
  released: boolean;
}

interface PtyController {
  readonly connectionId: string;
  readonly controllerId: string;
}

export interface HostRuntimeResourceCoordinatorOptions
  extends Omit<ShellRunProcessManagerInput, 'onShellRunSettled' | 'onShellRunUpdate'> {
  readonly acquireResidency: () => ResidencyToken;
  readonly onShellRunSettled?: (event: ShellRunSettlementEvent) => void;
  readonly onShellRunUpdate?: (update: ShellRunUpdate) => void;
}

/** Owns Host-local ShellRun processes, wire projections, and PTY controller leases. */
export class HostRuntimeResourceCoordinator
  implements ShellRunLauncher, RuntimeResourceReader, BackgroundTaskStopper, PtyControlWriter
{
  readonly handlers: RuntimeResourceOperationHandlerMap = {
    'resource.query': (input) => this.#query(input),
    'resource.read': (input) => this.#read(input),
    'resource.stop': (input) => this.#stop(input),
    'pty.acquire': (input, context) => this.#acquire(input, context),
    'pty.release': (input, context) => this.#release(input, context),
    'pty.control': (input, context) => this.#control(input, context),
    'pty.read': (input) => this.#readPty(input),
  };

  readonly #manager: ShellRunProcessManager;
  readonly #acquireResidency: () => ResidencyToken;
  readonly #backgroundResidencies = new Map<string, BackgroundResidency>();
  readonly #pendingLaunchResidencies = new Map<string, Set<BackgroundResidency>>();
  readonly #pendingLaunchSettlements = new Set<Promise<void>>();
  readonly #controllers = new Map<string, PtyController>();
  readonly #resourceQueues = new Map<string, Promise<void>>();
  readonly #terminalizationFailures = new Set<Error>();
  #draining = false;
  #terminateTask?: Promise<void>;
  #closeTask?: Promise<void>;

  constructor(options: HostRuntimeResourceCoordinatorOptions) {
    const { acquireResidency, onShellRunSettled, onShellRunUpdate, ...managerInput } = options;
    this.#acquireResidency = acquireResidency;
    this.#manager = new ShellRunProcessManager({
      ...managerInput,
      onShellRunUpdate: (update) => {
        this.#observeUpdate(update);
        onShellRunUpdate?.(update);
      },
      onShellRunSettled: (event) => {
        this.#observeSettlement(event);
        onShellRunSettled?.(event);
      },
    });
  }

  get shellRuns(): ShellRunProcessManager {
    return this.#manager;
  }

  runForegroundBash(
    input: ShellRunBashInput,
  ): Promise<Extract<ToolResultContent, { kind: 'terminal' }>> {
    this.#assertLaunchAdmission();
    return this.#manager.runForegroundBash(input);
  }

  async runBackgroundBash(
    input: ShellRunBashInput,
  ): Promise<Extract<ToolResultContent, { kind: 'shell_run' }>> {
    this.#assertLaunchAdmission();
    const residency: BackgroundResidency = {
      token: this.#acquireResidency(),
      terminal: false,
      released: false,
    };
    let resolveLaunchSettlement!: () => void;
    const launchSettlement = new Promise<void>((resolve) => {
      resolveLaunchSettlement = resolve;
    });
    this.#pendingLaunchSettlements.add(launchSettlement);
    const launchKey = sourceKey(input.sessionId, input.sourceTurnId, input.sourceToolCallId);
    let pending = this.#pendingLaunchResidencies.get(launchKey);
    if (!pending) {
      pending = new Set();
      this.#pendingLaunchResidencies.set(launchKey, pending);
    }
    pending.add(residency);
    try {
      const result = await this.#manager.runBackgroundBash(input);
      if (isTerminalDomainShellRunStatus(result.status) || residency.terminal) {
        this.#releaseResidency(residency);
      } else {
        this.#backgroundResidencies.set(resourceKey(input.sessionId, result.ref), residency);
      }
      return result;
    } catch (error) {
      this.#releaseResidency(residency);
      throw error;
    } finally {
      pending.delete(residency);
      if (pending.size === 0) this.#pendingLaunchResidencies.delete(launchKey);
      this.#pendingLaunchSettlements.delete(launchSettlement);
      resolveLaunchSettlement();
    }
  }

  readRuntimeResource(sessionId: string, ref: string, abortSignal: AbortSignal) {
    return this.#manager.readRuntimeResource(sessionId, ref, abortSignal);
  }

  stopBackgroundTask(sessionId: string, ref: string, abortSignal: AbortSignal) {
    return this.#manager.stopBackgroundTask(sessionId, ref, abortSignal);
  }

  writeStdin(
    input: ShellRunWriteInput,
  ): Promise<Extract<ToolResultContent, { kind: 'shell_run' }>> {
    return this.#manager.writeStdin(input);
  }

  beginDrain(): void {
    if (this.#draining) return;
    this.#draining = true;
    this.#terminateTask = this.#manager.terminateAll();
    void this.#terminateTask.catch(() => undefined);
  }

  async releaseConnection(connectionId: string): Promise<void> {
    const releases: Promise<void>[] = [];
    for (const [key, controller] of this.#controllers) {
      if (controller.connectionId !== connectionId) continue;
      releases.push(
        this.#inResourceQueue(key, async () => {
          const current = this.#controllers.get(key);
          if (current?.connectionId === connectionId) this.#controllers.delete(key);
        }),
      );
    }
    await Promise.all(releases);
  }

  close(): Promise<void> {
    this.beginDrain();
    this.#closeTask ??= this.#closeOnce();
    return this.#closeTask;
  }

  async #closeOnce(): Promise<void> {
    const failures: unknown[] = [];
    const failureIdentities = new Set<unknown>();
    const termination = await Promise.allSettled([this.#terminateTask]);
    if (termination[0]?.status === 'rejected') {
      addFailure(failures, failureIdentities, termination[0].reason);
    }
    while (this.#pendingLaunchSettlements.size > 0) {
      await Promise.all([...this.#pendingLaunchSettlements]);
    }
    while (this.#resourceQueues.size > 0) {
      const settled = await Promise.allSettled([...this.#resourceQueues.values()]);
      for (const result of settled) {
        if (result.status === 'rejected') addFailure(failures, failureIdentities, result.reason);
      }
    }
    this.#controllers.clear();
    for (const residency of this.#backgroundResidencies.values()) {
      this.#releaseResidency(residency);
    }
    this.#backgroundResidencies.clear();
    this.#pendingLaunchResidencies.clear();
    for (const failure of this.#terminalizationFailures) {
      addFailure(failures, failureIdentities, failure);
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Runtime resource coordinator failed to close cleanly');
    }
  }

  async #query(input: RuntimeResourceRefInput): Promise<OperationOutcome<'resource.query'>> {
    let snapshot: ShellRunSnapshotResult;
    try {
      snapshot = await this.#manager.inspectResource(input.sessionId, input.ref);
    } catch (error) {
      return storeFailure(error, 'Runtime resource query failed');
    }
    try {
      const { output: _output, ...metadata } = snapshot;
      return {
        ok: true,
        result: encodeRuntimeResourceQueryResult(projectWireMetadata(metadata)),
      };
    } catch {
      return internalFailure('Runtime resource query projection failed');
    }
  }

  async #read(input: RuntimeResourceRefInput): Promise<OperationOutcome<'resource.read'>> {
    let snapshot: ShellRunSnapshotResult;
    try {
      snapshot = await this.#manager.inspectResource(input.sessionId, input.ref);
    } catch (error) {
      return storeFailure(error, 'Runtime resource read failed');
    }
    try {
      return {
        ok: true,
        result: projectWireSnapshot(
          snapshot,
          (resource) => resource,
          encodeRuntimeResourceReadResult,
        ),
      };
    } catch {
      return internalFailure('Runtime resource read projection failed');
    }
  }

  #stop(input: RuntimeResourceRefInput): Promise<OperationOutcome<'resource.stop'>> {
    const key = resourceKey(input.sessionId, input.ref);
    return this.#inResourceQueue(key, async () => {
      let result: ToolResultContent;
      try {
        result = await this.#manager.stopRuntimeResource(
          input.sessionId,
          input.ref,
          new AbortController().signal,
        );
      } catch (error) {
        return storeFailure(error, 'Runtime resource stop failed');
      }
      try {
        if (result.kind !== 'shell_run' || !result.output || result.operation?.kind !== 'stop') {
          throw new Error('ShellRun stop did not return a canonical terminal snapshot');
        }
        const operation = result.operation;
        return {
          ok: true,
          result: projectWireSnapshot(
            result,
            (resource) => withStopOperation(resource, operation),
            encodeRuntimeResourceStopResult,
          ),
        };
      } catch {
        return internalFailure('Runtime resource stop projection failed');
      }
    });
  }

  #acquire(
    input: RuntimeResourceRefInput,
    context: ConnectionContext,
  ): Promise<OperationOutcome<'pty.acquire'>> {
    const key = resourceKey(input.sessionId, input.ref);
    return this.#inResourceQueue(key, async () => {
      if (this.#draining) return hostDraining();
      try {
        const resource = await this.#manager.inspectResource(input.sessionId, input.ref);
        const invalid = validateRunningPty(resource);
        if (invalid) return invalid;
        if (this.#controllers.has(key)) {
          return failure('controller_held', 'PTY controller is already held');
        }
        const controller = { connectionId: context.connectionId, controllerId: randomUUID() };
        this.#controllers.set(key, controller);
        try {
          return {
            ok: true,
            result: encodePtyAcquireResult({ controllerId: controller.controllerId }),
          };
        } catch {
          this.#controllers.delete(key);
          return internalFailure('PTY controller projection failed');
        }
      } catch (error) {
        return storeFailure(error, 'PTY controller acquisition failed');
      }
    });
  }

  #release(
    input: PtyReleaseInput,
    context: ConnectionContext,
  ): Promise<OperationOutcome<'pty.release'>> {
    const key = resourceKey(input.sessionId, input.ref);
    return this.#inResourceQueue(key, async () => {
      const controller = this.#controllers.get(key);
      if (!ownsController(controller, context.connectionId, input.controllerId)) {
        return failure('controller_invalid', 'PTY controller lease is invalid');
      }
      this.#controllers.delete(key);
      try {
        return { ok: true, result: encodePtyReleaseResult({ released: true }) };
      } catch {
        return internalFailure('PTY controller release projection failed');
      }
    });
  }

  #control(
    input: PtyControlInput,
    context: ConnectionContext,
  ): Promise<OperationOutcome<'pty.control'>> {
    const key = resourceKey(input.sessionId, input.ref);
    return this.#inResourceQueue(key, async () => {
      if (this.#draining) return hostDraining();
      const controller = this.#controllers.get(key);
      if (!ownsController(controller, context.connectionId, input.controllerId)) {
        return failure('controller_invalid', 'PTY controller lease is invalid');
      }
      let resource: ShellRunSnapshotResult;
      try {
        resource = await this.#manager.inspectResource(input.sessionId, input.ref);
      } catch (error) {
        return storeFailure(error, 'PTY control failed');
      }
      const invalid = validateRunningPty(resource);
      if (invalid) return invalid;

      let result: Extract<ToolResultContent, { kind: 'shell_run' }>;
      try {
        result = await this.#manager.controlPtyResource({
          sessionId: input.sessionId,
          ref: input.ref,
          ...(input.input !== undefined ? { input: input.input } : {}),
          ...(input.resize ? { size: input.resize } : {}),
        });
      } catch (error) {
        return storeFailure(error, 'PTY control failed');
      }

      try {
        if (result.operation?.kind !== 'pty_control') {
          throw new Error('ShellRun control did not return an operation outcome');
        }
        if (result.operation.failed) {
          return failure('outcome_unknown', 'PTY control outcome is unknown');
        }
        return {
          ok: true,
          result: encodePtyControlResult({
            ...(result.operation.input
              ? {
                  input: {
                    accepted: result.operation.input.queued,
                    bytes: result.operation.input.bytes,
                  },
                }
              : {}),
            ...(result.operation.resize
              ? {
                  resize: {
                    applied: result.operation.resize.applied,
                    changed: result.operation.resize.changed,
                  },
                }
              : {}),
          }),
        };
      } catch {
        return internalFailure('PTY control projection failed');
      }
    });
  }

  async #readPty(input: PtyReadInput): Promise<OperationOutcome<'pty.read'>> {
    let resource: ShellRunSnapshotResult;
    try {
      resource = await this.#manager.inspectResource(input.sessionId, input.ref);
    } catch (error) {
      return storeFailure(error, 'PTY read failed');
    }
    if (resource.mode !== 'pty') {
      return failure('invalid_request', 'PTY read requires a PTY runtime resource');
    }
    try {
      const cursor = revisionCursor(resource.revision);
      if (input.cursor === cursor) {
        const { output: _output, ...metadata } = resource;
        return {
          ok: true,
          result: encodePtyReadResult({
            kind: 'unchanged',
            resource: projectWireMetadata(metadata),
            cursor,
          }),
        };
      }
      return {
        ok: true,
        result: projectWireSnapshot(
          resource,
          (projected) => ({ kind: 'snapshot' as const, resource: projected, cursor }),
          (value) => encodePtyReadResult({ kind: 'snapshot', resource: value.resource, cursor }),
        ),
      };
    } catch {
      return internalFailure('PTY read projection failed');
    }
  }

  #observeUpdate(update: ShellRunUpdate): void {
    const key = resourceKey(update.sessionId, update.result.ref);
    const pending = this.#pendingLaunchResidencies.get(
      sourceKey(update.sessionId, update.sourceTurnId, update.sourceToolCallId),
    );
    if (pending) {
      for (const residency of pending) {
        if (!isTerminalDomainShellRunStatus(update.result.status)) {
          this.#backgroundResidencies.set(key, residency);
        }
      }
    }
    if (!isTerminalDomainShellRunStatus(update.result.status)) return;
    this.#queueControllerCleanup(key);
    const owned = this.#backgroundResidencies.get(key);
    if (owned) {
      this.#backgroundResidencies.delete(key);
      this.#releaseResidency(owned);
    }
    if (!pending) return;
    for (const residency of pending) {
      residency.terminal = true;
      this.#releaseResidency(residency);
    }
  }

  #observeSettlement(event: ShellRunSettlementEvent): void {
    if (event.terminalizationError) this.#terminalizationFailures.add(event.terminalizationError);
    const key = resourceKey(event.sessionId, event.ref);
    const residency = this.#backgroundResidencies.get(key);
    if (residency) {
      this.#backgroundResidencies.delete(key);
      this.#releaseResidency(residency);
    }
    this.#queueControllerCleanup(key);
  }

  #queueControllerCleanup(key: string): void {
    void this.#inResourceQueue(key, async () => {
      this.#controllers.delete(key);
    });
  }

  #releaseResidency(residency: BackgroundResidency): void {
    if (residency.released) return;
    residency.released = true;
    residency.token.release();
  }

  #assertLaunchAdmission(): void {
    if (this.#draining) throw new Error('Runtime Host is draining');
  }

  #inResourceQueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const predecessor = this.#resourceQueues.get(key) ?? Promise.resolve();
    const result = predecessor.then(operation, operation);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.#resourceQueues.set(key, settled);
    void settled.finally(() => {
      if (this.#resourceQueues.get(key) === settled) this.#resourceQueues.delete(key);
    });
    return result;
  }
}

function addFailure(failures: unknown[], identities: Set<unknown>, failure: unknown): void {
  if (identities.has(failure)) return;
  identities.add(failure);
  failures.push(failure);
}

function projectWireSnapshot<Envelope, Result>(
  snapshot: ShellRunSnapshotResult,
  envelope: (resource: RuntimeResourceSnapshot) => Envelope,
  encode: (value: Envelope) => Result,
): Result {
  const metadata = projectWireMetadata(snapshot);
  const maxOutputBytes =
    snapshot.mode === 'pipes'
      ? RUNTIME_RESOURCE_OUTPUT_FIELD_MAX_BYTES * 2
      : RUNTIME_RESOURCE_OUTPUT_FIELD_MAX_BYTES;
  const empty = envelope(withOutputBudget(metadata, snapshot.output, 0));
  let outputBudget = Math.min(
    maxOutputBytes,
    Math.max(0, RUNTIME_RESOURCE_RESULT_MAX_BYTES - jsonBytes(empty)),
  );

  for (;;) {
    const candidate = envelope(withOutputBudget(metadata, snapshot.output, outputBudget));
    const size = jsonBytes(candidate);
    if (size <= RUNTIME_RESOURCE_RESULT_MAX_BYTES) return encode(candidate);
    if (outputBudget === 0) {
      throw new Error('Runtime resource metadata exceeds the wire result budget');
    }
    outputBudget = Math.max(
      0,
      outputBudget - Math.max(256, size - RUNTIME_RESOURCE_RESULT_MAX_BYTES),
    );
  }
}

function projectWireMetadata(
  resource: ShellRunSnapshotResult | Omit<ShellRunSnapshotResult, 'output'>,
): RuntimeResourceMetadata {
  const fields = {
    kind: 'shell_run' as const,
    ref: resource.ref,
    status: resource.status,
    cwd: boundWireMetadataText(resource.cwd, RUNTIME_RESOURCE_CWD_MAX_BYTES, 'tail'),
    cmd: boundWireMetadataText(resource.cmd, RUNTIME_RESOURCE_COMMAND_MAX_BYTES, 'head'),
    startedAt: resource.startedAt,
    updatedAt: resource.updatedAt,
    revision: resource.revision,
    ...(resource.completedAt !== undefined ? { completedAt: resource.completedAt } : {}),
    ...(resource.exitCode !== undefined ? { exitCode: resource.exitCode } : {}),
    ...(resource.failureMessage !== undefined
      ? {
          failureMessage: boundWireMetadataText(
            resource.failureMessage,
            RUNTIME_RESOURCE_FAILURE_MAX_BYTES,
            'tail',
          ),
        }
      : {}),
    ...(resource.timeoutMs !== undefined ? { timeoutMs: resource.timeoutMs } : {}),
    ...(resource.sandboxDenial !== undefined
      ? {
          sandboxDenial: {
            likely: true as const,
            recovery: 'require_escalated' as const,
            ...(resource.sandboxDenial.backend !== undefined
              ? { backend: resource.sandboxDenial.backend }
              : {}),
          },
        }
      : {}),
  };
  return resource.mode === 'pipes' ? { ...fields, mode: 'pipes' } : { ...fields, mode: 'pty' };
}

function boundWireMetadataText(value: string, maxBytes: number, keep: 'head' | 'tail'): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes && jsonStringContentBytes(value) <= maxBytes) {
    return value;
  }

  const characters = Array.from(value);
  const selected: string[] = [];
  let rawBytes = 0;
  let encodedBytes = 0;
  for (
    let index = keep === 'head' ? 0 : characters.length - 1;
    index >= 0 && index < characters.length;
    index += keep === 'head' ? 1 : -1
  ) {
    const character = characters[index];
    if (character === undefined) break;
    const nextRawBytes = Buffer.byteLength(character, 'utf8');
    const nextEncodedBytes = jsonStringContentBytes(character);
    if (rawBytes + nextRawBytes > maxBytes || encodedBytes + nextEncodedBytes > maxBytes) break;
    selected.push(character);
    rawBytes += nextRawBytes;
    encodedBytes += nextEncodedBytes;
  }
  return keep === 'head' ? selected.join('') : selected.reverse().join('');
}

function jsonStringContentBytes(value: string): number {
  return jsonBytes(value) - 2;
}

function withOutputBudget(
  metadata: RuntimeResourceMetadata,
  output: ShellRunSnapshotResult['output'],
  outputBudget: number,
): RuntimeResourceSnapshot {
  if (metadata.mode === 'pty' && output.mode === 'pty') {
    const projected = projectPtyOutputForModel(
      output,
      Math.min(outputBudget, RUNTIME_RESOURCE_OUTPUT_FIELD_MAX_BYTES),
    );
    return {
      ...metadata,
      output: {
        mode: 'pty',
        screen: projected.screen,
        scrollback: projected.scrollback,
        ...(projected.lastAlternateScreen !== undefined
          ? { lastAlternateScreen: projected.lastAlternateScreen }
          : {}),
        cols: projected.cols,
        rows: projected.rows,
        cursor: {
          x: projected.cursor.x,
          y: projected.cursor.y,
          visible: projected.cursor.visible,
        },
        alternateScreen: projected.alternateScreen,
        truncated: projected.truncated,
        redacted: projected.redacted,
      },
    };
  }
  if (metadata.mode !== 'pipes' || output.mode !== 'pipes') {
    throw new Error('ShellRun metadata and output modes disagree');
  }

  const stdoutBytes = Buffer.byteLength(output.stdout, 'utf8');
  const stderrBytes = Buffer.byteLength(output.stderr, 'utf8');
  let stdoutBudget = Math.min(
    stdoutBytes,
    Math.floor(outputBudget / 2),
    RUNTIME_RESOURCE_OUTPUT_FIELD_MAX_BYTES,
  );
  let stderrBudget = Math.min(
    stderrBytes,
    outputBudget - stdoutBudget,
    RUNTIME_RESOURCE_OUTPUT_FIELD_MAX_BYTES,
  );
  let remaining = outputBudget - stdoutBudget - stderrBudget;
  const stdoutCapacity = Math.max(0, RUNTIME_RESOURCE_OUTPUT_FIELD_MAX_BYTES - stdoutBudget);
  const stdoutExtra = Math.min(remaining, stdoutCapacity, stdoutBytes - stdoutBudget);
  stdoutBudget += stdoutExtra;
  remaining -= stdoutExtra;
  stderrBudget += Math.min(
    remaining,
    Math.max(0, RUNTIME_RESOURCE_OUTPUT_FIELD_MAX_BYTES - stderrBudget),
    stderrBytes - stderrBudget,
  );

  const stdout = projectPipeText(output.stdout, stdoutBudget);
  const stderr = projectPipeText(output.stderr, stderrBudget);
  return {
    ...metadata,
    output: {
      mode: 'pipes',
      stdout: stdout.content,
      stderr: stderr.content,
      ...(output.latestStream !== undefined ? { latestStream: output.latestStream } : {}),
      stdoutTruncated: output.stdoutTruncated || stdout.truncated,
      stderrTruncated: output.stderrTruncated || stderr.truncated,
      redacted: output.redacted,
    },
  };
}

function withStopOperation(
  snapshot: RuntimeResourceSnapshot,
  operation: { readonly kind: 'stop'; readonly applied: boolean },
): RuntimeResourceStopResult {
  if (!isTerminalRuntimeResourceStatus(snapshot.status)) {
    throw new Error('ShellRun stop projection is not terminal');
  }
  return {
    ...snapshot,
    status: snapshot.status,
    operation: { kind: 'stop', applied: operation.applied },
  };
}

function projectPipeText(text: string, budget: number): { content: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= budget) return { content: text, truncated: false };
  const projected = truncateToolOutput(text, {
    direction: 'tail',
    maxBytes: Math.max(0, budget - PIPE_TRUNCATION_MARKER_HEADROOM_BYTES),
    maxLines: Number.MAX_SAFE_INTEGER,
  });
  return {
    content: sliceUtf8(projected.content, budget, 'tail'),
    truncated: true,
  };
}

function sliceUtf8(value: string, maxBytes: number, keep: 'head' | 'tail'): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maxBytes) return value;
  const sliced =
    keep === 'head' ? bytes.subarray(0, maxBytes) : bytes.subarray(bytes.length - maxBytes);
  const decoded = sliced.toString('utf8');
  return keep === 'head' ? decoded.replace(/�+$/, '') : decoded.replace(/^�+/, '');
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function validateRunningPty(resource: ShellRunSnapshotResult):
  | {
      readonly ok: false;
      readonly error: {
        readonly code: 'invalid_request' | 'resource_terminal';
        readonly message: string;
      };
    }
  | undefined {
  if (resource.mode !== 'pty') {
    return failure('invalid_request', 'PTY control requires a PTY runtime resource');
  }
  if (resource.status !== 'running') {
    return failure('resource_terminal', 'PTY runtime resource is not running');
  }
  return undefined;
}

function storeFailure(error: unknown, message: string) {
  return isNotFoundError(error)
    ? failure('not_found', 'Runtime resource was not found')
    : failure('persistence_failed', message);
}

function internalFailure(message: string) {
  return failure('internal_failure', message);
}

function isNotFoundError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function failure<C extends string>(code: C, message: string) {
  return { ok: false as const, error: { code, message } };
}

function hostDraining() {
  return failure('host_draining', 'Runtime Host is draining');
}

function ownsController(
  controller: PtyController | undefined,
  connectionId: string,
  controllerId: string,
): boolean {
  return controller?.connectionId === connectionId && controller.controllerId === controllerId;
}

function resourceKey(sessionId: string, ref: string): string {
  return `${sessionId}\u0000${ref}`;
}

function sourceKey(sessionId: string, turnId: string, toolCallId: string): string {
  return `${sessionId}\u0000${turnId}\u0000${toolCallId}`;
}

function revisionCursor(revision: number): string {
  return Buffer.from(`revision:${revision}`, 'utf8').toString('base64url');
}
