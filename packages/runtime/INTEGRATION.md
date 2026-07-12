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
