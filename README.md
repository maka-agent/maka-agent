 [ENGLISH](./README.en.md)

# Maka

Maka 是一个本地优先的桌面 AI 工作台。它把模型连接、会话、工具权限、文件读写、终端执行、搜索、机器人入口和运行恢复放在一个 Electron 应用里，目标是让用户在自己的电脑上跑一个可观察、可控、可持续恢复的 agent。

这个仓库还在活跃开发中。README 先服务两类人：

- 第一次打开 Maka 的用户：知道为什么要先配置 AI、数据放在哪里、哪些能力已经可用。
- 继续开发 Maka 的工程师：能快速启动、验证、定位关键包和设计文档。

## 你会看到什么

首次进入 Maka 时，如果还没有可用模型连接，首屏会引导你完成 AI 配置，而不是直接给一个不能发送的空聊天框。推荐路径是：

1. 打开 `设置 -> 模型`。
2. 选择一个真实模型供应商，填写 API key 或完成已接入的账号登录。
3. 测试连接并选择默认模型。
4. 回到首屏，用快速输入开始第一条对话。

已接入的模型类型包括：

- 海外 API：Anthropic、OpenAI、Google Gemini。
- 国内 API：DeepSeek、Moonshot、Z.AI Coding Plan、Kimi Coding Plan。
- 本地模型：Ollama。
- 自定义网关：OpenAI Compatible endpoint。
- 账号订阅入口：Claude Subscription、Codex Subscription、Gemini CLI 等仍按实验/可用状态分开呈现，未接入发送链路的入口不会伪装成可用。

## 当前能力

Maka 当前不是简单 chat demo，已经有这些核心面：

- **桌面会话**：创建、切换、归档、搜索、重命名、停止、重试、重新生成、从 turn 分支。
- **模型运行时**：基于 Vercel AI SDK 的 provider runtime，支持模型流式输出、工具调用、usage 记录、错误分类和启动恢复。
- **本地工具**：`Read`、`Write`、`Edit`、`Bash`、`Glob`、`Grep`，写文件和命令执行走权限策略。
- **首跑引导**：根据真实连接状态展示“补配置 / 选默认连接 / 选默认模型 / 开始对话”的不同状态。
- **设置中心**：模型、账号、使用统计、每日回顾、本地记忆、语音模型、开放网关、机器人对话、联网搜索、网络代理、权限与能力、健康状态、数据与关于。
- **本地记忆**：`MEMORY.md` 管理、手动添加、归档/恢复、agent 读取开关。
- **联网搜索**：Tavily 凭据配置、测试和 agent tool 边界。
- **机器人入口**：Telegram、飞书、企业微信、微信 iLink、Discord、钉钉、QQ 的配置/测试/运行状态框架。
- **开放网关**：本地 HTTP/SSE API，用 token 保护外部读取会话状态、事件、能力和健康摘要。
- **Office 文档工作流**：通过本地 `officecli` 探测后启用读取、校验和按次授权编辑。
- **运行内核**：`AgentRun` ledger、`RuntimeEvent` read model、`ToolRuntime`、`ModelAdapter`、`RunTrace` 和恢复逻辑。

## 本地与隐私边界

Maka 默认把工作数据放在 Electron `userData` 下的工作区目录：

```text
<Electron userData>/workspaces/default/
  llm-connections.json
  credentials.json
  settings.json
  sessions/
```

重要边界：

- Provider 连接元数据和 session JSONL 在本地文件系统。
- Provider/API key、bot token、proxy password、gateway token、Tavily key 等运行凭据写入本地 `credentials.json`；当前格式是 file-first plaintext JSON，依赖 OS 账号边界，并在 POSIX 上强制目录 `0700`、文件 `0600`。
- Claude、Codex、Cursor、Antigravity 等 subscription OAuth token 使用各自独立的 Electron `safeStorage` 存储路径；`safeStorage` 不可用时这些 token store 会 fail closed。
- Renderer 不直接拿明文密钥；Settings 只显示 masked 状态和测试结果。
- 文件读写、shell、危险操作需要经过 permission engine。
- Incognito / privacy context、memory、voice、workspace instructions 等能力有单独 contract 文档约束。

## 快速开始

仓库使用 npm workspaces。虽然存在 `pnpm-workspace.yaml`，当前脚本和 lockfile 以 npm 为准。

```sh
npm install
npm run dev
```

`npm run dev` 会先 build 全部 workspace，再启动 Electron desktop app。

如果安装依赖时设置过 `ELECTRON_SKIP_BINARY_DOWNLOAD=1`，启动前需要补 Electron 平台二进制：

```sh
node node_modules/electron/install.js
```

常用开发命令：

```sh
npm run build
npm run typecheck
npm --workspace @maka/desktop run test
npm --workspace @maka/runtime run test
npm --workspace @maka/core run test
```

桌面视觉和真实窗口验证：

```sh
npm --workspace @maka/desktop run screenshots
npm --workspace @maka/desktop run screenshots:diff:stable
npm --workspace @maka/desktop run smoke:real-window
```

Release 前的基础检查：

```sh
npm run check:release
```

## 可选环境变量

这些变量只影响本地开发或特定能力：

| 变量 | 用途 |
| --- | --- |
| `ANTHROPIC_API_KEY` | 首次启动时可用来 bootstrap Anthropic 连接。 |
| `OPENAI_API_KEY` | 首次启动时可用来 bootstrap OpenAI 连接。 |
| `TAVILY_API_KEY` / `MAKA_TAVILY_API_KEY` | 联网搜索的 Tavily 凭据来源。 |
| `MAKA_RIVE_BIN` / `RIVE_BIN` | 指定 Rive workflow 使用的 `rive` CLI。 |
| `MAKA_VISUAL_SMOKE_FIXTURE` | 启用确定性视觉 fixture，仅限 dev/test build。 |

## 项目结构

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

## Runtime 架构

当前 runtime 已从单一大流程拆成更清楚的内核边界：

```text
SessionManager
  -> AgentRun
      -> AiSdkBackend
          -> ModelAdapter
          -> ToolRuntime
      -> RunTrace
      -> AgentRunStore
```

关键原则：

- `SessionManager` 仍是对桌面、bot、gateway 暴露的公共 runtime API。
- `AgentRun` 负责单次 turn 的 durable run 事实和启动恢复。
- `ToolRuntime` 负责工具输入校验、权限、watchdog、abort、telemetry、artifact candidate 和错误分类。
- `ModelAdapter` 隔离 provider stream / error / usage normalization。
- `RunTrace` 是 best-effort，不允许因为 trace 写失败影响用户对话。

更多细节见：

- [`ARCHITECTURE.md`](./ARCHITECTURE.md)：后端架构总览、六章专题索引和按问题阅读路径。
- `docs/runtime-kernel.md`
- `docs/runtime-v2-architecture-evolution.md`
- `docs/runtime-v2-implementation-notes.md`

## UI 与产品质量契约

Maka 的 UI 不是随手堆页面，已有单独的设计系统和测试计划：

- `docs/design-system.md`：颜色、密度、状态、动效、Settings IA、copy 和 a11y 契约。
- `docs/ui-quality-plan.md`：真实窗口、视觉截图、交互状态、回归验证策略。
- `docs/full-product-test-plan.md`：从首跑、设置、会话、工具、搜索、bot、gateway 到失败路径的完整 QA 路线。

改 UI 时不要只跑 TypeScript。至少要配套：

1. 对应 surface 的 node:test contract。
2. `check-console` / `check-a11y` 通过。
3. 必要时补视觉 fixture 或真实窗口 smoke。

## 贡献前检查

常规代码改动建议至少跑：

```sh
npm run typecheck --workspaces --if-present
npm run build
git diff --check
```

涉及 desktop renderer / Settings / IPC 的改动，再跑对应 focused suite，例如：

```sh
npm --workspace @maka/desktop run test -- settings-form-a11y-contract visible-copy-hygiene-contract
```

涉及 runtime / storage 的改动，再跑对应 workspace 测试：

```sh
npm --workspace @maka/runtime run test
npm --workspace @maka/storage run test
```

## 相关文档

- `CHANGELOG.md`：当前未发布变更摘要。
- `SECURITY.md`：安全边界和报告方式。
- `docs/workspace-privacy-context.md`：工作区隐私上下文。
- `docs/search-service-threat-model.md`：搜索服务威胁模型。
- `docs/memory-threat-model.md`：本地记忆威胁模型。
- `docs/voice-threat-model.md`：语音能力边界。
- `docs/maka-capability-audit-v1.md`：能力成熟度审计和后续路线。
