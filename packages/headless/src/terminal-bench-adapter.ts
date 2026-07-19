import type { TerminalBenchVerifierSpec } from './contracts.js';
import { runVerification } from './evaluator.js';
import type { BenchmarkVerifierOutput } from './benchmark-adapters.js';

export async function runTerminalBenchTestCommand(input: {
  verifier: TerminalBenchVerifierSpec;
  workspaceDir: string;
}): Promise<BenchmarkVerifierOutput> {
  const command = input.verifier.testCommand;
  if (!command || command.trim().length === 0) {
    return {
      kind: 'terminal_bench',
      passed: false,
      exitCode: null,
      error: 'terminal_bench verifier adapter is not implemented',
      errorClass: 'unsupported_adapter',
      authority: {
        source: 'self_check',
        authoritative: false,
        label: 'unsupported local benchmark placeholder',
      },
      details: { ...terminalBenchDetails(input.verifier), verificationPlaceholder: true },
    };
  }

  const startedAt = Date.now();
  const evaluation = await runVerification(command, input.workspaceDir, timeoutMs(input.verifier));
  const errorClass =
    evaluation.timedOut || evaluation.exitCode === null
      ? 'verification_error'
      : evaluation.passed
        ? undefined
        : 'verification_failed';
  return {
    kind: 'terminal_bench',
    passed: evaluation.passed,
    exitCode: evaluation.exitCode,
    durationMs: Date.now() - startedAt,
    stdout: evaluation.stdout,
    stderr: evaluation.stderr,
    ...(evaluation.timedOut ? { error: 'verification timed out' } : {}),
    ...(errorClass ? { errorClass } : {}),
    score: evaluation.passed ? 1 : 0,
    maxScore: 1,
    authority: {
      source: 'self_check',
      authoritative: false,
      label: 'local Terminal-Bench testCommand self-check',
    },
    details: {
      ...terminalBenchDetails(input.verifier),
      testCommand: command,
      timedOut: evaluation.timedOut,
      verificationPlaceholder: true,
    },
  };
}

export function terminalBenchDetails(verifier: TerminalBenchVerifierSpec): Record<string, unknown> {
  return {
    adapter: verifier.adapter,
    instanceId: verifier.instanceId,
    ...(verifier.dataset ? { dataset: verifier.dataset } : {}),
    ...(verifier.datasetPath ? { datasetPath: verifier.datasetPath } : {}),
    ...(verifier.taskDir ? { taskDir: verifier.taskDir } : {}),
    ...(verifier.taskDescriptionKey ? { taskDescriptionKey: verifier.taskDescriptionKey } : {}),
    ...(verifier.maxAgentTimeoutSec !== undefined
      ? { maxAgentTimeoutSec: verifier.maxAgentTimeoutSec }
      : {}),
    ...(verifier.maxTestTimeoutSec !== undefined
      ? { maxTestTimeoutSec: verifier.maxTestTimeoutSec }
      : {}),
    ...(verifier.adapterOptions ? { adapterOptions: { ...verifier.adapterOptions } } : {}),
  };
}

function timeoutMs(verifier: TerminalBenchVerifierSpec): number | undefined {
  return verifier.maxTestTimeoutSec === undefined ? undefined : verifier.maxTestTimeoutSec * 1000;
}
