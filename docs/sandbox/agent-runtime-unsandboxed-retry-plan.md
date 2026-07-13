# Codex-style Auto Review 与 Unsandboxed Retry 实施方案

> 实施状态（2026-07-13）：已完成。全仓库 `npm test`、`npm run typecheck`、`npm run build` 与 macOS Seatbelt exact approved retry smoke 均已通过。

## 1. 目标

在 Maka 现有 PermissionMode、PermissionEngine、PermissionProfile、additional permissions 和 macOS Seatbelt 链路上补齐：

- 审批请求与审批执行者分离。
- `ask` 模式继续由用户审批。
- `execute` 模式由受限、fail-closed 的 AutoReviewer 审批。
- Bash 可以显式声明 `require_escalated`。
- 审批通过后，只为当前精确工具调用发放一次性 unsandboxed grant。
- foreground 和 background Bash 使用同一套审批、grant 和 sandbox bypass 规则。
- AutoReview 拒绝、超时、异常或输出无效时绝不回退到 host execution。

本方案不把 sandbox denial 后的自动 host retry 作为默认行为。对齐 Codex 当前 `OnRequest + AutoReview` 的方式是：第一次 sandboxed execution 失败后，模型收到可恢复的 denial；模型使用相同命令和 `require_escalated` 显式发起新调用；runtime 审批通过后执行该调用。

## 2. 非目标

- 不实现永久 prefix rule 或跨 turn/session 的 escalation grant。
- 不允许模型直接选择 `SandboxablePreference.forbid`。
- 不因普通 non-zero exit、timeout 或 abort 自动推断并放宽权限。
- 不为文件工具提供完全 unsandboxed execution；Read/Write/Edit/Glob/Grep 继续使用 scoped additional permissions。
- 不静默从 AutoReviewer 回退到人工审批。
- 不新增大型 settings 页面或独立权限管理 UI。
- 本阶段仍不实现 Linux/Windows sandbox backend。

## 3. Codex 对齐点

Codex 将以下三个维度分开：

1. Permission profile：进程默认能访问什么。
2. Approval policy：哪些操作需要审批。
3. Approvals reviewer：审批交给用户还是自动审核器。

Maka 保留现有 PermissionMode 作为用户入口，并在 runtime 中编译出 reviewer：

| PermissionMode | PermissionProfile | Reviewer | Sandbox escalation |
| --- | --- | --- | --- |
| `explore` | read-only | user（仅保留既有非提权 prompt） | block |
| `ask` | workspace-write | user | 允许，必须人工审批 |
| `execute` | workspace-write | auto_review | 允许，必须自动审核 |
| `bypass` | danger-full-access | 无 | 不需要 |

`execute` 不是无条件允许。现有 policy matrix 中仍需 prompt 的 destructive、git-destructive、privileged、browser 和 additional permissions 请求也路由给 AutoReviewer。

## 4. 目标架构

```text
PermissionMode
  -> active profile + approval routing policy
  -> PermissionEngine creates exact request
  -> ApprovalCoordinator
       -> UserApprovalReviewer -> existing UI response
       -> AutoApprovalReviewer -> no-tool structured model review
  -> PermissionEngine records decision
  -> one-shot grant
       -> AdditionalPermissionGrant
       -> SandboxEscalationGrant
  -> WorkspaceExecutor / ShellRunProcessManager
  -> SandboxManager.transform()
       -> normal: preference=auto
       -> approved escalation: preference=forbid
```

SandboxManager 仍只负责 sandbox 选择和命令转换。它不判断谁批准了命令，也不自行生成或信任 escalation。

## 5. 数据模型

### 5.1 Reviewer

```ts
type ApprovalsReviewer = 'user' | 'auto_review';

interface ActiveApprovalRoutingPolicy {
  reviewer: ApprovalsReviewer;
  sandboxEscalationAllowed: boolean;
}
```

第一版从 PermissionMode 编译，不增加可见 session 设置。类型与编译边界保持独立，后续可在不修改 PermissionProfile 的情况下增加单独设置。

### 5.2 Sandbox escalation request

PermissionRequest union 增加：

```ts
interface SandboxEscalationRequest {
  kind: 'sandbox_escalation';
  requestId: string;
  toolUseId: string;
  toolName: 'Bash';
  category: ToolCategory;
  reason: 'sandbox_escalation';
  cwd: string;
  command: string;
  justification: string;
  intentHash: string;
  commandHash: string;
  trigger: 'proactive' | 'sandbox_denial';
  risk: SandboxEscalationRiskSummary;
  alsoApprovesToolExecution: boolean;
  availableDecisions: readonly ['allow_once', 'deny'];
}
```

request 中的 command 仅用于当前审批和经过现有 redaction 的 UI。durable diagnostics 只记录 hash、风险标记、decision source 和失败阶段，不记录原始 argv/env。

### 5.3 One-shot grant

```ts
interface SandboxEscalationGrant {
  grantId: string;
  sessionId: string;
  turnId: string;
  toolUseId: string;
  toolName: 'Bash';
  intentHash: string;
  commandHash: string;
  cwd: string;
  issuedAt: number;
  expiresAt: number;
}
```

grant 绑定精确 session、turn、tool call、tool name、command 和 cwd，只能消费一次并具有短 TTL。模型、renderer、插件和 tool args 都不能直接构造 grant。

### 5.4 Decision metadata

Permission decision 增加可选字段：

```ts
interface ApprovalDecisionMetadata {
  reviewer: 'user' | 'auto_review';
  rationale?: string;
  riskLevel?: 'low' | 'medium' | 'high' | 'critical';
}
```

所有新字段在 IPC/main boundary 做 allowlist normalization。rationale 在持久化和展示前经过长度限制与 secret redaction。

## 6. ApprovalCoordinator

PermissionEngine 继续拥有 requestId、parked request、turn remembered state 和 grant store。ApprovalCoordinator 负责把 `prompt` 分发给正确 reviewer：

- `user`：发送现有 `permission_request` event，等待 `respondToPermission()`。
- `auto_review`：不发送可交互 permission dialog；调用 AutoApprovalReviewer，将结果以受信任的 runtime response 写回 PermissionEngine。
- reviewer 缺失、调用失败或超时：deny/fail closed。

ToolRuntime 只处理一个统一的审批结果，不再假设结果一定来自用户。

## 7. AutoApprovalReviewer

AutoReviewer 是专用、无工具、单次 structured-output 模型调用，不复用普通 ToolRuntime，也不能调用 Bash、文件工具、MCP、插件或 child agent。

输入只包含：

- 当前用户意图的受限摘要。
- tool name、脱敏参数和 cwd。
- active profile / mode 摘要。
- additional permissions 或 sandbox escalation 的精确能力。
- sandbox denial 的结构化信息（如果存在）。
- 风险标记和用户是否有明确授权。

不包含完整 env、密钥、无关文件内容或无限历史。tool args 和 workspace 文本按不可信数据处理，不能覆盖 reviewer system policy。

输出 schema：

```ts
{
  outcome: 'allow' | 'deny';
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  rationale: string;
}
```

默认使用当前会话模型，保留 optional reviewer model override。调用设置固定超时；只对传输失败或无效结构做有限重试。所有终态失败均 deny。

## 8. Bash escalation contract

Bash `sandbox_permissions` 扩展为互斥 union：

```ts
{ mode: 'use_default' }
{ mode: 'with_additional_permissions', ... }
{ mode: 'require_escalated', justification: string }
```

规则：

- `explore`：拒绝 `require_escalated`。
- `ask`：生成用户审批请求。
- `execute`：生成 AutoReview 请求。
- `bypass`：已经 unrestricted，不生成无意义 grant。
- `with_additional_permissions` 与 `require_escalated` 不能同时出现。
- 能用 scoped additional permissions 表达时，应优先使用 additional permissions。

审批通过后，ToolRuntime 消费 SandboxEscalationGrant，并通过 trusted `permissionContext` 传给 foreground/background command executor。只有持有有效 grant 的 executor 才把 preference 改为 `forbid`。

## 9. Denial 分类

区分：

- transform/setup failure：missing context、unsupported platform、backend unavailable、invalid profile。不可作为 unsandboxed retry 的自动理由。
- process sandbox denial：命令确实在 active platform sandbox 中运行，并出现 backend-specific denial evidence。
- ordinary process failure：普通 non-zero exit、timeout、abort、signal。不得标记为 sandbox escalation。

macOS 第一版使用受限 classifier 识别 Seatbelt 常见 denial。classifier 只产生 `likely_sandbox_denial` 和模型提示，不批准、不重试、不改变 sandbox。

## 10. AutoReview 拒绝与人工覆盖

AutoReview deny 不自动弹出普通审批框，也不自动重试。runtime 记录 exact denied action 和 rationale，并返回可恢复工具错误。

后续最小人工覆盖入口只允许批准一条近期、精确匹配的 denial 重试一次。覆盖必须绑定原 request hash，不能变成 session-level rule；重试仍重新验证 command/cwd 和 grant TTL。

## 11. Foreground、background 与文件工具

- Foreground Bash：ToolRuntime 审批完成后，在 `WorkspaceExecutor.exec()` 前消费 grant。
- Background Bash：在 spawn 前完成审批和 grant 消费；运行中的 background process 不接受后置 escalation。
- 文件工具：不使用 unsandboxed grant，继续经过 profile enforcement、filesystem worker 和 scoped additional permission。
- External/headless executor：没有受信任 escalation protocol 时显式 unsupported 并 fail closed。

## 12. Diagnostics 与持久化

新增或扩展 RunTrace 事件：

- `approval_routed`
- `auto_review_started`
- `auto_review_decided`
- `auto_review_failed`
- `sandbox_escalation_requested`
- `sandbox_escalation_granted`
- `sandbox_escalation_denied`
- `sandbox_escalation_applied`
- `sandbox_denial_detected`

durable projection 不记录完整 command、argv、env、路径 grant 或 reviewer prompt，只记录 request/intent hash、reviewer、risk level、decision、backend 和阶段。

## 13. 测试矩阵

### Core / model

- request/decision union validation。
- mode 到 reviewer 的固定映射。
- escalation request hash 和 immutable grant。
- IPC normalization 拒绝伪造 reviewer metadata。

### PermissionEngine / coordinator

- ask 路由到 UI 并保持现有 parked behavior。
- execute 路由到 AutoReviewer，不发交互 permission event。
- AutoReview allow/deny/timeout/invalid output。
- one-shot、TTL、intent mismatch、cwd/command mismatch、double consume。
- additional permissions 与普通 tool approval 合并后只审核一次。

### Command execution

- foreground approved escalation 使用 `preference=forbid`。
- foreground denied escalation 不调用 runner。
- background approved escalation 在 spawn 前消费 grant。
- external executor unsupported 时 fail closed。
- bypass 不创建 escalation request。
- explore block。

### macOS smoke

- 默认 workspace-write 下 workspace 外写入失败。
- 相同命令以 `require_escalated` 发起，user/auto reviewer allow 后成功。
- reviewer deny 后目标文件不存在。
- timeout/abort/ordinary exit 不能触发自动 host execution。
- additional permissions 仍保持 sandbox，并只开放声明的路径或 network 能力。

## 14. 实施顺序

1. reviewer、request、decision 和 active routing policy 类型。
2. ApprovalCoordinator 与 UserApprovalReviewer 兼容接线。
3. AutoApprovalReviewer 及 fail-closed structured review。
4. `require_escalated` proposal、grant、hash 和 PermissionEngine store。
5. foreground/background executor 接线。
6. macOS denial classifier、tool guidance 和 RunTrace。
7. IPC/read model/UI 最小兼容更新。
8. 单元测试、集成测试、macOS smoke、typecheck 和 build。

## 15. 实际实现范围

已实现：

- mode -> reviewer routing、ApprovalCoordinator 与 AI SDK no-tools AutoReviewer。
- `require_escalated` schema、exact proposal/hash、one-shot grant、TTL 和 replay/mismatch 防护。
- foreground/background Bash trusted permission context 与 `preference=forbid` 接线。
- macOS denial classifier、terminal/shell-run recovery metadata 和 explicit retry prompt contract。
- RuntimeEvent、RunTrace、desktop/CLI allow-once UI 与 renderer IPC trusted-field guard。
- 单元、集成和 macOS exact approved retry smoke。

明确未实现：

- runtime 自动重放第一次失败的命令。
- AutoReview deny 后的人工 override。
- 永久/跨 turn prefix rules。
- external/remote executor escalation protocol。
- Linux/Windows sandbox backend 和 managed domain-level network policy。

## 16. E2E 回归修复（2026-07-13）

实际桌面端 E2E 暴露并修复了三处边界问题：

- AutoReviewer 返回 deny 或发生终态失败后，runtime 会按 `turnId + exact command/cwd hash` 记录本轮拒绝。同一轮中即使模型换用新的 `toolCallId` 重提完全相同的 escalation，也不会再次调用 reviewer；只有新的用户消息开始下一轮后才可重新申请。该限制不影响第一次 Seatbelt denial 后发起一次显式 `require_escalated` 请求。
- macOS 会把 `/tmp` 映射为 `/private/tmp`。runtime 现在在创建 path context 时规范化 `:tmpdir` 和 `:slash_tmp`，并在 profile precheck、write lock、filesystem worker request 与 Seatbelt profile 中统一使用 enforcement path，避免同一路径因别名不同被误拒绝或使用不同写锁。
- 文件工具不再把原始 additional permission 直接当作 worker 内部授权。client 先校验原始 grant/hash，再基于 effective profile 检查规范化后的 operation path，最后只向 one-shot worker 下发当前操作需要的 exact/subtree capability。worker 仍执行 realpath containment，Seatbelt 仍是最终 OS 边界。

回归测试覆盖 AutoReview deny/failure 后的同轮精确重提、下一轮重新申请、`/tmp` canonical alias、单操作 worker capability、protected metadata 拒绝，以及真实 macOS Seatbelt 文件工具 smoke。
