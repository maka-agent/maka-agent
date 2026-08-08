import { waitForOperationalStateMigrationTurn } from '../../operational-state-schema-lock.js';

const databasePath = process.argv[2];
const holdMs = Number(process.argv[3]);
if (!databasePath || !Number.isSafeInteger(holdMs) || holdMs < 0 || !process.send) {
  throw new Error(
    'usage: operational-state-migration-turn-holder <database-path> <hold-milliseconds>',
  );
}

const migrationTurn = waitForOperationalStateMigrationTurn(databasePath);
process.send({ type: 'ready' });
setTimeout(() => {
  migrationTurn.close();
  process.exit(0);
}, holdMs);
