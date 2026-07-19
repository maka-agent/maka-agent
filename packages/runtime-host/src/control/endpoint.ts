import { chmod, lstat, mkdtemp, readdir, rm, rmdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const POSIX_ENDPOINT_ROOT = '/tmp';
const PORTABLE_UNIX_SOCKET_PATH_LIMIT = 100;

export interface RuntimeHostEndpointInput {
  rootId: string;
  hostEpoch: string;
}

export interface RuntimeHostEndpoint {
  path: string;
  prepareAfterListen(): Promise<void>;
  cleanup(): Promise<void>;
}

export class RuntimeHostEndpointError extends Error {
  constructor(
    readonly code: 'insecure_endpoint_directory' | 'endpoint_path_too_long',
    message: string,
  ) {
    super(message);
    this.name = 'RuntimeHostEndpointError';
  }
}

export async function prepareRuntimeHostEndpoint(
  input: RuntimeHostEndpointInput,
): Promise<RuntimeHostEndpoint> {
  if (process.platform === 'win32') {
    const path = `\\\\.\\pipe\\maka-runtime-host-${input.rootId.slice(0, 16)}-${input.hostEpoch}`;
    return {
      path,
      async prepareAfterListen() {},
      async cleanup() {},
    };
  }

  const prefix = endpointDirectoryPrefix(input.rootId);
  await removeStaleEndpointDirectories(prefix);
  const directory = await mkdtemp(join(POSIX_ENDPOINT_ROOT, prefix));
  try {
    await ensurePrivateEndpointDirectory(directory);
    const path = join(directory, 'h.sock');
    if (Buffer.byteLength(path, 'utf8') > PORTABLE_UNIX_SOCKET_PATH_LIMIT) {
      throw new RuntimeHostEndpointError(
        'endpoint_path_too_long',
        `Runtime Host endpoint path exceeds the portable Unix socket limit: ${path}`,
      );
    }
    return {
      path,
      async prepareAfterListen() {
        await chmod(path, 0o600);
        const endpointStat = await lstat(path);
        if (
          !endpointStat.isSocket() ||
          endpointStat.uid !== currentUid() ||
          (endpointStat.mode & 0o077) !== 0
        ) {
          throw new RuntimeHostEndpointError(
            'insecure_endpoint_directory',
            `Runtime Host endpoint is not a private current-user socket: ${path}`,
          );
        }
      },
      async cleanup() {
        await unlink(path).catch((error: unknown) => {
          if (!isNodeError(error, 'ENOENT')) throw error;
        });
        await rmdir(directory).catch((error: unknown) => {
          if (!isNodeError(error, 'ENOENT')) throw error;
        });
      },
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

function endpointDirectoryPrefix(rootId: string): string {
  if (!/^[a-f0-9]{64}$/.test(rootId)) {
    throw new RuntimeHostEndpointError(
      'insecure_endpoint_directory',
      'Runtime Host endpoint requires a valid storage root identity',
    );
  }
  const rootTag = Buffer.from(rootId, 'hex').toString('base64url');
  return `m-${currentUid()}-${rootTag}-`;
}

async function removeStaleEndpointDirectories(prefix: string): Promise<void> {
  const entries = await readdir(POSIX_ENDPOINT_ROOT, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      if (
        !entry.isDirectory() ||
        !entry.name.startsWith(prefix) ||
        entry.name.length !== prefix.length + 6
      )
        return;
      const path = join(POSIX_ENDPOINT_ROOT, entry.name);
      const directoryStat = await lstat(path).catch(() => undefined);
      if (!directoryStat?.isDirectory() || directoryStat.uid !== currentUid()) return;
      await rm(path, { recursive: true, force: true });
    }),
  );
}

async function ensurePrivateEndpointDirectory(path: string): Promise<void> {
  await chmod(path, 0o700);
  const directoryStat = await lstat(path);
  if (
    !directoryStat.isDirectory() ||
    directoryStat.uid !== currentUid() ||
    (directoryStat.mode & 0o077) !== 0
  ) {
    throw new RuntimeHostEndpointError(
      'insecure_endpoint_directory',
      `Runtime Host endpoint parent is not a private current-user directory: ${path}`,
    );
  }
}

function currentUid(): number {
  if (typeof process.getuid !== 'function') {
    throw new RuntimeHostEndpointError(
      'insecure_endpoint_directory',
      'Runtime Host POSIX endpoints require a current-user identity',
    );
  }
  return process.getuid();
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code
  );
}
