# PR-PI-AGENT-LOOP-0 Plan

Scope: replace Maka's primary chat agent loop with a pi / ACP-style coding-agent
loop in a staged way, while preserving Maka's event stream, storage, permission
UI, privacy boundaries, and existing tools.

This is a source-grounded migration plan. It is not a product roadmap page and
must not surface as user-visible copy.

## Source Anchors

reference implementation source: an upstream desktop agent's ACP / `pi-acp`
coding-agent path was inspected offline. Specific paths are held
out of this repo. The findings used in this plan are summarized
in §"Reference Loop Findings" below — no upstream file paths are
required to follow the migration.

Maka source:

- `packages/runtime/src/ai-sdk-backend.ts`
- `packages/runtime/src/session-manager.ts`
- `packages/core/src/backend-types.ts`
- `packages/core/src/events.ts`
- `packages/core/src/session.ts`

## Current Maka Loop

Maka currently has one production backend kind: `ai-sdk`.

`AiSdkBackend.send()` does all of this inside one class:

- creates an `AbortController`
- imports `ai`
- resolves a model through `modelFactory`
- wraps each `MakaTool` with permission handling
- materializes prior text messages only
- calls `streamText({ model, messages, tools, activeTools, system, stopWhen })`
- consumes `result.fullStream`
- normalizes text/thinking/tool events to `SessionEvent`
- persists assistant/tool/permission/token messages through `appendMessage`
- records usage telemetry

Important current constraints:

- `BackendKind` is only `'ai-sdk' | 'fake'`.
- Tool calls are persisted before permission decisions.
- Tool implementations are Maka-native callbacks.
- Tool output deltas are Maka-native side channels.
- Prior tool calls/results are not replayed into the next model request.
- The main loop is still model-provider based; it is not a process-backed agent
  session.

## Reference Loop Findings

The reference implementation has two distinct agent layers.

### Main Chat Loop

The main chat loop is still an AI SDK `streamText` loop in the inspected build.
Key features Maka can borrow without changing to pi:

- outer retry loop around a single stream
- `readUIMessageStream()` snapshot consumption
- delta computation from full UI-message snapshots
- stall watchdog with separate LLM idle timeout and tool idle timeout
- 4-hour hard generation watchdog
- pre-flight and token-limit compaction
- dynamic active tool set plus always-available tool discovery
- explicit step cap and completion tool behavior for specific providers
- post-stream usage/provider metadata harvesting

Maka already has smaller equivalents for some of these: stream watchdog, event
normalization, tool-output deltas, permission parking, and step cap grace copy.

### Coding Agent / Pi Layer

The reference implementation's coding-agent path uses ACP:

- `acpx` can launch `pi` through `npx pi-acp`.
- Configurable ACP providers are process-backed sessions.
- `createACPProvider(...)` exposes an AI-SDK-compatible provider around the
  child agent.
- The ACP session sends `session/prompt` and receives `session/update`.
- Streaming updates include agent text chunks, tool calls, tool-call updates,
  available command updates, and permission requests.
- ACP sessions carry cwd, optional MCP server definitions, auth method, linked
  provider env, and model mapping.
- Direct child-agent lanes parse NDJSON / JSON-RPC and translate them into UI
  message parts.

Critical security observation: some reference child-agent paths auto-approve
or skip permissions. Maka must not copy that behavior as the default. The pi
loop must route permission requests through Maka's `PermissionEngine` unless a
specific product mode explicitly allows otherwise.

## Target Architecture

Add a new runtime adapter while keeping `SessionManager` as the public runtime
owner:

```text
SessionManager
  -> BackendRegistry
     -> AiSdkBackend        current provider loop
     -> PiAgentBackend      process-backed pi / ACP loop

PiAgentBackend
  -> PiProcessSession
     -> spawn/attach pi-acp or acpx pi
     -> initialize/auth/session-new
     -> session-prompt
     -> normalize session/update frames to SessionEvent
     -> route session/request_permission to PermissionEngine
```

The renderer should keep consuming the same `SessionEvent` union. PR-PI-0 must
not introduce provider-native event types into the renderer.

## Blocking Gates

PR-PI-AGENT-LOOP-0 is not allowed to ship unless all gates below are met.

### G1 Backend Boundary

- Add a separate backend kind for the pi loop.
- Keep `AiSdkBackend` available for fallback until the pi path passes runtime
  smoke.
- Do not overload `backend: 'ai-sdk'` with process-backed behavior.
- Existing sessions must continue to open with their recorded backend kind.

### G2 Process Lifecycle

- Resolve the pi launcher from a bounded allowlist:
  - bundled `node_modules/.bin/acpx`
  - `~/.local/bin/acpx`
  - `/usr/local/bin/acpx`
  - `/opt/homebrew/bin/acpx`
  - explicit user-configured absolute path, if added later
- Start with a dry `status` / `initialize` probe before showing the backend as
  selectable.
- Track child pid, startedAt, cwd, and current request id.
- `stop()` must send cooperative cancel first, then terminate the child if it
  stays alive after a bounded timeout.
- `dispose()` must always close stdio and clear pending permission waiters.

### G3 Stream Normalization

Map ACP / pi events into existing Maka events:

- assistant text chunk -> `text_delta`
- final assistant text -> `text_complete`
- tool call start/update -> `tool_start` / `tool_progress` / `tool_output_delta`
- terminal tool result -> `tool_result`
- permission request -> `permission_request`
- error frame / child exit nonzero -> `error` + `complete(stopReason:'error')`
- cancel -> `abort` + `complete(stopReason:'user_stop')`

No renderer code may import ACP/pi SDK types.

### G4 Permission Boundary

- Every `session/request_permission` must go through Maka's `PermissionEngine`.
- The child-agent option ids must be mapped to Maka decisions; raw option copy
  must be redacted and capped before display.
- `rememberForTurn` can apply only to the normalized tool intent, not a broad
  child-agent grant.
- Bot / cron / background contexts must not silently auto-approve pi actions in
  PR-PI-0.
- There must be a negative test proving that an ACP permission request does not
  execute before `respondToPermission()` resolves allow.

### G5 Credential Boundary

- API keys, OAuth tokens, and child-agent auth env must stay in main/runtime.
- Renderer/preload must receive readiness state only.
- Env injected into a child process must be allowlisted per adapter.
- Telemetry must not record prompts, command args, token values, or raw ACP
  frames.

### G6 Storage and Replay

- Persist only Maka `StoredMessage` records, not raw ACP frames.
- Store child process diagnostics as redacted structured incidents.
- Reconnect/reload must recover a terminal status, not replay a live child
  process from partial UI state.
- If pi session persistence is enabled later, its session id must be stored as a
  separate redacted backend metadata field, not inside chat text.

### G7 Privacy / Incognito

- Incognito sessions must not start a persistent pi session.
- Incognito must not pass local memory, workspace instruction files, or durable
  session ids to the child agent.
- Read/write filesystem requests from the child must remain under the same
  permission policy as native tools.

### G8 Runtime Smoke

Before showing the pi backend as available:

- launcher probe passes
- can send one short text prompt and receive text
- can trigger one read-only tool request and render progress
- can trigger one permission request, deny it, and see a clean denied result
- stop button cancels a running prompt and leaves no child process
- no raw token/prompt/ACP frame appears in renderer DOM or usage telemetry

## PR Sequence

### PR-PI-AGENT-LOOP-0: Contract and Session Skeleton

Deliverables:

- `PiAgentBackend` skeleton implementing `AgentBackend`
- launcher resolution + probe helper
- ACP frame type guards for the small subset we consume
- no Settings UI selector yet
- tests for launcher resolution, event mapping, permission parking, child stop,
  and no renderer ACP type imports

Exit criteria:

- Pi backend can be constructed in tests with a fake process transport.
- A fake `session/update` stream maps into Maka events.
- A fake `session/request_permission` parks until user response.

### PR-PI-AGENT-LOOP-1: Dev-Flag Runtime Path

Deliverables:

- hidden env flag to create new sessions with pi backend
- real local `acpx pi` or direct `pi-acp` process transport
- text-only send path
- stop/dispose hardening

Exit criteria:

- manual local smoke with a real child process
- automated fake-transport tests stay green
- no visible product claim yet

### PR-PI-AGENT-LOOP-2: Tool and Permission UI Parity

Deliverables:

- map pi tool calls to existing ToolActivity cards
- map pi permission requests to existing PermissionDialog
- preserve current permission-mode semantics
- redacted/capped raw input preview

Exit criteria:

- allow/deny/remember flow tested
- renderer sees only Maka events
- denied child tool request does not execute

### PR-PI-AGENT-LOOP-3: Settings / Model Selection

Deliverables:

- Settings account/model surface for pi readiness
- backend selector or agent-loop selector
- probe status and repair copy

Exit criteria:

- pi is only selectable after probe
- existing ai-sdk sessions remain unaffected
- disabled/missing pi shows actionable setup copy, not raw errors

### PR-PI-AGENT-LOOP-4: Default Switch

Deliverables:

- switch new coding/deep-research sessions to pi by default if probe passes
- keep ai-sdk fallback for normal chat or failed probe
- add runtime smoke script

Exit criteria:

- end-to-end local run with text, read-only tool, permission deny, permission
  allow, stop, and reload
- no leaked raw frames/secrets in DOM, JSONL, or usage telemetry

## Explicit Non-Goals

- Do not port the reference implementation's auto-approve child-agent mode as default.
- Do not add arbitrary MCP forwarding in PR-PI-0.
- Do not expose raw pi/ACP frames to renderer or storage.
- Do not change Claude/OAuth subscription behavior in this PR.
- Do not delete `AiSdkBackend` until the pi path passes the runtime smoke.

## Current Gap Summary

Maka has strong event/storage/permission foundations, but it still lacks the
process-backed agent session layer. The next real implementation step is not a
UI polish pass; it is a fake-transport `PiAgentBackend` skeleton that proves
event normalization, permission parking, cancellation, and storage boundaries
before wiring any real child process.
