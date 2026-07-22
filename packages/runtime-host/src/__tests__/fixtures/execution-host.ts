import {
  resolveExistingStorageRoot,
  tryAcquireInteractiveRootOwner,
} from '@maka/storage/root-authority';
import { startExecutionRuntimeHostCandidate } from '../../server/execution-candidate.js';
import { createExecutionRuntimeHostComposition } from '../../server/execution-composition.js';
import { RuntimeHostKernel } from '../../server/host-kernel.js';

const [rootPath, expectedRootId, idleGraceRaw] = process.argv.slice(2);
if (!rootPath || !expectedRootId || !/^[a-f0-9]{64}$/.test(expectedRootId)) {
  throw new Error('usage: execution-host <root> <expected-root-id> [idle-grace-ms]');
}
const idleGraceMs = idleGraceRaw === undefined ? 30_000 : Number(idleGraceRaw);
if (!Number.isSafeInteger(idleGraceMs) || idleGraceMs < 0) {
  throw new Error('execution-host requires a non-negative idle grace');
}

const candidateOptions = {
  rootPath,
  expectedRootId,
  idleGraceMs,
};
const result =
  process.env.MAKA_RUNTIME_HOST_GOAL_ADMISSION_FAILPOINT === 'after_durable_commit'
    ? await startGoalAdmissionGateCandidate(candidateOptions)
    : await startExecutionRuntimeHostCandidate(candidateOptions);
if (result.kind === 'loser') process.exit(2);

process.send?.({
  type: 'ready',
  hostEpoch: result.host.hostEpoch,
  endpoint: result.host.endpoint,
});

let closing = false;
const close = () => {
  if (closing) return;
  closing = true;
  void result.host.close();
};
process.once('SIGINT', close);
process.once('SIGTERM', close);
process.once('disconnect', close);
try {
  await result.host.closed;
} catch {
  process.exitCode = 1;
} finally {
  if (process.connected) process.disconnect?.();
}

async function startGoalAdmissionGateCandidate(options: {
  rootPath: string;
  expectedRootId: string;
  idleGraceMs: number;
}) {
  const capability = await resolveExistingStorageRoot({
    path: options.rootPath,
    kind: 'interactive',
    expectedRootId: options.expectedRootId,
  });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  if (!owner) return { kind: 'loser' as const };
  const host = await RuntimeHostKernel.start({
    owner,
    idleGraceMs: options.idleGraceMs,
    compositionFactory: (context) =>
      createExecutionRuntimeHostComposition(context, {
        rootTurnHooks: {
          afterGoalAdmissionDurableCommit: async (admission) => {
            process.send?.({ type: 'goal_admission_committed', ...admission });
            await new Promise<void>(() => {
              // This test-only gate is released by terminating the child process.
            });
          },
        },
      }),
  });
  return { kind: 'winner' as const, host };
}
