import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	resolveRootControlNamespace,
	resolveStorageRoot,
	tryAcquireInteractiveRootOwner,
} from "@maka/storage/root-authority";
import {
	connectRuntimeHost,
	type RuntimeHostConnection,
} from "../client/index.js";
import {
	decodeHostFrame,
	RUNTIME_HOST_PROTOCOL_VERSION,
	type TurnSnapshot,
} from "../protocol/index.js";
import {
	RuntimeHostKernel,
	type RuntimeHostComposition,
} from "../server/index.js";
import { RuntimeHostConnectionSession } from "../server/connection-session.js";
import {
	combineDomainOperationHandlers,
	createUnavailableDomainOperationHandlers,
	type OperationHandlerMap,
	type TurnOperationHandlerMap,
} from "../server/operation-dispatcher.js";
import { SessionContinuityCoordinator } from "../server/session-continuity-coordinator.js";
import { FramedTransport } from "../transport/framed-transport.js";

const CURRENT_PROTOCOL = {
	min: RUNTIME_HOST_PROTOCOL_VERSION,
	max: RUNTIME_HOST_PROTOCOL_VERSION,
} as const;

type TurnQueryHandler = RuntimeHostComposition["handlers"]["turn.query"];

test("concurrent responses remain framed and correlated in reverse completion order", async () => {
	const requestCount = 16;
	const entered = Array.from({ length: requestCount }, () => deferred());
	const release = Array.from({ length: requestCount }, () => deferred());
	await withRuntimeHost(
		async (input) => {
			const index = Number(input.turnId.slice("turn-".length));
			entered[index]?.resolve();
			await release[index]?.promise;
			return {
				ok: true,
				result: runningSnapshot(input.sessionId, input.turnId),
			};
		},
		async ({ connectClient }) => {
			const client = await connectClient();
			const requests = Array.from({ length: requestCount }, (_, index) =>
				client.queryTurn(
					{ sessionId: "session", turnId: `turn-${index}` },
					5_000,
				),
			);
			try {
				await withTimeout(
					Promise.all(entered.map((item) => item.promise)),
					1_000,
					"concurrent handlers were not all admitted",
				);

				for (let index = requestCount - 1; index >= 0; index -= 1) {
					release[index]?.resolve();
					const result = await requests[index];
					assert.equal(result?.turnId, `turn-${index}`);
					assert.equal(result?.runId, `run-turn-${index}`);
				}
				const results = await Promise.all(requests);
				assert.deepEqual(
					results.map((result) => result.turnId),
					Array.from({ length: requestCount }, (_, index) => `turn-${index}`),
				);
			} finally {
				for (const gate of release) gate.resolve();
				await Promise.allSettled(requests);
			}
		},
	);
});

test("an admitted operation settles without connection or residency leakage after disconnect", async () => {
	const handlerEntered = deferred();
	const releaseHandler = deferred();
	const handlerSettled = deferred();
	await withRuntimeHost(
		async (input, context) => {
			const residency = context.acquireResidency();
			handlerEntered.resolve();
			try {
				await releaseHandler.promise;
				return {
					ok: true,
					result: runningSnapshot(input.sessionId, input.turnId),
				};
			} finally {
				residency.release();
				handlerSettled.resolve();
			}
		},
		async ({ connectClient }) => {
			const client = await connectClient();
			const requestFailure = client
				.queryTurn({ sessionId: "session", turnId: "disconnect" }, 5_000)
				.then(
					() => undefined,
					(error: unknown) => error,
				);
			try {
				await withTimeout(
					handlerEntered.promise,
					1_000,
					"handler was not admitted",
				);
				await client.close();
				releaseHandler.resolve();
				await withTimeout(
					handlerSettled.promise,
					1_000,
					"handler did not settle after disconnect",
				);
				assert.ok((await requestFailure) instanceof Error);

				const observer = await connectClient();
				const status = await waitForStatus(
					observer,
					(value) =>
						value.connections === 1 &&
						value.activeOperations === 1 &&
						value.activeResidencies === 0,
				);
				assert.equal(status.connections, 1);
				assert.equal(status.activeOperations, 1);
				assert.equal(status.activeResidencies, 0);
			} finally {
				releaseHandler.resolve();
				await client.close().catch(() => undefined);
				await Promise.allSettled([requestFailure]);
			}
		},
	);
});

test("a duplicate active request id tears down only the offending connection", async () => {
	const handlerEntered = deferred();
	const releaseHandler = deferred();
	let handlerCalls = 0;
	await withRuntimeHost(
		async (input) => {
			handlerCalls += 1;
			handlerEntered.resolve();
			await releaseHandler.promise;
			return {
				ok: true,
				result: runningSnapshot(input.sessionId, input.turnId),
			};
		},
		async ({ connectClient, endpoint }) => {
			const transport = await openAcceptedTransport(
				endpoint,
				"duplicate-request-client",
			);
			try {
				await transport.write({
					requestId: "duplicate-request",
					operation: "turn.query",
					input: { sessionId: "session", turnId: "first" },
				});
				await withTimeout(
					handlerEntered.promise,
					1_000,
					"first request was not admitted",
				);
				await transport.write({
					requestId: "duplicate-request",
					operation: "turn.query",
					input: { sessionId: "session", turnId: "second" },
				});
				await withTimeout(
					transport.closed,
					1_000,
					"duplicate request id did not close its connection",
				);
				assert.equal(handlerCalls, 1);
			} finally {
				releaseHandler.resolve();
				transport.destroy();
			}

			const observer = await connectClient();
			const status = await waitForStatus(
				observer,
				(value) =>
					value.connections === 1 &&
					value.activeOperations === 1 &&
					value.activeResidencies === 0,
			);
			assert.equal(status.state, "ready");
		},
	);
});

test("a sixty-fifth in-flight request tears down only the overflowing connection", async () => {
	const releaseHandlers = deferred();
	await withRuntimeHost(
		async (input) => {
			await releaseHandlers.promise;
			return {
				ok: true,
				result: runningSnapshot(input.sessionId, input.turnId),
			};
		},
		async ({ connectClient, endpoint }) => {
			const transport = await openAcceptedTransport(
				endpoint,
				"overflowing-client",
			);
			const observer = await connectClient();
			try {
				const requests = Array.from({ length: 64 }, (_, index) =>
					JSON.stringify({
						requestId: `overflow-${index}`,
						operation: "turn.query",
						input: { sessionId: "session", turnId: `turn-${index}` },
					}),
				).join("\n");
				transport.socket.write(`${requests}\n`);
				await waitForStatus(
					observer,
					(value) =>
						value.connections === 2 &&
						value.activeOperations === 65 &&
						value.activeResidencies === 0,
				);
				await transport.write({
					requestId: "overflow-64",
					operation: "turn.query",
					input: { sessionId: "session", turnId: "turn-64" },
				});
				await withTimeout(
					transport.closed,
					1_000,
					"in-flight overflow did not close its connection",
				);
			} finally {
				releaseHandlers.resolve();
				transport.destroy();
			}

			const status = await waitForStatus(
				observer,
				(value) =>
					value.connections === 1 &&
					value.activeOperations === 1 &&
					value.activeResidencies === 0,
			);
			assert.equal(status.state, "ready");
		},
	);
});

test("disconnect while operation admission is pending cannot attach phantom continuity", async () => {
	const base = await mkdtemp(join(tmpdir(), "maka-runtime-session-admission-"));
	const continuity = new SessionContinuityCoordinator(
		"host-epoch",
		async (sessionId) => ({
			session: {
				sessionId,
				status: "running",
				createdAt: 1,
				lastUsedAt: 1,
				isArchived: false,
			},
			rootTurn: runningSnapshot(sessionId, "turn"),
		}),
	);
	const handlers = createConnectionHandlers(continuity);
	const admissionEntered = deferred();
	const releaseAdmission = deferred();
	const firstTeardown = deferred();
	const firstPair = await openTransportPair(base, "first");
	const firstSession = new RuntimeHostConnectionSession({
		transport: firstPair.serverTransport,
		connection: {
			hostEpoch: "host-epoch",
			connectionId: "reused-connection",
			surface: "tui",
			principal: "local_os_user",
		},
		resolveHandlers: () => handlers,
		resolveContinuity: () => continuity,
		beginOperation: async () => {
			admissionEntered.resolve();
			await releaseAdmission.promise;
			return {
				acquireResidency: () => ({ release() {} }),
				seal() {},
				finish() {},
			};
		},
		onTeardown: () => firstTeardown.resolve(),
	});
	const firstRun = firstSession.run();
	let secondPair: TransportPair | undefined;
	let secondRun: Promise<void> | undefined;
	try {
		await firstPair.clientTransport.write({
			requestId: "pending-open",
			operation: "subscription.open",
			input: { sessionId: "session" },
		});
		await withTimeout(
			admissionEntered.promise,
			1_000,
			"subscription.open did not reach operation admission",
		);
		firstPair.clientTransport.destroy();
		await withTimeout(
			firstTeardown.promise,
			1_000,
			"connection did not tear down while admission was pending",
		);
		releaseAdmission.resolve();
		await withTimeout(
			firstRun,
			1_000,
			"connection session did not settle after admission release",
		);
		secondPair = await openTransportPair(base, "second");
		const secondSession = new RuntimeHostConnectionSession({
			transport: secondPair.serverTransport,
			connection: {
				hostEpoch: "host-epoch",
				connectionId: "reused-connection",
				surface: "tui",
				principal: "local_os_user",
			},
			resolveHandlers: () => handlers,
			resolveContinuity: () => continuity,
			beginOperation: async () => ({
				acquireResidency: () => ({ release() {} }),
				seal() {},
				finish() {},
			}),
			onTeardown() {},
		});
		secondRun = secondSession.run();
		await secondPair.clientTransport.write({
			requestId: "open-after-disconnect",
			operation: "subscription.open",
			input: { sessionId: "session" },
		});
		const response = decodeHostFrame(
			await secondPair.clientTransport.read(1_000),
		);
		if ("kind" in response || response.operation !== "subscription.open") {
			assert.fail("Expected a subscription.open response");
		}
		if (!response.ok) assert.fail(response.error.message);
		assert.equal(response.result.snapshot.projectionRevision, 1);

		await continuity.acceptAssistantDelta("session", "run-turn", {
			type: "text_delta",
			turnId: "turn",
			messageId: "message",
			text: "attached-after-disconnect",
		});
		const delta = decodeHostFrame(await secondPair.clientTransport.read(1_000));
		if (!("kind" in delta) || delta.kind !== "subscription.session_delta") {
			assert.fail("Expected continuity delivery on the replacement session");
		}
		assert.equal(delta.delta.text, "attached-after-disconnect");
	} finally {
		releaseAdmission.resolve();
		firstPair.clientTransport.destroy();
		secondPair?.clientTransport.destroy();
		await Promise.allSettled([firstRun, secondRun]);
		continuity.close();
		await Promise.allSettled([firstPair.close(), secondPair?.close()]);
		await rm(base, { recursive: true, force: true });
	}
});

interface RuntimeHostTestFixture {
	connectClient(): Promise<RuntimeHostConnection>;
	endpoint: string;
}

async function withRuntimeHost(
	queryTurn: TurnQueryHandler,
	run: (fixture: RuntimeHostTestFixture) => Promise<void>,
): Promise<void> {
	const base = await mkdtemp(join(tmpdir(), "maka-runtime-host-continuity-"));
	const root = join(base, "root");
	const capability = await resolveStorageRoot({
		path: root,
		kind: "interactive",
	});
	const owner = await tryAcquireInteractiveRootOwner(capability);
	assert.ok(owner);
	const connections = new Set<RuntimeHostConnection>();
	const host = await RuntimeHostKernel.start({
		owner,
		idleGraceMs: 10_000,
		compositionFactory: async () => ({
			handlers: createHandlers(queryTurn),
			async recover() {},
			async close() {},
		}),
	});
	try {
		await run({
			endpoint: host.endpoint,
			connectClient: async () => {
				const result = await connectRuntimeHost({
					rootPath: root,
					surface: "tui",
					protocol: CURRENT_PROTOCOL,
				});
				assert.equal(result.kind, "connected");
				connections.add(result.connection);
				return result.connection;
			},
		});
	} finally {
		await Promise.allSettled(
			[...connections].map((connection) => connection.close()),
		);
		await host.close();
		await rm(join(resolveRootControlNamespace(), capability.rootId), {
			recursive: true,
			force: true,
		});
		await rm(base, { recursive: true, force: true });
	}
}

async function openAcceptedTransport(
	endpoint: string,
	clientInstanceId: string,
): Promise<FramedTransport> {
	const socket = connect(endpoint);
	await new Promise<void>((resolve, reject) => {
		socket.once("connect", resolve);
		socket.once("error", reject);
	});
	const transport = new FramedTransport(socket);
	await transport.write({
		kind: "hello",
		clientInstanceId,
		surface: "tui",
		protocolMin: CURRENT_PROTOCOL.min,
		protocolMax: CURRENT_PROTOCOL.max,
	});
	const handshake = decodeHostFrame(await transport.read(1_000));
	assert.ok("kind" in handshake);
	assert.equal(handshake.kind, "accepted");
	return transport;
}

function createHandlers(
	queryTurn: TurnQueryHandler,
): RuntimeHostComposition["handlers"] {
	const turnHandlers = createTurnHandlers(queryTurn);
	const unavailable = createUnavailableDomainOperationHandlers();
	return combineDomainOperationHandlers(turnHandlers, {
		"subscription.open": unavailable["subscription.open"],
		"subscription.close": unavailable["subscription.close"],
	});
}

function createTurnHandlers(
	queryTurn: TurnQueryHandler,
): TurnOperationHandlerMap {
	return {
		"turn.start": async (input) => ({
			ok: true,
			result: runningSnapshot(input.sessionId, input.turnId),
		}),
		"turn.query": queryTurn,
		"turn.stop": async (input) => ({
			ok: true,
			result: runningSnapshot(input.sessionId, input.turnId),
		}),
	};
}

function createConnectionHandlers(
	continuity: SessionContinuityCoordinator,
): OperationHandlerMap {
	const queryTurn: TurnQueryHandler = async (input) => ({
		ok: true,
		result: runningSnapshot(input.sessionId, input.turnId),
	});
	return {
		"host.status": async () => ({
			ok: true,
			result: {
				hostEpoch: "host-epoch",
				state: "ready",
				connections: 1,
				activeOperations: 0,
				activeResidencies: 0,
			},
		}),
		...combineDomainOperationHandlers(
			createTurnHandlers(queryTurn),
			continuity.handlers,
		),
	};
}

interface TransportPair {
	clientTransport: FramedTransport;
	serverTransport: FramedTransport;
	close(): Promise<void>;
}

async function openTransportPair(
	directory: string,
	name: string,
): Promise<TransportPair> {
	const listener = createServer();
	const endpoint = join(directory, `${name}.sock`);
	const accepted = new Promise<Socket>((resolve) => {
		listener.once("connection", resolve);
	});
	await listen(listener, endpoint);
	const clientSocket = connect(endpoint);
	await new Promise<void>((resolve, reject) => {
		clientSocket.once("connect", resolve);
		clientSocket.once("error", reject);
	});
	const serverSocket = await accepted;
	const clientTransport = new FramedTransport(clientSocket);
	const serverTransport = new FramedTransport(serverSocket);
	return {
		clientTransport,
		serverTransport,
		close: async () => {
			clientTransport.destroy();
			serverTransport.destroy();
			await Promise.all([clientTransport.closed, serverTransport.closed]);
			await closeServer(listener);
		},
	};
}

function listen(server: Server, endpoint: string): Promise<void> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(endpoint, resolve);
	});
}

function closeServer(server: Server): Promise<void> {
	if (!server.listening) return Promise.resolve();
	return new Promise((resolve, reject) => {
		server.close((error) => {
			if (error) reject(error);
			else resolve();
		});
	});
}

function runningSnapshot(sessionId: string, turnId: string): TurnSnapshot {
	return {
		sessionId,
		turnId,
		runId: `run-${turnId}`,
		status: "running",
	};
}

async function waitForStatus(
	connection: RuntimeHostConnection,
	predicate: (
		status: Awaited<ReturnType<RuntimeHostConnection["status"]>>,
	) => boolean,
): Promise<Awaited<ReturnType<RuntimeHostConnection["status"]>>> {
	const deadline = Date.now() + 1_000;
	let status = await connection.status(1_000);
	while (!predicate(status) && Date.now() < deadline) {
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
		status = await connection.status(1_000);
	}
	assert.equal(
		predicate(status),
		true,
		"Host operation counters did not settle",
	);
	return status;
}

interface Deferred {
	promise: Promise<void>;
	resolve(): void;
}

function deferred(): Deferred {
	let resolve!: () => void;
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

async function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	message: string,
): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(message)), timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
