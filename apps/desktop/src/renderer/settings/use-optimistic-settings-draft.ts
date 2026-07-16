import { useEffect, useRef, useState } from 'react';
import { useMountedRef } from '@maka/ui';
import type { RefObject } from 'react';
import {
  createOptimisticDraftController,
  type OptimisticDraftController,
  type OptimisticUpdateOptions,
  type RunSaveHelpers,
} from './optimistic-settings-draft-controller';

export type { OptimisticUpdateOptions, RunSaveHelpers } from './optimistic-settings-draft-controller';

/**
 * Shared optimistic last-write-wins draft for Settings pages.
 *
 * Several Settings pages (network proxy, open gateway, usage, personalization)
 * had each hand-copied the same block: a local draft mirrored on a ref, a
 * `persistedRef`, a `pendingSaveCount`, a monotonic `saveTicket`, a
 * `commitDraft` helper, and a prop→state sync effect. This hook owns that
 * machinery once (via `createOptimisticDraftController`) so no page reinvents
 * the async-correctness contract. The pure controller carries the logic and is
 * unit-tested without a React renderer; this hook is the thin shell that wires
 * it to React state + `useMountedRef`.
 */

export interface UseOptimisticSettingsDraftOptions<T> {
  /** Extra side-effect run when the persisted value syncs into the draft. */
  onSyncPersisted?(persisted: T): void;
}

export interface OptimisticSettingsDraft<T> {
  draft: T;
  draftRef: { current: T };
  persistedRef: { current: T };
  mountedRef: RefObject<boolean>;
  commit(next: T): void;
  update(patch: Partial<T>, options?: OptimisticUpdateOptions<T>): Promise<boolean>;
  runSave<R>(run: (helpers: RunSaveHelpers) => Promise<R>): Promise<R>;
  /** The narrowed persist call, for use inside a `runSave` block. */
  persist(patch: Partial<T>): Promise<T>;
  pendingSaveCount(): number;
}

export function useOptimisticSettingsDraft<T>(
  persisted: T,
  onUpdate: (patch: Partial<T>) => Promise<T>,
  options?: UseOptimisticSettingsDraftOptions<T>,
): OptimisticSettingsDraft<T> {
  const mountedRef = useMountedRef();
  const [draft, setDraft] = useState<T>(persisted);
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;
  const onSyncPersistedRef = useRef(options?.onSyncPersisted);
  onSyncPersistedRef.current = options?.onSyncPersisted;

  const controllerRef = useRef<OptimisticDraftController<T> | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = createOptimisticDraftController<T>({
      initial: persisted,
      onUpdate: (patch) => onUpdateRef.current(patch),
      onDraftChange: setDraft,
      isMounted: () => mountedRef.current === true,
    });
  }
  const controller = controllerRef.current;

  useEffect(() => {
    controller.syncPersisted(persisted, onSyncPersistedRef.current);
    // Sync is intentionally keyed on the persisted value alone; the callback
    // is read from a ref so it never re-triggers the effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persisted]);

  useEffect(() => {
    return () => {
      controller.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    draft,
    draftRef: controller.draftRef,
    persistedRef: controller.persistedRef,
    mountedRef,
    commit: controller.commit,
    update: controller.update,
    runSave: controller.runSave,
    persist: (patch) => onUpdateRef.current(patch),
    pendingSaveCount: controller.pendingSaveCount,
  };
}
