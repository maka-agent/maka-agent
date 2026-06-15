# 05 — Reference app coder-agent auto-detection: `coderAgentProviderId` resolution

> Source-grounded against `~/Downloads/reference-source/readable/main.js`.
> Round-4 [`01-rest-api-operator-agent.md`](../reference app-deep-dive-yuejing-round-4/01-rest-api-operator-agent.md)
> noted the api-spec's `coderAgentProviderId: '__auto__' |
> '__claude_code__' | '__builtin__' | ACP provider ID` field
> but didn't trace the resolution logic. This note covers the
> 4-way dispatch, Claude Code CLI detection across 4 hardcoded
> paths, fallback toasts, and how the resolved choice feeds the
> ACP session (round-5 [`01-acp-bridge.md`](./01-acp-bridge.md)).

## 3 sentinel values + 1 user-provider ID

`main.js:20373-20375`:

```js
Fh = "__auto__",
Uh = "__claude_code__",
Bh = "__builtin__";
```

Plus `coderAgentProviderId` can be a **specific provider id**
that points at an ACP-type provider in the DB (e.g., a user-
configured Codex CLI or Cursor bridge — round-5 01).

So 4 cases to dispatch:
- `__auto__`: try Claude Code, else built-in (default if unset).
- `__claude_code__`: try Claude Code, else built-in with warning.
- `__builtin__`: always built-in.
- `<provider-id>`: lookup in DB, must be ACP type or warn + fall
  back.

## Resolution dispatch

`main.js:20988-21034`:

```js
const setting = settings?.chat?.coderAgentProviderId || Fh;  // default __auto__

if (setting === Bh) {
  return { kind: "builtin", displayName: "Built-in agent" };
}

if (setting === Uh) {                                        // explicit __claude_code__
  return Vh()
    ? { kind: "claude-code", displayName: "Claude Code" }
    : {
        kind: "builtin",
        displayName: "Built-in agent",
        warning: "Configured Claude Code is unavailable. Falling back to the built-in agent.",
      };
}

if (setting !== Fh) {                                        // specific provider id
  const provider = To.getProviderByIdFromDatabaseOnly(setting);
  return provider?.type === "acp"
    ? { kind: "acp", displayName: provider.name, provider, modelId: jh(provider, e) }
    : {
        kind: "builtin",
        displayName: "Built-in agent",
        warning: "Configured coding agent provider was not found. Falling back to the built-in agent.",
      };
}

// fall-through: __auto__
return Vh()
  ? { kind: "claude-code", displayName: "Claude Code" }
  : { kind: "builtin", displayName: "Built-in agent" };
```

Two cases that DIFFER by `warning` field presence:

| Setting | CC present | CC missing |
|---|---|---|
| `__auto__` | claude-code (silent) | built-in (silent) |
| `__claude_code__` | claude-code (silent) | **built-in + WARNING** |

The asymmetry is the right UX:
- `__auto__` says "use whatever's available" — silent fallback
  to built-in is fine.
- `__claude_code__` says "I configured Claude Code on purpose" —
  silent fallback is bug-like. Warn.

## Warning broadcast → in-thread system message

`main.js:21036`:

```js
if (t.warning) Ou(e.id, "system", `⚠️ ${t.warning}`);
```

The warning is injected into the thread as a `system`-role
message with ⚠️ emoji prefix. Renderer styles `system` messages
distinctly (cross-ref round-4 [`07-websocket-sync.md`](../reference app-deep-dive-yuejing-round-4/07-websocket-sync.md)
`message_updated` events). So the user sees:

> ⚠️ Configured Claude Code is unavailable. Falling back to the
> built-in agent.

…RIGHT next to their request, not in a toast that might miss the
moment. This is the right UX for a fallback that affects the
quality of the immediate result.

## Claude Code CLI detection — `Vh()`

`main.js:20616-20631`:

```js
function Vh() {
  const candidates = [
    F.join(I.homedir(), ".local/bin/claude"),
    "/usr/local/bin/claude",
    F.join(I.homedir(), ".local/share/mise/installs/node/22.22.0/bin/claude"),
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  try {
    return execSync("which claude", { encoding: "utf-8" }).trim() || null;
  } catch {
    return null;
  }
}
```

4-tier path resolution:

1. **`~/.local/bin/claude`** — npm/pip global install default.
2. **`/usr/local/bin/claude`** — Homebrew default on Intel Mac,
   common system-wide install.
3. **`~/.local/share/mise/installs/node/22.22.0/bin/claude`** —
   the most specific path. `mise` is a polyglot version manager
   (replaces `asdf`/`nvm`); Node 22.22.0 is the LTS at time of
   writing. This is reference app author's own dev setup leaking into
   the code.
4. **`which claude` shell-out** — last resort, finds claude on
   the user's PATH wherever it is.

The mise path is suspicious — it WILL go stale when Node 22.22.0
ages out, and it doesn't match what users on other version
managers (nvm, fnm, volta) have. The `which` fallback rescues
most cases, but only if claude is on `PATH` in the reference app process's
inherited environment.

Open question: how does reference app boot? If it's launched from Finder,
its PATH may NOT include `~/.local/share/mise/shims/`, and `which
claude` returns nothing. The hardcoded path tries to dodge that —
but only for ONE specific version. Fragile.

## What's NOT detected

- `claude-code` (the npm package name, sometimes installed as
  `claude-code` not `claude`).
- Cursor's CLI (would need a separate path probe).
- Codex CLI (ditto).
- Antigravity CLI (ditto).

The function is **Claude-Code-specific**. Other ACP bridges go
through the explicit `<provider-id>` route — the user explicitly
adds a Codex CLI provider via the Settings UI, providing the
`acpCommand` (round-5 01 covered the provider shape).

## How resolution feeds the ACP session

`main.js:21036-21047` continues:

```js
if (t.warning) Ou(e.id, "system", `⚠️ ${t.warning}`);

if (t.kind === "acp") {
  // Stamp subagent context for round-3 04 bypass detection
  const ctx = pu.getContext();
  pu.setContext({
    threadId: r ?? ctx?.threadId ?? "",
    messageId: i ?? ctx?.messageId ?? "",
    sessionId: `subagent:${e.id}`,
    source: ctx?.source,
  });
  // …delegate to ACP via Xh(provider)…
}
```

Three observations:

### `sessionId: \`subagent:${e.id}\``

The agent run id gets prefixed with `subagent:` to mark this as
a SUBAGENT execution. Cross-ref round-5 [`01-acp-bridge.md`](./01-acp-bridge.md)
where the ACP's `setPermissionRequestHandler` reads this exact
prefix:

```js
const isSubagent = ctx?.sessionId?.startsWith("subagent:");
```

And round-3 [`04-permissions-runtime-risk.md`](../reference app-deep-dive-yuejing-round-3/04-permissions-runtime-risk.md)
where bypass channel 2 auto-approves tool calls with
`metadata.isSubagent`. Three subsystems cooperate via a
**single string prefix convention**.

### Context-from-context propagation

`threadId` and `messageId` cascade with explicit overrides:

```js
threadId: r ?? ctx?.threadId ?? "",
messageId: i ?? ctx?.messageId ?? "",
source: ctx?.source,
```

If the caller passes explicit values, they win; otherwise
inherit the ambient context. This handles three nesting
patterns:
- Top-level Task → set from caller args.
- Nested Task → inherit from parent.
- Tool-triggered Task → inherit from the tool call's context.

### `source` only inherits, never explicit

Notice `source: ctx?.source` has no explicit override. The
`source` field (cron / telegram / discord — round-3 04 bypass
channel 3) is **flow-context**, set at the top of the WS message
chain (round-4 07). Subagents/ACP can't change it; they
inherit. This is the right call — a subagent shouldn't be able
to claim it's "from cron" if its parent wasn't.

## `coderAgentProviderId` model ID resolution

`main.js:21023`:

```js
modelId: jh(n, e)
```

`jh` resolves which model to use within the ACP provider.
Different from the chat model — this is the specific Claude /
Codex / Cursor model the coder agent should run with. Probably
checks `provider.acpModelMapping` (round-5 01) for the right
slot (default vs opus vs sonnet vs haiku vs subagent).

Open question for future round: trace `jh()` to confirm the
mapping logic.

## What Maka has today

Maka added `claude-subscription` provider type recently
(`PR-OAUTH-SUBSCRIPTION-0`), but:
- No `__auto__` / `__claude_code__` / `__builtin__` sentinel
  dispatch.
- No multi-path Claude Code CLI detection.
- No in-thread `⚠️` system messages for fallbacks (toast-only).
- No `subagent:` prefix convention threading isSubagent across
  permission ladders.

## Ranked Maka improvements

1. **Multi-path CLI detection with `which` fallback.** The
   reference app pattern (3 hardcoded paths + `which`) is straight-up
   copyable. ~20 lines. Worth detecting BOTH `claude` and
   `claude-code` (npm package alias).

2. **In-thread system messages for fallback warnings, not
   toasts.** A "your configured backend isn't available"
   message belongs visually NEXT to the affected response,
   not in a separate toast that may have been dismissed.
   Toasts are for transient notifications, system messages
   are for context the user needs to interpret the result.

3. **Asymmetric silent vs warn fallback based on user intent.**
   `__auto__` = "you decide, no judgment" → silent fallback.
   `__claude_code__` = "I want this specifically" → loud
   fallback. Maka's settings UI should follow this convention.

4. **`subagent:` session-id prefix as cross-subsystem
   convention.** Even if Maka doesn't have full subagent
   orchestration yet, adopting the prefix lets future
   subsystems detect subagent context cheaply. Round-trip
   through ACP, permission ladder, etc., all read the same
   string.

5. **`getProviderByIdFromDatabaseOnly` to avoid cycles.** When
   the resolution layer needs to look up a provider, hitting
   the DB directly (vs the full provider service that
   instantiates language models) avoids dependency cycles.
   `*FromDatabaseOnly` naming is a readable convention.

## Open questions for future rounds

- `jh(provider, agentRun)` is the model ID resolver. Does it
  consult the `acpModelMapping.subagentModel` for subagent-
  context invocations, or does it always use `defaultModel`?
- The mise path with Node 22.22.0 is fragile. Does reference app have a
  release process that bumps this when LTS rolls forward? Or
  is it accidentally pinned forever?
- When the warning fires inside a top-level user message
  (not a subagent), is the ⚠️ system message broadcast via
  WebSocket immediately, or does it batch with the next
  agent message? Determines whether user sees the warning
  before generation starts.
- What about Windows? The hardcoded paths are POSIX-style.
  Cross-platform Claude Code detection needs `%LOCALAPPDATA%\
  Programs\claude-code\claude.exe` or similar. Round-5
  candidate.

## Cross-refs

- Round 4: [`01-rest-api-operator-agent.md`](../reference app-deep-dive-yuejing-round-4/01-rest-api-operator-agent.md)
  — `coderAgentProviderId` is in the AppSettings type the
  operator agent can curl.
- Round 4: [`07-websocket-sync.md`](../reference app-deep-dive-yuejing-round-4/07-websocket-sync.md)
  — `Ou(threadId, "system", message)` broadcasts via
  `/ws/threads` `message_updated` events.
- Round 3: [`04-permissions-runtime-risk.md`](../reference app-deep-dive-yuejing-round-3/04-permissions-runtime-risk.md)
  — bypass channel 2 reads `metadata.isSubagent`, which is
  set via the `sessionId: "subagent:..."` convention here.
- Round 5: [`01-acp-bridge.md`](./01-acp-bridge.md) — the ACP
  permission delegation reads `sessionId.startsWith("subagent:")`
  to propagate subagent context across the bridge.
