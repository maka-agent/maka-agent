/**
 * Serialize a write operation under `key` against a per-key promise
 * chain held in `queueMap`. Once the chain for a key drains with no
 * newer write queued behind it, the entry self-evicts so the Map
 * does not accumulate one settled Promise per key forever.
 *
 * The returned promise rejects on operation failure so callers can
 * observe errors; the Map-held chain swallows rejections only to keep
 * the chain alive for subsequent writes.
 */
export function chainWrite(
  queueMap: Map<string, Promise<void>>,
  key: string,
  operation: () => Promise<void>,
): Promise<void> {
  const previous = queueMap.get(key) ?? Promise.resolve();
  const next = previous.then(operation, operation);
  const stored = next.catch(() => {
    // Keep the chain alive after failures.
  });
  const tracked = stored.finally(() => {
    if (queueMap.get(key) === tracked) queueMap.delete(key);
  });
  queueMap.set(key, tracked);
  return next;
}
