import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  OPENCODE_TOOLCHAIN_FINGERPRINT,
  OPENCODE_TOOLCHAIN_SPEC,
} from '../opencode-toolchain.js';

describe('OpenCode toolchain', () => {
  test('validates a prepared toolchain and rejects binary drift', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-opencode-toolchain-'));
    try {
      const binDir = join(root, 'bin');
      await mkdir(binDir);
      await writeFile(join(binDir, 'node'), 'pinned node\n');
      await writeFile(join(binDir, 'opencode'), 'pinned opencode\n');
      await chmod(join(binDir, 'node'), 0o755);
      await chmod(join(binDir, 'opencode'), 0o755);
      const files = {
        'bin/node': sha256('pinned node\n'),
        'bin/opencode': sha256('pinned opencode\n'),
      };
      await writeFile(join(root, 'manifest.json'), `${JSON.stringify({
        schemaVersion: 1,
        fingerprint: OPENCODE_TOOLCHAIN_FINGERPRINT,
        spec: OPENCODE_TOOLCHAIN_SPEC,
        files,
      }, null, 2)}\n`);
      await writeFile(
        join(root, 'checksums.sha256'),
        Object.entries(files).map(([path, hash]) => `${hash}  ${path}\n`).join(''),
      );

      const module = await import('../opencode-toolchain.js') as Record<string, unknown>;
      const validate = module.validatePreparedOpenCodeToolchain as ((path: string) => Promise<unknown>);
      const prepare = module.prepareOpenCodeToolchain as ((
        path: string,
        options: { fetchFn: typeof fetch },
      ) => Promise<{ path: string; fingerprint: string }>);
      await validate(root);
      const reused = await prepare(root, {
        fetchFn: async () => {
          throw new Error('a valid prepared toolchain must not access the network');
        },
      });
      assert.equal(reused.path, root);
      assert.equal(reused.fingerprint, OPENCODE_TOOLCHAIN_FINGERPRINT);

      await writeFile(join(binDir, 'opencode'), 'drifted opencode\n');
      await assert.rejects(validate(root), /bin\/opencode SHA-256 mismatch/);
      assert.match(await readFile(join(root, 'manifest.json'), 'utf8'), /1\.17\.18/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
