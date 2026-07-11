# Linux Bubblewrap Sandbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fail-closed Linux bubblewrap backend to Maka's existing `PermissionProfile` and `SandboxManager` runtime, then wire Bash execution through it on Linux.

**Architecture:** Keep upstream's canonical permission model and registered `SandboxBackend` interface. Add Linux capability probing and a `LinuxBubblewrapBackend` that materializes path context into bubblewrap argv, register it in the default manager, and pass the effective session profile into foreground and background Bash execution. Commands remain argv-based so wrapper quoting cannot escape the sandbox.

**Tech Stack:** TypeScript, Node.js child processes, bubblewrap (`bwrap`), Node test runner.

---

### Task 1: Synchronize With Upstream Sandbox Foundations

**Files:**
- Rebase: current worktree onto `origin/main`
- Preserve: all tracked and untracked Linux sandbox work

- [ ] **Step 1: Fetch and compare the remote heads**

Run: `git fetch --prune origin && git rev-list --left-right --count HEAD...origin/main`

Expected: remote refs update and the ahead/behind count is known.

- [ ] **Step 2: Preserve the current implementation in a local commit**

Run: `git add <sandbox-related-files> && git commit -m "feat(runtime): add Linux sandbox backend"`

Expected: the worktree implementation is recoverable throughout the rebase.

- [ ] **Step 3: Rebase onto the fetched main branch**

Run: `git rebase origin/main`

Expected: conflicts are limited to files upstream introduced or changed for the macOS sandbox foundation.

- [ ] **Step 4: Resolve conflicts in favor of upstream abstractions**

Keep `SandboxBackend`, `SandboxTransformRequest`, `SandboxTransformResult`, and `createDefaultSandboxManager`; port only Linux-specific behavior and shared Bash integration.

### Task 2: Linux Capability Probe and Backend Contract

**Files:**
- Create: `packages/runtime/src/sandbox/linux-capability.ts`
- Create: `packages/runtime/src/sandbox/linux-sandbox.ts`
- Modify: `packages/runtime/src/sandbox/types.ts`
- Modify: `packages/runtime/src/sandbox/index.ts`
- Test: `packages/runtime/src/__tests__/linux-sandbox.test.ts`
- Test: `packages/runtime/src/__tests__/sandbox-manager.test.ts`

- [ ] **Step 1: Write tests for capability and backend selection**

Cover non-Linux, missing `bwrap`, executable `bwrap`, registered Linux backend selection, and clear fail-closed errors.

- [ ] **Step 2: Run tests and verify RED**

Run: `npm --workspace @maka/runtime run build && node --test packages/runtime/dist/__tests__/linux-sandbox.test.js packages/runtime/dist/__tests__/sandbox-manager.test.js`

Expected: Linux backend exports/selection tests fail because the backend is not yet registered.

- [ ] **Step 3: Implement the minimal backend**

Implement `LinuxBubblewrapBackend.transform()` using the existing result union. Probe the configured `bwrap` executable and return `backend_not_available` when enforcement cannot be provided.

- [ ] **Step 4: Run tests and verify GREEN**

Run the same focused test command.

Expected: all contract tests pass.

### Task 3: Bubblewrap Filesystem and Network Policy

**Files:**
- Modify: `packages/runtime/src/sandbox/linux-sandbox.ts`
- Test: `packages/runtime/src/__tests__/linux-sandbox.test.ts`
- Test: `packages/runtime/src/__tests__/linux-sandbox-smoke.test.ts`

- [ ] **Step 1: Write argv contract tests**

Cover read-only roots, writable workspace roots, writable temp paths, protected metadata read-only overlays, `--unshare-net` for restricted networking, no network namespace for enabled networking, cwd, inner argv, and unsupported deny entries.

- [ ] **Step 2: Run tests and verify RED**

Expected: missing mount/network arguments or unsupported policy behavior fails with precise assertions.

- [ ] **Step 3: Materialize profile entries and path context**

Resolve special paths from `SandboxPathContext`, mount required host runtime paths read-only, bind allowed write roots, overlay existing protected metadata read-only, create an isolated `/tmp`, and include process/session namespaces.

- [ ] **Step 4: Fail closed for semantics bubblewrap cannot faithfully enforce**

Return `invalid_request` for deny entries that cannot be represented and never fall back to host execution.

- [ ] **Step 5: Run unit and Linux-only smoke tests**

Smoke assertions: workspace write succeeds, outside write fails, existing protected metadata write fails, restricted network fails, and non-Linux or unavailable bubblewrap skips with an explicit reason.

### Task 4: Register and Wire Linux Bash Execution

**Files:**
- Modify: `packages/runtime/src/sandbox/default-sandbox-manager.ts`
- Modify: `packages/runtime/src/builtin-tools.ts`
- Modify: `packages/runtime/src/shell-tools.ts`
- Modify: `packages/runtime/src/shell-run-manager.ts`
- Modify: `packages/runtime/src/tool-runtime.ts`
- Modify: `packages/cli/src/runtime-bootstrap.ts`
- Modify: `apps/desktop/src/main/main.ts`
- Test: `packages/runtime/src/__tests__/builtin-tools.test.ts`
- Test: `packages/runtime/src/__tests__/shell-exec.test.ts`

- [ ] **Step 1: Write tests for session-derived profiles**

Verify foreground and background Bash both compile `permissionMode + cwd`, consult real sandbox availability before permission evaluation, and execute the transformed argv.

- [ ] **Step 2: Run tests and verify RED**

Expected: current Bash tools bypass the default sandbox manager or lack argv metadata.

- [ ] **Step 3: Wire the effective profile through tool runtime**

Resolve sandbox metadata from the invocation context, retain permission prompts when Linux enforcement is unavailable, and pass `permissionMode` to tool implementations.

- [ ] **Step 4: Execute transformed commands without shell re-parsing**

Use `/bin/sh -lc <command>` as inner argv and spawn the final wrapper argv with `shell: false`; retain cwd, env, streaming, timeout, abort, and bounded output behavior.

- [ ] **Step 5: Register Linux in production entrypoints**

Use `createDefaultSandboxManager()` in CLI and Desktop so the same backend registry handles macOS and Linux.

### Task 5: Documentation and Verification

**Files:**
- Modify: `docs/sandbox/agent-runtime-codex-sandbox-todo.md`

- [ ] **Step 1: Document implemented scope and limitations**

Record bubblewrap distribution expectations, fail-closed behavior, Linux entrypoint wiring, and the limitation that absent protected metadata directories cannot be overlaid read-only until they exist.

- [ ] **Step 2: Run focused tests**

Run all permission-profile, sandbox-manager, Linux backend, Bash integration, shell runner, and workspace executor tests.

- [ ] **Step 3: Run full build and repository checks**

Run: `npm run build` and `git diff --check`.

Expected: build exits 0 and diff check reports no whitespace errors.

- [ ] **Step 4: Review the final diff against Phase 10**

Verify every Linux acceptance criterion has direct unit or smoke-test evidence; report platform-dependent tests as skipped when the current host is not Linux.
