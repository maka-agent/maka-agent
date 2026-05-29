import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';

import { normalizeOfficeCliVersion, probeOfficeCli } from '../officecli-probe.js';

describe('officecli probe', () => {
  it('normalizes common officecli --version output', () => {
    assert.equal(normalizeOfficeCliVersion('officecli 1.0.63\n'), '1.0.63');
    assert.equal(normalizeOfficeCliVersion('v1.2.3\n'), 'v1.2.3');
    assert.equal(normalizeOfficeCliVersion('custom-build\n'), 'custom-build');
    assert.equal(normalizeOfficeCliVersion('\n'), 'unknown');
  });

  it('reports available when officecli returns a version', async () => {
    const result = await probeOfficeCli({
      now: 123,
      execFileImpl: fakeExecFile((_file, _args, _options, callback) => {
        callback(null, 'officecli 1.0.63\n', '');
      }),
    });

    assert.deepEqual(result, { available: true, version: '1.0.63', checkedAt: 123 });
  });

  it('classifies missing officecli without throwing', async () => {
    const result = await probeOfficeCli({
      now: 456,
      execFileImpl: fakeExecFile((_file, _args, _options, callback) => {
        const error = new Error('missing') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        callback(error, '', '');
      }),
    });

    assert.deepEqual(result, { available: false, reason: 'missing', checkedAt: 456 });
  });
});

function fakeExecFile(
  fn: (
    file: string,
    args: readonly string[],
    options: Record<string, unknown>,
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => void,
): typeof import('node:child_process').execFile {
  return ((file: string, args: readonly string[], options: Record<string, unknown>, callback: (...args: unknown[]) => void) => {
    queueMicrotask(() => fn(file, args, options, callback as (error: Error | null, stdout: string, stderr: string) => void));
    return new EventEmitter() as ReturnType<typeof import('node:child_process').execFile>;
  }) as typeof import('node:child_process').execFile;
}
