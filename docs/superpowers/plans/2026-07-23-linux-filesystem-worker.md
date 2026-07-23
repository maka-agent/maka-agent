# Linux Filesystem Worker Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run Maka's local file tools through the sandboxed filesystem worker on Linux and enable Linux one-shot additional permissions plus explicit unsandboxed Bash escalation.

**Architecture:** Reuse the existing filesystem-worker protocol and `PermissionProfile` orchestration. Extend the Linux bubblewrap transform with trusted worker runtime mounts, forward seccomp FD inputs through the worker launcher, and enable the already platform-neutral approval planners in Linux host assembly.

**Tech Stack:** TypeScript, Node.js child processes and test runner, bubblewrap, classic-BPF seccomp, npm workspaces.

---

## File Map

- `packages/runtime/src/builtin-tools.ts`: supported-platform gate for one-shot planners.
- `packages/runtime/src/child-fd-input.ts`: reusable spawn stdio layout with configurable stdin.
- `packages/runtime/src/filesystem-worker/client.ts`: Linux worker path context and transformed FD forwarding.
- `packages/runtime/src/filesystem-worker/process-runner.ts`: spawn worker with inherited FD payloads.
- `packages/runtime/src/sandbox/types.ts`: runtime-only readable, executable, and writable mount context.
- `packages/runtime/src/sandbox/linux-sandbox.ts`: materialize worker runtime roots in bubblewrap.
- `packages/cli/src/runtime-bootstrap.ts`: construct the worker on Linux and macOS.
- `apps/desktop/src/main/tool-assembly.ts`: construct the worker on Linux and macOS.
- Runtime tests under `packages/runtime/src/__tests__`: unit, contract, and platform smoke coverage.

### Task 1: Enable Linux one-shot planner construction

**Files:**
- Modify: `packages/runtime/src/__tests__/builtin-tools.test.ts`
- Modify: `packages/runtime/src/__tests__/builtin-tools-file-worker.test.ts`
- Modify: `packages/runtime/src/builtin-tools.ts`

- [ ] **Step 1: Replace macOS-only expectations with Linux acceptance tests**

Add assertions that `buildBuiltinTools` succeeds for `sandboxPlatform: 'linux'`
when the required manager/worker exists, exposes `sandbox_permissions` on Bash,
and attaches a file-tool additional-permission planner.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```powershell
npm --workspace @maka/runtime run build
node --test packages/runtime/dist/__tests__/builtin-tools.test.js packages/runtime/dist/__tests__/builtin-tools-file-worker.test.js
```

Expected: Linux construction throws `supported only on macOS`.

- [ ] **Step 3: Permit both builtin sandbox platforms**

Replace the two `sandboxPlatform !== 'darwin'` checks with:

```ts
if (
  enabled &&
  sandboxPlatform !== 'darwin' &&
  sandboxPlatform !== 'linux'
) {
  throw new Error('... supported only on macOS and Linux.');
}
```

- [ ] **Step 4: Re-run the focused tests and verify GREEN**

Expected: both test files pass.

- [ ] **Step 5: Commit**

```powershell
git add packages/runtime/src/builtin-tools.ts packages/runtime/src/__tests__/builtin-tools.test.ts packages/runtime/src/__tests__/builtin-tools-file-worker.test.ts
git commit -m "feat(runtime): enable Linux one-shot permission planners"
```

### Task 2: Forward Linux seccomp FD inputs to filesystem workers

**Files:**
- Modify: `packages/runtime/src/__tests__/filesystem-worker-client.test.ts`
- Modify: `packages/runtime/src/child-fd-input.ts`
- Modify: `packages/runtime/src/filesystem-worker/client.ts`
- Modify: `packages/runtime/src/filesystem-worker/process-runner.ts`

- [ ] **Step 1: Add a client regression test**

Create a Linux fake backend transform that returns:

```ts
exec: {
  argv: ['/usr/bin/bwrap', '--seccomp', '3'],
  fdInputs: [{ fd: 3, data: Uint8Array.from([1, 2, 3]) }],
  cwd: workspace,
  env: {},
  sandboxType: 'linux',
  effectiveProfile: createReadOnlyPermissionProfile(),
}
```

Assert that the captured `FilesystemWorkerProcessRunInput.fdInputs` contains
the same FD and bytes.

- [ ] **Step 2: Run the client test and verify RED**

Run:

```powershell
npm --workspace @maka/runtime run build
node --test packages/runtime/dist/__tests__/filesystem-worker-client.test.js
```

Expected: `processInputs[0].fdInputs` is `undefined`.

- [ ] **Step 3: Extend the process-runner input and spawn path**

Add `fdInputs?: readonly ChildFdInput[]` to
`FilesystemWorkerProcessRunInput`. Extend `buildSpawnStdio` with an optional
stdin mode:

```ts
export function buildSpawnStdio(
  fdInputs: readonly ChildFdInput[] | undefined,
  stdin: 'ignore' | 'pipe' = 'ignore',
): Array<'ignore' | 'pipe'> {
  const stdio: Array<'ignore' | 'pipe'> = [stdin, 'pipe', 'pipe'];
  // existing FD validation and pipe allocation
}
```

Spawn the worker with `buildSpawnStdio(input.fdInputs, 'pipe')`, then call
`writeChildFdInputs(child, input.fdInputs)` before sending the JSON stdin.

- [ ] **Step 4: Forward transformed FD inputs from the client**

Pass:

```ts
...(transformed.exec.fdInputs ? { fdInputs: transformed.exec.fdInputs } : {})
```

to `runProcess`.

- [ ] **Step 5: Re-run the focused tests and verify GREEN**

Expected: client, shell-exec, and pipe-process-driver tests pass.

- [ ] **Step 6: Commit**

```powershell
git add packages/runtime/src/child-fd-input.ts packages/runtime/src/filesystem-worker/client.ts packages/runtime/src/filesystem-worker/process-runner.ts packages/runtime/src/__tests__/filesystem-worker-client.test.ts
git commit -m "feat(runtime): pass seccomp fd to Linux file workers"
```

### Task 3: Materialize worker runtime mounts in bubblewrap

**Files:**
- Modify: `packages/runtime/src/__tests__/linux-sandbox.test.ts`
- Modify: `packages/runtime/src/sandbox/types.ts`
- Modify: `packages/runtime/src/sandbox/linux-sandbox.ts`

- [ ] **Step 1: Add failing argv contract tests**

Add one test whose command path context contains:

```ts
runtimeReadableRoots: ['/runtime/filesystem-worker.js'],
executableRoots: ['/opt/node/bin/node', '/opt/rg/bin/rg'],
runtimeWritableRoots: ['/outside'],
```

Assert required `--ro-bind` mounts for readable/executable roots, a `--bind`
for `/outside`, and no redundant exact bind for `/outside/new.txt` when the
profile grants that exact write.

- [ ] **Step 2: Run Linux sandbox tests and verify RED**

Expected: the runtime roots are absent from bubblewrap argv.

- [ ] **Step 3: Add the runtime mount context**

Extend `SandboxPathContext`:

```ts
runtimeWritableRoots?: readonly string[];
```

In `buildBubblewrapArgv`, normalize and de-duplicate:

- optional `minimalRoots` as `--ro-bind-try`;
- required `runtimeReadableRoots` and `executableRoots` as `--ro-bind`; and
- required `runtimeWritableRoots` as `--bind`.

Filter profile read/write roots already covered by a runtime mount so a missing
exact target is not rebound.

- [ ] **Step 4: Re-run Linux sandbox tests and verify GREEN**

Expected: all argv and backend contract tests pass.

- [ ] **Step 5: Commit**

```powershell
git add packages/runtime/src/sandbox/types.ts packages/runtime/src/sandbox/linux-sandbox.ts packages/runtime/src/__tests__/linux-sandbox.test.ts
git commit -m "feat(runtime): mount Linux filesystem worker resources"
```

### Task 4: Give missing exact worker writes a trusted parent mount

**Files:**
- Modify: `packages/runtime/src/__tests__/filesystem-worker-client.test.ts`
- Modify: `packages/runtime/src/filesystem-worker/client.ts`

- [ ] **Step 1: Add a Linux missing-write path-context test**

Create a Linux client fixture, execute:

```ts
{
  operation: { kind: 'write', path: join(outside, 'new.txt'), content: 'new' },
  cwd: workspace,
  mode: 'ask',
  additionalGrant: exactWriteGrant,
}
```

Assert:

```ts
transform.command.pathContext.runtimeWritableRoots === [outside]
request.operationPermission.fileSystem.entries === [{
  path: join(outside, 'new.txt'),
  access: 'write',
  scope: 'exact',
}]
```

- [ ] **Step 2: Run the client test and verify RED**

Expected: `runtimeWritableRoots` is absent.

- [ ] **Step 3: Add the trusted parent only for Linux missing writes**

After target normalization, include:

```ts
...(platform === 'linux' &&
access === 'write' &&
target.targetType === 'missing'
  ? { runtimeWritableRoots: [dirname(target.enforcementPath)] }
  : {})
```

in the sandbox path context. Do not change the operation permission or grant.

- [ ] **Step 4: Re-run client and Linux sandbox tests**

Expected: both suites pass and the operation request remains exact.

- [ ] **Step 5: Commit**

```powershell
git add packages/runtime/src/filesystem-worker/client.ts packages/runtime/src/__tests__/filesystem-worker-client.test.ts
git commit -m "feat(runtime): support Linux worker file creation"
```

### Task 5: Wire Linux hosts and add smoke coverage

**Files:**
- Modify: `packages/cli/src/runtime-bootstrap.ts`
- Modify: `apps/desktop/src/main/tool-assembly.ts`
- Modify: `packages/runtime/src/__tests__/filesystem-worker-smoke.test.ts`

- [ ] **Step 1: Add a Linux smoke suite**

When `process.platform === 'linux'` and the bubblewrap capability probe passes,
run a real filesystem worker that verifies:

- workspace write and read;
- outside path denial without a grant;
- exact outside write with a one-shot grant;
- sibling denial with that grant; and
- file/directory Grep.

- [ ] **Step 2: Run the smoke test before host wiring**

On non-Linux the Linux suite skips explicitly. On Linux with bubblewrap it
should expose missing FD or mount behavior until Tasks 2-4 are complete.

- [ ] **Step 3: Enable worker construction whenever a builtin manager exists**

Replace the macOS-only launch-provider condition in both hosts:

```ts
const filesystemWorkerLaunchSpecProvider = sandboxManager
  ? createFilesystemWorkerLaunchSpecProvider(...)
  : undefined;
```

This enables macOS and Linux while leaving unsupported platforms unchanged.

- [ ] **Step 4: Run host builds and focused runtime tests**

Run:

```powershell
npm --workspace @maka/runtime run build
npm --workspace maka-agent run typecheck
npm --workspace @maka/desktop run typecheck
node --test packages/runtime/dist/__tests__/filesystem-worker-smoke.test.js
```

Expected: builds pass; platform-inapplicable smoke suites skip with clear
reasons.

- [ ] **Step 5: Commit**

```powershell
git add packages/cli/src/runtime-bootstrap.ts apps/desktop/src/main/tool-assembly.ts packages/runtime/src/__tests__/filesystem-worker-smoke.test.ts
git commit -m "feat(runtime): wire Linux sandboxed file tools"
```

### Task 6: Final verification

**Files:**
- Verify all changed files and commits.

- [ ] **Step 1: Run format and lint checks**

```powershell
npm run format:check
npm run lint
```

- [ ] **Step 2: Run typechecking and runtime tests**

```powershell
npm run typecheck
npm --workspace @maka/runtime run test
```

- [ ] **Step 3: Run the broad repository test command**

```powershell
npm test
```

If a host-only or pre-existing failure blocks the broad suite, preserve the
full evidence and rerun the directly affected suites.

- [ ] **Step 4: Inspect the final diff**

```powershell
git diff --check upstream/main...HEAD
git status --short
git log --oneline upstream/main..HEAD
```

Confirm every requested Linux behavior has direct test evidence and that the
three pre-existing untracked user paths remain untouched.
