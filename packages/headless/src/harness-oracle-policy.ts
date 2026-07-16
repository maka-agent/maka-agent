import { createHash } from 'node:crypto';

export const HARBOR_ORACLE_VERSION = '0.13.2';
export const HARBOR_ORACLE_DOCKER_PLATFORM = 'linux/amd64';
export const HARBOR_ORACLE_EXECUTION_POLICY = {
  schemaVersion: 1,
  harborVersion: HARBOR_ORACLE_VERSION,
  environment: {
    type: 'docker',
    platform: HARBOR_ORACLE_DOCKER_PLATFORM,
    forceBuild: false,
    delete: true,
  },
  job: {
    agent: 'oracle',
    attempts: 1,
    concurrentTrials: 1,
    timeoutMultiplier: 1,
  },
  verifier: {
    importPath: 'maka_verifier:MakaVerifier',
    maxAttempts: 2,
    defaultAttemptTimeoutSec: 600,
    retryGraceSec: 120,
    timeoutPolicy: 'candidate_timeout_without_replay',
  },
  resultInterpretation: 'structured-verifier-outcome-and-reward-agreement-v1',
} as const;
export const HARBOR_ORACLE_MAX_ATTEMPTS = HARBOR_ORACLE_EXECUTION_POLICY.verifier.maxAttempts;

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
    policy: HARBOR_ORACLE_EXECUTION_POLICY,
    verifierImplementationFingerprint: fingerprintBytes(input.verifierImplementationSource),
    composeImplementationFingerprint: fingerprintBytes(input.composeImplementationSource),
  });
}

function fingerprintBytes(value: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function fingerprintValue(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}
