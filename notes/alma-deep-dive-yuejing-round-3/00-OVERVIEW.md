# Alma deep-dive round 3 — yuejing

Round 1 (`notes/alma-deep-dive-yuejing-2026-05-31/`) covered the agent
loop, tools registry, prompts/skills, memory, renderer architecture,
bots, and 40+ borrowable patterns.

Round 2 (`notes/alma-deep-dive-yuejing-round-2/`) added 11 source-
grounded subsystem notes: Computer Use, send→response, Maka OAuth
diff, permissions, Bash, tool routing, subagents, MCP, cloak request
shape, ChromeRelay, sandbox Browser.

Round 3 picks up the open questions pinned at the bottom of round-2
notes, plus surfaces neither round touched at all.

## Round 3 inventory

| # | Note | Subsystem | Status |
|---|---|---|---|
| 00 | `00-OVERVIEW.md` | This file (round-3 index) | **shipped** |
| 01 | `01-skills-system.md` | SKILL.md discovery + Skill / SlashCommand tools + persistent enable/disable + extraction loop | **shipped** |
| 02 | `02-output-safety-modes.md` | 3-mode classifier (exact/compact/passthrough) + 8 budget profiles + `[alma-output-safety: …]` marker + truncation cascade with recovery hints + outer shrink loop | **shipped** |
| 03 | `03-mcp-tool-name-collisions.md` | `bf` prefix function + asymmetric sanitizers (yf server vs wf tool) + why `__` cannot collide with built-ins + cross-MCP-server collision risk + per-tool safety mode injection from MCP | **shipped** |
| 04 | `04-permissions-runtime-risk.md` | `autoApproveToolRequests` is a flat skip (no risk gate) + 5 bypass channels (autoApprove / subagent / bot-source / bot-thread / cron) + 6th allow_always policy cache scoped per-thread + 7th interactive modal + Bash's AI pre-gate analyzer with safe/low/medium/high risk levels + headless ALMA_TOOL_APPROVAL env | **shipped** |
| 05 | `05-readability-execution-context.md` | Mozilla Readability runs in PAGE CONTEXT via `webContents.executeJavaScript` across 4 call sites (WebSearch / WebFetch / BrowserRead / ChromeRelayRead) + asymmetric `document` vs `cloneNode(true)` use + pre-sweep selector strip + 2-tier fallback hierarchy + main-process turndown HTML→md + per-call 6000-char trim before safety-mode profile | **shipped** |

## Picking the next note

The OPEN-QUESTIONS sections at the bottom of each round-2 note are
the source of truth for round 3 candidates. Likely picks:

- **Permissions risk metadata**: does `autoApproveToolRequests`
  cover ALL tools or still gate destructive ones at runtime? (round-2
  note 04 open question)
- **MCP tool name collisions**: how does the `serverName__toolName`
  prefix interact with same-named built-in tools? (round-2 note 08)
- **Output safety modes** (`[alma-output-safety: exact|compact|
  passthrough]`): pinned in round-2 note 02 but not traced.
- **Mozilla Readability execution context** (page-context vs main
  process): pinned in round-2 notes 10 + 11.

## Reading order

Round 3 is open-ended. Each note is **source-grounded** — every
claim cites `main.js:NNNN`. Cross-references back to round 1 or
round 2 use relative paths.
