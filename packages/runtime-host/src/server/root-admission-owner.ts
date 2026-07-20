import type { RootTurnAdmission } from '@maka/storage/execution-stores';

export interface RootAdmissionIdentity {
  readonly turnId: string;
  readonly runId: string;
  readonly userMessageId: string;
  readonly previousRootTurnId: string | null;
  readonly admittedAt: number;
}

export interface RootAdmissionReader {
  readonly latestAdmission: (sessionId: string) => RootAdmissionIdentity | undefined;
}

export interface RootAdmissionWriter {
  readonly previousRootTurnIdForNextAdmission: (sessionId: string) => string | null;
  readonly record: (admission: RootTurnAdmission) => void;
  readonly installRecoveryTip: (sessionId: string, tip: RootTurnAdmission | undefined) => void;
}

export class RootAdmissionOwner {
  readonly reader: RootAdmissionReader;
  readonly writer: RootAdmissionWriter;

  readonly #latestAdmissions = new Map<string, RootAdmissionIdentity>();
  readonly #installedRecoverySessions = new Set<string>();

  constructor() {
    this.reader = Object.freeze({
      latestAdmission: (sessionId: string) => this.#latestAdmissions.get(sessionId),
    });
    this.writer = Object.freeze({
      previousRootTurnIdForNextAdmission: (sessionId: string) =>
        this.#latestAdmissions.get(sessionId)?.turnId ?? null,
      record: (admission: RootTurnAdmission) => this.#record(admission),
      installRecoveryTip: (sessionId: string, tip: RootTurnAdmission | undefined) =>
        this.#installRecoveryTip(sessionId, tip),
    });
  }

  #record(admission: RootTurnAdmission): void {
    const current = this.#latestAdmissions.get(admission.sessionId);
    if (current?.turnId === admission.turnId) {
      if (!sameRootAdmissionIdentity(admission, current)) {
        throw new Error('Root Turn admission identity changed within one Epoch');
      }
      return;
    }
    const expectedPreviousRootTurnId = current?.turnId ?? null;
    if (admission.previousRootTurnId !== expectedPreviousRootTurnId) {
      throw new Error('Root Turn admission does not extend the canonical chain');
    }
    this.#latestAdmissions.set(admission.sessionId, rootAdmissionIdentity(admission));
  }

  #installRecoveryTip(sessionId: string, tip: RootTurnAdmission | undefined): void {
    if (this.#installedRecoverySessions.has(sessionId)) {
      throw new Error('Root Turn recovery tip was already installed');
    }
    if (tip) {
      this.#latestAdmissions.set(sessionId, rootAdmissionIdentity(tip));
    }
    this.#installedRecoverySessions.add(sessionId);
  }
}

export function sameRootAdmissionIdentity(
  admission: RootTurnAdmission,
  identity: RootAdmissionIdentity | undefined,
): boolean {
  return (
    identity !== undefined &&
    admission.turnId === identity.turnId &&
    admission.runId === identity.runId &&
    admission.userMessageId === identity.userMessageId &&
    admission.previousRootTurnId === identity.previousRootTurnId &&
    admission.admittedAt === identity.admittedAt
  );
}

function rootAdmissionIdentity(admission: RootTurnAdmission): RootAdmissionIdentity {
  return Object.freeze({
    turnId: admission.turnId,
    runId: admission.runId,
    userMessageId: admission.userMessageId,
    previousRootTurnId: admission.previousRootTurnId,
    admittedAt: admission.admittedAt,
  });
}
