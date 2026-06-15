# 01 — Reference app's REST API + self-referential `app-operator` agent

> Source-grounded against `~/Downloads/reference-source/readable/main.js`.
> Round 4 opens with a surface neither round 1, 2, nor 3 touched:
> reference app exposes a localhost REST API that the LLM agent can call
> via `curl` to **operate the app itself** — change theme, swap
> models, add providers, etc. The `app-operator` subagent is the
> agent embodiment of this pattern.

## The architectural idea

Most apps gate their internal state behind in-process bindings.
"How do I change the theme?" → call an IPC handler → which calls a
React state setter → which broadcasts. The agent never sees this
surface directly; it can only do what the renderer team exposed
via an IPC.

Reference app flips the relationship:

1. App boots → spins up an **Express server bound to 127.0.0.1**
   on a dynamically chosen port (`main.js:65404-65412`).
2. App writes a **self-describing API spec** to `~/.config/reference app/
   api-spec.md` with the actual port baked in (`main.js:65415-
   65428`).
3. When the LLM wants to operate the app, it spawns an
   `app-operator` subagent whose instructions say:
   *"Read `~/.config/reference app/api-spec.md` first, then use `curl` via
   Bash."*

The agent **discovers** the API instead of having it pre-wired.
Same pattern works across restarts even when the OS reassigns
ports. Same agent works against any reference app version because the
spec ships with the port AND the schema.

## Server lifecycle

`main.js:65404-65428`:

```js
o("Finding available port..."),
(this.port = await this.findAvailablePort(this.port)),
o(`Found port: ${this.port}`),
new Promise((t, o) => {
  ((this.server = Ge(this.app)),
   this.server.listen(this.port, "127.0.0.1", () => {
     console.log(`API server started on http://localhost:${this.port}`);
     this.setupWebSocket();
     t(this.port);
     setImmediate(() => {
       try {
         const e = (function (port) {
           const t = U.join(n.getPath("home"), ".config", "reference app", "api-spec.md");
           const o = `# Reference app API Specification\n…`; // big template literal
           v.writeFileSync(t, o, "utf-8");
           return t;
         })(this.port);
         console.log(`[APISpec] Generated at: ${e}`);
       } catch (t) {
         console.error("[APISpec] Failed to generate API spec:", t);
       }
     });
   }));
})
```

Notable:
- `findAvailablePort` (function defined elsewhere) increments
  until a free port is found. The port is NOT fixed.
- Bind is `127.0.0.1`, not `0.0.0.0` — localhost-only. No
  external attacker can hit the API.
- API spec generation runs `setImmediate` AFTER the server
  starts. If spec gen fails, the API is still up. Conservative.

## What's in the spec

The `api-spec.md` template (`main.js:65422` — a ~10K-char string
literal) contains:

- **Base URL** with the actual port: `http://localhost:${e}`
- **Per-endpoint docs**: method, path, request schema, response
  schema, curl example with `| jq` formatting.
- **Full `AppSettings` TypeScript type** (general / chat / agents
  / ui / network / data / security / advanced / keybindings /
  memory / toolModel / onboarding / whisper / webSearch /
  terminal / themeConfig).
- **Full `Provider` TypeScript type** with all 15 provider types
  (openai, anthropic, google, aihubmix, openrouter, deepseek,
  copilot, azure, moonshot, volcengine, custom, acp,
  claude-subscription, zai-coding-plan, kimi-coding-plan).
- **Caveats**: model ID format `providerId:modelId`, complete-
  object PUT requirement on settings, encrypted API keys never
  exposed.

Generated fresh on every startup with the timestamp at the end.

## Routes (from `main.js:51543-51694+`)

| Verb | Path | Purpose |
|---|---|---|
| GET | /api/providers | List providers |
| POST | /api/providers | Create provider |
| PUT | /api/providers/:id | Update provider |
| DELETE | /api/providers/:id | Delete provider |
| POST | /api/providers/:id/test | Test connection |
| GET | /api/providers/:id/models | List provider's models |
| POST | /api/providers/:id/models/fetch | Refresh from upstream |
| PUT | /api/providers/:id/models | Update enabled models |
| GET | /api/threads | List threads |
| GET | /api/threads/:id | Get thread |
| POST | /api/threads | Create thread |
| PUT | /api/threads/:id | Update thread |
| DELETE | /api/threads/:id | Delete thread |
| POST | /api/threads/archive | Bulk archive |
| POST | /api/threads/:id/branch | Branch a thread |
| POST | /api/threads/:id/switch | Switch active thread |
| POST | /api/threads/:id/compact | Auto-compact |
| GET | /api/search/threads | Full-text thread search |
| GET | /api/settings | Read settings |
| PUT | /api/settings | Update settings (whole-object) |
| POST | /api/settings/reset | Reset to defaults |
| POST | /api/settings/test-proxy | Test proxy |
| GET | /api/models | List enabled models across providers |
| GET | /api/tool-model | Get tool-model config |
| POST | /api/tool-model/test | Test tool-model |
| GET | /api/chrome-relay/status | ChromeRelay connection state |
| GET | /api/chrome-relay/token | Auth token (cross-ref round-2 10) |
| POST | /api/chrome-relay/token/regenerate | Rotate token |
| POST | /api/chrome-relay/launch-chrome | Launch Chrome with extension |
| GET | /api/chrome-relay/extension-path | Where the extension lives |
| POST | /api/chrome-relay/tabs | List tabs |
| POST | /api/chrome-relay/tabs/create | Create tab |
| POST | /api/chrome-relay/navigate | Navigate tab |
| POST | /api/chrome-relay/click | Click element |
| GET | /api/health | Liveness probe |

So the API surface is essentially the **internal IPC surface
projected over HTTP**. Anything the renderer can do via preload,
the agent can do via curl.

## Port discovery for the agent

`main.js:20389-20410` is the **runtime** port discovery helper
(used by non-Bash agents that need API access):

```js
function Wh(e) {
  const t = (function () {
    const e = F.join(I.homedir(), ".config", "reference app", "api-spec.md");
    if (!b.existsSync(e)) return null;
    try {
      const t = b.readFileSync(e, "utf-8").match(/http:\/\/localhost:(\d+)/);
      if (!t) return null;
      const n = Number(t[1]);
      return Number.isFinite(n) ? n : null;
    } catch (t) {
      console.warn("[Agent] Failed to read API spec for local server port:", t);
      return null;
    }
  })();
  if (!t) throw new Error(`Local API server port not available for ${e}.`);
  return t;
}
```

This is **the same file the app-operator agent reads**. The agent
isn't taught a separate discovery protocol — it uses the same
file the runtime helpers use. The first regex hit on the
`http://localhost:NNNN` literal wins. Cheap, robust, no in-band
control messages.

## `app-operator` agent shape

`main.js:20447`:

```js
"app-operator": ["Bash", "Read"]
```

**Only two tools.** Bash for curl, Read for the spec file. No
Edit, no Write, no Glob, no Grep. The agent is intentionally
narrow — its job is "use HTTP to operate the app", not "rewrite
the codebase".

`main.js:20472-20473` is the system prompt. Highlights:

> You are the Reference app configuration operator agent.
> Your goal is to read and modify Reference app's runtime configuration
> via its REST API.
>
> ## API Specification
> The complete API specification is available at:
> `~/.config/reference app/api-spec.md`
>
> **IMPORTANT:** Before performing any operation, you MUST first
> read the API spec file using the Read tool:
> ```
> Read ~/.config/reference app/api-spec.md
> ```
>
> ## Workflow
> 1. **First:** Read ~/.config/reference app/api-spec.md to understand the
>    complete API
> 2. **Then:** Use curl commands via Bash to interact with the API
> 3. **Always:** Use `| jq` to format JSON responses for readability
> 4. **Important:** For settings updates, GET current settings
>    first, modify, then PUT the complete object

The agent's discovery protocol is "READ the spec, then ACT." The
spec is the **complete specification** — types, examples, gotchas.
The agent doesn't need the LLM to know about Express, ports, or
JSON; it just reads markdown.

## Cross-cutting pattern: agents-as-API-clients

The same "Bash + curl + read spec" pattern is generalizable.
Reference app's Task tool description (`main.js:22269+`) describes
`app-operator` as:

> Use this agent to read or modify Reference app's runtime configuration.
> This includes: (1) Reading current settings (language, theme,
> chat options, memory settings, etc.); (2) Updating settings;
> (3) Managing AI providers (list, create, update, delete, test
> connection); (4) Fetching available models from providers.
>
> **NOTE:** When users say "you" in requests like "Change your
> theme" or "Update your settings", they are referring to Reference app
> (the app). The agent reads `~/.config/reference app/api-spec.md` for the
> actual API port.

The framing "When users say 'you', they mean Reference app" is a tell:
this is the self-modification surface. The LLM and the app are
explicitly two different things; the LLM controls the app the
same way a human would (read docs → curl).

## WebSocket sync

`main.js:65411` calls `this.setupWebSocket()` right after server
start. The spec mentions:

> **WebSocket Sync:** Changes made via the API are automatically
> broadcast to all connected clients via WebSocket.

So when the operator agent PUTs new settings, the renderer
(which is a WebSocket client) gets notified and updates its UI
state. The agent's curl call doesn't have to think about renderer
sync; the server handles it.

This is the right architectural pattern for "agent changes
state, UI updates live" — the agent doesn't need IPC awareness;
state-broadcast happens at the model layer.

## What Maka has today

Maka has a similar REST API in `apps/desktop/src/main/http-api/`
(the Settings API the Computer Use lane uses). But:
- No `~/.config/maka/api-spec.md` written at startup.
- No `app-operator`-style agent that reads the spec and
  operates the app via curl.
- No WebSocket sync (renderer is purely IPC-driven today).

## Ranked Maka improvements

1. **Write a self-describing API spec at startup.** Even before
   any agent uses it, this is good engineering hygiene — the
   user can `cat ~/.config/maka/api-spec.md` to debug, AI
   tools can be pointed at it for context. ~50 lines of template
   literal + writeFileSync.

2. **Adopt the dynamically-allocated port pattern.** Fixed ports
   collide. Findfree-port-then-write-to-spec is the right shape
   for a desktop app.

3. **Add a maka-operator agent.** Narrow tool surface (Bash +
   Read). System prompt teaches it: "read the spec, use curl".
   Maka can adopt this without any other agent system changes
   — it's just a Task subagent profile + role brief. ~100 lines.

4. **WebSocket sync at the API layer.** Without it, agent changes
   show up after a manual refresh. With it, the user sees the
   theme flip live as the agent writes `PUT /api/settings`. UX
   payoff is high.

5. **Mention "When users say 'you', they mean Maka (the app)"
   in the operator's system prompt.** This is a tiny linguistic
   move that disambiguates a real source of confusion. Worth
   copying verbatim.

## Open questions for future rounds

- Is there a CSRF risk? The server binds to 127.0.0.1 only, but
  a malicious local process (any subprocess of the user) could
  curl it without auth. Does reference app have a session token? Looking
  at the routes above, none require an Authorization header.
  This is a "you trust your local processes" model.
- The spec is regenerated on every startup — if a previous
  process crashed leaving stale spec content, would the new
  process detect and overwrite? `writeFileSync` overwrites
  unconditionally, so yes. But if the new process picks the
  SAME port as the old one (because old is dead), the
  agent reading from a brief race window could land on the old
  port. Probably not a real-world problem since `findAvailablePort`
  binds first.
- Does the operator agent EDIT settings or only GET/PUT whole
  objects? The spec says "complete object" — does the agent
  reliably round-trip and only modify intended fields? Risk:
  agent drops a field, settings are corrupted, but it's a
  prompt-only contract.

## Cross-refs

- Round 1: [overall agent loop section](../reference app-deep-dive-yuejing-2026-05-31/)
  — Task tool spawn + subagent system.
- Round 2: [`07-subagent-orchestration.md`](../reference app-deep-dive-yuejing-round-2/07-subagent-orchestration.md)
  — app-operator is one of the 7 specialists; only it has the
  Bash + Read narrow surface.
- Round 2: [`10-chrome-relay.md`](../reference app-deep-dive-yuejing-round-2/10-chrome-relay.md)
  — ChromeRelay endpoints live behind the same Express server.
- Round 3: [`01-skills-system.md`](../reference app-deep-dive-yuejing-round-3/01-skills-system.md)
  — skill bodies could trigger operator workflows ("change theme
  to dark" → load skill → invoke app-operator).
