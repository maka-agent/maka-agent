import { acquireOperationalStateDatabase } from '../../operational-state-store.js';

const root = process.argv[2];
if (!root || !process.send) {
  throw new Error('usage: operational-state-lease-holder <root>');
}

const lease = acquireOperationalStateDatabase(root);
process.send({ type: 'ready' });
process.on('message', (message) => {
  if (message !== 'close') return;
  lease.close();
  process.exit(0);
});
