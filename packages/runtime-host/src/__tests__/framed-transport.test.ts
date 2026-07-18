import assert from "node:assert/strict";
import { connect, createServer, type Server, type Socket } from "node:net";
import { test } from "node:test";
import {
	RUNTIME_HOST_MAX_FRAME_BYTES,
	RuntimeHostProtocolError,
} from "../protocol/index.js";
import { FramedTransport } from "../transport/framed-transport.js";

test("fails closed on an oversized unterminated frame over a real socket", async () => {
	await withSocketPair(async (transport, peer) => {
		const read = transport.read(1_000);
		peer.write(Buffer.alloc(RUNTIME_HOST_MAX_FRAME_BYTES + 1, 0x61));
		await assert.rejects(
			read,
			(error: unknown) =>
				error instanceof RuntimeHostProtocolError &&
				error.code === "frame_too_large",
		);
		await transport.closed;
	});
});

async function withSocketPair(
	run: (transport: FramedTransport, peer: Socket) => Promise<void>,
): Promise<void> {
	const accepted = deferred<Socket>();
	const server = createServer(accepted.resolve);
	await listen(server);
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const socket = connect(address.port, "127.0.0.1");
	await onceConnected(socket);
	const peer = await accepted.promise;
	const transport = new FramedTransport(socket);
	try {
		await run(transport, peer);
	} finally {
		transport.destroy();
		peer.destroy();
		await transport.closed;
		await closeServer(server);
	}
}

function listen(server: Server): Promise<void> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
}

function onceConnected(socket: Socket): Promise<void> {
	return new Promise((resolve, reject) => {
		socket.once("connect", resolve);
		socket.once("error", reject);
	});
}

function closeServer(server: Server): Promise<void> {
	if (!server.listening) return Promise.resolve();
	return new Promise((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
	});
}

function deferred<T>(): {
	promise: Promise<T>;
	resolve(value: T | PromiseLike<T>): void;
	reject(error: unknown): void;
} {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}
