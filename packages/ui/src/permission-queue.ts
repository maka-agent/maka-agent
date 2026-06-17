import type { PermissionRequestEvent } from '@maka/core';

/**
 * Per-session permission request queues.
 *
 * The renderer used to hold a single pending request per session, so when a
 * model fired several tool calls in one step (e.g. `browser_snapshot` +
 * `browser_extract` in parallel), the later `permission_request` overwrote the
 * earlier one. The overwritten request could never be answered — its tool stayed
 * parked forever while the run status flipped back to "running" — and the turn
 * hung until the user stopped it. A FIFO queue keeps every parallel request, so
 * the user clears them one by one and nothing is stranded.
 */
export type PermissionQueues = Record<string, PermissionRequestEvent[]>;

/** Append a request to a session's queue, ignoring duplicates by requestId. */
export function enqueuePermission(
  queues: PermissionQueues,
  sessionId: string,
  request: PermissionRequestEvent,
): PermissionQueues {
  const queue = queues[sessionId] ?? [];
  if (queue.some((r) => r.requestId === request.requestId)) return queues;
  return { ...queues, [sessionId]: [...queue, request] };
}

/** Remove a resolved request by id; the next queued request becomes the head. */
export function dequeuePermission(
  queues: PermissionQueues,
  sessionId: string,
  requestId: string,
): PermissionQueues {
  const queue = queues[sessionId];
  if (!queue) return queues;
  return { ...queues, [sessionId]: queue.filter((r) => r.requestId !== requestId) };
}

/**
 * Remove a request by its toolUseId. A permission that ends without a user
 * decision — a runtime timeout / expiry — emits a `tool_result` rather than a
 * `permission_decision_ack`, so the renderer drains the stale queue entry on
 * that result. No-op once the request was already dequeued via its ack.
 */
export function dequeuePermissionByToolUseId(
  queues: PermissionQueues,
  sessionId: string,
  toolUseId: string,
): PermissionQueues {
  const queue = queues[sessionId];
  if (!queue || !queue.some((r) => r.toolUseId === toolUseId)) return queues;
  return { ...queues, [sessionId]: queue.filter((r) => r.toolUseId !== toolUseId) };
}

/** Drop every pending request for a session (its turn errored / aborted / ended). */
export function clearPermissions(queues: PermissionQueues, sessionId: string): PermissionQueues {
  if (!queues[sessionId]?.length) return queues;
  return { ...queues, [sessionId]: [] };
}

/** The request the user should act on now: the head of the session's queue. */
export function activePermissionFor(
  queues: PermissionQueues,
  sessionId: string | undefined,
): PermissionRequestEvent | undefined {
  return sessionId ? queues[sessionId]?.[0] : undefined;
}
