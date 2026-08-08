import { waitForOperationalStateMigrationTurn } from '../../operational-state-schema-lock.js';

const databasePath = process.argv[2];
if (!databasePath || !process.send) {
  throw new Error('usage: operational-state-migration-turn-holder <database-path>');
}

const migrationTurn = waitForOperationalStateMigrationTurn(databasePath);
process.send({ type: 'ready' });
process.once('message', (message) => {
  if (message !== 'close') throw new Error(`unexpected message: ${String(message)}`);
  migrationTurn.close();
  process.exit(0);
});
