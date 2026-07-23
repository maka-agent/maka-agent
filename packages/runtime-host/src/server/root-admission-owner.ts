import type {
  AdmitRootTurnInput,
  AdmitRootTurnResult,
  RootTurnAdmission,
  RootTurnAdmissionStore,
} from '@maka/storage/execution-stores';

type OwnedAdmitRootTurnInput = Omit<AdmitRootTurnInput, 'previousRootTurnId'>;

export class RootAdmissionOwner {
  readonly #admissionsBySession = new Map<string, Map<string, RootTurnAdmission>>();
  readonly #tips = new Map<string, RootTurnAdmission>();
  readonly #poisonedSessions = new Set<string>();

  constructor(private readonly store: RootTurnAdmissionStore) {}

  assertKnownAdmission(admission: RootTurnAdmission): void {
    const known = this.#admissionsBySession.get(admission.sessionId)?.get(admission.turnId);
    if (!known || !sameRootAdmission(known, admission)) {
      throw new Error('Root Turn admission identity changed within one Host Epoch');
    }
  }

  async recoverSession(sessionId: string): Promise<readonly RootTurnAdmission[]> {
    if (this.#admissionsBySession.has(sessionId)) {
      throw new Error(`Root Turn recovery chain was already installed for Session ${sessionId}`);
    }
    const admissions = await this.store.listRootTurnAdmissionsForRecovery(sessionId);
    const snapshots = admissions.map(snapshotAdmission);
    const byTurnId = new Map<string, RootTurnAdmission>();
    for (const admission of snapshots) byTurnId.set(admission.turnId, admission);
    this.#admissionsBySession.set(sessionId, byTurnId);
    const tip = snapshots.at(-1);
    if (tip) this.#tips.set(sessionId, tip);
    return snapshots;
  }

  async admitRootTurn(input: OwnedAdmitRootTurnInput): Promise<AdmitRootTurnResult> {
    if (this.#poisonedSessions.has(input.sessionId)) {
      throw new Error(`Root Turn admission state is uncertain for Session ${input.sessionId}`);
    }
    const current = this.#tips.get(input.sessionId);
    try {
      const result = await this.store.admitRootTurn({
        ...input,
        previousRootTurnId: current?.turnId ?? null,
      });
      const admission = result.admission;
      if (
        admission.sessionId !== input.sessionId ||
        admission.turnId !== input.turnId ||
        admission.previousRootTurnId !== (current?.turnId ?? null)
      ) {
        throw new Error('Durable Root Turn admission does not extend the owned chain');
      }

      const byTurnId = this.#admissionsBySession.get(input.sessionId) ?? new Map();
      const known = byTurnId.get(admission.turnId);
      if (known && !sameRootAdmission(known, admission)) {
        throw new Error('Root Turn admission identity changed within one Host Epoch');
      }
      const snapshot = snapshotAdmission(admission);
      byTurnId.set(admission.turnId, snapshot);
      this.#admissionsBySession.set(input.sessionId, byTurnId);
      this.#tips.set(input.sessionId, snapshot);
      return result;
    } catch (error) {
      this.#poisonedSessions.add(input.sessionId);
      throw error;
    }
  }
}

function sameRootAdmission(left: RootTurnAdmission, right: RootTurnAdmission): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.sessionId === right.sessionId &&
    left.turnId === right.turnId &&
    left.runId === right.runId &&
    left.userMessageId === right.userMessageId &&
    left.previousRootTurnId === right.previousRootTurnId &&
    left.normalizedInput.text === right.normalizedInput.text &&
    left.admittedAt === right.admittedAt
  );
}

function snapshotAdmission(admission: RootTurnAdmission): RootTurnAdmission {
  return Object.freeze({
    ...admission,
    normalizedInput: Object.freeze({ ...admission.normalizedInput }),
  });
}
