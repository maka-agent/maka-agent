# Reference app deep-dive round 2 — yuejing

Round 1 (`notes/reference app-deep-dive-yuejing-2026-05-31/`) covered the agent loop,
tools registry, prompts/skills, memory, renderer architecture, bots, and
40+ borrowable patterns. WAWQAQ asked for **deeper reverse engineering**
(msg `bdb272f7`) — round 2 picks subsystems that round 1 skipped or only
touched lightly, and traces each end-to-end at the `main.js:NNNN` level
against the reference app `readable/main.js` source.

## Round 2 inventory

| # | Note | Subsystem | Status |
|---|---|---|---|
| 00 | `00-OVERVIEW.md` | This file (round-2 index) | **shipped** |
| 01 | `01-computer-use.md` | Native macOS Computer Use stack (helper binary + Unix socket + 18 commands + 3 exposure layers + DB-backed approvals/audit) | **shipped** |
| 02 | `02-send-response-flow-WIP.md` | Send→response end-to-end flow (5 streamText sites, broadcast surface, auto-compact in prepareStep) | **shipped (WIP)** |
| 03 | `03-current-maka-oauth-request-shape.md` | Point-in-time diff of Maka's OAuth send path against reference app — ranked actionables | **shipped** |
| 04 | `04-permissions-runtime.md` | Binary autoApproveToolRequests toggle (NOT three-mode), per-call action vocabulary, denyReason propagation, headless override | **shipped** |
| 05 | `05-bash-tool-family.md` | Bash + BashOutput + KillShell + risk analyzer + streaming via per-thread broadcaster | **shipped** |
| 06 | `06-tool-routing.md` | Pre-loop selector (per user message) + in-loop ToolSearch — reference app's two-layer tool routing | **shipped** |
| 07 | `07-subagent-orchestration.md` | Task / TaskOutput / TaskStop family, 7-specialist roster, resume-by-id, sprint harness mode, handoff packet | **shipped** |
| 08 | `08-mcp-client.md` | Full MCP client (config, lifecycle, hot refresh, OAuth reconnect, Resources API) | **shipped** |
| 09 | `09-cloak-request-full.md` | Byte-by-byte cloaked-request shape (9 HTTP headers, Stainless chain with pinned values, two-variant anthropic-beta, three body rewrites, x-api-key delete) | **shipped** |

Round 2 is open-ended. Each note in this directory is **source-grounded**
— every claim cites `main.js:NNNN`. Cross-references back to round 1
notes use `[../reference app-deep-dive-yuejing-2026-05-31/NN-name.md]`.

## Reading order

Two entry points depending on what the reader needs:

**Architecture → implementation**:
00 → 01 (Computer Use) → 04 (permissions) → 05 (Bash) → 06 (tool routing)
→ 07 (subagents) → 08 (MCP).

**OAuth → chat send debug**:
00 → 02 (send→response flow) → 03 (Maka diff) → 09 (cloak detail).

## Cross-cutting themes

Three patterns appear in multiple notes — they're reference app's
"infrastructure idioms":

1. **`Promise.allSettled` + per-record diagnostic buffer.** Used in
   MCP server startup (note 08), Computer Use helper spawn
   (note 01), and the agent loop's tool dispatch. Pattern: try
   everything in parallel, never let one failure block the rest,
   keep enough state on the failed record (stderr buffer,
   error_code, last_used_at) that the user gets an actionable
   message.

2. **`run_in_background: boolean` everywhere.** Bash (note 05) and
   subagents (note 07) both support it. Same semantic: kick off
   work, get an id back, retrieve output later via the matching
   `*Output` tool. The pre-loop selector (note 06) is taught to
   pair them.

3. **Self-referential agents.** `app-guide` and `app-operator`
   (note 07) read/modify the host app's own settings via local
   API endpoints. This is how reference app exposes "change my theme",
   "what's my current model?" as natural-language operations
   without touching the renderer.

## Borrowable shortlist for Maka

The single biggest architectural gap between Maka and reference app is
**subagent orchestration with background mode** (note 07). Without
it, Maka can't parallelize agent work and can't express the
"kick off the test suite, keep thinking, come back for results"
pattern. The Task / TaskOutput / TaskStop trio + resume-by-id +
handoff packet is ~600 lines of orchestration logic mostly in
`packages/runtime/`.

After that, in ROI order:

1. **Bash run_in_background + BashOutput + KillShell** (note 05) —
   unblocks every long-running build/test workflow.
2. **MCP service** (note 08) — opens Maka to the ecosystem
   (Linear, GitHub, Notion, etc.). ~400 lines for the minimum
   viable shape.
3. **Pre-loop tool selector** (note 06) — only matters at >25
   tools, but becomes essential the moment MCP servers start
   contributing.
4. **Binary permission model** (note 04) — drop the three-mode
   chip, replace with a single `autoApproveToolRequests` toggle
   + per-tool risk classification. UX win on top of
   architectural simplification.

Anything cloak-related (note 09) is already mostly in place after
`PR-CLAUDE-OAUTH-XAPIKEY-STRIP-0` (commit `17d6f53`); note 09 is
the regression watch document.

## Status

Round 2 is **shipped at note 09**. Future round 3 candidates pinned
inside each note's "Open questions for round 3 of round-2"
section. Two likely round-3 starting points:

- `permissions runtime → risk metadata`: does
  `autoApproveToolRequests` cover ALL tools or still gate
  destructive ones? (Open question in note 04.)
- `MCP service → tool name collisions`: how does the
  `serverName__toolName` prefix interact with same-named built-in
  tools? (Open question in note 08.)
