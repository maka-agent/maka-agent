import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import {
  filesystemWorkerBundleCandidate,
  resolveFilesystemWorkerBundle,
} from '../filesystem-worker/resource-resolver.js';
import { parseFilesystemWorkerResponse } from '../filesystem-worker/protocol.js';

describe('filesystem worker bundle and resource resolver', () => {
  test('runtime build emits a directly executable one-shot worker bundle', async () => {
    const resolved = await resolveFilesystemWorkerBundle({ kind: 'runtime' });
    assert.equal(resolved.ok, true);
    if (!resolved.ok) return;
    const cwd = await mkdtemp(join(tmpdir(), 'maka-fs-worker-bundle-'));
    await writeFile(join(cwd, 'input.txt'), 'bundle-ok', 'utf8');

    const launched = await launchWorker(resolved.path, JSON.stringify({
      version: 1,
      requestId: 'request-1',
      operation: { kind: 'read', cwd, path: 'input.txt' },
    }));

    assert.equal(launched.exitCode, 0);
    assert.equal(launched.stderr, '');
    assert.deepEqual(parseFilesystemWorkerResponse(JSON.parse(launched.stdout)), {
      version: 1,
      requestId: 'request-1',
      ok: true,
      result: { kind: 'read', content: 'bundle-ok' },
    });
  });

  test('returns invalid_request for malformed input without leaking a stack', async () => {
    const resolved = await resolveFilesystemWorkerBundle({ kind: 'runtime' });
    assert.equal(resolved.ok, true);
    if (!resolved.ok) return;

    const launched = await launchWorker(resolved.path, '{invalid-json');

    assert.equal(launched.exitCode, 0);
    assert.equal(launched.stderr, '');
    const response = parseFilesystemWorkerResponse(JSON.parse(launched.stdout));
    assert.equal(response.ok, false);
    if (!response.ok) assert.equal(response.error.code, 'invalid_request');
    assert.equal('stack' in (response.ok ? response : response.error), false);
  });

  test('resolves the packaged Electron resources contract and fails closed when absent', async () => {
    const resourcesPath = await mkdtemp(join(tmpdir(), 'maka-desktop-resources-'));
    const candidate = filesystemWorkerBundleCandidate({
      kind: 'desktop-packaged',
      resourcesPath,
    });
    assert.equal(candidate, join(resourcesPath, 'workers', 'filesystem-worker.js'));
    assert.deepEqual(await resolveFilesystemWorkerBundle({
      kind: 'desktop-packaged',
      resourcesPath,
    }), {
      ok: false,
      reason: 'bundle_not_found',
      path: candidate,
    });

    await mkdir(join(resourcesPath, 'workers'));
    await writeFile(candidate, 'worker', 'utf8');
    const resolved = await resolveFilesystemWorkerBundle({
      kind: 'desktop-packaged',
      resourcesPath,
    });
    assert.equal(resolved.ok, true);
  });
});

async function launchWorker(
  bundlePath: string,
  input: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [bundlePath], {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (exitCode) => resolvePromise({
      exitCode: exitCode ?? 1,
      stdout,
      stderr,
    }));
    child.stdin.end(input);
  });
}
