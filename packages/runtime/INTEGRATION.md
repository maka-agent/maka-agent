# Runtime Integration Guide

`@maka/runtime` exposes `SessionManager`, `BackendRegistry`,
`PermissionEngine`, `AiSdkBackend`, `FakeBackend`, builtin tools, and provider
helpers.

Desktop wiring lives in `apps/desktop/src/main/main.ts`:

1. Create storage with `createSessionStore()`, `createConnectionStore()`, and
   `createShellRunStore()`.
2. Create one process-wide `PermissionEngine`.
3. Create one process-wide `ShellRunProcessManager`.
4. Register `ai-sdk` and `fake` backends.
5. Use `AiSdkBackend` with `getAIModel`, `buildBuiltinTools()`, and the
   encrypted desktop credential store.
6. Forward `SessionEvent` values over `sessions:event:<sessionId>`.
7. Forward durable `ShellRunUpdate` values through a separate observer channel;
   they are runtime state, not model-turn events.

Provider connection CRUD and probes are exposed through `connections:*` IPC
handlers. The runtime package provides:

- `getAIModel()` for provider/model construction
- `testConnection()` for small REST probes
- `fetchProviderModels()` for model discovery
- `buildBuiltinTools()` for Read, Write, Bash, Grep, Glob, and the currently
  unregistered Edit implementation. Inject `ShellRunProcessManager` through
  the `shellRuns`, `runtimeResources`, `backgroundTasks`, and `ptyControls`
  capability slots to add background Bash, runtime-resource Read,
  `StopBackgroundTask`, and `WriteStdin` to Desktop or TUI hosts. Headless and
  subagent hosts omit those capabilities.

PTY Bash uses `node-pty` with an in-process headless terminal parser. This keeps
process, parser, persistence, and cleanup ownership inside the existing
`ShellRunProcessManager`, and supports native Windows ConPTY without requiring
an external session server such as tmux. The parser is required for truthful
screen state after clear, redraw, cursor movement, and alternate-screen
transitions; resize alone is not the reason for this architecture. POSIX PTY
commands explicitly use `/bin/sh -c`, matching the current `shell: true` pipe
dialect.

Terminal output redaction is deliberately conservative because sensitive text
can cross wrapped rows and parser boundaries; a match may replace more context
than the exact secret span. Process-tree cleanup is also bounded by the host OS:
processes that remain uninterruptible even after `SIGKILL` are reported as an
integrity failure rather than held forever or reported as successfully cleaned.
