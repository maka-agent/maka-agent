# Linux Filesystem Worker and One-Shot Permissions Design

## Goal

Bring Linux to parity with the existing macOS runtime for:

- sandboxed `Read`, `Write`, `Edit`, `FormatJson`, `Glob`, and `Grep`;
- one-shot additional filesystem/network permissions; and
- explicit, approved one-shot unsandboxed Bash execution.

The implementation must preserve the current `PermissionProfile`, approval,
grant-consumption, and fail-closed semantics.

## Upstream Findings

The current upstream implementation is intentionally split:

- PR #745 added the Linux bubblewrap backend and wired sandboxed Bash.
- PR #983 added the filesystem worker and file-tool one-shot grants on macOS.
- PR #1016 added explicit unsandboxed escalation and auto review on macOS.

No open or merged follow-up was found that connects the latter two features to
Linux. PR #977 explicitly listed Linux exact-path enforcement as out of scope.

## Considered Approaches

### 1. Reuse the existing filesystem worker through bubblewrap

Enable the existing worker on Linux, teach the Linux backend to mount its
runtime resources, pass the backend's seccomp FD into the child, and enable the
existing one-shot planners on both supported sandbox platforms.

This is the selected approach. It keeps one protocol, one permission model, and
one approval path across macOS and Linux.

### 2. Keep file tools in the host and add `PermissionProfile` checks

This would improve policy checks but would leave file parsing, globbing, grep
launches, and mutations in the unsandboxed host process. It does not meet the
requested sandboxed-worker boundary.

### 3. Add a Linux-specific native helper or Landlock executor

This could express stronger path policies, including absent protected metadata
and missing exact Bash write targets, but it introduces a new native artifact,
distribution work, and a second execution implementation. It is unnecessary
for worker parity and remains a future hardening option.

## Architecture

### Host assembly

Desktop and CLI create a filesystem-worker launch provider whenever a builtin
platform sandbox manager exists. Today that means macOS and Linux. Windows
continues without the worker because it has no builtin sandbox backend.

`buildBuiltinTools` accepts one-shot Bash and file-tool permissions on both
`darwin` and `linux`. Other platforms still fail construction when a host tries
to opt into those features.

### Worker launch

Each file operation launches a fresh worker process. The client:

1. canonicalizes the session cwd and requested target;
2. compiles or accepts the active `PermissionProfile`;
3. consumes and revalidates any one-shot grant;
4. checks the target against the effective profile;
5. derives an operation-scoped worker profile;
6. transforms the launch through `SandboxManager`; and
7. sends one hash-bound request over stdin.

On Linux, the transformed request carries the seccomp program on FD 3. The
filesystem-worker process runner must create and populate inherited FD pipes in
the same way as foreground and background Bash.

### Linux mount materialization

The Linux backend adds three runtime-controlled mount categories:

- required readable roots for the worker bundle and runtime dependencies;
- required executable roots for Node/Electron and ripgrep; and
- trusted writable runtime roots used only for a missing exact file target.

Required roots use fail-closed binds. Optional shell/runtime discovery roots
retain `--ro-bind-try`.

An exact write to a missing file cannot be represented as a host bind because
the destination does not exist. For this case only, the trusted filesystem
worker supplies the canonical parent as a runtime writable root. The outer
bubblewrap boundary exposes that parent, while the single-use worker request
still enforces the exact target, access mode, target type, grant hash, and
realpath containment. Arbitrary Bash commands never receive this widening.

### One-shot permissions

Existing grant orchestration remains unchanged:

- additional grants are bound to session, turn, tool call, intent, normalized
  paths, and permission hash;
- grants are consumed once and revalidated immediately before execution;
- explicit `require_escalated` creates an exact one-shot Bash grant and runs
  with sandbox preference `forbid`;
- additional permissions and unsandboxed escalation remain mutually exclusive;
  and
- unsupported or unenforceable requests fail closed.

Linux uses the same planners and grants. Bubblewrap continues to reject
profiles it cannot represent instead of weakening them.

## Error Handling

- Missing/incompatible bubblewrap returns `backend_not_available`.
- Missing worker bundles or runtimes return the existing launch errors.
- Invalid FD specifications fail before spawn.
- Transform failures never fall back to in-process file access.
- Worker crashes, protocol mismatches, timeout, abort, and output overflow keep
  their existing structured errors.
- A Linux exact Bash write grant for a missing target is not silently widened;
  if bubblewrap cannot bind it, execution fails closed. Only the trusted file
  worker receives the parent-mount mechanism.

## Testing

Unit and contract coverage will prove:

- Linux is accepted for Bash and file-tool one-shot planners.
- CLI/Desktop assembly enables the worker on Linux-capable hosts.
- Linux transforms mount worker bundle/runtime/executable roots.
- A missing exact worker write mounts its parent without changing the internal
  exact operation permission.
- Seccomp FD inputs reach the filesystem worker child process.
- Existing macOS worker behavior remains unchanged.
- Linux-only smoke coverage performs real worker reads, writes, grep, outside
  denial, and one-shot exact outside writes when bubblewrap is available.

Fresh verification will include focused runtime tests, runtime build and
typecheck, repository lint/format checks, and the broadest practical test suite
on the current host.
