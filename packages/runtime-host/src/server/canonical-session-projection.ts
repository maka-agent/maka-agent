import type { SessionHeader } from "@maka/core/session";
import type {
	ExecutionStoresWriter,
	RootTurnAdmission,
} from "@maka/storage/execution-stores";
import {
	readCanonicalTurnSnapshot,
	type CanonicalTurnSnapshotStores,
} from "./canonical-turn-snapshot.js";
import type {
	CanonicalSessionProjection,
	ReadCanonicalSessionProjection,
} from "./session-continuity-coordinator.js";

interface RootTurnAdmissionIdentity {
	turnId: string;
	runId: string;
	userMessageId: string;
	previousRootTurnId: string | null;
	admittedAt: number;
}

type CanonicalSessionProjectionStores = CanonicalTurnSnapshotStores & {
	readonly sessionStore: Pick<
		ExecutionStoresWriter<"interactive">["sessionStore"],
		"readHeaderSnapshot"
	>;
	readonly agentRunStore: CanonicalTurnSnapshotStores["agentRunStore"] &
		Pick<
			ExecutionStoresWriter<"interactive">["agentRunStore"],
			"readRootTurnAdmission"
		>;
};

export interface DurableRootAdmissionIndex {
	record(admission: RootTurnAdmission): void;
	currentRootTurnId(sessionId: string): string | null;
	installRecoveryChain(
		sessionId: string,
		admissions: readonly RootTurnAdmission[],
	): void;
}

export interface CanonicalSessionProjectionReader {
	readonly read: ReadCanonicalSessionProjection;
	readonly rootAdmissions: DurableRootAdmissionIndex;
}

export function createCanonicalSessionProjectionReader(
	stores: CanonicalSessionProjectionStores,
): CanonicalSessionProjectionReader {
	const latestAdmissions = new Map<string, RootTurnAdmissionIdentity>();
	const installedRecoverySessions = new Set<string>();
	const rootAdmissions = {
		record(admission: RootTurnAdmission): void {
			const current = latestAdmissions.get(admission.sessionId);
			if (current?.turnId === admission.turnId) {
				if (!sameAdmissionIdentity(admission, current)) {
					throw new Error(
						"Root Turn admission identity changed within one Epoch",
					);
				}
				return;
			}
			const expectedPreviousRootTurnId = current?.turnId ?? null;
			if (admission.previousRootTurnId !== expectedPreviousRootTurnId) {
				throw new Error(
					"Root Turn admission does not extend the canonical chain",
				);
			}
			latestAdmissions.set(admission.sessionId, admissionIdentity(admission));
		},
		currentRootTurnId(sessionId: string): string | null {
			return latestAdmissions.get(sessionId)?.turnId ?? null;
		},
		installRecoveryChain(
			sessionId: string,
			admissions: readonly RootTurnAdmission[],
		): void {
			if (installedRecoverySessions.has(sessionId)) {
				throw new Error("Root Turn recovery chain was already installed");
			}
			let previousRootTurnId: string | null = null;
			const seen = new Set<string>();
			for (const admission of admissions) {
				if (admission.sessionId !== sessionId) {
					throw new Error("Root Turn recovery chain crosses Sessions");
				}
				if (seen.has(admission.turnId)) {
					throw new Error("Root Turn recovery chain repeats an admission");
				}
				if (admission.previousRootTurnId !== previousRootTurnId) {
					throw new Error("Root Turn recovery chain is not contiguous");
				}
				seen.add(admission.turnId);
				previousRootTurnId = admission.turnId;
			}
			const tip = admissions.at(-1);
			if (tip) latestAdmissions.set(sessionId, admissionIdentity(tip));
			installedRecoverySessions.add(sessionId);
		},
	} satisfies DurableRootAdmissionIndex;
	return {
		read: async (sessionId) => {
			const session = await readSessionHeaderIfPresent(stores, sessionId);
			if (!session) return null;
			const indexedAdmission = latestAdmissions.get(sessionId);
			const latest = indexedAdmission
				? await stores.agentRunStore.readRootTurnAdmission(
						sessionId,
						indexedAdmission.turnId,
					)
				: undefined;
			if (indexedAdmission && !latest) {
				throw new Error("Indexed root Turn admission is not durable");
			}
			if (latest && !sameAdmissionIdentity(latest, indexedAdmission)) {
				throw new Error("Durable root Turn admission identity changed");
			}
			return {
				session: sessionIdentity(session),
				rootTurn: latest
					? await readCanonicalTurnSnapshot(
							stores,
							latest.sessionId,
							latest.turnId,
							latest.runId,
						)
					: null,
			};
		},
		rootAdmissions,
	};
}

function admissionIdentity(
	admission: RootTurnAdmission,
): RootTurnAdmissionIdentity {
	return {
		turnId: admission.turnId,
		runId: admission.runId,
		userMessageId: admission.userMessageId,
		previousRootTurnId: admission.previousRootTurnId,
		admittedAt: admission.admittedAt,
	};
}

function sameAdmissionIdentity(
	admission: RootTurnAdmission,
	identity: RootTurnAdmissionIdentity | undefined,
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

function sessionIdentity(
	header: SessionHeader,
): CanonicalSessionProjection["session"] {
	return {
		sessionId: header.id,
		status: header.status,
		createdAt: header.createdAt,
		lastUsedAt: header.lastUsedAt,
		isArchived: header.isArchived,
		...(header.archivedAt === undefined
			? {}
			: { archivedAt: header.archivedAt }),
	};
}

async function readSessionHeaderIfPresent(
	stores: CanonicalSessionProjectionStores,
	sessionId: string,
): Promise<SessionHeader | undefined> {
	try {
		return await stores.sessionStore.readHeaderSnapshot(sessionId);
	} catch (error) {
		if (isMissingFile(error)) return undefined;
		throw error;
	}
}

function isMissingFile(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "ENOENT"
	);
}
