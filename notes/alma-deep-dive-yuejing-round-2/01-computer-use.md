# 01 — Alma Computer Use: native helper + IPC protocol + DB

> Source-grounded against `~/Downloads/alma-re/readable/main.js`. Every
> claim cites `main.js:NNNN`. Cross-refs to round 1:
> `[../alma-deep-dive-yuejing-2026-05-31/02-tools.md]` (tools registry).

## Architecture at a glance

Alma's Computer Use is **not** a typescript Electron module. It's a
*separate native macOS binary* (`AlmaComputerUse`) that talks to Alma's
Node main process over a **Unix domain socket**, exchanging
**newline-delimited JSON**. The Node side then exposes the same surface
to three distinct callers:

1. **Internal**: a singleton `cE` client (`main.js:48275-48495`) that the
   tool runtime calls.
2. **HTTP REST API**: Express routes `/api/computer-use/*` on Alma's
   local server (`main.js:51983-52055`) for external programs and
   scripts.
3. **Provider-executed Computer Use tool** when OpenAI's Responses API
   returns a `computer_call` action (`main.js:11747-11764`).

The helper itself ships as an `.app` bundle inside Alma's resources
directory (`Alma Computer Use.app/Contents/MacOS/AlmaComputerUse`,
`main.js:48222-48272`). Path discovery checks three locations and
returns the first that exists.

## Native helper lookup

`main.js:48221-48274` (`aE()` resolver):

```
candidates = [
  resourcesPath + "Alma Computer Use.app/.../AlmaComputerUse",
  __dirname + "../../computer-use/Alma Computer Use.app/.../AlmaComputerUse",
  __dirname + "../../../computer-use/Alma Computer Use.app/.../AlmaComputerUse",
  app.getAppPath() + "computer-use/.../AlmaComputerUse",
  app.getAppPath() + "../computer-use/.../AlmaComputerUse",
]
```

Returns the first existing path; `null` if none found. The helper
**must be built separately** — the user-facing error string at
`main.js:48408` reads
`"Alma Computer Use helper not found. Run pnpm build:computer-use or reinstall Alma."`

`isAvailable()` (`main.js:48287-48289`) gates everything on
`process.platform === 'darwin' && helperPath() !== null`. macOS-only,
no Linux/Windows path.

## Socket lifecycle

`main.js:48275-48495` defines the singleton `cE` (a `new (class { ... })`
instance). State:

```ts
child = null;            // ChildProcess once spawned
sock = null;             // net.Socket once connected
connecting = null;       // in-flight connect promise (so concurrent calls coalesce)
pending = new Map();     // requestId → { resolve, reject, timer }
readBuffer = Buffer.alloc(0);
socketPath = userData + "/computer-use.sock";  // line 48281-48286
```

On macOS-only check passes, the lazy `ensureConnected()`
(`main.js:48398-48431`):

1. If socket already alive, return immediately.
2. Coalesce concurrent attempts via `this.connecting`.
3. Try `connectOnce()` against existing socket file.
4. If that fails, `spawnDaemon(helperPath)` and retry up to **4 seconds**
   in 100 ms increments.
5. Throw `helper_unreachable` if no success.

Once connected, `wireSocket(e)` (`main.js:48447-48468`):
- Parses newline-delimited JSON frames from the read buffer.
- On socket `close`, rejects all `pending` with
  `helper_disconnected`.
- On `error`, swallows silently (relies on `close` for cleanup).

## Request protocol

`call(cmd, args, timeoutMs)` (`main.js:48369-48397`):

1. Hard error if not macOS.
2. `await ensureConnected()`.
3. Generate `id = randomBytes(8).hex()`.
4. Set a per-call `setTimeout(timeoutMs)` (default 20 000 ms; some
   methods override — see below).
5. Stash `{ resolve, reject, timer }` in `pending` map keyed by id.
6. Write `JSON.stringify({ id, cmd, args }) + "\n"` to socket.
7. Wait for matching `id` on `handleLine`.

On the helper side every response is a line of JSON `{ id, ...result }`
that the read buffer parser picks up at `main.js:48469-48495`.

## Command surface (18 commands)

All exposed via methods on `cE` (`main.js:48293-48367`). The full list:

| Method | Socket cmd | Args | Timeout | Purpose |
|---|---|---|---|---|
| `ping()` | `ping` | — | 20s | Liveness check |
| `permissions()` | `permissions` | — | 20s | Read TCC / accessibility / screen-recording status |
| `grant()` | `grant` | — | 20s | Trigger system permission prompts |
| `apps()` | `apps` | — | 20s | List running apps |
| `launchApp(bundle, activates)` | `launch_app` | `{ bundle, activates }` | 20s | Launch app by bundle id |
| `listApps(opts)` | `list_apps` | `opts` | 20s | List installed apps |
| `windows(opts)` | `windows` | `opts` | 20s | List visible windows |
| `snap(opts)` | `snap` | `opts` | 20s | Snapshot window state |
| `getAppState(opts)` | `get_app_state` | `opts` | **30s** | Read AX tree |
| `click(opts)` | `click` | `opts` | 20s | Click at ref |
| `performSecondaryAction(opts)` | `perform_secondary_action` | `opts` | 20s | Right-click |
| `drag(opts)` | `drag` | `opts` | 20s | Drag gesture |
| `type(ref, text, replace, show_cursor)` | `type` | `{ ref, text, replace, show_cursor }` | 20s | Type into AX element |
| `typeText(opts)` | `type_text` | `opts` | 20s | Type without AX ref |
| `press(ref, key, show_cursor)` | `press` | `{ ref, key, show_cursor }` | 20s | Key into element |
| `pressKey(key, pid)` | `press_key` | `{ key, pid }` | 20s | Key into process |
| `setValue(ref, value)` | `set_value` | `{ ref, value }` | 20s | Set value of AX element |
| `scroll(ref, direction, pages, show_cursor)` | `scroll` | `{ ref, direction, pages, show_cursor }` | 20s | Scroll within element |
| `lens(enabled)` | `lens` | `{ enabled? }` | 20s | Toggle visual overlay |
| `raise(opts)` | `raise` | `opts` | 20s | Bring window to front |
| `shot(opts)` | `shot` | `opts` | **30s** | Screenshot |
| `shutdown()` | `shutdown` | `{}` | 2s | Tell helper to exit, then teardown locally |

Observations:
- `getAppState` and `shot` get an extended 30 s timeout because they
  may need to walk a large AX tree or write a multi-megapixel image.
- `shutdown` gets a *short* 2 s timeout — Alma is fine with a hard
  teardown if the helper doesn't ack.
- `show_cursor` is a near-universal arg: alma can choose to display a
  visible cursor during automated input so the user sees what's
  happening.
- `ref` is alma's opaque AX element handle — the model uses it after a
  prior `get_app_state` returned the compact AX tree (see prompt fragment
  at `main.js:28757`).

## Compact AX tree shape (model-facing)

The model receives interactive elements *as text lines*, not as a deep
tree. Format pinned at `main.js:28757`:

```
ref role "name" [flags]
```

This is what makes the loop tractable for a token-limited model: instead
of dumping the full AX hierarchy, alma flattens it to one short line per
interactive element with an opaque `ref`. The model then calls
`click(ref=X)` / `type(ref=X, text=...)` without ever seeing absolute
coordinates.

## HTTP REST exposure

`main.js:51983-52055` registers the same commands as POST endpoints on
Alma's local Express server:

```
POST /api/computer-use/{windows,snap,get_app_state,click,
  perform_secondary_action,drag,type,type_text,press,press_key,
  set_value,scroll,lens,raise,shot,shutdown}
```

Each endpoint accepts the same JSON body shape as the internal `cE`
method, runs it through a shared `t(res, fn)` wrapper that catches
errors and returns 500s, and returns the helper's JSON result directly
through to the HTTP client. This means external CLIs, MCP servers, or
even the user's own scripts can drive Computer Use without going through
the Electron main process at the JS layer.

A parallel `POST /api/computer-use/log` endpoint
(`main.js:51970-51978`) lets the caller persist an action to the
`computer_use_action_log` SQLite table without invoking the helper —
useful for scripted tests or replay.

## DB-backed approvals + action audit

Two tables live in Alma's main SQLite database. From `main.js:1946-1953`:

```sql
CREATE TABLE IF NOT EXISTS computer_use_app_approvals (
  bundle_id     TEXT PRIMARY KEY,
  app_name      TEXT,
  approved_at   TEXT,
  revoked_at    TEXT,
  use_count     INTEGER NOT NULL DEFAULT 0,
  last_used_at  TEXT
);

CREATE TABLE IF NOT EXISTS computer_use_action_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  logged_at       TEXT NOT NULL,
  tool_name       TEXT NOT NULL,
  bundle_id       TEXT,
  pid             INTEGER,
  args_json       TEXT NOT NULL,
  duration_ms     INTEGER NOT NULL,
  screenshot_sha  TEXT,
  error_code      TEXT
);

CREATE INDEX idx_cu_action_log_bundle_time
  ON computer_use_action_log (bundle_id, logged_at);
```

DB methods (`main.js:4643-4750`):
- `getComputerUseAppApproval(bundleId)` — read approval row
- `listComputerUseAppApprovals()` — paginated list, newest first
- `approveComputerUseApp(bundleId, appName)` — UPSERT, clears revoked_at
- `revokeComputerUseApp(bundleId)` — set revoked_at
- `bumpComputerUseAppUsage(bundleId)` — increment use_count + update
  last_used_at
- `logComputerUseAction(entry)` — append to action log
- `listComputerUseActionLog(limit=100)` — newest-first
- `trimComputerUseActionLog(keep=5000)` — vacuum old rows

**Approval model:** per-target-app, not per-call. The user approves a
bundle id (e.g. `com.apple.Safari`) and from that point on, every
Computer Use call against that app skips re-prompt. Revoke flips the
`revoked_at` timestamp; the row stays so usage history isn't lost.

**Audit log:** every Computer Use call writes a row with arg JSON,
duration, optional screenshot SHA (so the action can be linked to a
stored screenshot artifact), and optional error code. The index on
`(bundle_id, logged_at)` makes "show me everything alma did to App X
in the last hour" a single fast scan.

## Where the model invokes it

Two integration points found in round 2:

1. **OpenAI Responses provider-executed path** (`main.js:11747-11764`).
   When the OpenAI Responses API returns a `computer_call`, alma's
   normalizer emits a synthetic `tool-call` with
   `toolName: "computer_use"` and `providerExecuted: true`. The
   `tool-result` carries `type: "computer_use_tool_result"`. This is
   the path that uses OpenAI's hosted Computer Use directly — the
   *model* picks coordinates, OpenAI executes against a sandbox.

2. **Custom Browser tool family** (`main.js:28971-28973`, full list in
   `02-browser-tools.md`). These are Alma-defined tools
   (BrowserOpen / Click / Type / Screenshot / Read / ReadDom / Back /
   Forward / Reload / Eval / Close) that internally call the native
   helper. The model sees them as ordinary client tools and picks them
   via the tool-selection assistant.

The tool-selection assistant prompt (`main.js:29668`) explicitly tells
the model:
- Use ChromeRelay tools if Chrome Relay is connected (user sessions
  available).
- Otherwise use Browser tools.
- Don't use either for simple content reading (use WebFetch) or
  search (use WebSearch).

There is no separate model-facing `computer_use` tool with a Zod
schema — alma uses the high-level Browser tools as the curated surface,
and reserves the raw native command set for code-driven scripting via
the HTTP API.

## Borrowable for Maka

Concrete patterns Maka could adopt, in priority order:

1. **Native helper as separate binary + Unix-socket JSON protocol**
   instead of bundling AX/screen capture into Electron main. Keeps
   Electron's signing surface small, allows the native side to be
   updated independently, and gives a clean kill-zone when the helper
   misbehaves. Maka's `pi-agent-backend.ts` could use the same
   idea — spawn pi as a side daemon, IPC over socket.

2. **Three-layer exposure**: internal client + HTTP REST + provider
   tool. The HTTP layer is the unlock for power users — they can drive
   Maka from `curl` / scripts / their own MCP servers without any
   Maka-specific Electron API.

3. **DB-backed app approval (per bundle id)** with use_count + last_used
   so "trusted apps" graduate naturally. Maka's current modal "ask
   every time" pattern doesn't scale to repeated computer-use work.

4. **Action audit log table** with screenshot SHA + duration + error
   code. Pairs naturally with Maka's existing audit JSONL — could go
   into SQLite for queryability ("show me everything claude did in the
   last hour with error code X").

5. **Compact AX tree as `ref role "name" [flags]`** lines. If Maka
   ever exposes AX to the model, this is the format that's been
   battle-tested against token budgets.

6. **`show_cursor` parameter on every input action.** Cheap UX win
   that makes automation visible to the user.

7. **`lens` overlay** as a separate command. Visual indicator the
   helper is in control of the screen — important trust signal.

## Open questions for round 3 / round 4

- The native helper binary itself is closed source (not in
  `readable/`). Can we estimate the implementation effort to ship a
  comparable helper for Maka? Probably 2-4 weeks of Swift work using
  AXUIElement + CGEventTap + ScreenCaptureKit.
- Does alma's helper handle macOS Sequoia's new "Screen & System Audio
  Recording" prompt? Need to test on real macOS 15.
- What's the latency budget for a single click? The 20 s timeout
  suggests it's not optimized for sub-second; alma is tolerating long
  AX walks.
