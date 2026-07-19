import { launchDetachedRuntimeHostCandidate } from '../../client/launcher.js';

const [rootPath, expectedRootId] = process.argv.slice(2);
if (!rootPath || !expectedRootId) {
  throw new Error('usage: detached-launcher <root> <expected-root-id>');
}

const attempt = await launchDetachedRuntimeHostCandidate({
  rootPath,
  expectedRootId,
  idleGraceMs: 10_000,
}).spawned;
process.send?.({ type: 'launched', pid: attempt.pid });
