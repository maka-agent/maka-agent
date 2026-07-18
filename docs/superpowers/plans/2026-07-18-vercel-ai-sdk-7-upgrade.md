# Vercel AI SDK 7 Upgrade TODO

**目标：** 将 Maka 从 Vercel AI SDK 6 升级到 AI SDK 7，并保持现有多供应商模型调用、Tool Calling Agent Loop、权限/Sandbox、上下文管理和 usage 统计行为不变。

**升级前基线：** `ai@6.0.185`；runtime 使用 OpenAI、Anthropic、Google、Cohere 和 OpenAI-compatible provider 包。

**当前实现：** `ai@7.0.31`；`@ai-sdk/openai@4.0.16`、`@ai-sdk/anthropic@4.0.16`、`@ai-sdk/google@4.0.18`、`@ai-sdk/cohere@4.0.11`、`@ai-sdk/openai-compatible@3.0.12`。

**验证状态：** clean build、全 workspace typecheck、Biome lint、runtime 全量测试和 monorepo 全量测试均通过。真实 API 验证中，DeepSeek 官方端点（OpenAI-compatible）的 `deepseek-chat` 与 `deepseek-v4-pro` 文本流和两步 Tool Calling 均已通过；`deepseek-v4-pro` 还验证了 reasoning stream 与 reasoning usage。真实 Electron Computer Use observe-only E2E 已执行，但 `deepseek-v4-pro` 在 Maka 中属于非视觉模型，Desktop 会按设计移除会返回截图的 `maka_computer` 工具，因此该模型无法满足 Computer Use 资格门槛。tokenhub/OpenAI `gpt-5.5` 到达 provider 后因账户额度不足返回 HTTP 402；Anthropic、Google、Cohere 暂无本地凭据。

**目标版本策略：** 使用最新兼容的 `7.0.x` 补丁版本，并将所有 `@ai-sdk/*` provider 包升级到与 AI SDK 7 匹配的主版本；不要只升级 `ai` 包。

**最高风险：** `LanguageModelV3` 自定义代理、`prepareStep` 的跨 step 语义、`usage` 累计语义。

---

## 1. 建立升级前基线

- [x] 确认本地 Node.js、CI 和 Electron runtime 均满足 AI SDK 7 的 Node.js 22+ 与 ESM 要求。
- [x] 从干净依赖状态执行 `npm ci`，避免旧 `node_modules` 或 `dist` 干扰结果。
- [x] 执行 `npm run clean`、`npm run build`、`npm run typecheck` 和现有测试。
- [x] 记录升级前已经存在的失败，避免把基线问题误判为 SDK 7 回归。
- [x] 记录五类 provider 的当前模型创建方式、自定义 base URL、headers、fetch 和 provider options。

## 2. 升级依赖

**文件：**

- `packages/runtime/package.json`
- `packages/headless/package.json`
- `apps/desktop/package.json`
- `package-lock.json`

- [x] 将 `ai` 升级到最新兼容的 `7.0.x`。
- [x] 协同升级 `@ai-sdk/openai`。
- [x] 协同升级 `@ai-sdk/anthropic`。
- [x] 协同升级 `@ai-sdk/google`。
- [x] 协同升级 `@ai-sdk/cohere`。
- [x] 协同升级 `@ai-sdk/openai-compatible`。
- [x] 检查 lockfile 中 `@ai-sdk/provider`、`@ai-sdk/provider-utils` 和 `@ai-sdk/gateway` 是否收敛到兼容版本。
- [x] 评估官方 V7 codemod；Maka 的 SDK 边界包含自定义 Agent Loop 适配和 usage 语义，因此本次采用逐项手工迁移与审查。

## 3. 迁移模型与 provider contract

**主要文件：** `packages/runtime/src/model-factory.ts`

- [x] 将 `LanguageModelV3`、`SharedV3ProviderOptions` 等 V3 类型迁移到 V4 contract。
- [x] 更新 OpenAI、Anthropic、Google、Cohere 和 OpenAI-compatible 的模型 factory 调用。
- [x] 将 `createGoogleGenerativeAI` 迁移到 AI SDK 7 推荐的 Google factory。
- [x] 迁移自定义 `doGenerate()` / `doStream()` Proxy。
- [x] 验证自定义 subscription fetch、base URL 和请求头没有丢失。
- [x] 验证 reasoning details、provider metadata、tool-call chunk 和 finish reason 的 V4 结构。
- [x] 检查 OpenAI reasoning summary 默认值变化，保留 Maka 的 provider options 行为。
- [x] 检查 V4 cache usage 字段，并验证 Maka 的 cache read/write/creation 统计映射。

## 4. 迁移 AI SDK 适配层

**主要文件：** `packages/runtime/src/model-adapter.ts`

- [x] 将 SDK-facing 的 `system` 参数迁移为 `instructions`；Maka 内部接口暂时保留 `system` 命名以限制改动范围。
- [x] 将 `stepCountIs()` 迁移为 `isStepCount()`。
- [x] 将 `StreamTextResult.fullStream` 迁移为 `stream`。
- [x] 将 `experimental_context` 迁移到 V7 的 `runtimeContext` / `toolsContext` contract。
- [x] 更新本地 `StreamTextResult`、stream chunk、finish reason 和 usage 兼容类型。
- [x] 验证 `onError`、abort 和 stream error chunk/throw 的行为保持不变。
- [x] 验证 `generateText()` 摘要路径的返回类型和 usage 处理。

## 5. 重新验证 Agent Loop 语义

**主要文件：**

- `packages/runtime/src/ai-sdk-backend.ts`
- `packages/runtime/src/tool-availability.ts`
- `packages/runtime/src/active-full-compact.ts`
- `packages/runtime/src/active-tool-result-prune.ts`
- `packages/runtime/src/context-budget.ts`
- `packages/runtime/src/model-history.ts`
- `packages/runtime/src/request-shape.ts`
- `packages/runtime/src/semantic-compact.ts`

- [x] 审计所有 `prepareStep` hook 的输入、输出和组合顺序。
- [x] 处理 V7 中 `prepareStep` 返回的 messages/instructions 会延续到后续 step 的变化。
- [x] 防止 steering message 被重复追加。
- [x] 防止 compact 或 tool-result prune 被重复应用。
- [x] 验证 `load_tools` 后同一 turn 的动态 `activeTools` 激活仍然生效。
- [x] 验证显式最大 step 数和无限 Tool Calling Loop 的停止条件。
- [x] 验证 tool call repair、大小写修复和 invalid-tool fallback。
- [x] 验证权限 prompt、park/resume、deny 和 abort 不会破坏 AI SDK 内层循环。
- [x] 验证 overflow retry、transport retry 和 watchdog 不会重复执行有副作用的工具。

## 6. 重写 usage 与成本统计

**主要文件：**

- `packages/runtime/src/ai-sdk-backend.ts`
- `packages/runtime/src/model-adapter.ts`

- [x] 删除“`usage` 仅代表最后一个 step、`totalUsage` 代表累计值”的 V6 假设。
- [x] 按 V7 的累计 `usage` 语义重写 turn-level 统计。
- [x] 需要最后一个 step usage 时继续使用 `finish-step` 的 step usage（或 `finalStep.usage`）。
- [x] 防止多 step、overflow retry 和 transport retry 重复累计 token。
- [x] 保留 abort、部分 stream 和缺失 usage 时的降级行为。
- [x] 验证 input、output、reasoning、cached input 和 cache creation token 映射。
- [x] 通过现有 usage/cost 回归用例验证单步、多步和 retry 算例。

## 7. 迁移工具、图片和消息格式

**主要文件：**

- `packages/runtime/src/builtin-tools.ts`
- `packages/runtime/src/mcp-tools.ts`
- `packages/runtime/src/ai-sdk-tool-output.ts`
- `packages/runtime/src/tool-runtime.ts`
- `packages/runtime/src/computer-use-tools.ts`
- `packages/runtime/src/ai-sdk-backend.ts`

- [x] 验证 `jsonSchema()` 和 `zodSchema()` 的 V7 contract。
- [x] 验证 MakaTool 到 AI SDK tool 的 `description`、`inputSchema`、`execute` 和 `toModelOutput` 映射。
- [x] 将弃用的 `image-data` 工具输出迁移到 V7 推荐的 `file`/media 输出结构。
- [x] 迁移用户附件中的 image/file message parts。
- [x] 验证 MCP 文本、图片、错误和超大结果的转换。
- [x] 验证 computer-use screenshot 可以正确返回给模型。
- [x] 验证 system prompt 通过 `instructions` 传入，不会成为 messages 中的 system role。

## 8. 迁移独立文本生成调用

**文件：**

- `packages/runtime/src/approval-reviewer.ts`
- `packages/runtime/src/history-compact-summarizer.ts`
- `apps/desktop/src/main/daily-review-main.ts`
- `apps/desktop/src/main/goal-wiring.ts`
- `packages/cli/src/runtime-bootstrap.ts`
- `packages/headless/src/one-shot-completion.ts`

- [x] 将 `generateText()` 调用迁移到 V7 参数结构。
- [x] 将 system prompt 迁移到 `instructions`。
- [x] 更新返回值、usage 和错误处理类型。
- [x] 审批、摘要、daily review、goal、CLI 和 headless completion 的相关 workspace 测试均通过。

## 9. 更新测试基础设施

- [x] 将 `MockLanguageModelV3` 迁移到 V4 mock。
- [x] 将 `LanguageModelV3StreamPart` 和 `LanguageModelV3Usage` 迁移到 V4 类型。
- [x] 更新所有 `fullStream`、`stepCountIs`、SDK-facing `system` 和 `totalUsage` 测试。
- [x] 覆盖普通文本完成、单次 tool call 和多步 tool loop。
- [x] 覆盖 deferred tools 与每一步 `prepareStep`。
- [x] 覆盖 mid-turn compact、tool-result prune 和上下文溢出恢复。
- [x] 覆盖权限允许、拒绝、等待用户和取消。
- [x] 覆盖 tool 执行后网络失败时不重放副作用。
- [x] 覆盖图片附件、MCP 图片和 computer-use screenshot。
- [x] 保持 provider conformance 和 provider contract matrix 全部通过。

## 10. 验收与发布前检查

- [x] `npm run clean`
- [x] `npm run build`
- [x] `npm run typecheck`
- [x] `npm run lint`
- [x] `npm test`
- [ ] 分别对 OpenAI、Anthropic、Google、Cohere 和 OpenAI-compatible 执行真实 API smoke test。
  - [x] OpenAI-compatible：DeepSeek 官方 `deepseek-chat` 与 `deepseek-v4-pro` 文本流和两步 Tool Calling 通过；观测到 reasoning、`tool-call`、`tool-result`、`finish-step` 和累计 usage。
  - [ ] OpenAI：tokenhub `gpt-5.5` 请求到达 `/v1/responses`，但 provider 返回 HTTP 402 额度不足，尚不能完成生成验证。
  - [ ] Anthropic：未发现可用凭据。
  - [ ] Google：未发现可用凭据。
  - [ ] Cohere：未发现可用凭据。
- [x] 通过自动化测试验证多步骤 Tool Calling Loop、动态工具加载、权限确认、取消和上下文 compact。
- [ ] 真实 Computer Use：隔离 Electron `l0-observe-only` 已执行，fixture 身份、无副作用和会话完成检查通过；但 `deepseek-v4-pro` 是非视觉模型，`maka_computer` 按产品策略不会暴露，无法产生要求的 observe action。需要支持视觉输入且兼容工具调用的模型完成此项。
- [x] 通过 provider contract 与 usage 回归测试对比请求体、tool schema、finish reason 和 usage/cost 结果。
- [x] 扫描并确认 SDK-facing 代码没有遗留 V3 类型、V6 API 名称或本次涉及的弃用调用。
- [ ] 在 PR 中记录无法自动化验证的 provider 行为和所用模型版本。

## 完成标准

- [x] 所有工作区能够从干净依赖状态构建和测试。
- [ ] 五类 provider 的基本文本生成和 Tool Calling 均通过验证。
- [x] Maka 的权限、Sandbox、动态工具、compact、retry 和持久化语义没有自动化测试回归。
- [x] usage/cost 在单步、多步和 retry 场景下均有可解释且不重复的结果。
- [x] SDK-facing 代码中不再依赖 V3 contract 或 AI SDK 6 的弃用 API。
