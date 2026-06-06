# Alma deep-dive round 5 — yuejing

Rounds 1-4 closed at 30 source-grounded notes covering the agent
loop, tools, OAuth, permissions, MCP, browsers, skills, output
safety, Readability, REST API + alma-operator, autoCompact,
memory recall, bots, workspaces, Whisper, and WebSocket sync.

Round 5 picks up areas that prior rounds touched only obliquely
or skipped: ACP coder-agent bridge, sprint-harness orchestration,
provider abstraction, telemetry/observability, and the
Hummingbird context system.

## Round 5 inventory

| # | Note | Subsystem | Status |
|---|---|---|---|
| 00 | `00-OVERVIEW.md` | This file (round-5 index) | **shipped** |
| 01 | `01-acp-bridge.md` | ACP provider integration via @mcpc-tech/acp-ai-provider + setSessionUpdateHandler wrapper + tool_call_update + permission delegation back to alma's lh ladder | **shipped** |
| 02 | `02-sprint-harness.md` | Planner → Generator → Evaluator autonomous build loop + 4 DB tables (agent_missions/mission_sprints/sprint_contracts/sprint_evaluations) + filesystem artifact layout (spec.md + sprints.json + per-attempt evaluation-N.json) + adversarial evaluator prompt ('Empty evidence = automatic FAIL') + 4 writeBack modes (artifact/patch/summary/decision) + halt-on-first-fail outer loop + retry-with-feedback inner loop | **shipped** |

## Candidates for next notes

- **Sprint Harness mode**: the Planner → Generator → Evaluator
  loop triggered by `handoff.harness.enabled: true` in Task
  invocations (round-2 07 mentioned but didn't trace).
- **Hummingbird context**: the `hummingbirdContext` field on
  generate_response WS messages (round-4 07). What is this and
  how does it shape the prompt?
- **Provider abstraction**: 15 provider types + capabilities +
  modelMapping. How does ACP integrate vs the OpenAI/Anthropic
  direct path?
- **Telemetry / Gt() event broadcaster**: round-4 02 saw
  `Gt("context_compaction_started", …)` — where do these go?
- **API key encryption**: the spec says "stored encrypted, not
  exposed." Round-1 mentioned it but never traced the cipher.
- **Auto-detected coder agent** (`coderAgentProviderId: '__auto__'`):
  selector logic for picking the right ACP provider per task.

## Reading order

Round 5 is open-ended. Each note is **source-grounded** — every
claim cites `main.js:NNNN`. Cross-references back to rounds 1-4
use relative paths.
