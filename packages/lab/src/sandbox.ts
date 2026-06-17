import { cp, lstat, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A throwaway copy of a task fixture. The copy keeps a run from mutating
 * the source fixture and from bleeding into other runs — it is NOT a
 * security sandbox (a tool can still reach outside it via absolute paths
 * or the network; see runner.ts for the permission policy).
 */
export interface PreparedWorkspace {
  /** Absolute path to the throwaway copy — the agent's cwd. */
  dir: string;
  /** Remove the copy. Always call (the runner does so in a finally). */
  cleanup: () => Promise<void>;
}

export async function prepareWorkspace(fixtureDir: string): Promise<PreparedWorkspace> {
  const dir = await mkdtemp(join(tmpdir(), 'maka-lab-ws-'));
  try {
    const source = await realpath(fixtureDir);
    // Copy the fixture into the throwaway dir, rejecting symlinks: a
    // fixture symlink could point outside its root, and fs.cp preserves
    // symlinks verbatim — the agent could then write through it to the
    // source or host. Coding-task fixtures don't need symlinks.
    await cp(source, dir, {
      recursive: true,
      filter: async (src) => {
        if ((await lstat(src)).isSymbolicLink()) {
          throw new Error(`fixture contains a symlink (${src}); not supported for safety`);
        }
        return true;
      },
    });
  } catch (error) {
    // mkdtemp already created the dir, but the runner only registers its
    // cleanup after we return — so clean up here if the copy fails.
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  return {
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
