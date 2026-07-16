/**
 * Pure optimistic last-write-wins draft controller for Settings pages.
 *
 * Holds the ticket/pending/commit bookkeeping that several Settings pages had
 * hand-copied (draftRef + persistedRef + pendingSaveCount + saveTicket +
 * commitDraft + sync effect). It has no React or DOM dependency so the
 * async-correctness contract can be unit-tested directly; the React shell
 * `useOptimisticSettingsDraft` wires it to component state.
 *
 * Invariants:
 * - A monotonic ticket disambiguates overlapping in-flight saves so a stale
 *   earlier response cannot clobber a newer draft (last write wins).
 * - A pending-save count keeps `syncPersisted` from resetting local state out
 *   from under the user while a save is still in flight.
 * - `dispose` invalidates any in-flight save's late write.
 */

export interface OptimisticUpdateOptions<T> {
  /** Report a save failure (typically a scrubbed toast). */
  onError?(error: unknown): void;
  /** Fired synchronously after the optimistic commit, before awaiting. */
  onStart?(): void;
  /**
   * Extra side-effect run with the authoritative value whenever the draft is
   * synced to it — on a successful save and on an error rollback (but not on
   * the optimistic commit).
   */
  onSync?(value: T): void;
  /** Fired in the finally block with the post-decrement pending-save count. */
  onSettled?(pendingSaveCount: number): void;
  /**
   * Return `isMounted()` instead of the default `isCurrent()` gate. Preserves
   * the open-gateway contract where a superseded-but-mounted save still
   * reports success to its caller.
   */
  returnMounted?: boolean;
  /** Roll the draft back to the persisted value on failure. Defaults to true. */
  restoreOnError?: boolean;
}

export interface RunSaveHelpers {
  /** True while this is the newest save and the owner is still mounted. */
  isCurrent(): boolean;
}

export interface OptimisticDraftController<T> {
  readonly draftRef: { current: T };
  readonly persistedRef: { current: T };
  /** Set the optimistic draft immediately (ref + rendered state). */
  commit(next: T): void;
  /**
   * Sync the draft to a newly persisted value, but only when no save is in
   * flight so an optimistic edit is not reset mid-save. `onSynced` runs with
   * the persisted value when the sync actually lands.
   */
  syncPersisted(persisted: T, onSynced?: (persisted: T) => void): void;
  /** Optimistically apply `patch`, persist it, and reconcile last-write-wins. */
  update(patch: Partial<T>, options?: OptimisticUpdateOptions<T>): Promise<boolean>;
  /**
   * Run a bespoke save under the same ticket/pending bookkeeping as `update`,
   * for pages whose persist path does not fit the generic reconcile.
   */
  runSave<R>(run: (helpers: RunSaveHelpers) => Promise<R>): Promise<R>;
  /** Current in-flight save count. */
  pendingSaveCount(): number;
  /** Invalidate any in-flight save's late write (call on unmount). */
  dispose(): void;
}

export interface OptimisticDraftControllerDeps<T> {
  initial: T;
  onUpdate(patch: Partial<T>): Promise<T>;
  onDraftChange(draft: T): void;
  isMounted(): boolean;
}

export function createOptimisticDraftController<T>(
  deps: OptimisticDraftControllerDeps<T>,
): OptimisticDraftController<T> {
  const draftRef = { current: deps.initial };
  const persistedRef = { current: deps.initial };
  let pendingSaveCount = 0;
  let saveTicket = 0;

  function commit(next: T): void {
    draftRef.current = next;
    deps.onDraftChange(next);
  }

  function isCurrent(ticket: number): boolean {
    return deps.isMounted() && ticket === saveTicket;
  }

  function syncPersisted(persisted: T, onSynced?: (persisted: T) => void): void {
    persistedRef.current = persisted;
    if (pendingSaveCount === 0) {
      commit(persisted);
      onSynced?.(persisted);
    }
  }

  async function update(patch: Partial<T>, options: OptimisticUpdateOptions<T> = {}): Promise<boolean> {
    const { onError, onStart, onSync, onSettled, returnMounted = false, restoreOnError = true } = options;
    const nextDraft = { ...draftRef.current, ...patch } as T;
    saveTicket += 1;
    pendingSaveCount += 1;
    const ticket = saveTicket;
    commit(nextDraft);
    onStart?.();
    try {
      const next = await deps.onUpdate(patch);
      if (isCurrent(ticket)) {
        commit(next);
        onSync?.(next);
      }
      return returnMounted ? deps.isMounted() : isCurrent(ticket);
    } catch (error) {
      if (isCurrent(ticket)) {
        if (restoreOnError) {
          commit(persistedRef.current);
          onSync?.(persistedRef.current);
        }
        onError?.(error);
      }
      return false;
    } finally {
      pendingSaveCount = Math.max(0, pendingSaveCount - 1);
      onSettled?.(pendingSaveCount);
    }
  }

  async function runSave<R>(run: (helpers: RunSaveHelpers) => Promise<R>): Promise<R> {
    saveTicket += 1;
    pendingSaveCount += 1;
    const ticket = saveTicket;
    try {
      return await run({ isCurrent: () => isCurrent(ticket) });
    } finally {
      pendingSaveCount = Math.max(0, pendingSaveCount - 1);
    }
  }

  function dispose(): void {
    saveTicket += 1;
  }

  return {
    draftRef,
    persistedRef,
    commit,
    syncPersisted,
    update,
    runSave,
    pendingSaveCount: () => pendingSaveCount,
    dispose,
  };
}
