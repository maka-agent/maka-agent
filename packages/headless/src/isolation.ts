import type { Config, Task } from './contracts.js';

export interface IsolatedCommandInput {
  command: string;
  cwd: string;
  timeoutMs?: number;
}

export interface IsolatedCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Executes agent-visible shell commands outside the host credential process.
 *
 * Implementations can be a Harbor/Terminal-Bench environment, a Docker
 * container, or another executor that gives the model a task workspace without
 * inheriting host env/files. The headless runner does not infer that safety:
 * callers must pass an explicit RealBackendIsolation record before any
 * model-backed backend is allowed.
 */
export interface IsolatedToolExecutor {
  exec(input: IsolatedCommandInput): Promise<IsolatedCommandResult>;
}

export interface ExternalRealBackendIsolation {
  kind: 'external';
  /**
   * Human-readable evidence for audit logs/errors, e.g. "Harbor task
   * container" or "Docker workspace executor". It must be non-empty so a real
   * backend cannot be enabled by an accidental truthy object.
   */
  label: string;
  /**
   * Optional command executor for callers that want to reuse the built-in
   * headless Bash tool. A caller may omit this when its registered backend is
   * already isolated internally.
   */
  toolExecutor?: IsolatedToolExecutor;
}

export type RealBackendIsolation = ExternalRealBackendIsolation;

export interface HeadlessBackendContext {
  config: Config;
  task: Task;
  /** Absolute throwaway workspace path for this run. */
  workspaceDir: string;
  /**
   * Present only for model-backed backends and only after the caller has
   * explicitly asserted an isolation boundary.
   */
  realBackendIsolation?: RealBackendIsolation;
  /** Convenience alias for realBackendIsolation.toolExecutor. */
  toolExecutor?: IsolatedToolExecutor;
}

export function validateRealBackendIsolation(isolation: RealBackendIsolation | undefined): void {
  if (!isolation) {
    throw new Error(
      'model-backed backend requires an isolated executor; pass realBackendIsolation with an explicit external isolation label',
    );
  }
  if (isolation.kind !== 'external') {
    throw new Error(`unsupported real backend isolation kind: ${(isolation as { kind?: unknown }).kind}`);
  }
  if (typeof isolation.label !== 'string' || isolation.label.trim().length === 0) {
    throw new Error('realBackendIsolation.label is required');
  }
}
