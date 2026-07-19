import {
  prepareStorageRootControlDirectory,
  resolveStorageRoot,
} from '@maka/storage/root-authority';
import { connectOrSpawnRuntimeHost } from '../../client/index.js';
import { readHostRegistration } from '../../control/registration.js';
import { RUNTIME_HOST_PROTOCOL_VERSION } from '../../protocol/index.js';

const [rootPath] = process.argv.slice(2);
if (!rootPath) throw new Error('usage: electron-connect-parent <root>');
if (!process.versions.electron)
  throw new Error('electron-connect-parent requires Electron Node mode');

const result = await connectOrSpawnRuntimeHost({
  rootPath,
  surface: 'desktop',
  protocol: {
    min: RUNTIME_HOST_PROTOCOL_VERSION,
    max: RUNTIME_HOST_PROTOCOL_VERSION,
  },
  electionDeadlineMs: 5_000,
});
if (result.kind !== 'connected') {
  throw new Error(`Electron Client failed to connect: ${result.kind}`);
}

const capability = await resolveStorageRoot({ path: rootPath, kind: 'interactive' });
const { controlDirectory } = await prepareStorageRootControlDirectory(capability);
const registration = await readHostRegistration(controlDirectory);
if (!registration || registration.hostEpoch !== result.connection.hostEpoch) {
  throw new Error('Electron Client did not discover the Host it launched');
}
await result.connection.close();
await sendToParent({
  type: 'electron-parent-launched',
  hostEpoch: registration.hostEpoch,
  pid: registration.pid,
});
process.disconnect?.();

function sendToParent(message: unknown): Promise<void> {
  if (!process.send)
    return Promise.reject(new Error('electron-connect-parent requires an IPC parent'));
  return new Promise((resolve, reject) => {
    process.send?.(message, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
