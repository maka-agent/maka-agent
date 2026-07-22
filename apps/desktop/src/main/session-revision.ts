import type { ReviseBeforeTurnInput, SessionSummary } from '@maka/core';
import { normalizeReviseBeforeTurnInput } from './permission-response-guard.js';

/**
 * Edit-and-resend version boundary. Kept separate from ordinary branching so
 * the Desktop can model revisions as one conversation with durable versions.
 */
export async function handleReviseBeforeTurn(
  sessionId: string,
  input: unknown,
  deps: {
    ensureSessionWorkspaceAvailable(id: string): Promise<void>;
    reviseBeforeTurn(id: string, input: ReviseBeforeTurnInput): Promise<SessionSummary>;
    emitCreated(id: string): void;
  },
): Promise<SessionSummary> {
  await deps.ensureSessionWorkspaceAvailable(sessionId);
  const session = await deps.reviseBeforeTurn(sessionId, normalizeReviseBeforeTurnInput(input));
  deps.emitCreated(session.id);
  return session;
}
