import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  CreateFilesystemWorkerLaunchSpecProviderInput,
  FilesystemWorkerLaunchSpecProvider,
  FilesystemWorkerLaunchSpecResult,
} from '@maka/runtime';
import { createHostFilesystemWorkerLaunchSpecProvider } from '../server/execution-composition.js';

const SUCCESS: FilesystemWorkerLaunchSpecResult = {
  ok: true,
  spec: {
    program: '/runtime/executable',
    args: ['/worker.js'],
    env: {},
    runtimeReadableRoots: [],
    executableRoots: [],
  },
};

test('selects Node runtime resources without an Electron packaged probe', async () => {
  const inputs: CreateFilesystemWorkerLaunchSpecProviderInput[] = [];
  const provider = createHostFilesystemWorkerLaunchSpecProvider(
    { runtime: 'node' },
    recordingFactory(inputs, () => SUCCESS),
  );

  assert.equal(await provider(), SUCCESS);
  assert.deepEqual(inputs, [{ runtime: 'node', resourceLocation: { kind: 'runtime' } }]);
});

test('selects the Electron executable and falls back only when its packaged bundle is unavailable', async () => {
  const inputs: CreateFilesystemWorkerLaunchSpecProviderInput[] = [];
  const unavailable: FilesystemWorkerLaunchSpecResult = {
    ok: false,
    reason: 'worker_bundle_unavailable',
    message: 'packaged worker is absent',
  };
  const provider = createHostFilesystemWorkerLaunchSpecProvider(
    {
      runtime: 'electron',
      executable: '/Applications/Maka.app/Contents/MacOS/Maka',
      resourcesPath: '/Applications/Maka.app/Contents/Resources',
    },
    recordingFactory(inputs, (input) =>
      input.resourceLocation.kind === 'desktop-packaged' ? unavailable : SUCCESS,
    ),
  );

  assert.equal(await provider(), SUCCESS);
  assert.deepEqual(inputs, [
    {
      runtime: 'electron',
      executable: '/Applications/Maka.app/Contents/MacOS/Maka',
      resourceLocation: {
        kind: 'desktop-packaged',
        resourcesPath: '/Applications/Maka.app/Contents/Resources',
      },
    },
    {
      runtime: 'electron',
      executable: '/Applications/Maka.app/Contents/MacOS/Maka',
      resourceLocation: { kind: 'runtime' },
    },
  ]);
});

test('does not hide an Electron runtime failure behind the resource fallback', async () => {
  const inputs: CreateFilesystemWorkerLaunchSpecProviderInput[] = [];
  const executableUnavailable: FilesystemWorkerLaunchSpecResult = {
    ok: false,
    reason: 'runtime_executable_unavailable',
    message: 'Electron framework is absent',
  };
  const provider = createHostFilesystemWorkerLaunchSpecProvider(
    {
      runtime: 'electron',
      executable: '/Applications/Maka.app/Contents/MacOS/Maka',
      resourcesPath: '/Applications/Maka.app/Contents/Resources',
    },
    recordingFactory(inputs, () => executableUnavailable),
  );

  assert.equal(await provider(), executableUnavailable);
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0]?.resourceLocation.kind, 'desktop-packaged');
});

function recordingFactory(
  inputs: CreateFilesystemWorkerLaunchSpecProviderInput[],
  resolve: (input: CreateFilesystemWorkerLaunchSpecProviderInput) => FilesystemWorkerLaunchSpecResult,
): (input: CreateFilesystemWorkerLaunchSpecProviderInput) => FilesystemWorkerLaunchSpecProvider {
  return (input) => {
    inputs.push(input);
    return async () => resolve(input);
  };
}
