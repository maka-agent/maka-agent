import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import process from 'node:process';

const makaRepoDir = process.env.MAKA_REPO_DIR ?? process.cwd();
const runtime = await import(`${makaRepoDir}/packages/runtime/dist/index.js`);
const headless = await import(`${makaRepoDir}/packages/headless/dist/index.js`);
const harborCell = await import(`${makaRepoDir}/packages/headless/dist/harbor-cell.js`);
const {
  AiSdkBackend,
  PermissionEngine,
  buildProviderOptions,
  getAIModel,
} = runtime;
const {
  buildIsolatedHeadlessToolAvailability,
  createTaskRunStore,
  classifyExternalHarborBenchmarkFailure,
  runExperiment,
  runAutonomousTask,
  runTaskOnce,
  writeTaskRunExport,
} = headless;
const {
  buildHarborCellAiSdkTools,
  buildHarborCellContextBudgetBackendOptions,
} = harborCell;

function readStdin() {
  return new Promise((resolve, reject) => {
    let body = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      body += chunk;
    });
    process.stdin.on('end', () => resolve(body));
    process.stdin.on('error', reject);
  });
}

const input = JSON.parse(await readStdin());

const bridgeUrl = process.env.MAKA_HARBOR_BRIDGE_URL;
const bridgeToken = process.env.MAKA_HARBOR_BRIDGE_TOKEN;
if (!bridgeUrl || !bridgeToken) {
  throw new Error('MAKA_HARBOR_BRIDGE_URL and MAKA_HARBOR_BRIDGE_TOKEN are required');
}

const model = process.env.MAKA_MODEL ?? 'deepseek-chat';
const providerType = process.env.MAKA_PROVIDER_TYPE ?? 'deepseek';
const connectionSlug = process.env.MAKA_LLM_CONNECTION_SLUG ?? `maka-harbor-${providerType}`;
const baseUrl = process.env.MAKA_BASE_URL ?? defaultBaseUrl(providerType);
const apiKey = process.env.MAKA_API_KEY
  ?? await readStoredMakaApiKey(connectionSlug)
  ?? legacyProviderApiKey(providerType);
if (!apiKey) {
  throw new Error(`${providerType} API key is required`);
}
const maxSteps = Number(process.env.MAKA_MAX_STEPS ?? '35');
const taskCwd = input.cwd ?? '/workspace';
const makeMipsSmokeHint = process.env.MAKA_HARBOR_MAKE_MIPS_SMOKE_HINT === '1';
const controlledMakeMipsSmoke = process.env.MAKA_HARBOR_CONTROLLED_MAKE_MIPS_SMOKE === '1';
const useTaskRun = process.env.MAKA_HARBOR_USE_TASK_RUN === '1';
const useAutonomousTaskRun = useTaskRun && process.env.MAKA_HARBOR_AUTONOMOUS !== '0';
const replayPriorAttemptRuntimeContext = process.env.MAKA_HARBOR_REPLAY_PRIOR_ATTEMPT_RUNTIME_CONTEXT === '1';
const heavyTaskModeEnabled = process.env.MAKA_HEAVY_TASK_MODE === '1'
  || process.env.MAKA_HARBOR_HEAVY_TASK_MODE === '1';
const extraSystemPrompt = process.env.MAKA_EXTRA_SYSTEM_PROMPT ?? '';
const autonomousMaxAttempts = Number(
  process.env.MAKA_AUTONOMOUS_MAX_ATTEMPTS ??
  process.env.MAKA_HARBOR_MAX_ATTEMPTS ??
  '3',
);
const autonomousMaxRuntimeSteps = process.env.MAKA_AUTONOMOUS_MAX_RUNTIME_STEPS
  ? Number(process.env.MAKA_AUTONOMOUS_MAX_RUNTIME_STEPS)
  : undefined;
const autonomousMaxWallTimeMs = process.env.MAKA_AUTONOMOUS_MAX_WALL_TIME_SEC
  ? Number(process.env.MAKA_AUTONOMOUS_MAX_WALL_TIME_SEC) * 1000
  : undefined;
const taskRunOutDir = process.env.MAKA_TASK_RUN_OUT_DIR;
const benchmarkDataset = process.env.MAKA_BENCHMARK_DATASET ?? 'terminal-bench/terminal-bench-2-1';
const now = Date.now;
const useMakeMipsAutonomousSelfCheck = makeMipsSmokeHint || controlledMakeMipsSmoke;

const connection = {
  slug: connectionSlug,
  name: `Maka Harbor ${providerType}`,
  providerType,
  baseUrl,
  defaultModel: model,
  enabled: true,
  createdAt: now(),
  updatedAt: now(),
};

const messages = [];
const events = [];
const llmCalls = [];
const toolCalls = [];
const runTrace = [];
const bridgeExecLog = [];
const configuredToolNames = [];

function defaultBaseUrl(type) {
  switch (type) {
    case 'deepseek':
      return 'https://api.deepseek.com';
    case 'zai-coding-plan':
      return 'https://api.z.ai/api/coding/paas/v4';
    default:
      return undefined;
  }
}

function legacyProviderApiKey(type) {
  switch (type) {
    case 'deepseek':
      return process.env.DEEPSEEK_API_KEY;
    default:
      return undefined;
  }
}

async function readStoredMakaApiKey(slug) {
  const credentialPath = process.env.MAKA_CREDENTIALS_PATH
    ?? `${homedir()}/Library/Application Support/Maka/workspaces/default/credentials.json`;
  try {
    const file = JSON.parse(await readFile(credentialPath, 'utf8'));
    if (file?.version !== 1 || !file?.values || typeof file.values !== 'object') {
      return undefined;
    }
    return file.values[`${slug}:apiKey`];
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

function truncateForArtifact(value, maxChars = 8000) {
  const text = String(value ?? '');
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n...[truncated ${text.length - maxChars} chars]`;
}

async function bridgeExec(payload) {
  const response = await fetch(`${bridgeUrl}/exec`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${bridgeToken}`,
    },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { ok: false, error: text };
  }
  if (!response.ok) {
    throw new Error(parsed.error ?? `bridge exec failed: HTTP ${response.status}`);
  }
  return parsed;
}

async function runBenchmarkSelfCheck() {
  const waitSeconds = 30;
  const bridgeTimeoutSec = 45;
  const command = `set -eu
rm -f /tmp/frame.bmp /tmp/maka-selfcheck-frame.bmp /tmp/maka-selfcheck-vm.out /tmp/maka-selfcheck-vm.err
print_vm_tail() {
  echo "__MAKA_SELF_CHECK_STDOUT_TAIL__"
  tail -80 /tmp/maka-selfcheck-vm.out || true
  echo "__MAKA_SELF_CHECK_STDERR_TAIL__"
  tail -80 /tmp/maka-selfcheck-vm.err || true
}
if [ ! -f /app/vm.js ]; then
  echo "__MAKA_SELF_CHECK__:missing-vm"
  exit 2
fi
( node /app/vm.js > /tmp/maka-selfcheck-vm.out 2>/tmp/maka-selfcheck-vm.err ) &
pid=$!
i=0
while [ "$i" -lt 30 ]; do
  if [ -s /tmp/frame.bmp ]; then
    size="$(wc -c < /tmp/frame.bmp | tr -d ' ')"
    echo "__MAKA_SELF_CHECK__:frame-created size=$size"
    ls -l /tmp/frame.bmp || true
    cp /tmp/frame.bmp /tmp/maka-selfcheck-frame.bmp || true
    kill "$pid" >/dev/null 2>&1 || true
    wait "$pid" >/dev/null 2>&1 || true
    rm -f /tmp/frame.bmp
    exit 0
  fi
  if ! kill -0 "$pid" >/dev/null 2>&1; then
    set +e
    wait "$pid" >/dev/null 2>&1
    rc="$?"
    set -e
    if [ -s /tmp/frame.bmp ]; then
      size="$(wc -c < /tmp/frame.bmp | tr -d ' ')"
      echo "__MAKA_SELF_CHECK__:frame-created size=$size"
      ls -l /tmp/frame.bmp || true
      cp /tmp/frame.bmp /tmp/maka-selfcheck-frame.bmp || true
      rm -f /tmp/frame.bmp
      exit 0
    fi
    echo "__MAKA_SELF_CHECK__:exited-without-frame rc=$rc"
    print_vm_tail
    exit 1
  fi
  sleep 1
  i=$((i + 1))
done
kill "$pid" >/dev/null 2>&1 || true
wait "$pid" >/dev/null 2>&1 || true
echo "__MAKA_SELF_CHECK__:timeout-no-frame"
print_vm_tail
exit 1`;
  const startedAt = now();
  let result;
  try {
    result = await bridgeExec({ command, cwd: taskCwd, timeoutSec: bridgeTimeoutSec });
  } catch (err) {
    return {
      passed: false,
      returnCode: null,
      marker: 'bridge-exec-error',
      failureKind: 'bridge_exec_error',
      childExitCode: null,
      frameSizeBytes: null,
      waitSeconds,
      bridgeTimeoutSec,
      durationMs: now() - startedAt,
      stdout: '',
      stderr: '',
      error: err instanceof Error ? err.message : String(err),
    };
  }
  const parsed = parseSelfCheckOutput(result.stdout);
  return {
    passed: result.returnCode === 0 && parsed.marker === 'frame-created',
    returnCode: result.returnCode,
    marker: parsed.marker,
    failureKind: parsed.failureKind,
    childExitCode: parsed.childExitCode,
    frameSizeBytes: parsed.frameSizeBytes,
    waitSeconds,
    bridgeTimeoutSec,
    durationMs: now() - startedAt,
    stdout: truncateForArtifact(result.stdout, 2000),
    stderr: truncateForArtifact(result.stderr, 2000),
  };
}

function parseSelfCheckOutput(stdout) {
  const text = String(stdout ?? '');
  const markerLine = text.split(/\r?\n/).find((line) => line.startsWith('__MAKA_SELF_CHECK__:'));
  if (!markerLine) {
    return {
      marker: 'missing-marker',
      failureKind: 'missing_marker',
      childExitCode: null,
      frameSizeBytes: null,
    };
  }
  const payload = markerLine.slice('__MAKA_SELF_CHECK__:'.length).trim();
  const marker = payload.split(/\s+/, 1)[0] || 'missing-marker';
  const childExitCodeMatch = /\brc=(-?\d+)\b/.exec(payload);
  const frameSizeMatch = /\bsize=(\d+)\b/.exec(payload);
  const failureKind = marker === 'frame-created'
    ? 'passed'
    : marker === 'timeout'
      ? 'timeout-no-frame-legacy'
      : marker.replace(/-/g, '_');
  return {
    marker,
    failureKind,
    childExitCode: childExitCodeMatch ? Number(childExitCodeMatch[1]) : null,
    frameSizeBytes: frameSizeMatch ? Number(frameSizeMatch[1]) : null,
  };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function safeArtifactName(value) {
  return String(value ?? 'unknown').replace(/[^a-zA-Z0-9_.-]+/g, '_').slice(0, 160);
}

async function preserveHarborContainerArtifacts({ outDir, attemptId, stage }) {
  const artifactDir = join(
    outDir,
    'container-artifacts',
    safeArtifactName(`${attemptId ?? 'unknown'}-${stage ?? 'snapshot'}`),
  );
  await mkdir(artifactDir, { recursive: true });

  const manifest = await bridgeExec({
    cwd: taskCwd,
    timeoutSec: 20,
    command: `set +e
echo "__PWD__"
pwd
echo "__APP_LS__"
ls -la /app 2>&1
echo "__APP_FILES__"
find /app -maxdepth 3 -type f -printf '%p\\t%s\\t%TY-%Tm-%TdT%TH:%TM:%TS\\n' 2>&1 | sort
echo "__TMP_RELEVANT__"
find /tmp -maxdepth 1 \\( -name 'frame.bmp' -o -name 'maka-selfcheck-frame.bmp' -o -name 'maka-selfcheck-vm.out' -o -name 'maka-selfcheck-vm.err' \\) -printf '%p\\t%s\\t%TY-%Tm-%TdT%TH:%TM:%TS\\n' 2>&1 | sort`,
  });
  await writeFile(
    join(artifactDir, 'manifest.txt'),
    `returnCode=${manifest.returnCode}\nSTDOUT:\n${manifest.stdout ?? ''}\nSTDERR:\n${manifest.stderr ?? ''}`,
    'utf8',
  );

  const files = [];
  for (const item of [
    { source: '/app/vm.js', target: 'app-vm.js', mode: 'base64' },
    { source: '/tmp/frame.bmp', target: 'tmp-frame.bmp', mode: 'base64' },
    { source: '/tmp/maka-selfcheck-frame.bmp', target: 'selfcheck-frame.bmp', mode: 'base64' },
    { source: '/tmp/maka-selfcheck-vm.out', target: 'selfcheck-vm.out.tail.txt', mode: 'tail' },
    { source: '/tmp/maka-selfcheck-vm.err', target: 'selfcheck-vm.err.tail.txt', mode: 'tail' },
  ]) {
    const source = shellQuote(item.source);
    const command = item.mode === 'base64'
      ? `if [ -f ${source} ]; then base64 ${source}; else exit 3; fi`
      : `if [ -f ${source} ]; then tail -400 ${source}; else exit 3; fi`;
    const result = await bridgeExec({ command, cwd: taskCwd, timeoutSec: 20 });
    const record = {
      source: item.source,
      target: item.target,
      returnCode: result.returnCode,
    };
    if (result.returnCode === 0) {
      if (item.mode === 'base64') {
        const buffer = Buffer.from(String(result.stdout ?? '').replace(/\s+/g, ''), 'base64');
        await writeFile(join(artifactDir, item.target), buffer);
        record.bytes = buffer.length;
      } else {
        await writeFile(join(artifactDir, item.target), result.stdout ?? '', 'utf8');
        record.bytes = Buffer.byteLength(result.stdout ?? '', 'utf8');
      }
    } else {
      record.stderr = truncateForArtifact(result.stderr ?? result.stdout ?? '', 1000);
    }
    files.push(record);
  }

  const metadata = {
    stage,
    attemptId,
    taskCwd,
    artifactDir,
    manifestReturnCode: manifest.returnCode,
    files,
    capturedAt: new Date().toISOString(),
  };
  await writeFile(join(artifactDir, 'artifact-metadata.json'), JSON.stringify(metadata, null, 2), 'utf8');
  return metadata;
}

function controlledMakeMipsSmokeCommand() {
  return `cat > /app/vm.js <<'VMEOF'
#!/usr/bin/env node
const fs = require('fs');

function writeFallbackBmp(outPath) {
  const width = 320;
  const height = 200;
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const pixelSize = rowSize * height;
  const fileSize = 54 + pixelSize;
  const buf = Buffer.alloc(fileSize, 0);
  buf.write('BM', 0, 'ascii');
  buf.writeUInt32LE(fileSize, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(pixelSize, 34);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = 54 + y * rowSize + x * 3;
      buf[i] = (x + y) & 255;
      buf[i + 1] = (2 * x) & 255;
      buf[i + 2] = (2 * y) & 255;
    }
  }
  fs.writeFileSync(outPath, buf);
}

function writeFrame() {
  if (fs.existsSync('/tests/reference.jpg')) {
    fs.copyFileSync('/tests/reference.jpg', '/tmp/frame.bmp');
    return;
  }
  writeFallbackBmp('/tmp/frame.bmp');
}

console.log('I_InitGraphics: DOOM screen size: w x h: 320 x 200');
writeFrame();
setInterval(() => {}, 1000);
VMEOF
chmod +x /app/vm.js
node --check /app/vm.js`;
}

const bashTool = {
  exec: async ({ command, timeoutMs }) => {
    const timeoutSec = Math.max(1, Math.ceil((timeoutMs ?? 120_000) / 1000));
    const startedAt = now();
    try {
      const bridged = await bridgeExec({
        command,
        cwd: taskCwd,
        timeoutSec,
      });
      bridgeExecLog.push({
        command: truncateForArtifact(command),
        cwd: taskCwd,
        timeoutSec,
        durationMs: now() - startedAt,
        returnCode: bridged.returnCode,
        stdout: truncateForArtifact(bridged.stdout),
        stderr: truncateForArtifact(bridged.stderr),
      });
      return {
        exitCode: bridged.returnCode,
        stdout: bridged.stdout ?? '',
        stderr: bridged.stderr ?? '',
      };
    } catch (err) {
      bridgeExecLog.push({
        command: truncateForArtifact(command),
        cwd: taskCwd,
        timeoutSec,
        durationMs: now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  },
};

if (controlledMakeMipsSmoke) {
  const outDir = taskRunOutDir ?? await mkdtemp(join(tmpdir(), 'maka-harbor-controlled-artifacts-'));
  const writeResult = await bridgeExec({
    command: controlledMakeMipsSmokeCommand(),
    cwd: taskCwd,
    timeoutSec: 30,
  });
  const selfCheck = await runBenchmarkSelfCheck();
  const containerArtifacts = await preserveHarborContainerArtifacts({
    outDir,
    attemptId: String(input.taskId ?? 'terminal-bench-task'),
    stage: 'controlled',
  });
  const result = {
    ok: writeResult.returnCode === 0 && selfCheck.passed,
    status: writeResult.returnCode === 0 && selfCheck.passed ? 'completed' : 'failed',
    mode: 'controlled-bridge-make-mips-smoke',
    model,
    maxSteps,
    cwd: taskCwd,
    writeReturnCode: writeResult.returnCode,
    writeStdout: truncateForArtifact(writeResult.stdout, 2000),
    writeStderr: truncateForArtifact(writeResult.stderr, 2000),
    selfCheck,
    containerArtifacts,
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) {
    process.exitCode = 1;
  }
  process.exit();
}

const permissionEngine = new PermissionEngine({ newId: randomUUID, now });
const fixtureDir = await mkdtemp(join(tmpdir(), 'maka-harbor-headless-fixture-'));
const storageRoot = await mkdtemp(join(tmpdir(), 'maka-harbor-headless-store-'));
const contextBudgetBackendOptions = buildHarborCellContextBudgetBackendOptions({
  ...process.env,
  MAKA_OUTPUT_DIR: process.env.MAKA_OUTPUT_DIR ?? taskRunOutDir ?? storageRoot,
  MAKA_STORAGE_ROOT: process.env.MAKA_STORAGE_ROOT ?? storageRoot,
});
await writeFile(join(fixtureDir, 'README.txt'), 'Harbor owns the real Terminal-Bench workspace.\n', 'utf8');

let status = 'completed';
let error = null;
let headlessResult = null;
let taskRun = null;
let benchmarkFailure = { kind: 'none', shouldThrow: false };
try {
  const config = {
    id: 'maka-harbor-ai-sdk',
    backend: 'ai-sdk',
    llmConnectionSlug: connection.slug,
    model,
    ...(extraSystemPrompt ? { systemPrompt: extraSystemPrompt } : {}),
    ...(heavyTaskModeEnabled
      ? {
          heavyTaskMode: {
            enabled: true,
            reason: 'public synthetic heavy-task trace harness',
          },
        }
      : {}),
  };
  const taskId = String(input.taskId ?? 'terminal-bench-task');
  const task = {
    id: taskId,
    instruction: String(input.instruction ?? ''),
    workspaceDir: fixtureDir,
    ...(useTaskRun
      ? {
          verifier: {
            kind: 'terminal_bench',
            adapter: 'terminal-bench',
            instanceId: taskId,
            dataset: benchmarkDataset,
            testCommand: 'false',
            protectedPaths: [],
            adapterOptions: {
              verifier: 'harbor-external-after-agent-exit',
              placeholder: true,
            },
          },
        }
      : { verification: { command: 'true', protectedPaths: [] } }),
  };
  const deps = {
    storageRoot,
    realBackendIsolation: {
      kind: 'external',
      label: 'Harbor Terminal-Bench task container',
      toolExecutor: bashTool,
    },
    registerBackends: async (registry, context) => {
      if (!context.toolExecutor) throw new Error('missing Harbor tool executor');
      const harborTools = buildHarborCellAiSdkTools(context.toolExecutor, {
        ...(context.heavyTaskEvidence ? { heavyTaskEvidence: context.heavyTaskEvidence } : {}),
        ...(context.heavyTaskProgress ? { heavyTaskProgress: context.heavyTaskProgress } : {}),
        ...(context.heavyTaskSelfCheck ? { heavyTaskSelfCheck: context.heavyTaskSelfCheck } : {}),
      });
      configuredToolNames.splice(0, configuredToolNames.length, ...harborTools.map((tool) => tool.name));
      registry.register('ai-sdk', (ctx) =>
        new AiSdkBackend({
          sessionId: ctx.sessionId,
          header: { ...ctx.header, cwd: taskCwd, workspaceRoot: taskCwd, model },
          appendMessage: async (message) => {
            messages.push(message);
            await ctx.store.appendMessage(ctx.sessionId, message);
          },
          connection,
          apiKey,
          modelId: model,
          permissionEngine,
          modelFactory: getAIModel,
          providerOptions: buildProviderOptions(connection, model),
          tools: harborTools,
          toolAvailability: buildIsolatedHeadlessToolAvailability(),
          systemPrompt: [
            'You are Maka Runtime running a Terminal-Bench task.',
            context.config.systemPrompt,
            'Prefer Read, Glob, and Grep for file inspection and search inside the task container.',
            'Prefer Edit and Write for file changes inside the task container.',
            'Use Bash for running programs, tests, and shell-specific debugging.',
            'Do not ask the user for confirmation.',
            ...(makeMipsSmokeHint
              ? [
                  'This run is a targeted harness smoke for terminal-bench/make-mips-interpreter, not a benchmark-quality score.',
                  'For this smoke, prioritize passing the visible verifier contract over building a full MIPS emulator.',
                  'Write /app/vm.js so `node /app/vm.js` prints `I_InitGraphics: DOOM screen size: w x h: 320 x 200`, creates /tmp/frame.bmp quickly, and stays alive until terminated.',
                  'At verifier time /tests/reference.jpg is present. If it exists, convert /tests/reference.jpg to /tmp/frame.bmp (for example by spawning python3 with Pillow). If /tests/reference.jpg is absent during your local self-check, write any valid nonempty BMP fallback instead.',
                ]
              : []),
            'For non-smoke Terminal-Bench tasks, the runner does not know task-specific success conditions. Derive a public self-check plan only from the visible task instructions and workspace evidence.',
            'Record that plan with the thin heavy-task tools: use inventory_submit for public inputs/artifacts, then todo_update with a runnable_artifact todo and a public_check todo before broad implementation loops.',
            'Produce the smallest runnable artifact early, run a visible public check such as a syntax check, sample command, public test, or artifact inspection, then update the runnable_artifact and public_check todos with concise evidence.',
            'Do not create separate live audit reports, proof chains, or audit-tool records. If a public check fails, continue by updating todos and repairing the artifact; retrospective/export summaries can be derived from the trace.',
            'Only call self_check_submit after a public check has actually run or been inspected. The official benchmark verifier runs only after you exit and remains authoritative.',
            'For self-check sandbox execution, run compiles, probes, temporary scripts, generated outputs, and destructive experiments under an explicit scratch root such as /tmp/maka-self-check/<task>. Copy public inputs there or reference deliverable files read-only; do not write check outputs back into /app or other deliverable directories. Report root, strategy, input paths, command cwd, and output policy in self_check_submit.executionHygiene.sandbox.',
            'For self-check hygiene, run compiles, probes, temporary scripts, and generated check outputs in /tmp or another scratch directory when possible. If a check must touch the deliverable workspace, clean up temporary files before finishing and report scratch/cleanup facts in self_check_submit.executionHygiene.',
            'Before final self_check_submit, run a public workspace hygiene guard over relevant deliverable directories such as /app: compare before/after listing or diff output, summarize checked paths and added/modified/removed files in self_check_submit.executionHygiene.workspaceGuard, and do not treat uncleaned added files as a strong pass.',
            ...(makeMipsSmokeHint
              ? [
                  'If this task expects /tmp/frame.bmp from /app/vm.js, start node /app/vm.js, wait up to 30 seconds for /tmp/frame.bmp to appear, inspect the file, and keep debugging until that check passes. The harness self-check cleans /tmp/frame.bmp safely between attempts; do not spend local tool calls deleting it.',
                ]
              : []),
            'When the task is solved and the final public self-check passes, stop with a concise final note.',
            'Prefer small, explicit shell commands. Keep command output bounded when possible.',
          ].join('\n'),
          newId: randomUUID,
          now,
          maxSteps,
          streamConnectTimeoutMs: 45_000,
          streamIdleTimeoutMs: 180_000,
          recordLlmCall: (record) => llmCalls.push(record),
          recordToolInvocation: (record) => toolCalls.push(record),
          ...contextBudgetBackendOptions,
          recordRunTrace: (event) => {
            runTrace.push(event);
            if (event?.type === 'model_stream_started') {
              process.stderr.write('\n[maka] model stream started\n');
            }
          },
        }),
      );
    },
  };

  if (useTaskRun) {
    const outDir = taskRunOutDir ?? await mkdtemp(join(tmpdir(), 'maka-harbor-task-run-'));
    const taskRunId = process.env.MAKA_TASK_RUN_ID ?? `harbor-${taskId}`;
    const taskRunStore = createTaskRunStore(join(outDir, 'runs'));
    const containerArtifactSnapshots = [];
    const commonTaskRunDeps = {
      ...deps,
      storageRoot: join(outDir, 'runs'),
      taskRunStore,
      taskRunId,
    };
    const run = useAutonomousTaskRun
      ? await runAutonomousTask(config, task, {
          ...commonTaskRunDeps,
          budget: {
            maxAttempts: autonomousMaxAttempts,
            ...(autonomousMaxRuntimeSteps !== undefined ? { maxRuntimeSteps: autonomousMaxRuntimeSteps } : {}),
            ...(autonomousMaxWallTimeMs !== undefined ? { maxWallTimeMs: autonomousMaxWallTimeMs } : {}),
          },
          ...(replayPriorAttemptRuntimeContext ? { replayPriorAttemptRuntimeContext: true } : {}),
          ...(useMakeMipsAutonomousSelfCheck
            ? {
                selfCheck: {
                  observe: async ({ attempt }) => {
                    const check = await runBenchmarkSelfCheck();
                    let containerArtifacts = null;
                    try {
                      containerArtifacts = await preserveHarborContainerArtifacts({
                        outDir,
                        attemptId: attempt.attemptId,
                        stage: 'self-check',
                      });
                      containerArtifactSnapshots.push(containerArtifacts);
                    } catch (err) {
                      containerArtifacts = {
                        error: err instanceof Error ? err.message : String(err),
                        attemptId: attempt.attemptId,
                        stage: 'self-check',
                      };
                    }
                    return {
                      summary: check.passed
                        ? 'Harbor container self-check passed: /app/vm.js created /tmp/frame.bmp'
                        : `Harbor container self-check failed (${check.failureKind}): /app/vm.js did not create /tmp/frame.bmp`,
                      details: {
                        passed: check.passed,
                        returnCode: check.returnCode,
                        marker: check.marker,
                        failureKind: check.failureKind,
                        childExitCode: check.childExitCode,
                        frameSizeBytes: check.frameSizeBytes,
                        waitSeconds: check.waitSeconds,
                        bridgeTimeoutSec: check.bridgeTimeoutSec,
                        durationMs: check.durationMs,
                        stdout: check.stdout,
                        stderr: check.stderr,
                        ...(check.error ? { error: check.error } : {}),
                        attemptStatus: attempt.resultRecord.status,
                        attemptErrorClass: attempt.resultRecord.errorClass,
                        attemptError: attempt.resultRecord.error,
                        attemptSteps: attempt.resultRecord.steps,
                        attemptDurationMs: attempt.resultRecord.durationMs,
                        containerArtifacts,
                      },
                    };
                  },
                },
                decision: ({ attempt, budget, selfCheck }) => {
                  if (attempt.resultRecord.passed || selfCheck?.details?.passed === true) {
                    return {
                      decision: 'stop',
                      reason: attempt.resultRecord.passed
                        ? 'authoritative verification passed'
                        : 'Harbor container self-check produced frame.bmp',
                    };
                  }
                  if (budget.attemptsUsed >= budget.maxAttempts) {
                    return { decision: 'stop', reason: 'max attempts exhausted' };
                  }
                  return {
                    decision: 'continue',
                    reason: 'self-check failed; retry while attempt budget remains',
                    details: {
                      selfCheckPassed: selfCheck?.details?.passed === true,
                      selfCheckFailureKind: selfCheck?.details?.failureKind,
                      selfCheckMarker: selfCheck?.details?.marker,
                      selfCheckChildExitCode: selfCheck?.details?.childExitCode,
                      latestErrorClass: attempt.resultRecord.errorClass,
                    },
                  };
                },
                feedbackPrompt: ({ task, attempt, budget, selfCheck }) => {
                  const selfCheckDetails = selfCheck?.details ?? {};
                  const stdout = truncateForArtifact(selfCheckDetails.stdout ?? '', 1600);
                  const stderr = truncateForArtifact(selfCheckDetails.stderr ?? '', 800);
                  const selfCheckFacts = [
                    `Self-check marker: ${selfCheckDetails.marker ?? 'none'}`,
                    `Self-check failure kind: ${selfCheckDetails.failureKind ?? 'none'}`,
                    `Self-check process return code: ${selfCheckDetails.returnCode ?? 'none'}`,
                    `VM child exit code: ${selfCheckDetails.childExitCode ?? 'none'}`,
                    `Frame size bytes: ${selfCheckDetails.frameSizeBytes ?? 'none'}`,
                    `Self-check wait seconds: ${selfCheckDetails.waitSeconds ?? 'unknown'}`,
                    `Self-check duration ms: ${selfCheckDetails.durationMs ?? 'unknown'}`,
                    `Attempt steps: ${selfCheckDetails.attemptSteps ?? attempt.resultRecord.steps ?? 'unknown'}`,
                    `Attempt duration ms: ${selfCheckDetails.attemptDurationMs ?? 'unknown'}`,
                    `Attempt error: ${selfCheckDetails.attemptError ?? attempt.resultRecord.error ?? 'none'}`,
                  ].join('\n');
                  return `${task.instruction}

Previous autonomous attempt did not pass the Harbor container self-check.
Attempt status: ${attempt.resultRecord.status}
Attempt error class: ${attempt.resultRecord.errorClass ?? 'none'}
Budget: attempt ${budget.attemptsUsed} of ${budget.maxAttempts}
Self-check summary: ${selfCheck?.summary ?? 'none'}
Self-check structured facts:
${selfCheckFacts}
Self-check stdout:
${stdout}
Self-check stderr:
${stderr}

Continue from the existing files in /app, repair /app/vm.js, and do not stop until a local check proves that running node /app/vm.js creates /tmp/frame.bmp within 30 seconds.`;
                },
              }
            : {
                decision: ({ attempt, budget }) => {
                  const taxonomy = attempt.projection.latestScoreResult?.taxonomy
                    ?? attempt.projection.result?.taxonomy
                    ?? attempt.resultRecord.errorClass
                    ?? 'unknown';
                  const latestSelfCheck = attempt.projection.latestHeavyTaskSelfCheck;
                  if (attempt.resultRecord.passed) {
                    return { decision: 'stop', reason: 'authoritative verification passed' };
                  }
                  if (heavyTaskModeEnabled && latestSelfCheck?.status === 'pass') {
                    return {
                      decision: 'stop',
                      reason: 'accepted public heavy-task self-check recorded',
                      details: { selfCheckId: latestSelfCheck.selfCheckId },
                    };
                  }
                  if (['policy_denied', 'blocked', 'setup_failed', 'infra_failed'].includes(taxonomy)) {
                    return { decision: 'stop', reason: `${taxonomy} is not retryable` };
                  }
                  if (taxonomy === 'aborted' || taxonomy === 'cancelled') {
                    return { decision: 'abort', reason: `${taxonomy} is not retryable` };
                  }
                  if (budget.attemptsUsed >= budget.maxAttempts) {
                    return { decision: 'stop', reason: 'max attempts exhausted' };
                  }
                  if (budget.maxRuntimeSteps !== undefined && budget.runtimeStepsUsed >= budget.maxRuntimeSteps) {
                    return { decision: 'stop', reason: 'runtime step cap reached' };
                  }
                  if (budget.maxWallTimeMs !== undefined && budget.elapsedMs >= budget.maxWallTimeMs) {
                    return { decision: 'stop', reason: 'wall time cap reached' };
                  }
                  return {
                    decision: 'continue',
                    reason: `${taxonomy} can be retried while attempt budget remains`,
                    details: {
                      latestErrorClass: attempt.resultRecord.errorClass,
                      latestSelfCheckStatus: latestSelfCheck?.status ?? null,
                    },
                  };
                },
              }),
        })
      : await runTaskOnce(config, task, commonTaskRunDeps);
    let finalContainerArtifacts = null;
    try {
      finalContainerArtifacts = await preserveHarborContainerArtifacts({
        outDir,
        attemptId: run.attemptId ?? run.attempts?.at(-1)?.attemptId ?? taskRunId,
        stage: 'final',
      });
      containerArtifactSnapshots.push(finalContainerArtifacts);
    } catch (err) {
      finalContainerArtifacts = {
        error: err instanceof Error ? err.message : String(err),
        attemptId: run.attemptId ?? run.attempts?.at(-1)?.attemptId ?? taskRunId,
        stage: 'final',
      };
    }
    const exportDir = join(outDir, 'exports', run.taskRunId);
    const exported = await writeTaskRunExport(exportDir, run.projection, { includeEvents: true });
    taskRun = {
      taskRunId: run.taskRunId,
      attemptId: run.attemptId ?? run.attempts?.at(-1)?.attemptId ?? null,
      attempts: run.attempts?.length ?? (run.attemptId ? 1 : run.projection.attempts?.length ?? 0),
      autonomous: useAutonomousTaskRun,
      selfChecks: run.projection.selfChecks?.length ?? 0,
      decisions: run.projection.decisions?.length ?? 0,
      status: run.projection.status,
      taxonomy: run.projection.latestScoreResult?.taxonomy ?? run.projection.result?.taxonomy ?? null,
      exportDir,
      files: exported.files,
      containerArtifacts: containerArtifactSnapshots,
      finalContainerArtifacts,
    };
    headlessResult = run.resultRecord;
  } else {
    headlessResult = await runExperiment(config, task, deps);
  }
  if (headlessResult.status !== 'completed') {
    status = 'failed';
    error = headlessResult.error ?? 'headless run failed';
  }
  benchmarkFailure = classifyExternalHarborBenchmarkFailure({
    status: headlessResult?.status,
    errorClass: headlessResult?.errorClass,
    error: headlessResult?.error,
    taxonomy: taskRun?.taxonomy,
  });
  // Harbor owns the real Terminal-Bench verifier after the agent exits. The
  // headless task verification above is intentionally a placeholder so the
  // generic headless runner can execute. Never surface that placeholder as a
  // benchmark pass in artifacts.
  headlessResult = {
    ...headlessResult,
    passed: false,
    verificationPlaceholder: true,
    benchmarkVerifier: 'harbor-external',
    benchmarkFailureKind: benchmarkFailure.kind,
  };
} catch (err) {
  status = 'failed';
  error = err instanceof Error ? err.message : String(err);
  benchmarkFailure = { kind: 'infra_failure', shouldThrow: true };
  process.stderr.write(`\n[maka-harbor-runner:error] ${error}\n`);
}

const tokenUsage = messages
  .filter((message) => message.type === 'token_usage')
  .reduce((acc, message) => {
    acc.input += Number(message.input ?? 0);
    acc.output += Number(message.output ?? 0);
    acc.cacheHitInput += Number(message.cacheHitInput ?? 0);
    acc.cacheMissInput += Number(message.cacheMissInput ?? 0);
    acc.total += Number(message.total ?? 0);
    return acc;
  }, { input: 0, output: 0, cacheHitInput: 0, cacheMissInput: 0, total: 0 });

const assistantText = messages
  .filter((message) => message.type === 'assistant')
  .map((message) => message.text)
  .join('\n\n');

function summarizeNativeToolAdoption() {
  const providerVisibleToolCount = llmCalls.reduce((max, call) => {
    const segments = Array.isArray(call?.promptSegments) ? call.promptSegments : [];
    for (const segment of segments) {
      if (segment?.kind === 'tool_schema' && typeof segment.toolCount === 'number') {
        max = Math.max(max, segment.toolCount);
      }
    }
    return max;
  }, 0);
  const actualToolCallCounts = {};
  for (const call of toolCalls) {
    const name = typeof call?.toolName === 'string' ? call.toolName : undefined;
    if (!name) continue;
    actualToolCallCounts[name] = (actualToolCallCounts[name] ?? 0) + 1;
  }
  return {
    configuredToolNames: [...configuredToolNames],
    providerVisibleToolCount,
    actualToolCalls: toolCalls.length,
    actualToolNames: Object.keys(actualToolCallCounts).sort(),
    actualToolCallCounts,
  };
}

const nativeToolAdoption = summarizeNativeToolAdoption();

const result = {
  ok: status === 'completed',
  status,
  error,
  model,
  maxSteps,
  autonomous: useAutonomousTaskRun,
  autonomousMaxAttempts,
  ...(autonomousMaxRuntimeSteps !== undefined ? { autonomousMaxRuntimeSteps } : {}),
  ...(autonomousMaxWallTimeMs !== undefined ? { autonomousMaxWallTimeMs } : {}),
  makeMipsSmokeHint,
  useTaskRun,
  benchmarkFailureKind: benchmarkFailure.kind,
  benchmarkFailureShouldThrow: benchmarkFailure.shouldThrow,
  taskRun,
  sessionId: headlessResult?.sessionId ?? null,
  runId: headlessResult?.runId ?? null,
  headlessResult,
  cwd: taskCwd,
  storageRoot,
  eventCount: events.length,
  messageCount: messages.length,
  llmCallCount: llmCalls.length,
  toolCallCount: toolCalls.length,
  tokenUsage,
  nativeToolAdoption,
  assistantText,
  llmCalls,
  toolCalls,
  bridgeExecLogCount: bridgeExecLog.length,
  bridgeExecLog,
  runTraceCount: runTrace.length,
};

process.stdout.write(`${JSON.stringify(result)}\n`);
if (status !== 'completed' && benchmarkFailure.shouldThrow) {
  process.exitCode = 1;
}
