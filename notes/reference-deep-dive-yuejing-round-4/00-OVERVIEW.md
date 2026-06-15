# Reference app deep-dive round 4 — yuejing

Rounds 1-3 covered the agent loop, send→response flow, OAuth cloak,
tools registry, permissions, Bash, MCP, ChromeRelay, sandbox Browser,
skills, output safety modes, MCP tool name collisions, autoApprove
bypass channels, Mozilla Readability execution context — 23 notes
across three rounds. Round 4 picks subsystems NONE of the prior
rounds touched, starting with self-referential agent surfaces.

## Round 4 inventory

| # | Note | Subsystem | Status |
|---|---|---|---|
| 00 | `00-OVERVIEW.md` | This file (round-4 index) | **shipped** |
| 01 | `01-rest-api-operator-agent.md` | Express server bound to 127.0.0.1 + dynamic port + self-describing `~/.config/reference app/api-spec.md` + 30+ routes (settings/providers/threads/ChromeRelay/health) + `app-operator` agent with Bash + Read only + WebSocket sync to live-update renderer | **shipped** |
| 02 | `02-auto-compact.md` | 3 trigger sites (pre-request / prepareStep / manual REST) + 3-tier fallback (LLM summary → hard truncate → emergency slice) + user-message-counted `keepRecentMessages` + 32k output reserve floor + `<context_summary>` markup + anti-loop guard + ineffective-compaction detection + "DO NOT preserve transient errors" prompt design | **shipped** |
| 03 | `03-memory-recall.md` | Recall + OperateMemory tools (both in exact-preserve set) + autoRetrieve pre-turn pipeline + fact-shape query rewriting (Chinese → "User's X is Y" English) + aggressive 0.1 similarity threshold default + incognito mode short-circuit + linkedUserIds cross-platform identity + 3 separate model slots (chat / tool / embedding) | **shipped** |
| 04 | `04-bot-integration-contract.md` | Prompt-as-contract + CLI-as-API strategy + 30+ `reference app group/people/msg/dm/skill` commands + DUPLICATE MESSAGE PREVENTION runtime detector + ACTION OVER WORDS / PROMISE TRACKING / NO MEANINGLESS FILLER rules + identity firewall (bub assertion) + privacy firewall (persona shield) + self-protection autonomy + people profile graph with avatars + skill self-evolution loop | **shipped** |
| 05 | `05-workspace-switching.md` | workspaces table with worktree + PR metadata + isTemporary cleanup + 4-layer default resolution (channel map → user default → builtin → lazy create) + dual workspace FKs on threads (session + artifact) + bot-thread unconditional reassignment + `isInsideSkillDirectory` + ACP/Bash sessions keyed on (workspace, thread) + ON DELETE SET NULL non-cascade | **shipped** |
| 06 | `06-whisper-voice.md` | 3-tier dispatch (local model → OpenAI cloud → null) + `@fugood/whisper.node` lazy load + ggml model storage + REST `/api/whisper/models` + IPC PCM decode round-trip (main → renderer Web Audio → main) + 15s decode timeout + ID-keyed concurrent request matching + language-code normalization mapping + Discord shell-out fallback path | **shipped** |
| 07 | `07-websocket-sync.md` | Single Express server piggybacking on REST port + 9 routed WS channels (`/ws/threads`, `/ws/settings`, `/ws/providers`, `/ws/memory`, `/ws/skills`, `/ws/mcp-resources`, `/ws/browser-relay?token=…`, `/ws/terminal/<id>`, `/ws/workspace/<id>`) + broadcast helpers stripping large fields (availableModels) + past-tense topic-prefixed event vocabulary + theme_preview client-to-client echo + RFC 6455 application close codes + scrollback-on-connect for terminal | **shipped** |

## Candidates for next notes

Topics no prior round has covered:
- **Renderer architecture deep dive**: how the React tree consumes
  WebSocket sync events; preload bridge shape; artifact pane.
- **Memory recall system**: Recall + OperateMemory tools; similarity
  threshold + maxRetrievedMemories settings; query rewriting.
- **Bot integrations**: Telegram/Discord/Feishu lifecycle, sticker
  + reaction handling, group rules persistence, USER.md / people
  observation pattern.
- **Workspace switching**: `defaultWorkspaceId` + project-scoped
  data paths; how skills (round-3 01) interact.
- **NvChad theme integration**: the `themeConfig.nvchad` settings
  group hints at filesystem-watched theme sync.
- **AutoCompact**: `chat.autoCompact.threshold` / `keepRecentMessages`
  / `summaryModel` — how reference app decides when and how to compress
  a thread.
- **Whisper voice input**: model selection, language detection,
  IPC contract.

## Reading order

Round 4 is open-ended. Each note is **source-grounded** — every
claim cites `main.js:NNNN`. Cross-references back to rounds 1-3
use relative paths.
