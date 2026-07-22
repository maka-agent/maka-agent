import { startExecutionRuntimeHostCandidate } from '../../server/execution-candidate.js';
import { runRuntimeHostProcessLifecycle } from '../../server/process-lifecycle.js';

const [rootPath, expectedRootId, idleGraceRaw] = process.argv.slice(2);
if (!rootPath || !expectedRootId || !/^[a-f0-9]{64}$/.test(expectedRootId)) {
  throw new Error('usage: execution-host <root> <expected-root-id> [idle-grace-ms]');
}
const idleGraceMs = idleGraceRaw === undefined ? 30_000 : Number(idleGraceRaw);
if (!Number.isSafeInteger(idleGraceMs) || idleGraceMs < 0) {
  throw new Error('execution-host requires a non-negative idle grace');
}

const result = await startExecutionRuntimeHostCandidate({
  rootPath,
  expectedRootId,
  idleGraceMs,
});
if (result.kind === 'loser') process.exit(2);

process.send?.({
  type: 'ready',
  hostEpoch: result.host.hostEpoch,
  endpoint: result.host.endpoint,
});

try {
  await runRuntimeHostProcessLifecycle(result.host, { closeOnDisconnect: true });
} catch {
  process.exitCode = 1;
} finally {
  if (process.connected) process.disconnect?.();
}
