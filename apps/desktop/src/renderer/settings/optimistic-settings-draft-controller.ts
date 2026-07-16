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

export interface OptimisticDraftController<T> {
  readonly draftRef: { current: T };
  /** Sync immediately when idle, or defer until the final pending save settles. */
  syncPersisted(persisted: T): void;
  /** Optimistically apply `patch`, persist it, and reconcile last-write-wins. */
  update(patch: Partial<T>): Promise<boolean>;
  /** Invalidate any in-flight save's late write (call on unmount). */
  dispose(): void;
}

export interface OptimisticDraftControllerDeps<T> {
  initial: T;
  onUpdate(patch: Partial<T>): Promise<T>;
  onDraftChange(draft: T): void;
  onReconcile?(draft: T): void;
  onError?(error: unknown): void;
  onSavingChange?(saving: boolean): void;
  isMounted(): boolean;
}

export function createOptimisticDraftController<T>(
  deps: OptimisticDraftControllerDeps<T>,
): OptimisticDraftController<T> {
  const draftRef = { current: deps.initial };
  const authoritativeRef = { current: deps.initial };
  let pendingSaveCount = 0;
  let saveTicket = 0;
  let confirmedSaveTicket = 0;
  let disposed = false;

  function commit(next: T): void {
    draftRef.current = next;
    deps.onDraftChange(next);
  }

  function reconcile(next: T): void {
    commit(next);
    deps.onReconcile?.(next);
  }

  function isCurrent(ticket: number): boolean {
    return !disposed && deps.isMounted() && ticket === saveTicket;
  }

  function syncPersisted(persisted: T): void {
    if (disposed) return;
    authoritativeRef.current = persisted;
    if (pendingSaveCount === 0) {
      reconcile(persisted);
    }
  }

  async function update(patch: Partial<T>): Promise<boolean> {
    if (disposed) return false;
    const nextDraft = { ...draftRef.current, ...patch } as T;
    saveTicket += 1;
    pendingSaveCount += 1;
    const ticket = saveTicket;
    commit(nextDraft);
    if (pendingSaveCount === 1 && deps.isMounted()) {
      deps.onSavingChange?.(true);
    }
    try {
      const next = await deps.onUpdate(patch);
      if (!disposed && ticket > confirmedSaveTicket) {
        confirmedSaveTicket = ticket;
        authoritativeRef.current = next;
      }
      if (isCurrent(ticket)) {
        reconcile(next);
      }
      return isCurrent(ticket);
    } catch (error) {
      if (isCurrent(ticket)) {
        reconcile(authoritativeRef.current);
        deps.onError?.(error);
      }
      return false;
    } finally {
      pendingSaveCount = Math.max(0, pendingSaveCount - 1);
      if (!disposed && pendingSaveCount === 0 && deps.isMounted()) {
        if (draftRef.current !== authoritativeRef.current) {
          reconcile(authoritativeRef.current);
        }
        deps.onSavingChange?.(false);
      }
    }
  }

  function dispose(): void {
    disposed = true;
    saveTicket += 1;
  }

  return {
    draftRef,
    syncPersisted,
    update,
    dispose,
  };
}
