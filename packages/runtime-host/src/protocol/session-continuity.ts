import { invalidProtocolFrame } from "./errors.js";
import {
	assertAllowedKeys,
	assertExactKeys,
	requireCount,
	requireEntityId,
	requireExactRecord,
	requireId,
	requirePositiveCount,
	requireRecord,
	requireUtf8BoundedString,
} from "./codec.js";
import { defineOperation } from "./operation-spec.js";
import { decodeTurnSnapshot, type TurnSnapshot } from "./turn.js";

export const SESSION_CONTINUITY_SCHEMA_VERSION = 1 as const;
export const SESSION_LIVE_DELTA_MAX_BYTES = 16 * 1024;

export type SessionLifecycleStatus =
	| "active"
	| "running"
	| "waiting_for_user"
	| "blocked"
	| "review"
	| "done"
	| "archived"
	| "aborted";

export interface SessionContinuityIdentity {
	sessionId: string;
	status: SessionLifecycleStatus;
	createdAt: number;
	lastUsedAt: number;
	isArchived: boolean;
	archivedAt?: number;
}

export interface SessionContinuitySnapshot {
	schemaVersion: typeof SESSION_CONTINUITY_SCHEMA_VERSION;
	session: SessionContinuityIdentity;
	projectionRevision: number;
	rootTurn: TurnSnapshot | null;
}

export interface SubscriptionOpenInput {
	sessionId: string;
}

export interface SubscriptionOpenResult {
	hostEpoch: string;
	subscriptionId: string;
	nextSequence: number;
	snapshot: SessionContinuitySnapshot;
}

export interface SubscriptionCloseInput {
	subscriptionId: string;
}

export interface SubscriptionCloseResult {
	subscriptionId: string;
}

interface SubscriptionEnvelope {
	hostEpoch: string;
	subscriptionId: string;
	sequence: number;
}

export interface SessionProjectionFrame extends SubscriptionEnvelope {
	kind: "subscription.session_projection";
	snapshot: SessionContinuitySnapshot;
}

export interface SessionAssistantDelta {
	kind: "text" | "thinking";
	turnId: string;
	runId: string;
	messageId: string;
	text: string;
}

export interface SessionDeltaFrame extends SubscriptionEnvelope {
	kind: "subscription.session_delta";
	sessionId: string;
	delta: SessionAssistantDelta;
}

export interface SubscriptionClosedFrame extends SubscriptionEnvelope {
	kind: "subscription.closed";
	reason: "slow_consumer";
}

export type SubscriptionFrame =
	| SessionProjectionFrame
	| SessionDeltaFrame
	| SubscriptionClosedFrame;

export const SESSION_CONTINUITY_OPERATION_SPECS = {
	"subscription.open": defineOperation({
		mode: "control",
		decodeInput: decodeSubscriptionOpenInput,
		decodeOutput: decodeSubscriptionOpenResult,
		errors: [
			"host_not_ready",
			"host_draining",
			"operation_unavailable",
			"not_found",
			"operation_conflict",
			"internal_failure",
		] as const,
		retry: "none",
		admission: "session",
	}),
	"subscription.close": defineOperation({
		mode: "control",
		decodeInput: decodeSubscriptionCloseInput,
		decodeOutput: decodeSubscriptionCloseResult,
		errors: [
			"host_not_ready",
			"host_draining",
			"operation_unavailable",
			"not_found",
			"internal_failure",
		] as const,
		retry: "safe",
		admission: "session",
	}),
} as const;

export function decodeSubscriptionFrame(value: unknown): SubscriptionFrame {
	const record = requireRecord(value, "subscription frame");
	const envelope = {
		hostEpoch: requireId(record.hostEpoch, "hostEpoch"),
		subscriptionId: requireId(record.subscriptionId, "subscriptionId"),
		sequence: requirePositiveCount(record.sequence, "sequence"),
	};
	if (record.kind === "subscription.session_projection") {
		assertExactKeys(record, "Session projection frame", [
			"kind",
			"hostEpoch",
			"subscriptionId",
			"sequence",
			"snapshot",
		]);
		return {
			kind: record.kind,
			...envelope,
			snapshot: decodeSessionContinuitySnapshot(record.snapshot),
		};
	}
	if (record.kind === "subscription.session_delta") {
		assertExactKeys(record, "Session delta frame", [
			"kind",
			"hostEpoch",
			"subscriptionId",
			"sequence",
			"sessionId",
			"delta",
		]);
		const delta = requireExactRecord(record.delta, "Session assistant delta", [
			"kind",
			"turnId",
			"runId",
			"messageId",
			"text",
		]);
		if (delta.kind !== "text" && delta.kind !== "thinking") {
			throw invalidProtocolFrame("Invalid Session assistant delta kind");
		}
		return {
			kind: record.kind,
			...envelope,
			sessionId: requireEntityId(record.sessionId, "sessionId"),
			delta: {
				kind: delta.kind,
				turnId: requireEntityId(delta.turnId, "turnId"),
				runId: requireEntityId(delta.runId, "runId"),
				messageId: requireEntityId(delta.messageId, "messageId"),
				text: requireUtf8BoundedString(
					delta.text,
					"Session assistant delta text",
					SESSION_LIVE_DELTA_MAX_BYTES,
				),
			},
		};
	}
	if (record.kind === "subscription.closed") {
		assertExactKeys(record, "subscription closed frame", [
			"kind",
			"hostEpoch",
			"subscriptionId",
			"sequence",
			"reason",
		]);
		if (record.reason !== "slow_consumer") {
			throw invalidProtocolFrame("Invalid subscription close reason");
		}
		return { kind: record.kind, ...envelope, reason: record.reason };
	}
	throw invalidProtocolFrame("Unknown subscription frame kind");
}

export function isSubscriptionFrameKind(
	value: unknown,
): value is SubscriptionFrame["kind"] {
	return (
		value === "subscription.session_projection" ||
		value === "subscription.session_delta" ||
		value === "subscription.closed"
	);
}

function decodeSubscriptionOpenInput(value: unknown): SubscriptionOpenInput {
	const record = requireExactRecord(value, "subscription.open input", [
		"sessionId",
	]);
	return { sessionId: requireEntityId(record.sessionId, "sessionId") };
}

function decodeSubscriptionOpenResult(value: unknown): SubscriptionOpenResult {
	const record = requireExactRecord(value, "subscription.open result", [
		"hostEpoch",
		"subscriptionId",
		"nextSequence",
		"snapshot",
	]);
	return {
		hostEpoch: requireId(record.hostEpoch, "hostEpoch"),
		subscriptionId: requireId(record.subscriptionId, "subscriptionId"),
		nextSequence: requirePositiveCount(record.nextSequence, "nextSequence"),
		snapshot: decodeSessionContinuitySnapshot(record.snapshot),
	};
}

function decodeSubscriptionCloseInput(value: unknown): SubscriptionCloseInput {
	const record = requireExactRecord(value, "subscription.close input", [
		"subscriptionId",
	]);
	return { subscriptionId: requireId(record.subscriptionId, "subscriptionId") };
}

function decodeSubscriptionCloseResult(
	value: unknown,
): SubscriptionCloseResult {
	const record = requireExactRecord(value, "subscription.close result", [
		"subscriptionId",
	]);
	return { subscriptionId: requireId(record.subscriptionId, "subscriptionId") };
}

function decodeSessionContinuitySnapshot(
	value: unknown,
): SessionContinuitySnapshot {
	const record = requireExactRecord(value, "Session continuity snapshot", [
		"schemaVersion",
		"session",
		"projectionRevision",
		"rootTurn",
	]);
	if (record.schemaVersion !== SESSION_CONTINUITY_SCHEMA_VERSION) {
		throw invalidProtocolFrame(
			"Unsupported Session continuity snapshot schema",
		);
	}
	const session = decodeSessionContinuityIdentity(record.session);
	const rootTurn =
		record.rootTurn === null ? null : decodeTurnSnapshot(record.rootTurn);
	if (rootTurn !== null && rootTurn.sessionId !== session.sessionId) {
		throw invalidProtocolFrame(
			"Session continuity root Turn belongs to a different Session",
		);
	}
	return {
		schemaVersion: SESSION_CONTINUITY_SCHEMA_VERSION,
		session,
		projectionRevision: requirePositiveCount(
			record.projectionRevision,
			"projectionRevision",
		),
		rootTurn,
	};
}

function decodeSessionContinuityIdentity(
	value: unknown,
): SessionContinuityIdentity {
	const record = requireRecord(value, "Session continuity identity");
	const required = [
		"sessionId",
		"status",
		"createdAt",
		"lastUsedAt",
		"isArchived",
	];
	assertAllowedKeys(record, "Session continuity identity", [
		...required,
		"archivedAt",
	]);
	if (required.some((key) => !Object.hasOwn(record, key))) {
		throw invalidProtocolFrame("Invalid Session continuity identity fields");
	}
	if (typeof record.isArchived !== "boolean") {
		throw invalidProtocolFrame("Invalid Session archived state");
	}
	return {
		sessionId: requireEntityId(record.sessionId, "sessionId"),
		status: requireSessionLifecycleStatus(record.status),
		createdAt: requireCount(record.createdAt, "createdAt"),
		lastUsedAt: requireCount(record.lastUsedAt, "lastUsedAt"),
		isArchived: record.isArchived,
		...(record.archivedAt === undefined
			? {}
			: { archivedAt: requireCount(record.archivedAt, "archivedAt") }),
	};
}

function requireSessionLifecycleStatus(value: unknown): SessionLifecycleStatus {
	if (
		value === "active" ||
		value === "running" ||
		value === "waiting_for_user" ||
		value === "blocked" ||
		value === "review" ||
		value === "done" ||
		value === "archived" ||
		value === "aborted"
	) {
		return value;
	}
	throw invalidProtocolFrame("Invalid Session lifecycle status");
}
