#!/usr/bin/env node
// Cheap RSI control experiment: real meta-agent, fake known-rule evaluator.
// It does not run Docker/Harbor tasks. Outputs live under repo-local maka-eval.

import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPromptControlExperiment } from '#prompt-control-run';

function envPath(name, fallback) {
  const raw = process.env[name];
  const value = raw && raw.length > 0 ? raw : fallback;
  if (!value) throw new Error(`${name} is required`);
  return value.startsWith('~') ? join(homedir(), value.slice(1)) : resolve(value);
}

function defaultLocalEvalRoot(repoRoot) {
  const marker = '/.worktree/';
  const index = repoRoot.indexOf(marker);
  return index >= 0 ? repoRoot.slice(0, index) : repoRoot;
}

async function main() {
  const repoRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
  const localEvalRoot = defaultLocalEvalRoot(repoRoot);
  const outDir = envPath(
    'MAKA_PROMPT_CONTROL_OUT_DIR',
    join(localEvalRoot, 'maka-eval', 'rsi-control-runs'),
  );
  const runId = process.env.MAKA_PROMPT_CONTROL_RUN_ID || `prompt-control-${Date.now()}`;
  const keyFile = envPath(
    'MAKA_PROMPT_KEY_FILE',
    join(localEvalRoot, '.local-secrets', 'deepseek-key'),
  );
  const provider = process.env.MAKA_PROMPT_PROVIDER || 'deepseek';
  const baseUrl = process.env.MAKA_PROMPT_BASE_URL || 'https://api.deepseek.com';
  const model = process.env.MAKA_PROMPT_MODEL || 'deepseek/deepseek-v4-flash';
  const runRoot = join(outDir, runId);

  await mkdir(runRoot, { recursive: true });
  console.log(`Starting prompt control experiment ${runId}`);
  const result = await runPromptControlExperiment({
    runId,
    runRoot,
    apiKeyFile: keyFile,
    provider,
    baseUrl,
    model,
  });

  console.log('---');
  console.log(
    `decision: ${result.decision?.decision ?? 'none'} (${result.decision?.reason ?? 'none'})`,
  );
  console.log(`learnedRulePresent: ${result.learnedRulePresent}`);
  console.log(
    `held-in: ${result.heldInBefore.passEligibleRate} -> ${result.heldInAfter.passEligibleRate}`,
  );
  console.log(`held-out: ${result.heldOutAfter.passEligibleRate}`);
  console.log(`result -> ${result.resultPath}`);
  console.log(`report -> ${result.reportPath}`);
  if (
    !result.accepted ||
    !result.learnedRulePresent ||
    result.heldOutAfter.passEligibleRate !== 1
  ) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
