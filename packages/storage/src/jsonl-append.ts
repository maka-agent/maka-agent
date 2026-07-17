import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";

const REVERSE_SCAN_CHUNK_BYTES = 64 * 1024;

export interface AppendJsonlOptions {
	requireExistingRecord?: boolean;
}

export async function appendJsonl(
	path: string,
	payload: string,
	options: AppendJsonlOptions = {},
): Promise<void> {
	if (payload.length === 0 || !payload.endsWith("\n")) {
		throw new Error("JSONL append payload must end with a newline");
	}

	const flags =
		constants.O_RDWR |
		constants.O_APPEND |
		(options.requireExistingRecord ? 0 : constants.O_CREAT);
	const handle = await open(path, flags, 0o600);
	try {
		const size = (await handle.stat()).size;
		if (size === 0 && options.requireExistingRecord) {
			throw new Error("Cannot append to an empty JSONL document");
		}

		let separator = "";
		if (size > 0 && !(await endsWithNewline(handle, size))) {
			const tailStart = await findTrailingRecordStart(handle, size);
			const tail = await readRange(handle, tailStart, size);
			if (isCompleteJson(tail)) {
				separator = "\n";
			} else {
				if (tailStart === 0 && options.requireExistingRecord) {
					throw new Error("Cannot repair a truncated JSONL document header");
				}
				await handle.truncate(tailStart);
				await handle.sync();
			}
		}

		await handle.appendFile(separator + payload, "utf8");
	} finally {
		await handle.close();
	}
}

async function endsWithNewline(
	handle: FileHandle,
	size: number,
): Promise<boolean> {
	const byte = Buffer.allocUnsafe(1);
	await readFully(handle, byte, size - 1);
	return byte[0] === 0x0a;
}

async function findTrailingRecordStart(
	handle: FileHandle,
	size: number,
): Promise<number> {
	let end = size;
	while (end > 0) {
		const start = Math.max(0, end - REVERSE_SCAN_CHUNK_BYTES);
		const chunk = Buffer.allocUnsafe(end - start);
		await readFully(handle, chunk, start);
		const newline = chunk.lastIndexOf(0x0a);
		if (newline >= 0) return start + newline + 1;
		end = start;
	}
	return 0;
}

async function readRange(
	handle: FileHandle,
	start: number,
	end: number,
): Promise<string> {
	const bytes = Buffer.allocUnsafe(end - start);
	await readFully(handle, bytes, start);
	return bytes.toString("utf8");
}

async function readFully(
	handle: FileHandle,
	buffer: Buffer,
	position: number,
): Promise<void> {
	let offset = 0;
	while (offset < buffer.length) {
		const { bytesRead } = await handle.read(
			buffer,
			offset,
			buffer.length - offset,
			position + offset,
		);
		if (bytesRead === 0) throw new Error("Unexpected end of JSONL document");
		offset += bytesRead;
	}
}

function isCompleteJson(value: string): boolean {
	try {
		JSON.parse(value);
		return true;
	} catch {
		return false;
	}
}
