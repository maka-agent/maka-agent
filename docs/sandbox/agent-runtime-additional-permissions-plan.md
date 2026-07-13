# Agent Runtime Additional Permissions Implementation Plan

本文档把 Maka 的 single-command additional permissions 设计拆成可执行、可测试、可独立审查的正式实施步骤。

状态：已完成代码实现、macOS 真实 Seatbelt smoke 和各 workspace 全量验证。根级聚合 `npm test` 仍受 desktop OpenGateway SSE 既有并发用例的间歇性卡住影响；该用例单独执行和 desktop 全量执行均通过。

实现基线：`feat/runtime-permission-profile-sandbox` 已完成 Phase 1-9。macOS managed runtime 已具备 active `PermissionProfile`、`PermissionEngine`、foreground/background Bash、one-shot filesystem worker、`SandboxManager`、macOS Seatbelt、capability gate 和 diagnostics。

关联文档：

- `docs/sandbox/agent-runtime-codex-sandbox-alignment.md`
- `docs/sandbox/agent-runtime-codex-sandbox-todo.md`
- `docs/sandbox/agent-runtime-codex-sandbox-status.md`
- `docs/sandbox/agent-runtime-codex-sandbox-phase-7-8-plan.md`
- `docs/sandbox/agent-runtime-codex-sandbox-phase-9-plan.md`

## 实施结果

- core 已实现受限的 `AdditionalPermissionProfile`、exact/subtree matcher、固定 limits、deterministic merge 和 stable hash。
- runtime 已实现路径规范化与二次校验、immutable proposal、allow-once/deny 审批以及绑定完整 tool intent 的一次性 grant。
- Read / Write / Edit / Glob / Grep 会从结构化参数规划最小权限；foreground/background Bash 使用显式 `sandbox_permissions` 声明，不猜测 shell command 中的路径。
- `SandboxManager`、filesystem worker 和 macOS Seatbelt 共用 base + additional 合成的 effective profile，支持 workspace 外路径、protected metadata exception 和单次 network enabled。
- desktop 和 CLI 复用现有审批界面，只提供“允许这一次”；child grant 不继承。headless/external 当前显式声明不支持 host-normalized additional permissions，并在审批或执行前 fail closed。
- RunTrace 和 durable shell summary 只保留 hash/count/risk 等安全投影，不持久化原始 path、argv、env 或可复用 grant。

仍不在本阶段范围内的能力：unsandboxed retry、永久规则、域名/方法/端口级网络策略、Linux backend 和 Windows sandbox。

## 1. 目标

为 Maka 增加正式可用的一次性额外权限系统：用户可以只为当前一个工具调用授予超出 active `PermissionProfile` 的最小权限，而不修改 session `permissionMode`，也不把整个 session 切换到 `danger-full-access`。

目标能力：

- 为单次 Read / Write / Edit 授予指定文件的 read/write。
- 为单次 Glob / Grep 授予指定目录树的 read。
- 为单次 foreground/background Bash 授予模型明确声明的文件路径 read/write。
- 为单次 foreground/background Bash 启用网络。
- 允许用户明确授权写入 workspace 外路径。
- 允许用户明确授权写入 `.git`、`.agents`、`.codex` 中的具体路径。
- 同一份 effective profile 同时约束 runtime matcher、filesystem worker 和 macOS Seatbelt。
- additional permission 只能使用一次，不持久化为 session 权限，不跨 tool/turn/session/child 复用。
- desktop、CLI、child、headless/intervention 和 external executor 有明确、可测试的行为。

## 2. 非目标

本阶段不实现：

- unsandboxed retry 或 `SandboxablePreference.forbid` 的审批编排。
- 域名级、HTTP method 级或端口级网络授权。
- managed network proxy、MITM CA 或 network env rewriting。
- 永久规则、prefix rule、session-level additional permissions。
- `rememberForTurn` additional permission。
- 任意 macOS entitlement、TCC、root、sudo 或设备权限提升。
- Linux backend 或 Windows sandbox。
- worktree、diff/write-back 或 apply patch UI。

本版本按正式可用标准实现上述目标。列出的非目标属于不同 enforcement 系统，不能在没有可靠底层约束时伪装成已支持。当前网络增量权限的准确语义固定为“仅当前 Bash 调用允许直接访问任意网络”。

## 3. 固定原则

- additional permissions 只能增加具体能力，模型不能提交完整 `PermissionProfile`。
- renderer 只能批准或拒绝 runtime 已规范化的申请，不能修改 grant 内容。
- 审批必须发生在扩权执行前；拒绝、超时、取消或协议异常都 fail closed。
- active profile 是基础事实，additional permissions 只生成当前调用的 effective profile。
- base profile、session header 和用户 settings 不因一次性 grant 发生变化。
- explicit hard deny 永远优先于 additional allow。
- protected metadata deny-write 是默认保护，可以被用户对具体路径的一次性 write grant 覆盖。
- 路径申请必须在 runtime 中规范化，并在执行前重新校验。
- 文件工具不要求模型重复描述可由工具参数确定的路径权限。
- Bash command string 不做 shell 语义解析；Bash 必须显式声明所需 additional permissions。
- `ask` 与 additional permission 合并成一次审批；`execute` 仍必须为 additional permission 单独审批。
- `bypass` 已经 unrestricted，不创建无意义的 additional permission request。
- `explore` 不允许 write 或 network additional permission；额外 read 也保持 fail closed，避免改变只读研究边界。
- child 不继承父调用 grant；每个 grant 必须绑定实际 child run/tool intent。
- diagnostics 不是授权输入；执行层不能依赖 model context 或 RunTrace 决定权限。

## 4. 权限语义

### 4.1 AdditionalPermissionProfile

在 core 增加平台无关的增量权限类型：

```ts
export interface AdditionalPermissionProfile {
  readonly fileSystem?: {
    readonly entries: readonly AdditionalFileSystemPermission[];
  };
  readonly network?: {
    readonly enabled: true;
  };
}

export interface AdditionalFileSystemPermission {
  readonly path: string;
  readonly access: 'read' | 'write';
  readonly scope: 'exact' | 'subtree';
}
```

约束：

- `path` 进入 core matcher 前必须是 runtime 规范化后的绝对路径。
- `exact` 只匹配目标路径；`subtree` 匹配目录本身及后代。
- `write` 同时提供读取目标所需的能力，与现有 `write -> readable` 语义一致。
- profile 至少包含一条 filesystem entry 或 `network.enabled = true`。
- filesystem entry 数量、路径长度和总序列化大小设置固定上限。
- 重复 entry 在规范化阶段去重；被更宽 subtree 覆盖的同 access entry 可收敛。
- 不接受 special path、glob、`deny`、`unrestricted`、protected metadata policy 或自定义 backend 字段。

### 4.2 Path match contract

现有 `FileSystemSandboxEntry` 的 path 语义需要显式支持 exact/subtree。建议增加：

```ts
export type FileSystemPathMatch = 'exact' | 'subtree';
```

普通 profile factory 生成的 path/special roots 保持 `subtree`；additional file grant 可选择 `exact`。matcher 与 Seatbelt policy generator 必须共享同一语义测试矩阵。

### 4.3 合并优先级

effective profile 的判断顺序固定为：

```text
explicit hard deny
  > approved additional allow
  > protected metadata default deny-write
  > base profile allow
  > default deny
```

合并规则：

- base `restricted` 保持 restricted，只追加获批 entry。
- base network `restricted` 在本次获批后生成 effective `enabled`。
- base `unrestricted` 不需要 additional profile，planner 返回 no-op。
- base `disabled` 不创建 Maka-managed grant。
- base `external` 只有在 external executor 明确声明支持 additional permissions 时才透传，否则审批前 block。
- additional permission 不得覆盖 explicit `deny` entry。
- additional write 命中 protected metadata 时，effective policy 只为获批 exact/subtree 增加 write exception，不移除其他 metadata 保护。
- effective profile 保留 base profile name，并附带独立、不可持久化的 applied-grant metadata；不能把 session profile 重命名为 `danger-full-access`。

## 5. 路径规范化与 TOCTOU 防护

路径处理只在 runtime 层执行，core 保持纯逻辑。

规范化流程：

1. 校验输入类型、长度、NUL 和平台路径格式。
2. 相对路径基于 canonical session cwd 解析。
3. 执行 lexical normalization，拒绝无法形成绝对路径的输入。
4. 已存在目标使用 `realpath`。
5. 不存在目标向上查找最近的已存在父目录，对父目录 realpath 后再拼回剩余 segments。
6. 记录 display path 与 enforcement path；审批 UI 优先展示用户可理解的 display path，同时明确 symlink 的真实目标。
7. 生成 `intentHash` 前使用 enforcement path 和规范化 permission entry。
8. 获批后、spawn/worker request 前再次执行相同解析。
9. 第二次解析结果、目标类型或 symlink 指向发生变化时，使 grant 失效并返回结构化错误。

附加约束：

- `exact` 文件 grant 不能因为父目录相同而扩大成目录 subtree。
- directory subtree grant 必须确认目标是目录；不存在目录需要由明确的 write intent 表达，不能从 Read/Glob 自动推断创建。
- file lock key、profile precheck、worker request 和 Seatbelt 参数使用同一 enforcement path。
- 路径发生竞态时不自动重新申请或静默扩大权限。

## 6. Permission Request 与一次性 Grant

### 6.1 请求协议

把 PermissionRequest 改为有判别字段的 union：

```ts
export type PermissionRequest =
  | ToolPermissionRequest
  | AdditionalPermissionRequest;
```

`AdditionalPermissionRequest` 至少包含：

- `kind: 'additional_permissions'`。
- `requestId`、`toolUseId`、`toolName`、`category`。
- normalized additional profile。
- canonical cwd 的安全展示值。
- justification。
- `intentHash` 与 `permissionsHash`。
- `outsideWorkspace`、`protectedMetadata`、`networkEnabled` 风险摘要。
- `alsoApprovesToolExecution`，用于 ask 模式合并普通审批。
- `availableDecisions: ['allow_once', 'deny']`。

PermissionResponse 仍只携带 request id 和 decision。renderer 不回传 permissions；runtime 从 parked request 中取回 immutable proposal。

### 6.2 合并普通审批

PermissionEngine 的 evaluate 顺序：

1. 先运行现有 mode x category 与 capability policy。
2. policy block 时保持 block，additional permission 不能绕过模式级禁令。
3. 没有 additional proposal 时保持现有 allow/prompt 行为。
4. ask 模式原本需要 prompt，且存在 additional proposal 时，生成一个 combined request。
5. execute 模式原本 allow，但存在 additional proposal时，生成 additional request。
6. bypass 模式且 base profile 已允许时，不产生 additional request。
7. explore 的 read/write/network additional proposal按固定策略 block。

现有 `rememberForTurn` 只适用于普通 ToolPermissionRequest。对 AdditionalPermissionRequest 携带 `rememberForTurn` 的响应必须拒绝为协议错误。

### 6.3 Grant 生命周期

```ts
export interface AdditionalPermissionGrant {
  readonly grantId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly toolUseId: string;
  readonly toolName: string;
  readonly intentHash: string;
  readonly permissionsHash: string;
  readonly profile: AdditionalPermissionProfile;
  readonly issuedAt: number;
  readonly expiresAt: number;
}
```

安全规则：

- grant 由 PermissionEngine 在 allow 决策后创建。
- grant 与 parked request、session、turn、toolUseId、toolName、intent hash 绑定。
- grant 只存在于主进程/runtime 内存，不进入 renderer state 或模型上下文。
- grant 在对应 implementation 开始消费时原子地标记 consumed。
- 同一个 grant 的第二次消费返回 `grant_already_consumed`。
- permission timeout、turn abort、session stop、runtime restart 或 intent mismatch 立即失效。
- 并发工具调用各自审批，不合并 grant，不因相同 path 自动批准其他调用。
- durable ledger 只记录决定与安全摘要，不保存可复用授权对象。

## 7. Tool Additional Permission Planner

在 MakaTool contract 增加 runtime-owned planner hook。planner 只提出申请，不执行 I/O side effect：

```ts
planAdditionalPermissions?(args, context):
  Promise<AdditionalPermissionPlanResult>;
```

结果为：

- `not_required`：base profile 已允许。
- `request`：返回规范化 proposal。
- `block`：权限无法安全表达、模式不允许或 executor 不支持。

文件工具 planner：

| Tool | operation | permission |
| --- | --- | --- |
| Read | 读取一个文件 | `read + exact` |
| Write | 创建/覆盖一个文件 | `write + exact` |
| Edit | 读取并修改一个文件 | `write + exact` |
| Glob | 枚举搜索根 | `read + subtree` |
| Grep | 搜索文件内容 | `read + subtree` |

文件工具 planner 使用 permission-aware file operation service 提供的 canonical path resolver 和 base profile matcher，不在 ToolRuntime 中按工具名解析任意 args。

Bash planner：

- 不解析 shell command string。
- Bash schema 增加 `sandbox_permissions: use_default | with_additional_permissions`。
- `with_additional_permissions` 必须同时提供非空 additional profile 和 justification。
- `use_default` 不得附带 additional profile。
- foreground 与 background Bash 复用同一个 validator/normalizer。
- Bash 声明的相对 path 同样基于 canonical cwd 解析。
- network grant 只允许 Bash；文件工具携带 network grant 必须 block。

## 8. 执行上下文与 Effective Profile

新增显式 per-call context：

```ts
export interface ToolExecutionPermissionContext {
  readonly additionalGrant?: AdditionalPermissionGrant;
}
```

传播链：

```text
ToolRuntime
  -> MakaToolContext
  -> Workspace command/file operation input
  -> AdditionalPermissionGrant validator/consumer
  -> effectivePermissionProfile()
  -> ProfileEnforcedFileOperations / SandboxManager
  -> macOS Seatbelt / filesystem worker
```

禁止使用 process-global mutable state 或 `AsyncLocalStorage` 隐式携带 grant。

`SandboxTransformRequest` 增加可选 additional profile；`SandboxManager.transform()` 负责生成 effective profile，再交给 backend。`SandboxManager` 仍不负责 UI、审批、grant 生命周期或 retry。

`SandboxExecRequest.effectiveProfile` 必须返回真实合并结果，供 diagnostics 和 contract tests 验证，不能继续指向 base profile。

## 9. macOS Seatbelt Enforcement

MacosSeatbeltBackend 需要支持：

- path entry 的 `literal`/exact 与 `subpath`/subtree 生成。
- additional readable/writable roots 使用独立参数传入 `sandbox-exec`，不插值到 policy text。
- explicit denied roots 对所有 base/additional allow clause 保持优先。
- protected metadata default exclusion继续作用于 workspace root allow clause。
- 获批 metadata exact/subtree 通过独立 allow clause放行，不删除其他 metadata exclusions。
- network additional permission 只在 effective profile 中生成 `(allow network*)`。
- base restricted + filesystem grants 仍然必须选择 `macos-seatbelt`，不能因为 network enabled 或 workspace 外 path 选择 `none`。
- transform/policy 参数不记录到普通 telemetry 或 renderer。

必须增加真实 macOS smoke：

- exact outside file grant 成功，但 sibling file 失败。
- subtree outside directory grant 成功，但相邻目录失败。
- exact `.git/config` grant 成功，但 `.git/HEAD` 仍失败。
- `.git` subtree grant 成功仅在用户明确申请整个目录时成立。
- explicit deny 覆盖 additional allow。
- one-command network enabled 对受控 loopback fixture 成功，下一条默认命令恢复 restricted；测试不依赖真实外网。

## 10. 文件工具执行

ProfileEnforcedFileOperations 与 filesystem worker 都接收 effective profile：

- precheck 使用 effective profile，不能在 worker 前仍按 base profile拒绝获批操作。
- worker request 包含 immutable effective profile 与 permissions hash。
- worker protocol validator限制 profile shape、entry 数量和 payload 大小。
- worker 在 sandbox 内再次执行 path containment 和 operation validation。
- symlink、realpath、write lock、Edit matcher 和 bounded output 行为保持不变。
- worker 不获得 host secrets、shell、网络或任意 executable。
- grant 消费后 worker 启动失败不允许把 grant用于新的模型工具调用；同一 in-flight operation 的受控内部 launch retry 需要独立定义，默认不重试。

## 11. Foreground 与 Background Bash

foreground Bash：

- schema 校验 additional request。
- 审批完成后把 grant 传给 `WorkspaceExecutor.exec()`。
- executor 基于 effective profile 生成 wrapper argv。
- terminal result shape、streaming、timeout、abort 和 process group termination 不变。

background Bash：

- 在 spawn 前完成审批和 grant 消费。
- ShellRun durable record 保存 permissions hash 和安全摘要，不保存 grant。
- ShellRun 从启动开始使用固定 effective profile，后续 observe/stop 不重新申请权限。
- quick completion 和 detached running 使用同一 spawn request。
- app 重启后不能用 durable ShellRun record恢复或复制 grant；已运行的 OS process 生命周期按现有 orphan/recovery 规则处理。

## 12. Runtime Surfaces

desktop：

- 复用现有 permission dialog。
- 增加“单次额外权限”标题、路径列表、exact/subtree、read/write、network 和风险提示。
- protected metadata 与 workspace 外路径必须有明显文本提示。
- 只提供“允许这一次”和“拒绝”，不增加 settings page。

CLI：

- 使用现有 permission prompt 通道展示相同 canonical request。
- 终端输出不能省略 scope、network 或 protected metadata 风险。

child agent：

- child planner 使用 child header/profile/cwd。
- desktop local child 可以经明确的 parent approval broker展示 child identity，但 grant 绑定 child run/toolUseId。
- child 不继承 parent remembered permissions 或 additional grant。
- 没有 approval broker 时 fail closed。

headless/intervention：

- desktop intervention mode 投影为 `needs_approval`，保留 canonical proposal hash。
- non-interactive headless 不自动批准，返回 policy-denied/needs-approval taxonomy。
- resume 时重新校验 task、attempt、tool intent 和 path；旧 grant 不复用。

external executor：

- capability contract 增加 `supportsAdditionalPermissions`。
- 支持时传递规范化 profile和 hash，由 adapter 返回已 enforce 的事实。
- 不支持时在审批前 block，不能批准后退回 host execution。

## 13. Diagnostics、审计与错误

RunTrace 增加：

- `additional_permission_requested`
- `additional_permission_granted`
- `additional_permission_denied`
- `additional_permission_applied`
- `additional_permission_failed`

安全投影只包含：

- tool name、operation、entry count。
- exact/subtree 和 read/write 计数。
- outside workspace / protected metadata / network boolean。
- profile name、permissions hash、failure reason。

不包含：

- 原始 path、command、argv、env、文件内容、policy text、grant id 或 credential。

结构化错误至少包括：

- `invalid_additional_permissions`
- `additional_permissions_not_supported`
- `additional_permissions_disallowed_by_mode`
- `additional_permissions_conflict_with_deny`
- `additional_permission_denied`
- `additional_permission_timeout`
- `grant_expired`
- `grant_already_consumed`
- `grant_intent_mismatch`
- `grant_path_changed`
- `effective_profile_invalid`

所有错误必须标注 domain、stage、reason、recoverable，并经过现有 sandbox safe serializer。

## 14. 测试矩阵

### 14.1 Core

- validator接受最小合法 profile，拒绝空、超限、special、deny 和 malformed entry。
- exact/subtree matcher边界。
- write implies read。
- hard deny优先。
- protected metadata exact/subtree exception。
- network restricted -> effective enabled，但 base profile 不变。
- merge确定性、去重和 hash稳定性。

### 14.2 PermissionEngine

- ask 普通审批与 additional审批合并。
- execute additional仍 prompt。
- bypass no-op。
- explore block。
- allow生成单次 grant；deny/timeout/abort不生成。
- rememberForTurn 对 additional响应无效并报协议错误。
- grant无法跨 toolUseId、turn、session或 intent复用。
- 并发请求互不授权。

### 14.3 Runtime/executor

- foreground/background Bash传递同一 effective profile。
- file planner生成最小权限。
- precheck、worker和Seatbelt消费相同权限。
- external unsupported fail closed。
- capability/context/transform/launch failure不降级。
- timeout、abort、streaming、bounded tail和process tree行为不回退。

### 14.4 macOS smoke

- workspace外 exact/subtree read/write。
- protected metadata exact/subtree。
- symlink target展示与 enforcement一致。
- path approval后 symlink变化被拒绝。
- sibling/parent路径不因 exact grant泄漏。
- single-command network enabled，下一条恢复 restricted。
- grant消费一次后不能复用。

### 14.5 Surface contracts

- desktop/CLI展示 canonical permission和风险。
- renderer无法篡改 profile。
- child identity与grant绑定。
- headless无审批通道时fail closed。
- RunTrace无原始路径、argv、env和grant secret。

## 15. Commit 计划

### Commit 1: Core additional permission model

Commit：`feat(core): add additional permission contracts`

- 新增 AdditionalPermissionProfile、entry、scope、limits和validator。
- 导出稳定类型。
- 增加core contract tests。

### Commit 2: Effective profile merge semantics

Commit：`feat(core): merge per-call permission profiles`

- exact/subtree matcher。
- hard deny与protected metadata exception优先级。
- effective profile builder、去重和hash。

### Commit 3: Runtime path normalization

Commit：`feat(runtime): normalize additional permission paths`

- canonical cwd、existing/missing target resolver、symlink展示与执行路径。
- 二次校验和结构化错误。

### Commit 4: Permission protocol and one-shot grants

Commit：`feat(runtime): add one-shot permission grants`

- PermissionRequest union。
- PermissionEngine combined approval。
- grant生命周期、绑定、消费和timeout/abort清理。

### Commit 5: SandboxManager effective profile

Commit：`feat(runtime): apply additional permissions in sandbox manager`

- transform接收additional profile。
- effectiveProfile成为执行权威。
- external capability/fail-closed contract。

### Commit 6: macOS Seatbelt exact and exception policy

Commit：`feat(runtime): enforce additional permissions with seatbelt`

- exact/subtree policy clause。
- metadata exception、deny优先和network enable。
- contract与macOS smoke tests。

### Commit 7: File tool permission planner

Commit：`feat(runtime): plan file tool additional permissions`

- Read/Write/Edit/Glob/Grep最小权限规划。
- permission-aware operation接口和precheck接线。

### Commit 8: Filesystem worker effective profile

Commit：`feat(runtime): enforce one-shot grants in filesystem worker`

- worker protocol、effective profile、grant hash和operation validation。
- symlink、lock、Edit regression tests。

### Commit 9: Foreground Bash additional permissions

Commit：`feat(runtime): support additional permissions for foreground bash`

- Bash schema、validator、approval和executor传播。
- terminal行为回归测试。

### Commit 10: Background Bash additional permissions

Commit：`feat(runtime): support additional permissions for background bash`

- pre-spawn approval、ShellRun摘要和固定effective profile。
- quick/detached/recovery contract tests。

### Commit 11: Desktop and CLI approval surfaces

Commit：`feat(app): present one-shot permission approvals`

- 复用现有dialog和terminal prompt。
- path/scope/network/metadata风险copy与IPC校验。

### Commit 12: Child, headless and external wiring

Commit：`feat(runtime): wire additional permissions across runtimes`

- child approval broker绑定。
- headless intervention/fail-closed。
- external capability contract。

### Commit 13: Diagnostics and audit projection

Commit：`feat(runtime): trace additional permission decisions`

- RunTrace事件、安全serializer和inspect摘要。
- storage round-trip和无敏感字段测试。

### Commit 14: Final verification and documentation

Commit：`docs(runtime): complete additional permissions phase`

- todo/status勾选与实现结果。
- 全仓库typecheck/test/build。
- 完整macOS手动smoke记录。

## 16. 验收标准

以下条件全部满足后，Phase 9.5 才算完成：

1. additional permission只能由runtime规范化并由用户批准。
2. ask不产生重复审批，execute不会静默扩权。
3. grant单次、短期、不可复用且绑定完整tool intent。
4. matcher、filesystem worker和Seatbelt使用同一effective profile。
5. workspace外和protected metadata可以按exact/subtree精确授权。
6. sibling、parent、symlink和并发调用不能扩大grant。
7. foreground/background Bash和全部文件工具接入。
8. desktop、CLI、child、headless和external行为明确且fail closed。
9. per-command network enable不会污染下一条命令或session profile。
10. RunTrace和telemetry不泄露path、argv、env、内容或可复用grant。
11. macOS真实smoke、全仓库test、typecheck和build通过。
12. 不引入unsandboxed fallback、host execution fallback或域名级网络能力误报。
