import { createHash } from 'node:crypto';
import { posix as pathPosix } from 'node:path';
import type { WorkspaceRevisionRef } from '@maka/core/execution-evidence';
import type { IsolatedToolExecutor } from './isolation.js';
import type {
  HeavyTaskWorkspaceObservationEntry,
  HeavyTaskWorkspaceObservationRecordedEvent,
} from './task-contracts.js';
import type { TaskRunProjection } from './task-run-store.js';

export async function observeHeavyTaskWorkspace(input: {
  taskRunId: string;
  projection: TaskRunProjection;
  executor?: IsolatedToolExecutor;
  cwd: string;
  now: () => number;
  newId: () => string;
}): Promise<HeavyTaskWorkspaceObservationRecordedEvent | undefined> {
  if (!input.executor) return undefined;
  const roots = observationRoots(input.projection);
  if (roots.length === 0) return undefined;
  const command = workspaceObservationCommand(roots);
  const result = await input.executor.exec({ command, cwd: input.cwd, timeoutMs: 30_000 });
  const entries = result.exitCode === 0 ? parseWorkspaceObservation(result.stdout) : [];
  const revision =
    result.exitCode === 0 && workspaceManifestIsContentAddressed(entries)
      ? workspaceManifestRevision(roots, entries)
      : undefined;
  return {
    type: 'heavy_task_workspace_observation_recorded',
    id: input.newId(),
    taskRunId: input.taskRunId,
    ts: input.now(),
    observation: {
      schemaVersion: 1,
      observationId: input.newId(),
      taskRunId: input.taskRunId,
      ts: input.now(),
      roots,
      entries,
      status: result.exitCode === 0 ? 'ok' : 'error',
      command,
      ...(revision ? { revision } : {}),
      ...(result.exitCode === 0
        ? {}
        : { errorExcerpt: cleanOneLine(result.stderr || result.stdout, 500) }),
      source: { kind: 'system', label: 'isolated workspace observation' },
    },
  };
}

function observationRoots(projection: TaskRunProjection): string[] {
  const candidates = [
    ...(projection.latestHeavyTaskSelfCheckPlan?.finalArtifacts ?? []).map((artifact) =>
      parentDir(artifact.path),
    ),
    ...(
      projection.latestHeavyTaskSelfCheck?.executionHygiene?.workspaceGuard?.checkedPaths ?? []
    ).map((path) => pathPosix.normalize(path)),
  ];
  return unique(
    candidates
      .filter((root) => root === '/app' || root.startsWith('/app/'))
      .map((root) => root.replace(/\/+$/, '')),
  ).slice(0, 12);
}

function parentDir(path: string): string {
  const dir = pathPosix.dirname(pathPosix.normalize(path));
  return dir === '.' ? path : dir;
}

function workspaceObservationCommand(roots: readonly string[]): string {
  const args = roots.map(shellQuote).join(' ');
  return [
    `for root in ${args}; do`,
    '  if [ -e "$root" ]; then',
    '    if [ -d "$root" ]; then find "$root" -mindepth 1 -maxdepth 1 -exec sh -c \'for p do if [ -L "$p" ]; then t=$(readlink "$p" 2>/dev/null || true); printf "symlink\\t%s\\t%s\\t\\t\\n" "$p" "$t"; elif [ -f "$p" ]; then s=$(wc -c < "$p" | tr -d " "); h=$(sha256sum "$p" | cut -d " " -f 1); printf "file\\t%s\\t\\t%s\\t%s\\n" "$p" "$s" "$h"; elif [ -d "$p" ]; then printf "directory\\t%s\\t\\t\\t\\n" "$p"; else printf "other\\t%s\\t\\t\\t\\n" "$p"; fi; done\' sh {} +;',
    '    elif [ -L "$root" ]; then t=$(readlink "$root" 2>/dev/null || true); printf "symlink\\t%s\\t%s\\n" "$root" "$t";',
    '    elif [ -f "$root" ]; then s=$(wc -c < "$root" | tr -d " "); h=$(sha256sum "$root" | cut -d " " -f 1); printf "file\\t%s\\t\\t%s\\t%s\\n" "$root" "$s" "$h";',
    '    else printf "other\\t%s\\t\\n" "$root"; fi',
    '  fi',
    'done',
  ].join('\n');
}

export function parseWorkspaceObservation(stdout: string): HeavyTaskWorkspaceObservationEntry[] {
  return stdout
    .split(/\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const [kind, path, symlinkTarget, sizeBytes, sha256] = line.split('\t');
      if (!isObservationKind(kind) || !path) return undefined;
      const parsedSize = sizeBytes && /^\d+$/.test(sizeBytes) ? Number(sizeBytes) : undefined;
      return {
        path,
        kind,
        ...(kind === 'symlink' && symlinkTarget ? { symlinkTarget } : {}),
        ...(kind === 'file' && parsedSize !== undefined ? { sizeBytes: parsedSize } : {}),
        ...(kind === 'file' && sha256 ? { sha256 } : {}),
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
}

export function workspaceManifestRevision(
  roots: readonly string[],
  entries: readonly HeavyTaskWorkspaceObservationEntry[],
): WorkspaceRevisionRef {
  const canonical = {
    schemaVersion: 'maka.workspace_manifest.v1',
    roots: [...roots].sort(),
    entries: [...entries]
      .map((entry) => ({ ...entry }))
      .sort(
        (left, right) => left.path.localeCompare(right.path) || left.kind.localeCompare(right.kind),
      ),
  };
  return {
    kind: 'manifest',
    ref: `sha256:${createHash('sha256').update(JSON.stringify(canonical)).digest('hex')}`,
  };
}

function workspaceManifestIsContentAddressed(
  entries: readonly HeavyTaskWorkspaceObservationEntry[],
): boolean {
  return entries.every(
    (entry) =>
      entry.kind !== 'file' ||
      (entry.sizeBytes !== undefined &&
        typeof entry.sha256 === 'string' &&
        entry.sha256.length > 0),
  );
}

function isObservationKind(
  value: string | undefined,
): value is 'file' | 'directory' | 'symlink' | 'other' {
  return value === 'file' || value === 'directory' || value === 'symlink' || value === 'other';
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function cleanOneLine(value: string, limit: number): string {
  const cleaned = value.replace(/\s+/g, ' ').trim();
  return cleaned.length <= limit ? cleaned : `${cleaned.slice(0, limit - 3)}...`;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
