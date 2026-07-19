import {
  resolveExistingStorageRoot,
  tryAcquireInteractiveRootOwner,
} from '@maka/storage/root-authority';
import type { RuntimeHostCandidateOptions } from './candidate.js';
import { createExecutionRuntimeHostComposition } from './execution-composition.js';
import { RuntimeHostKernel } from './host-kernel.js';

export type ExecutionRuntimeHostCandidateResult =
  | { kind: 'loser' }
  | { kind: 'winner'; host: RuntimeHostKernel };

export async function startExecutionRuntimeHostCandidate(
  options: RuntimeHostCandidateOptions,
): Promise<ExecutionRuntimeHostCandidateResult> {
  const capability = await resolveExistingStorageRoot({
    path: options.rootPath,
    kind: 'interactive',
    expectedRootId: options.expectedRootId,
  });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  if (!owner) return { kind: 'loser' };
  const host = await RuntimeHostKernel.start({
    owner,
    idleGraceMs: options.idleGraceMs,
    handshakeTimeoutMs: options.handshakeTimeoutMs,
    compositionFactory: createExecutionRuntimeHostComposition,
  });
  return { kind: 'winner', host };
}
