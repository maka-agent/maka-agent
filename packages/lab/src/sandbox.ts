import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A throwaway copy of a task fixture. Safety in the lab comes from
 * isolation, not from asking: the agent always runs against a fresh
 * copy, so the source fixture is never mutated and runs never bleed
 * into each other.
 */
export interface PreparedWorkspace {
  /** Absolute path to the throwaway copy — the agent's cwd. */
  dir: string;
  /** Remove the copy. Always call (the runner does so in a finally). */
  cleanup: () => Promise<void>;
}

export async function prepareWorkspace(fixtureDir: string): Promise<PreparedWorkspace> {
  const dir = await mkdtemp(join(tmpdir(), 'maka-lab-ws-'));
  // fs.cp merges the fixture's contents into the freshly-created temp dir.
  await cp(fixtureDir, dir, { recursive: true });
  return {
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
