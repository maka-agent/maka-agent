# 01 — Alma ACP bridge: delegating to Claude Code / Codex / Cursor / Antigravity

> Source-grounded against `~/Downloads/alma-re/readable/main.js`.
> Round-2 [`04-permissions-runtime.md`](../alma-deep-dive-yuejing-round-2/04-permissions-runtime.md)
> mentioned ACP as one of two policy-key sources alongside Bash.
> Round-3 [`04-permissions-runtime-risk.md`](../alma-deep-dive-yuejing-round-3/04-permissions-runtime-risk.md)
> traced the lh ladder but skipped ACP-specific paths. This note
> traces the full ACP bridge: how alma plugs in external coder
> agents as if they were native providers, and how their tool
> calls + permission requests bridge back to alma's UI.

## What ACP is

**ACP = Agent Client Protocol.** A JSON-RPC dialect spoken by
external "coder agent" runtimes that alma launches as
sub-processes. Today the supported bridges are:

| Provider type | Underlying agent | Connection |
|---|---|---|
| `claude-subscription` | Claude Code CLI | spawn `claude` |
| `codex` (via `coderAgentProviderId`) | OpenAI Codex CLI | spawn `codex` |
| `cursor` | Cursor's CLI agent | spawn `cursor` |
| `antigravity` | Google's Antigravity coder | spawn `antigravity` |
| `acp` (generic) | any ACP-speaking binary | user-configured |

`main.js:162`:

```js
createACPProvider as St, ...
} from "@mcpc-tech/acp-ai-provider";
```

The npm package wraps the spawn + JSON-RPC client + AI SDK
provider adapter behind a single factory. The agent loop sees
ACP-backed providers as ordinary `LanguageModelV1` instances —
same `generateText` / `streamText` API as OpenAI or Anthropic.

## Provider config shape

The schema (from round-4 [`01-rest-api-operator-agent.md`](../alma-deep-dive-yuejing-round-4/01-rest-api-operator-agent.md)
api-spec) includes ACP-specific fields on the Provider row:

```typescript
{
  type: 'acp' | 'claude-subscription' | 'codex' | ...,
  acpCommand?: string,         // executable to spawn (e.g., "claude")
  acpArgs?: string[],          // CLI args
  acpMcpServerIds?: string[],  // forward Maka MCP servers to ACP
  acpAuthMethodId?: string,    // login method id from the bridge
  acpApiProviderId?: string,   // upstream model provider (when the bridge accepts it)
  acpModelMapping?: {          // map alma model ids → bridge model ids
    defaultModel?: string,
    opusModel?: string,        // for Claude-style 3-tier mapping
    sonnetModel?: string,
    haikuModel?: string,
    subagentModel?: string,
  },
}
```

DB columns at `main.js:462-463`:

```typescript
acpCommand: text("acp_command"),
acpArgs: text("acp_args", { mode: "json" }).$type(),
```

So the user can install Claude Code + sign in with their
subscription, point an alma provider at it, and alma's agent
loop uses Claude Code as the inference backend AND uses
Claude's tool model. This is critical for users wanting to
USE their Claude Code subscription quota from inside alma.

## Session lifecycle

ACP sessions are keyed on `(providerId, threadId)` at
`main.js:48110-48150` (round-4 [`05-workspace-switching.md`](../alma-deep-dive-yuejing-round-4/05-workspace-switching.md)
covered this). Each session holds:

- `provider`: the AI SDK provider instance
- `availableCommands`: ACP-side slash commands (refreshed via
  `available_commands_update` events)
- `handlerSetUp`: a flag preventing double-wrapping of the
  session update handler
- `config.requestThreadId`: the alma thread that initiated this
  session (may differ from `threadId` if the session is reused)

`setupSessionUpdateHandler` (`main.js:19475-19704`) is the
**centerpiece** — it wraps the underlying provider's
`setSessionUpdateHandler` to intercept ACP events.

## The intercept-and-forward wrapper

```js
const original = client.setSessionUpdateHandler.bind(client);
client.setSessionUpdateHandler = (downstreamHandler) => {
  original(notification => {
    // INTERCEPT for alma's bookkeeping
    if (notification.update?.sessionUpdate === "available_commands_update") {
      session.availableCommands = notification.update.availableCommands;
      // notify alma-side listeners (Settings UI, etc.)
      const listeners = this.commandUpdateListeners.get(sessionKey);
      if (listeners) for (const fn of listeners) fn(session.availableCommands);
    }

    if (notification.update?.sessionUpdate === "tool_call_update") {
      // synthesize a tool-execution-result event for alma's UI
      this.toolExecutionResultCallback?.({
        toolCallId,
        toolName: notification.update.title || notification.update.toolCallId,
        output: notification.update.rawOutput ?? notification.update.content ?? null,
        isError: notification.update.status === "failed",
        status: notification.update.status || "completed",
        threadId, providerId,
      });
    }

    // FORWARD to whatever handler the AI SDK passed in
    if (downstreamHandler) {
      try { downstreamHandler(notification); }
      catch (err) {
        // "Controller is already closed" is normal during shutdown — silent
        if (!isControllerClosedError(err)) {
          console.error("[ACP] Error in session update handler:", err);
        }
      }
    }
  });
};
```

This is a **subscription proxy**: alma sees every ACP event,
processes the ones it cares about (commands list, tool calls),
then forwards the same event to whatever the AI SDK adapter
expected. The AI SDK never knows alma is reading along.

### Anti-double-wrap guard

`session.handlerSetUp = true` after wrap (`main.js:19546`). If
`setupSessionUpdateHandler` is called twice on the same session
(e.g., user switched away from the thread and came back), the
second call short-circuits at the early `if (o.handlerSetUp)
return true` check. Without this, alma's interception layer
would stack — every event would fire alma's callbacks N times.

### "Controller is already closed" silent suppression

`main.js:19535-19542`:

```js
.includes("Controller is already closed") || ...
  console.error("[ACP] Error in session update handler for ${n}:", err);
```

A downstream AI SDK handler frequently dies with "Controller is
already closed" when the user navigates away mid-stream. Spamming
the console would drown real errors. Alma matches against both
the error message AND `err.data.details` (the wrapper format
some bridges use) and downgrades to silent for matches. Other
errors still log.

This is a great pattern: **don't log expected errors** in code
you can't fix upstream. Note the specific string match — fragile
if @ai-sdk changes the wording, but a soft fail (logs extra
noise, never wrong behavior).

## Tool result bridging (`tool_call_update`)

ACP sends `tool_call_update` for every internal tool the coder
agent runs — Read, Write, Bash, etc. Alma rebroadcasts each as
a tool-execution-result event for its UI:

```js
{toolCallId, toolName, output, isError, status, threadId, providerId}
```

The renderer can show "Claude Code is running `Read file.ts`…"
in real-time — same UX as if alma's own Read tool ran. The user
sees a unified agent stream regardless of which engine is
generating.

Mapping notes:
- **`title || toolCallId`** for toolName: ACP doesn't always
  surface the tool name; fall back to the call id.
- **`rawOutput ?? content`** for output: different bridges put
  the result in different fields.
- **`status === "failed"`** → `isError: true`: normalized to
  alma's boolean. Other statuses (pending, completed) pass
  through as-is.

## Permission delegation — ACP asks alma's user

`main.js:19554-19704` is the **most interesting** part. When
the ACP-side agent (Claude Code, Codex, etc.) needs to run a
tool it doesn't auto-allow, it asks via
`setPermissionRequestHandler`. Alma delegates back to its OWN
permission UI:

```js
client.setPermissionRequestHandler(async (req) => {
  const toolName = req.toolCall.title || req.toolCall.kind || "Unknown Tool";
  const input = stringify(req.toolCall.rawInput);
  const ctx = pu.getContext();
  const isSubagent = ctx?.sessionId?.startsWith("subagent:");

  // Tell alma's UI: ACP needs permission
  this.toolExecutionResultCallback?.({
    toolCallId, toolName, status: "permission-requested", threadId, providerId,
  });

  // Use alma's own lh() permission ladder (round-3 04)
  const decision = await lh({
    source: "acp",
    title: "Allow ACP Tool Permission?",
    message: `ACP requested permission for tool: ${toolName}\n${input ? "Input:\n" + input : ""}`,
    confirmLabel: "Allow",
    cancelLabel: "Deny",
    type: "warning",
    threadId,
    metadata: {providerId, toolCallId, toolName, kind: req.toolCall.kind, isSubagent, source: ctx?.source},
  });

  // Map alma decision → ACP option
  const allowKind = decision.action === "allow_always" ? "allow_always" : "allow_once";
  const denyKind = "reject_once";
  const allowOpt = req.options.find(o => o.kind === allowKind)
                ?? req.options.find(o => o.kind === "allow_once");
  const denyOpt = req.options.find(o => o.kind === "reject_once")
                ?? req.options.find(o => o.kind === "reject_always");

  if (decision.approved && allowOpt) {
    // tell UI: allowed
    return { outcome: { outcome: "selected", optionId: allowOpt.optionId } };
  }
  if (!decision.approved && denyOpt) {
    return { outcome: { outcome: "selected", optionId: denyOpt.optionId } };
  }
  // No matching option — warn + reject. Bridge protocol mismatch.
});
```

Several non-obvious moves:

### 1. Subagent context detection (`main.js:19567`)

```js
const isSubagent = ctx?.sessionId?.startsWith("subagent:");
```

The `pu.getContext()` (round-3 04 mentioned) gives the **current
execution context**. If alma's parent agent invoked a Task
subagent that's now using ACP, the session id is prefixed with
`subagent:`. This flag is passed as metadata into `lh()` —
where round-3 04's bypass channel 2 (`metadata.isSubagent`) then
auto-approves the request.

So **alma's permission system has built-in awareness of "this
ACP call is on behalf of a subagent, don't modal the user."**
Cross-system context propagation done right.

### 2. Source: 'acp' policy keys

Round-3 04's `ih(input)` produces policy keys including
`acp:thread:N:tool:<kind>` and `acp:thread:N:all`. So "allow
always for Claude Code's Read tool in this thread" caches
correctly. Different source means **different policy
namespace** — ACP `allow_always` doesn't bleed into Bash
`allow_always`.

### 3. ACP option-shape flexibility

ACP bridges declare what options they support. The mapping
tries the most specific first, then falls back:
- allow: `allow_always` → `allow_once`
- deny: `reject_once` → `reject_always`

If a bridge supports neither allow option, we log a warning and
treat as deny. **Robustness through degradation.**

### 4. UI status pings

Three callbacks fire during a permission flow:
- `status: "permission-requested"` — modal opens, alma's UI
  shows "Claude Code is waiting for approval"
- `status: "approval-responded"` (after allow) — modal closed
  with allow
- `status: "permission-denied"` (after deny) — modal closed with
  deny, output = deny reason

This three-state flow lets the UI accurately reflect what's
happening on the ACP side without polling.

## Provider abstraction implications

The fact that ACP plugs into the AI SDK provider interface means
**every alma feature that consumes models works with ACP**:
- autoCompact (round-4 02) can use Claude Code as its
  summaryModel
- Memory query rewriting (round-4 03) can use Codex as its tool
  model
- Thread title generation works the same way
- Even the alma-operator agent (round-4 01) could theoretically
  be backed by ACP

This is the architectural payoff: by encapsulating ACP behind
the SDK provider abstraction, alma gets near-zero integration
cost for every new bridge.

## What Maka has today

Maka's `@maka/providers` supports OpenAI / Anthropic / Google /
DeepSeek / etc. via the AI SDK. Maka recently added partial ACP
shape (the `claude-subscription` provider in
`PR-OAUTH-SUBSCRIPTION-0`), but:
- No `setSessionUpdateHandler` wrapper for intercepting events
- No `setPermissionRequestHandler` delegation back to alma's UI
- No subagent context detection across the bridge boundary
- No `acpMcpServerIds` forwarding (Maka can't share its MCP
  servers with Claude Code yet)

## Ranked Maka improvements

1. **Adopt the intercept-and-forward subscription proxy
   pattern.** When wrapping ANY external SDK that exposes a
   "subscribe to events" entry point, this pattern lets the
   host app see everything without coupling the SDK to host
   internals. Cross-ref the round-3 02 in-band marker pattern
   — same "decouple via interception" idea.

2. **Delegate permission requests back to the host's permission
   ladder.** If Maka adds Claude Code bridge, the user should
   see ONE permission UX (Maka's), not Claude Code's separate
   modal. The setPermissionRequestHandler wrapper is the right
   shape.

3. **Subagent context propagation via session id prefix.** The
   `sessionId.startsWith("subagent:")` check lets host
   permission bypass channels apply correctly even when the
   tool call is happening "inside" a bridged agent. Cheap
   convention, big behavior payoff.

4. **Silent error suppression for "Controller is already
   closed".** Whenever you wrap an upstream SDK and forward
   events, you'll hit shutdown races. Adopting the string-
   match silent-suppression rule keeps console signal-to-noise
   high. Bonus: match against `err.data.details` for SDK
   wrappers that nest the error.

5. **Three-state permission UI callbacks
   (`permission-requested` / `approval-responded` /
   `permission-denied`).** Gives the UI everything it needs to
   render a clean state machine without polling. Cheap once
   the callback infrastructure exists.

## Open questions for future rounds

- The `acpMcpServerIds` field forwards Maka MCP servers to the
  ACP runtime. How? Does alma spawn `claude` with extra args,
  or pipe MCP config in via stdin? Either approach has
  interesting implications for credential sharing.
- The `acpModelMapping` has `opusModel`/`sonnetModel`/
  `haikuModel`/`subagentModel` slots — does alma route by Task
  weight or by alma's own subagent system (round-2 07)?
- What happens if the ACP-spawned process crashes mid-stream?
  Does the session auto-recover, or does the user need to
  manually restart? Round-5 candidate.
- The `acpAuthMethodId` field implies multi-auth support — does
  alma know how to OAuth Claude Code, or does it delegate
  entirely to the spawned process?

## Cross-refs

- Round 2: [`04-permissions-runtime.md`](../alma-deep-dive-yuejing-round-2/04-permissions-runtime.md)
  — first mention of ACP as a permission source.
- Round 3: [`04-permissions-runtime-risk.md`](../alma-deep-dive-yuejing-round-3/04-permissions-runtime-risk.md)
  — the `lh` ladder this note delegates to. `ih(input)` produces
  `acp:thread:N:tool:<kind>` policy keys.
- Round 4: [`01-rest-api-operator-agent.md`](../alma-deep-dive-yuejing-round-4/01-rest-api-operator-agent.md)
  — ACP fields are in the Provider type that the operator agent
  can manage via curl.
- Round 4: [`05-workspace-switching.md`](../alma-deep-dive-yuejing-round-4/05-workspace-switching.md)
  — ACP sessions are keyed on `(workspaceId, threadId)` and
  passed `workspacePath` for cwd.
- Round 4: [`07-websocket-sync.md`](../alma-deep-dive-yuejing-round-4/07-websocket-sync.md)
  — `toolExecutionResultCallback` writes events that broadcast
  via `/ws/threads` to the renderer.
