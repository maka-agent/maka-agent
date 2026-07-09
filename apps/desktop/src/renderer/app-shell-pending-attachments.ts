export type PendingByKey<T> = Record<string, T[]>;

export function selectPending<T>(map: PendingByKey<T>, key: string): T[] {
  return map[key] ?? [];
}

export function appendPending<T>(
  map: PendingByKey<T>,
  key: string,
  items: readonly T[],
): PendingByKey<T> {
  return { ...map, [key]: [...(map[key] ?? []), ...items] };
}

export function removePending<T>(map: PendingByKey<T>, key: string, index: number): PendingByKey<T> {
  const current = map[key] ?? [];
  return { ...map, [key]: current.filter((_, i) => i !== index) };
}

export function clearPending<T>(map: PendingByKey<T>, key: string): PendingByKey<T> {
  const next = { ...map };
  delete next[key];
  return next;
}