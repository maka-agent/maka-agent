import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { test } from 'node:test';

import {
  runFilesystemWorkerProcess,
  type FilesystemWorkerProcessRunInput,
} from '../filesystem-worker/process-runner.js';

test('filesystem worker process receives inherited fd inputs alongside request stdin', async () => {
  const fdPayload = Uint8Array.from([1, 2, 3, 4]);
  const script = [
    "const fs = require('node:fs');",
    'const fd = [...fs.readFileSync(3)];',
    "let stdin = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => { stdin += chunk; });",
    "process.stdin.on('end', () => process.stdout.write(JSON.stringify({ fd, stdin })));",
  ].join('');
  const input = {
    argv: [process.execPath, '-e', script],
    cwd: tmpdir(),
    env: process.env,
    stdin: '{"request":true}',
    fdInputs: [{ fd: 3, data: fdPayload }],
  } as FilesystemWorkerProcessRunInput & {
    fdInputs: readonly { fd: number; data: Uint8Array }[];
  };

  const result = await runFilesystemWorkerProcess(input);

  assert.equal(result.exitCode, 0, result.stderrTail);
  assert.deepEqual(JSON.parse(result.stdout), {
    fd: [...fdPayload],
    stdin: input.stdin,
  });
});
