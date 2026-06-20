import type { HarborCellTokenSummary } from '../../cell-output.js';

export function tokenSummary(
  input: Pick<HarborCellTokenSummary, 'input' | 'output' | 'reasoning' | 'total' | 'costUsd'>,
): HarborCellTokenSummary {
  return {
    ...input,
    cachedInput: 0,
    cacheHitInput: 0,
    cacheMissInput: input.input,
    cacheWriteInput: 0,
    cacheMissInputSource: 'derived',
    pricingSource: 'runtime',
  };
}
