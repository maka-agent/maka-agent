import { readFile } from 'node:fs/promises';
import { createHeadlessRootLease, resolveStorageRoot } from '@maka/storage/root-authority';
import type { TaskEvent } from '../../task-contracts.js';
import { openHeadlessTaskRunWriter } from '../../task-run-store.js';

const [storageRoot, eventPath] = process.argv.slice(2);
if (!storageRoot || !eventPath) {
  throw new Error('storage root and event path are required');
}

const capability = await resolveStorageRoot({ path: storageRoot, kind: 'headless' });
const writer = await openHeadlessTaskRunWriter(createHeadlessRootLease(capability, 'write'));
process.send?.({ type: 'ready' });

process.once('message', async (message) => {
  if (!isAppendRequest(message)) {
    process.exitCode = 1;
    process.disconnect?.();
    return;
  }

  try {
    const event = JSON.parse(await readFile(eventPath, 'utf8')) as TaskEvent;
    await writer.appendEvent(event.taskRunId, event);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    process.disconnect?.();
  }
});

function isAppendRequest(value: unknown): value is { type: 'append' } {
  return (
    typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'append'
  );
}
