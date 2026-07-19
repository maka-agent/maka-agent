import type { Task, VerifierSpec } from './contracts.js';
import type { TaskRunArtifactAuthority, TaskRunArtifactDescriptor } from './task-contracts.js';

export interface BenchmarkInstanceRef {
  adapter: string;
  dataset?: string;
  datasetPath?: string;
  instanceId: string;
  taskDir?: string;
  split?: string;
  metadata?: Record<string, unknown>;
}

export interface BenchmarkVerifierInput {
  verifier: Exclude<VerifierSpec, { kind: 'command' }>;
  workspaceDir: string;
  taskRunId: string;
  attemptId?: string;
  submittedSnapshotId?: string;
  scoringWorkspaceId?: string;
}

export interface BenchmarkVerifierOutput {
  kind: Exclude<VerifierSpec['kind'], 'command'>;
  passed: boolean;
  exitCode: number | null;
  durationMs?: number;
  stdout?: string;
  stderr?: string;
  error?: string;
  errorClass?: string;
  score?: number;
  maxScore?: number;
  authority?: TaskRunArtifactAuthority;
  artifacts?: TaskRunArtifactDescriptor[];
  details?: Record<string, unknown>;
}

export interface BenchmarkAdapter {
  readonly name: string;
  taskFromInstance?(input: BenchmarkInstanceRef): Promise<Task> | Task;
  runVerifier(
    input: BenchmarkVerifierInput,
  ): Promise<BenchmarkVerifierOutput> | BenchmarkVerifierOutput;
}

export type BenchmarkAdapterRegistry =
  | Record<string, BenchmarkAdapter>
  | Map<string, BenchmarkAdapter>;

export function resolveBenchmarkAdapter(
  registry: BenchmarkAdapterRegistry | undefined,
  name: string,
): BenchmarkAdapter | undefined {
  if (!registry) return undefined;
  if (registry instanceof Map) return registry.get(name);
  return registry[name];
}
