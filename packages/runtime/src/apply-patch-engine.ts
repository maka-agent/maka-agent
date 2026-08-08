import {
  assertSafePatchPath,
  canonicalizeApplyPatchHunks,
  parseApplyPatch,
  planApplyPatchMutations,
  type ApplyPatchHunk,
  type ApplyPatchPathState,
  type PlannedPatchMutation,
} from '@maka/core/apply-patch';

export type ApplyPatchAccessIntent =
  | { access: 'write'; path: string }
  | { access: 'delete'; path: string };

export interface ApplyPatchSnapshot {
  readonly state: ApplyPatchPathState;
  readonly token: string;
}

export interface ApplyPatchFsAdapter {
  lockKey(path: string): Promise<string>;
  snapshot(path: string): Promise<ApplyPatchSnapshot>;
  writeText(
    path: string,
    content: string,
    mode: 'create' | 'replace',
    expectedToken: string,
  ): Promise<{ path: string; bytes: number; token: string }>;
  deletePath(path: string, expectedToken: string): Promise<{ path: string; token: string }>;
  preflightPermissions?(intents: readonly ApplyPatchAccessIntent[]): Promise<void>;
}

export interface ApplyPatchOperationResult {
  operation: PlannedPatchMutation['operation'];
  path: string;
  status: 'completed' | 'failed' | 'skipped';
  error?: string;
  bytes?: number;
  effectUnknown?: boolean;
}

export interface ApplyPatchEngineResult {
  ok: boolean;
  operations: ApplyPatchOperationResult[];
  completed: string[];
  uncompleted: string[];
  error?: string;
  partial?: boolean;
  effectUnknown?: boolean;
}

export async function executeApplyPatchWithAdapter(
  patchText: string,
  fs: ApplyPatchFsAdapter,
  withLock: <T>(key: string, run: () => Promise<T>) => Promise<T>,
): Promise<ApplyPatchEngineResult> {
  const parsed = parseApplyPatch(patchText);
  if (!parsed.ok) {
    const message =
      parsed.error.code === 'invalid_hunk'
        ? `ApplyPatch parse error at line ${parsed.error.lineNumber}: ${parsed.error.message}`
        : `ApplyPatch parse error: ${parsed.error.message}`;
    throw new Error(message);
  }

  const rawPaths = collectPaths(parsed.value.hunks);
  for (const path of rawPaths) {
    const pathError = assertSafePatchPath(path);
    if (pathError) {
      throw new Error(`ApplyPatch rejected path ${JSON.stringify(path)}: ${pathError}`);
    }
  }
  const hunks = canonicalizeApplyPatchHunks(parsed.value.hunks);
  const paths = collectPaths(hunks);
  const lockKeys = new Set<string>();
  for (const path of paths) lockKeys.add(await fs.lockKey(path));

  const run = async (): Promise<ApplyPatchEngineResult> => {
    await fs.preflightPermissions?.(collectAccessIntents(hunks));
    const snapshots = new Map<string, ApplyPatchSnapshot>();
    const state = new Map<string, ApplyPatchPathState>();
    for (const path of paths) {
      const snapshot = await fs.snapshot(path);
      snapshots.set(path, snapshot);
      state.set(path, snapshot.state);
    }
    const prepared = planApplyPatchMutations(hunks, state);
    return await settlePrepared(prepared, snapshots, fs);
  };

  return await withNestedLocks([...lockKeys].sort(), withLock, run);
}

function collectPaths(hunks: readonly ApplyPatchHunk[]): string[] {
  return [...new Set(hunks.map((hunk) => hunk.path))];
}

function collectAccessIntents(hunks: readonly ApplyPatchHunk[]): ApplyPatchAccessIntent[] {
  const intents = new Map<string, ApplyPatchAccessIntent>();
  for (const hunk of hunks) {
    const access = hunk.kind === 'delete' ? 'delete' : 'write';
    intents.set(`${access}:${hunk.path}`, { access, path: hunk.path });
  }
  return [...intents.values()];
}

async function settlePrepared(
  prepared: readonly PlannedPatchMutation[],
  snapshots: ReadonlyMap<string, ApplyPatchSnapshot>,
  fs: ApplyPatchFsAdapter,
): Promise<ApplyPatchEngineResult> {
  const operations: ApplyPatchOperationResult[] = [];
  const completed: string[] = [];
  const tokens = new Map([...snapshots].map(([path, snapshot]) => [path, snapshot.token]));
  let failure: string | undefined;
  let effectUnknown = false;

  for (const step of prepared) {
    if (failure) {
      operations.push({ operation: step.operation, path: step.path, status: 'skipped' });
      continue;
    }
    const expectedToken = tokens.get(step.path);
    if (expectedToken === undefined) {
      throw new Error(`ApplyPatch missing snapshot token for ${step.path}`);
    }
    try {
      if (step.operation === 'add' || step.operation === 'update') {
        const written = await fs.writeText(
          step.path,
          step.content,
          step.operation === 'add' ? 'create' : 'replace',
          expectedToken,
        );
        tokens.set(step.path, written.token);
        completed.push(step.path);
        operations.push({
          operation: step.operation,
          path: step.path,
          status: 'completed',
          bytes: written.bytes,
        });
        continue;
      }
      const deleted = await fs.deletePath(step.path, expectedToken);
      tokens.set(step.path, deleted.token);
      completed.push(step.path);
      operations.push({ operation: 'delete', path: step.path, status: 'completed' });
    } catch (error) {
      const unknown = mutationEffectUnknown(error);
      if (shouldRethrowBoundaryError(error, completed.length, unknown)) throw error;
      failure = errorMessage(error);
      effectUnknown ||= unknown;
      operations.push({
        operation: step.operation,
        path: step.path,
        status: 'failed',
        error: failure,
        ...(unknown ? { effectUnknown: true } : {}),
      });
    }
  }

  if (!failure) return { ok: true, operations, completed, uncompleted: [] };
  return {
    ok: false,
    partial: completed.length > 0 || effectUnknown,
    ...(effectUnknown ? { effectUnknown: true } : {}),
    error: failure,
    operations,
    completed,
    uncompleted: operations
      .filter((operation) => operation.status !== 'completed')
      .map((operation) => operation.path),
  };
}

function mutationEffectUnknown(error: unknown): boolean {
  return Boolean(
    error && typeof error === 'object' && 'effectUnknown' in error && error.effectUnknown,
  );
}

function shouldRethrowBoundaryError(
  error: unknown,
  completedCount: number,
  effectUnknown: boolean,
): boolean {
  if (completedCount > 0 || effectUnknown || !error || typeof error !== 'object') return false;
  const value = error as { requiredExpansion?: unknown; reason?: unknown; domain?: unknown };
  return (
    value.requiredExpansion !== undefined ||
    (value.domain === 'filesystem' && value.reason === 'sandbox_boundary_required')
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function withNestedLocks<T>(
  keys: readonly string[],
  withLock: <U>(key: string, run: () => Promise<U>) => Promise<U>,
  run: () => Promise<T>,
): Promise<T> {
  const [head, ...rest] = keys;
  if (!head) return await run();
  return await withLock(head, async () => await withNestedLocks(rest, withLock, run));
}
