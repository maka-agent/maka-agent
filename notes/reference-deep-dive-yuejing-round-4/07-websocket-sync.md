# 07 — Reference app WebSocket sync: 9 channels, single port, surgical state push

> Source-grounded against `~/Downloads/reference-source/readable/main.js`.
> Pivoted from NvChad (only the settings schema lives in main.js;
> implementation is renderer-side). WebSocket sync is the
> architectural through-line that ties together round-4 01 (REST
> API), 02 (autoCompact telemetry), 03 (memory progress events),
> 05 (workspace sync), and even round-2 10 (ChromeRelay browser
> extension transport).

## The strategy: one Express server, multiple WS channels

`main.js:166`:

```js
import { WebSocket as _t, WebSocketServer as $t } from "ws";
```

`main.js:65411` calls `this.setupWebSocket()` immediately after
the Express HTTP server starts. The WS server **piggybacks on
the same port** as the REST API:

```js
this.wss = new $t({ server: this.server });
```

This is the right choice for a desktop app: one localhost port,
two protocols. Renderer connects via
`new WebSocket("ws://localhost:<port>/ws/<channel>")` using the
port discovered through `~/.config/reference app/api-spec.md` (round-4
01). Same discovery, two surfaces.

## 9 routed channels at `main.js:59107-59320+`

The connection handler dispatches on URL path:

| Path | Purpose | Client set |
|---|---|---|
| `/ws/threads` | Generate response, stop generation, message stream | `threadSyncClients` |
| `/ws/settings` | Settings updates + theme preview | `settingsSyncClients` |
| `/ws/providers` | Provider CRUD + capability updates | `providerSyncClients` |
| `/ws/memory` | Memory recall + write events | `memorySyncClients` |
| `/ws/skills` | Skills enabled/disabled/reordered | `skillsSyncClients` |
| `/ws/mcp-resources` | MCP resource list changes | `mcpResourcesSyncClients` |
| `/ws/debug-sse` | Diagnostic event stream | one-off handler |
| `/ws/browser-relay?token=…` | Chrome extension transport (round-2 10) | `Ey.handleConnection` |
| `/ws/terminal/<sessionId>` | xterm.js → PTY bridge | `rE.addClient` |
| `/ws/workspace/<id>` | Workspace-scoped events | per-workspace |

Each channel:
1. Validates the path / params.
2. Adds the socket to a topic-specific `Set`.
3. Wires per-message handler.
4. Wires `close` handler to remove from the set.

10 distinct lifecycles, one routing function. Adding a 10th
channel is ~15 lines.

## Auth model

Two auth shapes:

- **`/ws/browser-relay?token=…`** validates against `Ey.validateToken`
  (`main.js:59250`). The token is generated + persisted in reference app
  settings (round-2 10's `chromeRelayAuthToken`). Mutual
  auth — the Chrome extension proves it's the user's.
- **Everything else: no auth.** Bound to 127.0.0.1; same trust
  model as the REST API (round-4 01). Local malicious processes
  could spoof a renderer connection — reference app takes the
  "local-machine = trusted" stance.

Token validation on `/ws/browser-relay` returns `close(4001,
"Invalid token")` — RFC 6455 application-defined close code.
Clients can read this and present "extension is misconfigured"
UI.

## `/ws/threads` — the agent loop transport

`main.js:59113-59189`. This is the **main interactive channel**.
The renderer SENDS messages of two types:

```typescript
{type: "generate_response", data: {
  threadId, userMessage, retryOfMessageId?, replaceMessageId?,
  tools?, reasoningEffort?, enabledMCPServerIds?, source?,
  noTools?, ephemeralModel?, userMessageMetadata?,
  ephemeralContext?, fromQuickChat?, hummingbirdContext?,
  model?
}}

{type: "stop_generation", data: {threadId}}
```

Notable details:
- **Model resolution cascade**: explicit `model` → thread's
  stored `model` → `settings.chat.defaultModel` → unprefixed-
  to-prefixed resolution if needed (`main.js:59137-59153`).
  Same fallback shape across multiple call sites.
- **`sourceClient: e`** is passed to `generateChatResponse`. The
  source socket can receive streaming responses while OTHER
  connected clients (multi-window) only get summary updates.
- **`source` string** identifies origin: cron / telegram /
  discord / heartbeat (cross-ref round-3 04 bypass channels).
  Set explicitly by the sender; the WS handler doesn't validate
  it but downstream permission logic trusts it.

## `/ws/settings` — theme preview echo

`main.js:59190-59212` has a SPECIAL handler shape:

```js
e.on("message", (msg) => {
  if (msg.type === "theme_preview") {
    const payload = JSON.stringify({...msg, timestamp: now()});
    this.settingsSyncClients.forEach(other => {
      if (other !== e && other.readyState === OPEN) {
        other.send(payload);
      }
    });
  }
});
```

This is **client-to-client broadcast** WITHOUT going through
server state. When user is dragging a theme preview slider in
one Maka window, all OTHER windows preview the same theme in
real-time. Doesn't write to settings DB — it's transient. Drop
the slider and `PUT /api/settings` commits.

The `n !== e` filter ensures the sender doesn't get its own echo
back. Classic broadcast-except-sender pattern.

## Broadcast helpers — surgical state push

`main.js:58990-59014` shows the three "broadcast X sync" helpers
share a template:

```js
broadcast<X>Sync(eventName, data) {
  const payload = JSON.stringify({
    type: eventName,
    data,
    timestamp: new Date().toISOString(),
  });
  this.<X>SyncClients.forEach(socket => {
    if (socket.readyState === WebSocket.OPEN) socket.send(payload);
  });
}
```

- **Stamped at broadcast time**, not when client receives.
  Clients can ignore stale events by timestamp.
- **Open-state filter** — closed sockets are skipped, not
  removed inline. Cleanup happens in the `close` handler
  registered at connect time.
- **No backpressure handling** — `send` is fire-and-forget. If
  a client is slow, messages queue in WS internal buffer.
  Eventual disconnect if backed up too far.

Helpers exist for: `Thread`, `Settings`, `Skills`, `Provider`,
`MCPResources`. Each topic has its own client set + its own
helper. ~60 call sites total throughout the codebase
broadcast specific event types.

### Provider broadcast strips `availableModels`

`main.js:59012-59014`:

```js
if (data && typeof data === "object" && "availableModels" in data) {
  const { availableModels: _, ...rest } = data;
  n = rest;
}
```

`availableModels` can be huge (hundreds of OpenAI models per
provider). Stripping before broadcast keeps WS payloads tight.
Renderer must re-fetch via `GET /api/providers/:id/models` if it
needs the full list. Reasonable trade.

## Event vocabulary

Sample event types broadcast across the 5 sync channels:

| Channel | Events |
|---|---|
| Threads | `thread_created`, `thread_updated`, `thread_deleted`, `message_updated`, `todo_update`, `context_compaction_started`, `context_compacted`, `context_usage_update` |
| Settings | `settings_updated`, `theme_preview` (client-routed) |
| Providers | `provider_created`, `provider_updated`, `provider_deleted` |
| Skills | enable / disable / reorder events |
| MCP | `resources_list_changed`, `resource_updated` |

Three rules visible across event names:
1. **Past-tense verb forms** (`thread_created`, not
   `create_thread`). Events describe completed state changes.
2. **Topic-prefixed**: `context_*` cluster, `provider_*` cluster,
   `thread_*` cluster — easier to filter at the client.
3. **Minimal payloads** (`{id}` for deletes, full object for
   creates/updates). Clients SHOULD have current state; events
   are notification, not data sync.

## `/ws/terminal/<sessionId>` — bidirectional PTY bridge

`main.js:59265-59300`. The terminal channel is **interactive
both directions**:

- On connect: server sends `{type: "terminal_output", data:
  scrollbackBuffer}` so the new client sees existing history.
- Client → server: `{type: "input", data: keystrokes}` and
  `{type: "resize", cols, rows}`.
- Server → client: PTY stdout streamed via separate broadcast.

The scrollback-on-connect pattern matters: opening a new window
on a long-running command shouldn't lose history. Cross-ref
round-2 [`05-bash-tool-family.md`](../reference app-deep-dive-yuejing-round-2/05-bash-tool-family.md)
for the BashOutput tool that uses the same scrollback model.

## `/ws/workspace/<id>` — workspace-scoped events

`main.js:59301-59320+`. Validates workspace exists, otherwise
sends error JSON and closes. The renderer's workspace switcher
opens this channel when the user navigates into a workspace —
events scoped to that workspace get delivered. Cross-ref
round-4 [`05-workspace-switching.md`](./05-workspace-switching.md).

## Shutdown contract

`main.js:65591-65596`:

```js
this.wss && (
  this.wss.clients.forEach(c => c.terminate()),
  this.wss.close()
);
```

Forced termination of all clients (not graceful close), then
server close. Reasonable for app shutdown — renderers close
soon after anyway.

## What Maka has today

Maka uses **IPC** (Electron `webContents.send` / preload
`contextBridge`) for renderer ↔ main communication. There's no
WebSocket layer. The agent never sees state changes initiated
outside the renderer.

When reference app's REST + WS architecture lands, Maka would gain:
- External agents (operator-style) can drive the app.
- Headless mode is possible (`ALMA_HEADLESS=1` mode from
  round-3 04).
- Multi-window state sync is automatic (vs IPC's per-window
  send loops).
- Test infra can mock the WS layer instead of mocking IPC.

## Ranked Maka improvements

1. **Adopt the channel-routing pattern on a single WS server.**
   Even without REST, a WS server with `/ws/<topic>` paths is
   the right shape. ~80 lines for setup + 3 channels (threads,
   settings, providers). Future channels are 15 lines each.

2. **Strip-large-fields-before-broadcast.** The
   `availableModels` strip pattern is generalizable: any
   "list of N items" payload should be a `*_list_changed`
   notification, NOT the full list. Push push push, pull pull
   pull — events for notify, REST for fetch.

3. **Adopt the past-tense event vocabulary.** `thread_created`
   not `create_thread`. Topic prefix + past-tense verb. Cheap
   convention, big readability dividend.

4. **Scrollback-on-connect for any "long-running stream"
   channel.** Whether terminal, log tail, or background-agent
   transcript — when a new client connects, send the current
   state then start streaming new events. Avoids "I missed
   what happened" UX.

5. **Use RFC 6455 application close codes for protocol errors.**
   `close(4001, "Invalid token")` is more informative than
   silent disconnect. Lets the renderer surface "you need to
   re-authenticate" instead of "connection dropped."

## Open questions for future rounds

- The auth model trusts 127.0.0.1. A malicious local process
  could open `/ws/threads` and inject `generate_response`
  messages, consuming the user's API quota or executing
  arbitrary commands via Bash tool. Round-5 candidate: is
  there ANY per-renderer auth (cookie, origin check), or
  purely localhost trust?
- The `theme_preview` echo doesn't write to the DB, but other
  client-routed messages? Are there any other "transient
  client-to-client" event types beyond theme preview?
- The WS layer has no `ack` mechanism. If `broadcastThreadSync`
  fires during a client reconnect window, the event is lost.
  Are critical events (e.g., tool approval results) sent only
  via WS, or also persisted to DB for replay?
- Theme preview is client-to-client. Does it cross-window
  ALSO update the local renderer? Or does the user-facing
  effect happen in-renderer first, with the WS broadcast as
  a sync-out?

## Cross-refs

- Round 2: [`05-bash-tool-family.md`](../reference app-deep-dive-yuejing-round-2/05-bash-tool-family.md)
  — terminal scrollback-on-connect mirrors BashOutput's
  scrollback model.
- Round 2: [`10-chrome-relay.md`](../reference app-deep-dive-yuejing-round-2/10-chrome-relay.md)
  — `/ws/browser-relay?token=…` is the Chrome extension's
  transport.
- Round 4: [`01-rest-api-operator-agent.md`](./01-rest-api-operator-agent.md)
  — same Express server; REST + WS share the port.
- Round 4: [`02-auto-compact.md`](./02-auto-compact.md) —
  `context_compaction_started`, `context_compacted`,
  `context_usage_update` events live here.
- Round 4: [`03-memory-recall.md`](./03-memory-recall.md) —
  `/ws/memory` channel carries recall progress events.
- Round 4: [`05-workspace-switching.md`](./05-workspace-switching.md)
  — `/ws/workspace/<id>` is the workspace-scoped channel.
