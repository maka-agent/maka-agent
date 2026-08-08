import { acquireOperationalStateDatabase } from '../../operational-state-store.js';

const root = process.argv[2];
if (!root || !process.send) {
  throw new Error('usage: operational-state-lease-holder <root>');
}

let lease: ReturnType<typeof acquireOperationalStateDatabase> | undefined;
const open = () => {
  lease = acquireOperationalStateDatabase(root);
  process.send?.({ type: 'ready' });
};

if (process.argv[3] === 'wait-for-open') {
  process.send({ type: 'waiting' });
} else {
  open();
}
process.on('message', (message) => {
  if (message === 'open' && !lease) {
    process.send?.({ type: 'opening' }, open);
    return;
  }
  if (message !== 'close') return;
  lease?.close();
  process.exit(0);
});
