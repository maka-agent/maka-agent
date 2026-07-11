import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const launcher = join(here, 'cu-e2e-launcher.mjs');

function readOption(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const runs = Number(readOption('--runs', '10'));
if (!Number.isInteger(runs) || runs < 1 || runs > 50) {
  throw new Error('--runs must be an integer from 1 to 50');
}
const batchId = readOption('--batch-id', new Date().toISOString().replace(/[:.]/g, '-'));
const outputDir = readOption(
  '--out',
  join(repoRoot, '.agents-workspace-data', 'cu-e2e', 'batches', batchId),
);

function runLauncher(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [launcher], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve({ code: code ?? 1, signal }));
  });
}

function percentile(values, percentileValue) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((percentileValue / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))];
}

function aggregate(reports) {
  const caseIds = [...new Set(reports.flatMap((report) => report.cases?.map((entry) => entry.caseId) ?? []))];
  const cases = Object.fromEntries(caseIds.map((caseId) => {
    const entries = reports.flatMap((report) => report.cases?.filter((entry) => entry.caseId === caseId) ?? []);
    const routeCounts = {};
    const fallbackReasons = {};
    for (const entry of entries) {
      const route = entry.route?.join(' > ') || 'none';
      routeCounts[route] = (routeCounts[route] ?? 0) + 1;
      if (entry.fallbackReason) {
        fallbackReasons[entry.fallbackReason] = (fallbackReasons[entry.fallbackReason] ?? 0) + 1;
      }
    }
    const durations = entries.map((entry) => entry.durationMs).filter(Number.isFinite);
    return [caseId, {
      runs: entries.length,
      pass: entries.filter((entry) => entry.pass).length,
      semanticPass: entries.filter((entry) => entry.semanticPass).length,
      behaviorPass: entries.filter((entry) => entry.behaviorPass).length,
      routeCounts,
      fallbackReasons,
      durationMs: {
        p50: percentile(durations, 50),
        p90: percentile(durations, 90),
        max: durations.length > 0 ? Math.max(...durations) : null,
      },
    }];
  }));
  return {
    schemaVersion: 1,
    batchId,
    requestedRuns: runs,
    completedRuns: reports.length,
    successfulRuns: reports.filter((report) => report.summary?.exitCode === 0).length,
    cases,
  };
}

await mkdir(outputDir, { recursive: true });
const reports = [];
for (let index = 0; index < runs; index += 1) {
  const suffix = String(index + 1).padStart(2, '0');
  const runId = `${batchId}-${suffix}`;
  const reportFile = join(outputDir, `run-${suffix}.json`);
  console.log(`\n=== Computer Use E2E repeat ${index + 1}/${runs}: ${runId} ===`);
  const exit = await runLauncher({
    MAKA_CU_E2E_RUN_ID: runId,
    MAKA_CU_E2E_REPORT_FILE: reportFile,
  });
  let report;
  try {
    report = JSON.parse(await readFile(reportFile, 'utf8'));
  } catch (error) {
    throw new Error(`run ${runId} produced no readable report: ${error}`);
  }
  if (report.runId !== runId) {
    throw new Error(`run ${runId} wrote mismatched report id ${JSON.stringify(report.runId)}`);
  }
  reports.push(report);
  if (exit.signal || report.fatal || report.summary?.exitCode !== exit.code) {
    throw new Error(
      `run ${runId} failed structurally: signal=${exit.signal ?? 'none'} `
      + `child=${exit.code} report=${report.summary?.exitCode} fatal=${report.fatal ?? 'none'}`,
    );
  }
}

const summary = aggregate(reports);
await writeFile(join(outputDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');
console.log(`\nComputer Use repeat summary: ${summary.successfulRuns}/${summary.completedRuns} green runs`);
for (const [caseId, entry] of Object.entries(summary.cases)) {
  console.log(
    `  ${caseId}: ${entry.pass}/${entry.runs}, `
    + `p50=${entry.durationMs.p50}ms p90=${entry.durationMs.p90}ms max=${entry.durationMs.max}ms`,
  );
}
process.exitCode = summary.successfulRuns === runs
  && Object.values(summary.cases).every((entry) => entry.pass === runs)
  ? 0
  : 1;
