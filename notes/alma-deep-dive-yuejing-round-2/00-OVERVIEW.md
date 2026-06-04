# Alma deep-dive round 2 — yuejing

Round 1 (`notes/alma-deep-dive-yuejing-2026-05-31/`) covered the agent loop,
tools registry, prompts/skills, memory, renderer architecture, bots, and
40+ borrowable patterns. WAWQAQ asked for **deeper reverse engineering**
(msg `bdb272f7`) — round 2 picks subsystems that round 1 skipped or only
touched lightly, and traces each end-to-end at the `main.js:NNNN` level
against the alma `readable/main.js` source.

## What round 2 picks up

| Note | Subsystem | Why round 1 missed depth | Round 2 deliverable |
|---|---|---|---|
| `01-computer-use.md` | Native macOS Computer Use stack | Round 1 only listed it as a future borrowable | Full architecture: native helper binary, Unix-socket protocol, 18 commands, three exposure layers (Node client + HTTP REST + provider-executed tool), DB schema for approvals/action-log |
| `02-browser-tools.md` (planned) | Built-in Browser tool family | Round 1 lumped into "tools registry" | Per-tool schemas, CDP integration, the BrowserOpen → Click → Type → Read DOM → Screenshot → Eval → Back / Forward / Reload / Close / Upload flow |
| `03-chrome-relay.md` (planned) | ChromeRelay (extension-bridged) | Round 1 didn't enumerate the user-session priority logic | Why ChromeRelay takes precedence when connected, the prompt switch logic at the tool selection assistant, extension protocol |
| `04-permissions-runtime.md` (planned) | Alma permission machinery (single-mode + auto-accept toggle) | Round 1 covered Maka's three-mode design — alma's is one-mode | The actual Shift+Tab auto-accept toggle, tool risk classification, app-bundle approval gating for computer use, action-log audit pattern |
| `05-bash-sandbox-full.md` (planned) | Persistent shell + sandbox boundary | Round 1 `08-extended-topics` only briefly noted bash-sandbox | Real lifecycle, env isolation, working-dir tracking, output streaming, kill semantics |
| `06-subagent-orchestration.md` (planned) | Spawn/lifecycle/parent-child + tool routing | Round 1 only sketched | Full Task / TaskOutput / TaskStop machinery, subagent registry, prompt scoping |
| `07-tool-selection-assistant.md` (planned) | Pre-loop tool gate (LLM picks tools before the main loop) | Round 1 didn't surface this | The big system prompt at `main.js:29668`, JSON output schema, fallback behavior |
| `08-mcp-client-full.md` (planned) | Full MCP integration | Round 1 `08-extended-topics` only briefly noted | Server lifecycle, JSON-Schema → Zod, server__tool prefix collision, secret handling |
| `09-cloak-request-full.md` (planned) | Full cloaked-request path (Stainless headers, system prefix, beta headers) | Round 1 didn't reverse engineer the full set | Per-endpoint header shape, system prefix injection, when to apply |

Round 2 is open-ended. Each note in this directory is **source-grounded**
— every claim cites `main.js:NNNN`. New cross-references back to round 1
notes use `[../alma-deep-dive-yuejing-2026-05-31/NN-name.md]`.

## Top-level borrowable summary

The single biggest gap between Maka and alma at the architecture level is
**Computer Use as a native macOS subsystem with its own binary, IPC
protocol, DB-backed approval store, and three-layer exposure (Node /
HTTP / provider-executed)**. Round 2 starts there because it informs
every "automate the OS" feature Maka might want next, and because the
HTTP-API layer is the cleanest way to make Computer Use scriptable from
outside the renderer.
