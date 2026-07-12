[中文](./README.md)

# Maka

Maka is a local-first desktop AI workspace. It brings model connections,
sessions, tool permissions, file I/O, terminal execution, search, bot entry
points, and run recovery into one Electron app, with the goal of letting users
run an observable, controllable, recoverable agent on their own computer.

This repository is under active development. The README currently serves two
audiences:

- First-time Maka users: understand why AI setup comes first, where data lives,
  and which capabilities are already available.
- Engineers continuing Maka development: get the app running quickly, verify
  changes, and find the key packages and design docs.

## What You Will See

When you enter Maka for the first time, if there is no usable model connection,
the first screen guides you through AI setup instead of showing an empty chat
box that cannot send. The recommended path is:

1. Open `Settings -> Models`.
2. Choose a real model provider and enter an API key or complete login for a
   supported account flow.
3. Test the connection and select a default model.
4. Return to the home screen and start your first conversation from the quick
   input.

Currently supported model connection types include:

- Global APIs: Anthropic, OpenAI, Google Gemini.
- China APIs: DeepSeek, Moonshot, Z.AI Coding Plan, Kimi Coding Plan.
- Local models: Ollama.
- Custom gateways: OpenAI-compatible endpoints.
- Account subscription entries: Claude Subscription, Codex Subscription,
  Gemini CLI, and others are shown separately according to their experimental
  or available status. Entries that are not wired into the send path are not
  presented as usable.

## Current Capabilities

Maka is not just a chat demo. It already includes these core surfaces:

- **Desktop sessions**: create, switch, archive, search, rename, stop, retry,
  regenerate, and branch from a turn.
- **Model runtime**: a provider runtime based on the Vercel AI SDK, supporting
  streaming model output, tool calls, usage accounting, error classification,
  and startup recovery.
- **Local tools**: `Read`, `Write`, `Edit`, `Bash`, `Glob`, `Grep`. File writes
  and command execution go through the permission policy.
- **First-run guidance**: different states for "finish setup / choose default
  connection / choose default model / start chatting" based on the real
  connection state.
- **Settings center**: models, accounts, usage stats, daily review, local
  memory, voice models, open gateway, bot conversations, web search, network
  proxy, permissions and capabilities, health, data, and about.
- **Local memory**: `MEMORY.md` management, manual add, archive/restore, and
  an agent read toggle.
- **Web search**: Tavily credential setup, connection testing, and agent tool
  boundaries.
- **Bot entry points**: configuration, testing, and run-status framework for
  Telegram, Feishu, WeCom, WeChat iLink, Discord, DingTalk, and QQ.
- **Open gateway**: local HTTP/SSE APIs, protected by tokens, for external
  access to session state, events, capabilities, and health summaries.
- **Office document workflow**: enabled after local `officecli` detection for
  read, validation, and per-action authorized edits.
- **Runtime kernel**: `AgentRun` ledger, `RuntimeEvent` read model,
  `ToolRuntime`, `ModelAdapter`, `RunTrace`, and recovery logic.

## Local Storage And Privacy Boundary

By default, Maka stores workspace data under Electron `userData`:

```text
<Electron userData>/workspaces/default/
  llm-connections.json
  credentials.json
  settings.json
  sessions/
```

Important boundaries:

- Provider connection metadata and session JSONL stay in the local filesystem.
- Runtime credentials such as provider API keys, bot tokens, proxy passwords,
  gateway tokens, and Tavily keys are written to local `credentials.json`. The
  current format is file-first plaintext JSON behind the OS account boundary,
  with POSIX directory mode `0700` and file mode `0600` enforced.
- Subscription OAuth tokens for Claude, Codex, Cursor, Antigravity, and similar
  account services use their own Electron `safeStorage` token stores. Those
  stores fail closed when `safeStorage` is unavailable.
- The renderer does not receive plaintext secrets. Settings surfaces only show
  masked status and test results.
- File I/O, shell access, and dangerous operations go through the permission
  engine.
- Incognito/privacy context, memory, voice, and workspace instructions are
  constrained by their own contract docs.

## Quick Start

The repository uses npm workspaces. Although `pnpm-workspace.yaml` exists, the
current scripts and lockfile are based on npm.

```sh
npm install
npm run dev
```

`npm run dev` first builds all workspaces, then starts the Electron desktop
app.

If you set `ELECTRON_SKIP_BINARY_DOWNLOAD=1` while installing dependencies,
install the Electron platform binary before starting:

```sh
node node_modules/electron/install.js
```

Common development commands:

```sh
npm run build
npm run typecheck
npm --workspace @maka/desktop run test
npm --workspace @maka/runtime run test
npm --workspace @maka/core run test
```

Desktop visual and real-window verification:

```sh
npm --workspace @maka/desktop run screenshots
npm --workspace @maka/desktop run screenshots:diff:stable
npm --workspace @maka/desktop run smoke:real-window
```

Basic checks before release:

```sh
npm run check:release
```

## Optional Environment Variables

These variables only affect local development or specific capabilities:

| Variable | Purpose |
| --- | --- |
| `ANTHROPIC_API_KEY` | Bootstrap an Anthropic connection on first launch. |
| `OPENAI_API_KEY` | Bootstrap an OpenAI connection on first launch. |
| `TAVILY_API_KEY` / `MAKA_TAVILY_API_KEY` | Sources for Tavily web search credentials. |
| `MAKA_RIVE_BIN` / `RIVE_BIN` | Specify the `rive` CLI used by the Rive workflow. |
| `MAKA_VISUAL_SMOKE_FIXTURE` | Enable deterministic visual fixtures, only for dev/test builds. |

## Project Structure

```text
apps/desktop/
  src/main/        Electron main process, IPC, settings, OAuth, bot, gateway
  src/preload/     window.maka preload bridge
  src/renderer/    React desktop UI and Settings surfaces

packages/core/     Pure contracts: sessions, events, settings, permissions, model connections
packages/storage/  File-backed session, settings, connection, run-ledger stores
packages/runtime/  SessionManager, AgentRun, AI SDK runtime, tools, bots, telemetry
packages/ui/       Shared rendering components, markdown, artifacts, redaction helpers

docs/              Product, runtime, design-system, privacy and test-plan contracts
scripts/           Build hygiene, screenshot, smoke and release helpers
```

## Runtime Architecture

The runtime has already been broken down from a single large flow into clearer
kernel boundaries:

```text
SessionManager
  -> AgentRun
      -> AiSdkBackend
          -> ModelAdapter
          -> ToolRuntime
      -> RunTrace
      -> AgentRunStore
```

Key principles:

- `SessionManager` remains the public runtime API exposed to the desktop app,
  bots, and gateway.
- `AgentRun` owns the durable facts for a single turn and startup recovery.
- `ToolRuntime` owns tool input validation, permissions, watchdogs, abort,
  telemetry, artifact candidates, and error classification.
- `ModelAdapter` isolates provider stream, error, and usage normalization.
- `RunTrace` is best-effort and must not block user conversations if trace
  writes fail.

See also:

- [`ARCHITECTURE.en.md`](./ARCHITECTURE.en.md): backend architecture overview,
  six-chapter index, and problem-oriented reading paths.
- `docs/runtime-kernel.md`
- `docs/runtime-v2-architecture-evolution.md`
- `docs/runtime-v2-implementation-notes.md`

## UI And Product Quality Contracts

Maka's UI is not assembled casually. It already has dedicated design-system and
test-plan contracts:

- `docs/design-system.md`: color, density, states, motion, Settings IA, copy,
  and accessibility contracts.
- `docs/ui-quality-plan.md`: real-window checks, visual screenshots,
  interaction states, and regression verification strategy.
- `docs/full-product-test-plan.md`: the full QA path from first run, settings,
  sessions, tools, search, bots, and gateway to failure paths.

When changing UI, do not stop at TypeScript checks. At minimum, add:

1. A node:test contract for the affected surface.
2. Passing `check-console` / `check-a11y`.
3. A visual fixture or real-window smoke test when needed.

## Checks Before Contributing

For ordinary code changes, at minimum run:

```sh
npm run typecheck --workspaces --if-present
npm run build
git diff --check
```

For desktop renderer, Settings, or IPC changes, also run a focused suite such
as:

```sh
npm --workspace @maka/desktop run test -- settings-form-a11y-contract visible-copy-hygiene-contract
```

For runtime or storage changes, also run the corresponding workspace tests:

```sh
npm --workspace @maka/runtime run test
npm --workspace @maka/storage run test
```

## Related Documents

- `CHANGELOG.md`: summary of unreleased changes.
- `SECURITY.md`: security boundary and reporting process.
- `docs/workspace-privacy-context.md`: workspace privacy context.
- `docs/search-service-threat-model.md`: search service threat model.
- `docs/memory-threat-model.md`: local memory threat model.
- `docs/voice-threat-model.md`: voice capability boundary.
- `docs/maka-capability-audit-v1.md`: capability maturity audit and follow-up roadmap.
