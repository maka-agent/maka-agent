# 08 — Reference app MCP client (full server lifecycle + Resources API)

> Source-grounded against `~/Downloads/reference-source/readable/main.js`.
> Round 2. Maka has zero MCP support today; this note pins what a
> minimal port would look like.

## Punchline

Reference app's MCP client is a real production-grade implementation:

- Config file at `~/.config/reference app/mcp.json` (`main.js:25219-25224`).
- Service singleton `Tf` extending an event emitter (`main.js:25212`).
- Parallel startup with `Promise.allSettled` — one failing server
  doesn't block the others (`main.js:25273`).
- Per-server stderr buffers for diagnostic surfacing
  (`main.js:25216`, `25236-25237`).
- Two transport types: stdio (30s timeout) and HTTP-like (60s)
  (`main.js:25282-25283`).
- OAuth reconnect support for protected servers
  (`main.js:25098-25110`).
- Exposes both tools (proxied as `serverName__toolName`) and
  Resources (file-like read API).

## Service shape

`main.js:25212-25278`:

```js
const Tf = new (class extends Gt {            // Gt = EventEmitter
  servers = new Map();                         // name → server record
  configPath;                                  // ~/.config/reference app/mcp.json
  initialized = false;
  stderrBuffers = new Map();                   // name → string[]

  constructor() {
    super();
    this.configPath = path.join(
      app.getPath("home"),
      ".config", "reference app", "mcp.json",
    );
  }

  readConfig()  { /* parse JSON, default { mcpServers: {} } */ }
  saveConfig(e) { /* mkdir -p + writeFile */ }

  async initialize() {
    if (this.initialized) return;
    const e = this.readConfig();
    const t = Object.entries(e.mcpServers);
    await Promise.allSettled(
      t.map(([e, t]) => this.startServer(e, t))
    );
    this.initialized = true;
  }

  async refresh() {                            // hot reload
    await this.stopAll();
    this.initialized = false;
    await this.initialize();
  }
});
```

A few patterns worth copying:

- **Singleton via IIFE class.** Module-level effect — reference app boots
  the MCP client once per process. Maka could do the same in a
  desktop main-process service.
- **Hot refresh.** `refresh()` is an explicit API, not "stop the
  app and restart." Users can edit `mcp.json`, click Reload, and
  see new servers come up.
- **Per-server stderr buffer.** When a server dies, we keep its
  last N stderr lines and prepend them to the error message
  (`main.js:25236-25237`). This is what makes MCP errors
  actionable instead of mysterious.

## Server lifecycle

`main.js:25280-25299` (excerpt):

```js
async startServer(t, n) {
  console.log(`[MCP] Starting server: ${t}`);
  const o = Wn(n);                             // is HTTP transport?
  const s = o ? 30_000 : 60_000;               // timeout (sic — stdio is 30s)

  if (jn(n)) {                                 // is stdio config?
    r = await this.createStdioTransport(t, n);
    i = new qt({ name: "reference app", version: "1.0.0" });
    const e = async (e, t) => {
      const n = new Promise((e, t) =>
        setTimeout(
          () => t(new Error(`Connection timeout after ${s / 1000}s`)),
          s,
        ),
      );
      await Promise.race([t.connect(e), n]);
    };
    …
  }
}
```

Per-server steps:
1. Detect transport type (stdio vs HTTP).
2. Build the transport object.
3. Spawn the client (`new qt({ name: "reference app", version: "1.0.0" })`).
4. Race connect against a hard timeout.
5. On success, register the server's tools + resources into the
   global tool registry under `serverName__toolName` prefix
   (cross-ref [`06-tool-routing.md`](./06-tool-routing.md) where
   the pre-loop selector is taught about this naming).

## OAuth reconnect

`main.js:25098-25110`:

```js
console.log(
  `[MCP OAuth] Reconnecting MCP server "${t.name}" after OAuth authorization`,
);
…
console.log(
  `[MCP OAuth] Successfully reconnected MCP server "${t.name}"`,
);
…
console.log(
  `[MCP OAuth] Failed to reconnect MCP server "${t.name}": ${o.error}`,
);
```

When a server uses OAuth (e.g., the official Linear MCP server),
reference app handles the token exchange flow and reconnects on success.
This is the same OAuth machinery Maka already has for Claude /
Codex / Cursor, just plugged into the MCP transport layer.

## Resources API

`main.js:25804-25864` (excerpt, two tools reference app exposes to the
model):

| Tool | Description |
|---|---|
| `ListMcpResources` | "List available resources from MCP servers. Use this to discover what resources (files, documents, data) are available for reading." |
| `ReadMcpResource` | "Read content from an MCP resource. Use this to access the actual content of files, documents, or data exposed by MCP servers." |

Args: `server` filter on `ListMcpResources` (omit to list all);
`server` + `resourceUri` on `ReadMcpResource`.

This is the lower-half of MCP — the file-system-like Resources
namespace. Many MCP servers expose only tools; the ones that
expose resources (e.g., a knowledge base or a documents server)
need this routing layer.

## What Maka has today

Zero. There's no MCP client, no `mcp.json`, no Resources tools.
The OAuth machinery is in place but only wired to Claude / Codex
/ Cursor SaaS, not to MCP servers.

## Ranked Maka improvements

1. **Ship a minimal `MCPService` singleton** that reads `~/.config/maka/mcp.json`,
   spawns stdio servers via `Promise.allSettled`, and registers
   their tools under `serverName__toolName`. ~400 lines including
   the transport adapter. The `@modelcontextprotocol/sdk` npm
   package provides the client + transports.

2. **Per-server stderr buffer for diagnostics.** Maka users will
   want "why didn't my server start?" answers more than any other
   MCP feature. Match reference app's pattern verbatim.

3. **Add `MCPRefresh` IPC** so the user can edit `mcp.json` from
   their editor and click Reload without restarting Maka.

4. **Add `ListMcpResources` + `ReadMcpResource` tools** once at
   least one server with resources lands in the wild. Until then
   they're dead weight.

5. **OAuth reconnect** can wait — most popular MCP servers (Linear,
   GitHub, Notion) ship behind API key today. Defer until needed.

## Open questions for round 3 of round-2

- Does reference app's MCP service ever hot-rebuild the pre-loop tool
  selector prompt when servers add tools mid-session? Or does it
  require a session restart?
- How does reference app handle MCP tools that the same name as a built-in
  (e.g. an MCP server exposes `Bash`)? The `serverName__toolName`
  prefix should disambiguate but the tool-selection prompt
  examples don't address it explicitly.
- Where does the timeout (30s stdio / 60s HTTP) come from? Is it
  configurable per-server in `mcp.json`?

## Cross-refs

- Round 1: [`07-borrowable-checklist.md`](../reference app-deep-dive-yuejing-2026-05-31/07-borrowable-checklist.md)
  for the original MCP roadmap entry (B-MCP-01) — note covers the
  same ground in depth.
- Round 2: [`06-tool-routing.md`](./06-tool-routing.md) — the
  pre-loop selector enumerates MCP tools alongside built-in tools.
- Round 1: [`08-extended-topics.md`](../reference app-deep-dive-yuejing-2026-05-31/08-extended-topics.md)
  which first mentioned MCP at a high level — this round goes deep.
