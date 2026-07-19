import { spawn } from 'node:child_process';
import {
  resolveStorageRoot,
  tryAcquireInteractiveRootOwner,
  tryAcquireInteractiveRootReader,
} from '../../root-authority.js';

const [root, access] = process.argv.slice(2);
if (!root || (access !== 'read' && access !== 'write')) {
  throw new Error('usage: root-lock-holder <root> <read|write>');
}

const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
const lock =
  access === 'write'
    ? await tryAcquireInteractiveRootOwner(capability)
    : await tryAcquireInteractiveRootReader(capability);

if (!lock) {
  process.send?.({ type: 'denied' });
  process.exit(2);
}

process.send?.({ type: 'locked' });
process.on('message', (message) => {
  if (message === 'close') {
    void lock.close().finally(() => process.exit(0));
    return;
  }
  if (message === 'throw') {
    throw new Error('intentional uncaught holder failure');
  }
  if (message === 'abort') {
    process.abort();
  }
  if (message === 'spawn-descendant') {
    const descendant = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], {
      detached: true,
      stdio: 'ignore',
    });
    const pid = descendant.pid;
    if (pid === undefined) throw new Error('descendant did not receive a process id');
    descendant.unref();
    process.send?.({ type: 'descendant', pid }, () => process.exit(0));
  }
});

setInterval(() => undefined, 1_000).unref();
