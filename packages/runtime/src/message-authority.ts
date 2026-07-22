import type { SteeringLease } from '@maka/core/backend-types';

export interface RuntimeMessageRunIdentity {
  readonly sessionId: string;
  readonly turnId: string;
  readonly runId: string;
}

/** Synchronous lease bridge owned by the Runtime Host for one live root Run. */
export interface RuntimeMessageRunOwner extends RuntimeMessageRunIdentity {
  pull(): readonly SteeringLease[];
  ack(leaseIds: readonly string[]): void;
  nack(leaseIds: readonly string[]): void;
  release(): void;
}

/** Process-wide factory. Queue admission and projection remain Host responsibilities. */
export interface RuntimeMessageAuthority {
  bindRun(identity: RuntimeMessageRunIdentity): RuntimeMessageRunOwner;
}

export class RuntimeMessageAuthorityInvariantError extends Error {
  readonly name = 'RuntimeMessageAuthorityInvariantError';
}
