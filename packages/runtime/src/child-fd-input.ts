import type { ChildProcess } from 'node:child_process';
import type { Writable } from 'node:stream';

export interface ChildFdInput {
  fd: number;
  data: Uint8Array;
}

export function buildSpawnStdio(
  fdInputs: readonly ChildFdInput[] | undefined,
): Array<'ignore' | 'pipe'> {
  const stdio: Array<'ignore' | 'pipe'> = ['ignore', 'pipe', 'pipe'];
  for (const input of fdInputs ?? []) {
    if (!Number.isInteger(input.fd) || input.fd < 3 || input.fd > 16) {
      throw new Error(
        `Child fd input must use an integer fd between 3 and 16; received ${input.fd}`,
      );
    }
    while (stdio.length <= input.fd) stdio.push('ignore');
    if (stdio[input.fd] === 'pipe') throw new Error(`Duplicate child fd input ${input.fd}`);
    stdio[input.fd] = 'pipe';
  }
  return stdio;
}

export function writeChildFdInputs(
  child: ChildProcess,
  fdInputs: readonly ChildFdInput[] | undefined,
): void {
  for (const input of fdInputs ?? []) {
    const stream = child.stdio[input.fd] as Writable | null | undefined;
    if (!stream || typeof stream.end !== 'function') {
      throw new Error(`Child fd ${input.fd} was not opened as a writable pipe`);
    }
    // A helper can exit before consuming the whole payload. Treat EPIPE as a
    // child execution failure, not an unhandled host-process stream error.
    stream.on('error', () => {});
    stream.end(Buffer.from(input.data));
  }
}
