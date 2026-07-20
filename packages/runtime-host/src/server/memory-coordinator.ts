import {
  appendApprovedLocalMemoryEntryDraft,
  appendLocalMemoryProposalDraft,
  approveLocalMemoryProposalDraft,
  findLocalMemoryEntryDraft,
  LOCAL_MEMORY_MAX_BYTES,
  parseLocalMemoryMarkdown,
  rejectLocalMemoryProposalDraft,
  setLocalMemoryEntryStatusDraft,
  stableLocalMemoryEntryId,
  stableLocalMemoryProposalId,
} from '@maka/core/local-memory';
import { normalizeMemoryContent } from '@maka/core/memory';
import { redactSecrets } from '@maka/core/redaction';
import {
  authenticateInteractiveMemoryStoreWriter,
  MemoryRevisionConflictError,
  MemoryStoreError,
  MemoryStoreLifecycleError,
  type InteractiveMemoryStoreWriter,
  type MemoryQueryResult as StoredMemoryQueryResult,
} from '@maka/storage/memory-store';
import {
  RuntimePolicyStoreError,
  type RuntimePolicyReader,
} from '@maka/storage/runtime-policy-stores';
import {
  encodeMemoryMutateResult,
  encodeMemoryQueryResult,
  type MemoryBlockedReason,
  type MemoryMutateInput,
  type MemoryMutateResult,
  type MemoryMutation,
  type MemoryMutationRejectedReason,
  type OperationOutcome,
} from '../protocol/index.js';
import type { MemoryOperationHandlerMap } from './operation-dispatcher.js';

type DraftResult =
  | { readonly ok: true; readonly draft: string }
  | { readonly ok: false; readonly reason: string };

/** Root-scoped Host authority over the canonical, user-visible MEMORY.md document. */
export class HostMemoryCoordinator {
  readonly handlers: MemoryOperationHandlerMap = {
    'memory.query': () => this.#query(),
    'memory.mutate': (input) => this.#mutate(input),
  };

  readonly #store: InteractiveMemoryStoreWriter;

  constructor(
    store: InteractiveMemoryStoreWriter,
    private readonly policy: Readonly<RuntimePolicyReader>,
    private readonly now: () => number = Date.now,
  ) {
    this.#store = authenticateInteractiveMemoryStoreWriter(store);
  }

  async #query(): Promise<OperationOutcome<'memory.query'>> {
    try {
      const blocked = await this.#blockedReason();
      if (blocked) return querySuccess({ kind: 'blocked', reason: blocked });

      const stored = await this.#store.query();
      if (stored.kind === 'missing') {
        return querySuccess({ kind: 'missing', revision: null });
      }
      if (stored.kind === 'safe_mode') {
        return querySuccess({
          kind: 'safe_mode',
          revision: stored.revision,
          reason: stored.reason,
        });
      }

      const content = decodeStoredDocument(stored);
      const parsed = parseLocalMemoryMarkdown(content);
      if (parsed.reason === 'empty') {
        return querySuccess({ kind: 'safe_mode', revision: stored.revision, reason: 'empty' });
      }
      if (parsed.safeMode) {
        return querySuccess({ kind: 'safe_mode', revision: stored.revision, reason: 'oversize' });
      }
      return querySuccess({
        kind: 'document',
        revision: stored.revision,
        contentBase64: Buffer.from(stored.bytes).toString('base64'),
      });
    } catch (error) {
      return queryFailure(error);
    }
  }

  async #mutate(input: MemoryMutateInput): Promise<OperationOutcome<'memory.mutate'>> {
    try {
      const blocked = await this.#blockedReason();
      if (blocked) return mutationSuccess({ kind: 'rejected', reason: blocked });

      if (input.mutation.kind === 'save') {
        return await this.#saveDocument(
          input.expectedRevision,
          Buffer.from(input.mutation.contentBase64, 'base64').toString('utf8'),
        );
      }

      const current = await this.#store.query();
      const actualRevision = current.kind === 'missing' ? null : current.revision;
      if (input.expectedRevision !== actualRevision) {
        return mutationSuccess({
          kind: 'revision_conflict',
          expectedRevision: input.expectedRevision,
          actualRevision,
        });
      }
      if (current.kind !== 'document') {
        return mutationSuccess({ kind: 'rejected', reason: 'invalid_document' });
      }

      const content = decodeStoredDocument(current);
      const parsed = parseLocalMemoryMarkdown(content);
      if (parsed.safeMode || parsed.reason) {
        return mutationSuccess({ kind: 'rejected', reason: 'invalid_document' });
      }

      const draft = this.#applyMutation(content, input.mutation);
      if (!draft.ok) {
        return mutationSuccess({ kind: 'rejected', reason: projectDraftFailure(draft.reason) });
      }
      return await this.#saveDocument(input.expectedRevision, draft.draft);
    } catch (error) {
      return mutationFailure(error);
    }
  }

  #applyMutation(
    current: string,
    mutation: Exclude<MemoryMutation, { readonly kind: 'save' }>,
  ): DraftResult {
    const now = this.now();
    if (mutation.kind === 'propose') {
      const content = normalizeMemoryContent(mutation.content);
      if (!content.ok) return { ok: false, reason: 'invalid_content' };
      return appendLocalMemoryProposalDraft(current, {
        id: stableLocalMemoryProposalId(content.value, now),
        title: mutation.title,
        content: content.value,
        scope: mutation.scope,
        ...(mutation.sourceTurnId === undefined ? {} : { sourceTurnId: mutation.sourceTurnId }),
        proposedAt: now,
      });
    }
    if (mutation.kind === 'remember') {
      const content = normalizeMemoryContent(mutation.content);
      if (!content.ok) return { ok: false, reason: 'invalid_content' };
      return appendApprovedLocalMemoryEntryDraft(current, {
        id: stableLocalMemoryEntryId(content.value, now),
        title: mutation.title,
        content: content.value,
        source: 'user_authored',
        scope: mutation.scope,
        confirmedAt: now,
        approvalSurface: 'manual_editor_save',
      });
    }
    if (mutation.kind === 'approve') {
      const proposal = findLocalMemoryEntryDraft(current, mutation.entryId);
      if (!proposal) return { ok: false, reason: 'not_found' };
      if (proposal.status !== 'proposal') return { ok: false, reason: 'not_pending' };
      if (!normalizeMemoryContent(proposal.content).ok) {
        return { ok: false, reason: 'invalid_content' };
      }
      return approveLocalMemoryProposalDraft(current, {
        id: mutation.entryId,
        confirmedAt: now,
        approvalSurface: 'settings_review_queue',
      });
    }
    if (mutation.kind === 'reject') {
      return rejectLocalMemoryProposalDraft(current, { id: mutation.entryId });
    }
    return setLocalMemoryEntryStatusDraft(current, {
      id: mutation.entryId,
      status: mutation.target,
      now,
      recordLifecycleMetadata: true,
    });
  }

  async #saveDocument(
    expectedRevision: MemoryMutateInput['expectedRevision'],
    content: string,
  ): Promise<OperationOutcome<'memory.mutate'>> {
    const bytes = Buffer.from(redactSecrets(content), 'utf8');
    if (bytes.byteLength > LOCAL_MEMORY_MAX_BYTES) {
      return mutationSuccess({ kind: 'rejected', reason: 'document_too_large' });
    }
    const stored = await this.#store.save({ expectedRevision, bytes });
    return mutationSuccess({
      kind: stored.changed ? 'committed' : 'unchanged',
      revision: stored.document.revision,
    });
  }

  async #blockedReason(): Promise<MemoryBlockedReason | undefined> {
    const snapshot = await this.policy.getSnapshot();
    if (snapshot.policy.privacy.incognitoActive) return 'incognito_active';
    if (!snapshot.policy.memory.enabled) return 'disabled';
    return undefined;
  }
}

function decodeStoredDocument(
  stored: Extract<StoredMemoryQueryResult, { readonly kind: 'document' }>,
): string {
  return Buffer.from(stored.bytes).toString('utf8');
}

function querySuccess(
  result: Parameters<typeof encodeMemoryQueryResult>[0],
): OperationOutcome<'memory.query'> {
  return { ok: true, result: encodeMemoryQueryResult(result) };
}

function mutationSuccess(result: MemoryMutateResult): OperationOutcome<'memory.mutate'> {
  return { ok: true, result: encodeMemoryMutateResult(result) };
}

function projectDraftFailure(reason: string): MemoryMutationRejectedReason {
  switch (reason) {
    case 'empty_title':
    case 'invalid_content':
    case 'invalid_id':
    case 'not_found':
    case 'not_pending':
    case 'invalid_transition':
      return reason;
    case 'empty_content':
      return 'invalid_content';
    case 'oversize':
      return 'document_too_large';
    default:
      throw new Error(`Unknown Memory mutation failure: ${reason}`);
  }
}

function queryFailure(error: unknown): OperationOutcome<'memory.query'> {
  if (error instanceof MemoryStoreLifecycleError) return hostDraining('memory.query');
  if (error instanceof MemoryStoreError || error instanceof RuntimePolicyStoreError) {
    return persistenceFailure('memory.query', 'Memory projection is unavailable');
  }
  throw error;
}

function mutationFailure(error: unknown): OperationOutcome<'memory.mutate'> {
  if (error instanceof MemoryRevisionConflictError) {
    return mutationSuccess({
      kind: 'revision_conflict',
      expectedRevision: error.expectedRevision,
      actualRevision: error.actualRevision,
    });
  }
  if (error instanceof MemoryStoreLifecycleError) return hostDraining('memory.mutate');
  if (error instanceof MemoryStoreError) {
    if (error.code === 'commit_unknown') {
      return {
        ok: false,
        error: {
          code: 'commit_outcome_unknown',
          message: 'MEMORY.md publication outcome is unknown; query before retrying',
        },
      };
    }
    return persistenceFailure('memory.mutate', 'Memory mutation could not be committed');
  }
  if (error instanceof RuntimePolicyStoreError) {
    return persistenceFailure('memory.mutate', 'Memory policy is unavailable');
  }
  throw error;
}

function hostDraining<K extends 'memory.query' | 'memory.mutate'>(
  _operation: K,
): OperationOutcome<K> {
  return {
    ok: false,
    error: { code: 'host_draining', message: 'Runtime Host is draining' },
  } as OperationOutcome<K>;
}

function persistenceFailure<K extends 'memory.query' | 'memory.mutate'>(
  _operation: K,
  message: string,
): OperationOutcome<K> {
  return {
    ok: false,
    error: { code: 'persistence_failed', message },
  } as OperationOutcome<K>;
}
