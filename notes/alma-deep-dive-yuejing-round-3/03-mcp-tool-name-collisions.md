# 03 — Alma MCP tool name collision logic (`bf` prefix + sanitizers)

> Source-grounded against `~/Downloads/alma-re/readable/main.js`.
> Pinned open question in round-2 [`08-mcp-client.md`](../alma-deep-dive-yuejing-round-2/08-mcp-client.md):
> how does the `serverName__toolName` prefix interact with same-
> named built-in tools? This note traces the answer end-to-end.

## TL;DR

There IS no collision by design. The `bf` prefix function
(`main.js:25201-25203`) always produces `<serverName>__<toolName>`
— a double-underscore separator that built-in tool names CANNOT
contain (round-2 17854-17875 lists every built-in; none use
`__`). The `compact` mode classifier (round-3 [`02-output-safety-
modes.md`](./02-output-safety-modes.md)) then treats any name
containing `__` as MCP-originating. So:

- Built-in tools live in a flat namespace: `Read`, `Bash`, …
- MCP tools live in a SECOND namespace: `<server>__<tool>`
- The separator is the boundary; no built-in can ever look like an
  MCP tool because the sanitizer guarantees a hyphen-only server
  half + `__` separator that built-ins lack.

## The prefix function

`main.js:25201-25203`:

```js
function bf(serverName, toolName) {
  return `${yf(serverName)}__${wf(toolName)}`;
}
```

Two sanitizers, distinct rules:

`yf` — server-name half (`main.js:25186-25192`):

```js
function yf(e) {
  return e.toLowerCase()
          .replace(/[^a-z0-9-]/g, "-")   // anything but [a-z0-9-] → "-"
          .replace(/-+/g, "-")            // collapse runs
          .replace(/^-|-$/g, "");         // trim leading/trailing
}
```

`wf` — tool-name half (`main.js:25193-25199`):

```js
function wf(e) {
  return e.replace(/[^a-zA-Z0-9_-]/g, "_")  // anything but [A-Za-z0-9_-] → "_"
          .replace(/_+/g, "_")               // collapse runs
          .replace(/^_|_$/g, "")             // trim
          || "unnamed_tool";                 // fallback for empty
}
```

Asymmetry: server half is **lowercased and hyphen-only**, tool
half **preserves case and allows underscore**. This is deliberate.
Server names appear in config (`mcp.json`) and surface text — they
should look like slugs (e.g., `linear`, `github-api`). Tool names
come from upstream MCP servers — `createIssue`, `list_repos`,
`SetCustomerStatus` — and need case + underscore preserved for
upstream identity.

## Why `__` as separator

Built-in tool names (round-2 note 02 sets `Yd` + `Jd` at
`main.js:17844-17875`) are camelCase identifiers without
underscores: `AttemptCompletion`, `BashOutput`, `BrowserReadDom`,
`ChromeRelayListTabs`, etc. None contain `__`. And `yf` strips
underscores from the server half (replaces with `-`). So the
ONLY thing that produces `__` in a final id is `bf` itself.

The mode classifier (round-3 02, `main.js:18141-18152`) uses this:

```js
Jd.has(toolName) || toolName.includes("__")  // compact mode trigger
  ? "compact"
  : ...
```

Anything containing `__` is auto-classified as MCP and gets the
`iu` budget profile (2,600 chars, `defaultStringChars: 1000`).

The tool selector prompt (`main.js:26395`) also relies on this:

> For MCP tools, use the full tool ID (e.g., `"serverName__toolName"`)

The model is taught the convention as a stable contract.

## Collision scenarios that DON'T collide

A user installs an MCP server named "read":

- yf("read") = "read"
- The tool's name within that server is, say, "file"
- bf produces: "read__file"
- Built-in `Read` is unchanged
- Built-in `Read` won't match `read__file` (no `__`)

A user installs an MCP server with a name that LOOKS like a
built-in tool ID:

- Config: `{"mcpServers": {"Bash": {…}}}`
- yf("Bash") = "bash" (lowercased)
- Tool name "run" → bf produces "bash__run"
- Still no clash. Built-in `Bash` is intact.

An upstream MCP tool has the EXACT name of a built-in:

- Server "ext", tool name "Read"
- bf produces "ext__Read"
- No clash because Read built-in is referenced as bare "Read";
  this lives at "ext__Read".

## Collision scenarios that CAN happen (between MCP servers)

Two MCP servers with names that sanitize to the same slug:

- Config: `{"mcpServers": {"Linear API": {…}, "linear_api": {…}}}`
- yf("Linear API") = "linear-api"
- yf("linear_api") = "linear-api"  (underscore → hyphen, collapsed)
- Both servers' tools land in `linear-api__*`
- Tool name conflict if both serve `createIssue`

The MCP service builds the toolset by iterating servers
(`main.js:25538`), keying into `e[bf(serverName, tool.name)]`. The
SECOND write wins — silently. There's no defensive check that the
key already exists. Open question: does the UI surface this when
adding a second server, or do users find out only when a tool
behaves wrong?

Tool name asymmetry inside the same server can also collide:

- Server "ext" tools: `["list-repos", "list_repos", "list repos"]`
- All sanitize to `list-repos` / `list_repos` / `list_repos` —
  wait, the tool half preserves both `-` and `_` (`wf` is more
  permissive), so:
- `list-repos` → `list-repos`
- `list_repos` → `list_repos`
- `list repos` → `list_repos` (space → `_`, then collapse)
- So `list_repos` and `list repos` collide. Same write-last-wins.

## Per-tool safety mode injection from MCP

`main.js:25542-25543`:

```js
const s = vf(o, t);                  // parse description for [alma-output-safety: …]
Qd(n, s.outputSafetyMode);            // register in Xd Map
```

`vf` at `main.js:25204-25211` reads two sources:
1. `tool.$.alma/outputSafetyMode` — schema-level annotation from
   upstream MCP server.
2. In-band `[alma-output-safety: …]` marker in `description`
   (round-3 02 covers the parser).

Mode is then set on the prefixed tool id via `Qd` → `Xd.set`. So
an MCP server can DECLARE its tools as `passthrough` (e.g., a
binary-returning tool) and override the default `compact`. That's
the convention for image/audio MCP tools — they get registered
once and the prefix-classified default doesn't strip their bytes.

## Wire-protocol invocation

When the model calls `linear-api__createIssue` with args, the MCP
service unprefixes by looking up the registry by full id and then
delegates to the upstream `callTool(serverName, originalToolName,
args)` (`main.js:25557`). The original (unsanitized) tool name
stays in the registry alongside the prefixed id, used for upstream
calls. So sanitization affects ONLY the model-facing id, not the
wire protocol.

## What Maka has today

- No MCP service.
- No prefix function.
- No same-namespace risk because there's nothing to namespace.

If Maka adds MCP later, this becomes the design baseline.

## Ranked Maka improvements (when shipping MCP)

1. **Adopt the `<server>__<tool>` separator with sanitizers.**
   The `__` boundary is invisible to users (they see the prefix
   in tool descriptions) but mechanically separates the two
   namespaces. The mode-classifier piggyback (`includes("__")`
   → compact profile) is the bonus payoff.

2. **Different rules for server-half vs tool-half.** Server name
   becomes a slug (lowercased, hyphen-only) because it's user-
   facing config. Tool name preserves case + underscore because
   it's an upstream identity that should round-trip in `callTool`.

3. **Detect sanitization collisions and warn.** alma silently
   write-last-wins on prefix collision. Maka can do better: when
   `bf(server, tool)` already exists in the registry, log a
   prominent warning AND surface it in the MCP settings panel.
   Cost: one Set lookup per registration.

4. **Forward MCP-supplied output safety mode.** The
   `$.alma/outputSafetyMode` schema annotation + in-band marker
   pattern lets upstream servers declare per-tool behavior. Even
   if Maka skips the marker initially, the schema-level annotation
   is cheap and future-proof.

5. **Surface the prefixed id in the UI.** Users typing `/use
   linear-api__create_issue` in the composer should be able to
   pick the tool. The prefix isn't an internal detail; it's the
   actual model-facing handle.

## Open questions for future rounds

- Does the MCP toolset rebuild on every `initialize()` or only
  for newly-started servers? If it rebuilds, the silent collision
  is at least reproducible; if it accumulates, an old server
  toggle could leak stale prefixed entries.
- What does the Skill subagent see if it calls a non-existent
  MCP tool — `linear-api__createIssue` after the linear server
  was removed? The mode classifier still says `compact`; the
  execute path will throw "tool not found" and the model needs
  to recover. Does the failure mode include a recovery hint
  like round-3 02's truncation marker?
- Tool name conflict inside one server (e.g., `list_repos` vs
  `list repos`) silently overwrites. Does the MCP service's
  underlying SDK already prevent same-named tools on the server
  side, or is it possible for an upstream to genuinely return
  two tools with names that collide post-sanitization?

## Cross-refs

- Round 2: [`08-mcp-client.md`](../alma-deep-dive-yuejing-round-2/08-mcp-client.md)
  — where this open question was pinned.
- Round 3: [`02-output-safety-modes.md`](./02-output-safety-modes.md)
  — explains why `__` triggers compact mode and how `Qd`/`Xd` work.
- Round 3: [`01-skills-system.md`](./01-skills-system.md) — the
  OTHER data-driven capability channel (skills are workflow-level,
  MCP tools are call-level).
