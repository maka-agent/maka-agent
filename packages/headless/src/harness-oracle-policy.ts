import { createHash } from 'node:crypto';

export const HARBOR_ORACLE_VERSION = '0.13.2';
export const HARBOR_ORACLE_DOCKER_PLATFORM = 'linux/amd64';
export const HARBOR_ORACLE_MAX_ATTEMPTS = 2;

export interface HarnessOracleTaskResult {
  outcome: 'passed' | 'failed' | 'candidate_timeout';
  reward: number;
  attempts: number;
}

export function buildHarnessOracleExecutionPolicyFingerprint(input: {
  verifierImplementationSource: string | Uint8Array;
  composeImplementationSource: string | Uint8Array;
}): string {
  return fingerprintValue({
    schemaVersion: 1,
    harborVersion: HARBOR_ORACLE_VERSION,
    environment: 'docker',
    dockerPlatform: HARBOR_ORACLE_DOCKER_PLATFORM,
    job: {
      agent: 'oracle',
      attempts: 1,
      concurrentTrials: 1,
      timeoutMultiplier: 1,
      forceBuild: false,
      deleteEnvironment: true,
    },
    verifier: {
      importPath: 'maka_verifier:MakaVerifier',
      maxAttempts: HARBOR_ORACLE_MAX_ATTEMPTS,
      defaultAttemptTimeoutSec: 600,
      retryGraceSec: 120,
      timeoutPolicy: 'candidate_timeout_without_replay',
    },
    verifierImplementationFingerprint: fingerprintBytes(input.verifierImplementationSource),
    composeImplementationFingerprint: fingerprintBytes(input.composeImplementationSource),
    resultInterpretation: 'structured-verifier-outcome-and-reward-agreement-v1',
  });
}

function fingerprintBytes(value: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function fingerprintValue(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}
