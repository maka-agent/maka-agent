import type { AgentRunStore, ContinuationAdmissionStore } from '@maka/core/agent-run';

export function resolveContinuationAdmissionStore(
  runStore: AgentRunStore | undefined,
  explicit: ContinuationAdmissionStore | undefined,
): ContinuationAdmissionStore | undefined {
  if (explicit) return explicit;
  if (!runStore) return undefined;
  const candidate = runStore as AgentRunStore & Partial<ContinuationAdmissionStore>;
  if (
    typeof candidate.admitContinuation !== 'function' ||
    typeof candidate.readContinuationAdmission !== 'function'
  ) {
    return undefined;
  }
  return candidate as AgentRunStore & ContinuationAdmissionStore;
}
