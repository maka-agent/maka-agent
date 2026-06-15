# 05 — Reference app Bash tool family (Bash / BashOutput / KillShell)

> Source-grounded against `~/Downloads/reference-source/readable/main.js`.
> Round 2 of yuejing's deep-dive. Cross-refs to round 1
> `02-tools.md` (tool registry) and round 2
> `04-permissions-runtime.md` (risk classification).

## The 4-tool family

Reference app exposes Bash as a **family** of complementary tools, not a single
`Bash`:

| Tool | One-line | Source |
|---|---|---|
| `Bash` | Run shell commands; foreground or `run_in_background` | `main.js:22997-23010`, `26284` |
| `BashOutput` | Retrieve stdout/stderr from a background shell by id | `main.js:26285-26286` |
| `KillShell` | Terminate a running background shell | `main.js:26287-26288` |
| (tool-search hints) | The pre-loop tool-selection LLM is told these go together | `main.js:26395` examples |

The tool-selection assistant prompt teaches the planner that
`run scripts` should select **both** `Bash` AND `BashOutput`
together (`main.js:26395` examples). This is the canonical pattern
for "kick off a long-running build, keep the agent loop free, poll
output later" — a workflow Maka currently can't express because it
only has a single foreground `Bash` tool.

## Bash tool signature

`main.js:22997-23010`:

```js
re({
  description:
    "Execute bash commands inside the workspace. Supports foreground execution and background shells retrievable via BashOutput.",
  inputSchema: ie(am),
  outputSchema: ie(dm),
  execute: async (
    {
      command,
      description,
      timeout = 12_0000,          // 120s default
      run_in_background = false,
    },
    s,
  ) => { … },
});
```

Key contract points:
- **`timeout` default 120s** — far longer than a single LLM call,
  but still bounded.
- **`run_in_background` boolean** — if true, the tool returns a
  shell id immediately and execution proceeds in the background.
  The agent can keep working; later it calls `BashOutput(id)` or
  `KillShell(id)`.
- **`description` arg** — the model is required to describe what
  the command does, presumably for audit + permission UI.

## Streaming output back to the renderer

`main.js:23012-23051` shows the streaming wiring:

- `toolCallId = s?.toolCallId || \`bash-${Date.now()}\`` — per-call
  unique id.
- `pu.getContext()` reads the AsyncLocalStorage agent loop context
  (thread id, message id).
- The streaming context resolves to `{ onStream, onPartUpdate }`
  callbacks that call `broadcastBashStream(messageId, toolCallId,
  partIndex, chunk)` on the per-thread broadcaster.
- The renderer subscribes via `message_delta` events of type
  `tool_output_streaming` (already traced in round 2's
  `02-send-response-flow-WIP.md` at the `broadcastThreadSync` site).
- If AsyncLocalStorage context is lost (process boundary issue),
  reference app falls back to a single-active-thread heuristic, and warns —
  but tool still runs, just unstreamed. Doesn't fail closed.

## Command risk analyzer

`main.js:23057-23074` — a `BashAnalyzer` classifies the command:

```js
const d = await (async function (e, t) {
  console.log("[BashAnalyzer] Analyzing command:", e, "workspace:", t);
  const n = (function (e, t) {
    const n = e.trim();
    for (const o of Jp)              // safe-pattern allowlist
      if (o.test(n)) {
        let e = !1;
        for (const o of Vp)          // dangerous-pattern overlay
          if (o.test(n)) {
            if (t && tm(o) && em(n, t)) continue;
            e = !0; break;
          }
        if (!e)
          return {
            needsPermission: false,
            description: `Execute: ${n}`,
            riskLevel: "safe",
            …
          };
      }
```

Two regex sets:
- `Jp` (safe allowlist) — commands like `ls`, `cat`, `git status`,
  `grep` patterns that are read-only.
- `Vp` (dangerous override) — even if the command matches a safe
  pattern, this set short-circuits to "needs permission". Examples
  likely include `sudo`, `rm -rf`, `git push --force`, `curl |
  sh`, etc.

When the workspace cwd is passed (`t`), the analyzer can also
distinguish "workspace-relative" vs "global" — e.g., `rm
./local-file` may be fine while `rm /` is never fine.

Result shape: `{ needsPermission: boolean, description: string,
riskLevel: 'safe' | …, … }`. The agent loop reads `needsPermission`
to decide whether to call the approval dialog (see round 2
`04-permissions-runtime.md`).

## Why Maka should care

Maka's current `Bash` is foreground-only. A user asking "run the
test suite" blocks the agent until the suite finishes (or
watchdog kicks in). Three concrete improvements that map directly
to reference app's pattern:

1. **Add `run_in_background: boolean` to Maka's Bash tool input
   schema.** When true, return a shell id immediately and stream
   output asynchronously. The agent continues planning.

2. **Add `BashOutput(shellId)` and `KillShell(shellId)` tools.**
   They route to the same shell registry the foreground Bash uses;
   the model picks them when it wants to check on or terminate the
   background work. Match reference app's tool descriptions verbatim so the
   model's pre-trained pattern recognition transfers.

3. **Add a command risk analyzer.** Two regex sets: safe-allowlist
   + dangerous-overlay, classify each command, set
   `needsPermission` accordingly. This is what unlocks the
   "auto-allow read-only Bash" behavior that goes with the binary
   permission mode described in
   [`04-permissions-runtime.md`](./04-permissions-runtime.md).

The first two are pure runtime work in
`packages/runtime/src/tools/bash.ts` (Maka's current Bash impl,
TBC). The third is a few hundred lines of regex tables that can
be ported almost directly from reference app's `Jp` / `Vp` patterns.

## Open questions for round 3 of round-2

- Where does reference app's background shell registry live? It's referenced
  by `BashOutput(id)` and `KillShell(id)` but the storage isn't on
  this page — needs another trace.
- Does the analyzer's `Jp` / `Vp` table change based on workspace
  trust? Round 2 traced `tm(o)` and `em(n, t)` calls but they're
  outside this slice — TBC.
- Is there a "no commands at all" mode for fully sandboxed runs?
  Maka probably doesn't need it, but worth knowing reference app's stance.

## Cross-refs

- Round 1: [`02-tools.md`](../reference app-deep-dive-yuejing-2026-05-31/02-tools.md)
  for the tool registry shape and `re()` / `ie()` helper functions.
- Round 2: [`02-send-response-flow-WIP.md`](./02-send-response-flow-WIP.md)
  for `broadcastBashStream` / `broadcastThreadSync` and how deltas
  reach the renderer.
- Round 2: [`04-permissions-runtime.md`](./04-permissions-runtime.md)
  for how `needsPermission: true` enters the approval dialog.
