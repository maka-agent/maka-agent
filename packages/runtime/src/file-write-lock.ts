// packages/runtime/src/file-write-lock.ts
// Serialize file-mutating tools (Write/Edit) per file. The AI SDK runs a single
// step's tool calls concurrently, so two edits to one file would race on the
// read-modify-write (read -> replace -> write back) and silently lose an update.
// withFileWriteLock(key, fn) runs work sharing a key strictly one-at-a-time, in
// submission order; distinct keys run concurrently. Callers pass a key that
// uniquely identifies the target file within their tool surface (the builtin
// tools key on the resolved absolute path; the headless tools key on a
// JSON [cwd, path] pair, since the executor boundary hides — and may relocate —
// the filesystem). A failed task never wedges its key, and keys are reclaimed
// once their chain drains, so the map stays bounded.
//
// Keying is lexical, so one file reached under two names — via a symlinked parent
// dir, a hard link, or a case-insensitive filesystem ("a.txt" vs "A.txt") — takes
// two keys and is not merged. This matches opencode's lexical (path.resolve)
// per-file Semaphore. (Bash is not serialized either — a per-file lock cannot key
// arbitrary shell.)

const tails = new Map<string, Promise<void>>();

export interface FileWriteLockLease {
  release(): void;
}

/** Acquire a per-file lease that may span preparation, T1, replace, and T2. */
export async function acquireFileWriteLock(key: string): Promise<FileWriteLockLease> {
  const previous = tails.get(key) ?? Promise.resolve();
  let releaseHold!: () => void;
  const hold = new Promise<void>((resolve) => {
    releaseHold = resolve;
  });
  const tail = previous.then(
    () => hold,
    () => hold,
  );
  tails.set(key, tail);
  await previous.catch(() => undefined);
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      releaseHold();
      void tail.then(() => {
        if (tails.get(key) === tail) tails.delete(key);
      });
    },
  };
}

/**
 * Runs `fn` exclusively for `key`: it waits until any prior work for `key`
 * settles, then runs, then releases the key for the next waiter. Distinct keys
 * never block each other.
 *
 * @internal Low-level primitive shared with the headless tools via the
 * `@maka/runtime/file-write-lock` subpath. Not part of the public runtime API —
 * file tools own the keying, so an external caller would only be sharing this
 * one process-global queue by accident.
 */
export function withFileWriteLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  return acquireFileWriteLock(key).then(async (lease) => {
    try {
      return await fn();
    } finally {
      lease.release();
    }
  });
}
