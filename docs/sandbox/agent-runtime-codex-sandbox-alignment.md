# Agent Runtime Codex-Style Permission and Sandbox Alignment Draft

这份文档用于整理 Maka 从旧的 worktree/write-back sandbox 方案，切换到
Codex-style 权限管理和平台 sandbox 权限兜底方案时，需要理解的核心概念、
模块对应关系和后续工作。

当前文档是讨论草案，不是最终 implementation plan。

## 当前方向

当前不实现 worktree sandbox，也不做 diff/write-back。

新的目标是：

```text
在 Maka runtime 内建立 Codex-style 权限语义模型，
并在工具执行时用平台 sandbox 做底层权限拦截。
```

核心边界变成：

```text
PermissionProfile
  描述 agent 允许访问什么

PermissionEngine / ToolOrchestrator
  决定是否允许、提示、阻止，或要求更高权限

SandboxManager
  把权限语义转换成具体平台 sandbox 执行请求

Platform Sandbox Backend
  macOS Seatbelt / Linux bubblewrap + seccomp
  真正拦截文件系统、网络和部分进程能力
```

平台顺序：

```text
v1: macOS Seatbelt
v2: Linux bubblewrap + seccomp
out of scope: Windows
```

## workspace-write 的含义

`workspace-write` 不是 worktree。

这里的 `workspace` 指 agent 被授权访问的一组真实目录。在 Maka 第一版中，
可以先把它理解成当前 session 的 `cwd`，未来再扩展成多个
`workspace_roots`。

`workspace-write` 的含义是：

- agent 可以读 workspace 内文件。
- agent 可以写 workspace 内普通文件。
- agent 不应该写 workspace 外路径。
- agent 不应该默认写 protected metadata，例如 `.git`、`.agents`、`.codex`。
- 网络默认受限，由 network policy 决定是否允许。
- 写入会直接作用于真实 workspace，不经过 worktree 副本。

例如 session cwd 是：

```text
/Users/me/projects/maka-agent
```

那么 `workspace-write` 允许：

```text
/Users/me/projects/maka-agent/src/foo.ts
```

但不允许：

```text
/Users/me/.ssh/config
/etc/hosts
/Users/me/projects/other-repo/file.ts
```

默认也应保护：

```text
/Users/me/projects/maka-agent/.git/*
/Users/me/projects/maka-agent/.agents/*
/Users/me/projects/maka-agent/.codex/*
```

所以当前安全目标不是“所有真实文件修改都必须经 diff review”，而是：

```text
workspace-write 允许 agent 在真实 workspace 内直接修改文件；
sandbox 的职责是阻止越权访问 workspace 外部、限制网络、保护敏感 metadata。
```

## Codex 的 unsandboxed retry 是什么

Codex 有一类执行流程：

```text
先用 sandbox 跑命令
  -> 如果命令失败，并且看起来是 sandbox 权限拒绝
  -> 根据 approval policy 判断是否可以升级
  -> 可能提示用户：是否允许不用 sandbox 或用更宽权限重试
  -> 用户同意后，再跑一次更宽权限的命令
```

例如：

```bash
npm install
```

第一次在 sandbox 中运行时，可能因为网络被禁、cache 不可写或某个目录没有权限而失败。
Codex 可能判断这是 sandbox denial，然后询问用户是否允许提升权限重试。

这就是 unsandboxed retry：

```text
sandboxed attempt failed
-> retry with sandbox disabled or relaxed
```

它的价值是可用性，风险是如果边界处理不好，就会出现“看起来有 sandbox，
实际最后无 sandbox 执行”的绕过感。

Maka 第一版不做 unsandboxed retry：

```text
sandbox deny -> 直接失败并解释原因
```

后续更成熟后，再考虑 additional permissions 或 explicit escalation prompt。

## 旧方案和当前方案的区别

旧方案重点是隔离修改结果：

```text
agent 写 sandbox workspace
  -> 用户 review diff
  -> write-back 到真实 workspace
```

新方案重点是限制进程能力：

```text
agent 在真实 workspace 运行
  -> sandbox 限制它能读写哪里、能不能联网
```

| 维度 | 旧方案 | 当前方案 |
| --- | --- | --- |
| 目标 | sandbox workspace + diff/write-back | permission profile + 平台 sandbox enforcement |
| 第一安全边界 | worktree 隔离真实文件修改 | 系统级 sandbox 权限拦截 |
| 主要抽象 | `WorkspaceExecutor` / `WorkspaceExecutorFacts` | `PermissionProfile` / `SandboxManager` |
| Bash 执行 | 在 sandbox cwd 里跑 | 在真实 cwd 语义下跑，但被 sandbox 限权 |
| 文件写入 | 先写 sandbox，再人工写回 | 受 profile 控制，可写范围内直接执行 |
| 网络控制 | 旧方案未完整覆盖 | `NetworkSandboxPolicy`，后续接 managed proxy |
| 复杂度 | 很早引入 cwd 映射、diff、apply patch、UI | 先建立权限模型和平台拦截，产品交互后置 |
| Codex 对齐度 | 部分相似，但不是核心设计 | 与 Codex 主线一致 |

旧 issue 中的 worktree 和 write-back 已移出当前规划，不再作为这条 sandbox
路线的后续目标。

## Maka 当前权限管理现状

Maka 当前已经有权限管理，但它主要是 runtime / 业务层权限，不是 OS sandbox。

当前中心是：

```text
PermissionMode + ToolCategory + PermissionEngine
```

### PermissionMode

`PermissionMode` 是会话级自动化模式，目前有四档：

```text
explore
ask
execute
bypass
```

它表达的是“这个会话整体应该多保守”。

当前大致语义：

- `explore`：只读探索。允许 read / shell_safe，阻止写入和危险 shell。
- `ask`：写入和危险操作需要询问用户。
- `execute`：允许更多自动化，包括 file_write 和 shell_unsafe，但 destructive / privileged 仍提示。
- `bypass`：全部允许。

对应代码主要在：

```text
packages/core/src/permission.ts
packages/core/src/session.ts
packages/core/src/settings.ts
```

### ToolCategory

`ToolCategory` 是工具风险分类。

当前类别包括：

```text
read
web_read
file_write
fs_destructive
shell_safe
shell_unsafe
git_destructive
network_send
privileged
browser
custom_tool
subagent
```

Bash 默认是 `shell_unsafe`，然后通过 `categorizeBash(command)` 用 allowlist、
prefix 和 regex 重新分类。

例如：

```text
git status        -> shell_safe
rm file           -> fs_destructive
git reset --hard  -> git_destructive
sudo ...          -> privileged
未知命令          -> shell_unsafe
```

这套分类可以继续保留，但新方案中它只应作为审批和风险提示的输入，不能作为完整安全边界。

### PermissionEngine

`PermissionEngine` 是 Maka 当前的审批器。

当前流程：

```text
ToolRuntime
  -> PermissionEngine.evaluate()
      -> preToolUse()
      -> allow / prompt / block
  -> allowed 后执行 tool.impl()
```

如果结果是 `prompt`，runtime 会生成 permission request event，等待用户响应。
用户允许后，tool 才继续执行。用户也可以选择 remember for turn，同一 turn 内相同
scope 不再重复提示。

对应代码主要在：

```text
packages/runtime/src/tool-runtime.ts
packages/runtime/src/permission-engine.ts
packages/core/src/permission.ts
```

### 当前 policy matrix

当前核心策略是：

```text
permissionMode x tool category -> allow / prompt / block
```

关键点：

```text
explore:
  read / shell_safe allow
  file_write / shell_unsafe / destructive block

ask:
  read / shell_safe allow
  write / shell_unsafe / destructive prompt

execute:
  read / file_write / shell_unsafe allow
  fs_destructive / git_destructive / privileged prompt

bypass:
  all allow
```

当前最大的安全缺口是：

```text
execute.shell_unsafe = allow
```

如果某个会修改本地状态的 Bash 命令没有被 regex 分类成 destructive，它就可能以
`shell_unsafe` 身份自动执行。

### 当前已有的工具级保护

Maka 当前不只有 prompt，也已经有一些工具级保护。

Bash 侧：

- timeout。
- abort signal。
- bounded tail output。
- stdout / stderr streaming。
- 进程树终止。

文件工具侧：

- `Read` / `Write` / `Edit` 要求路径在 session cwd 内。
- 使用 realpath 做 symlink escape 防护。
- `Write` / `Edit` 有同文件串行锁。
- `Edit` 有精确匹配和受控 fuzzy matching。
- `Glob` / `Grep` 限制搜索根不能逃出 cwd。

这些能力应该保留并复用。

### 当前没有的内容

当前 Maka 没有这些能力：

- 没有 canonical `PermissionProfile`。
- 没有 `FileSystemSandboxPolicy` / `NetworkSandboxPolicy`。
- 没有 `SandboxManager`。
- 没有 macOS Seatbelt / Linux sandbox backend。
- Bash 被允许后直接在 host shell 中运行。
- Node 主进程内的 Read / Write / Edit 没有统一 profile enforcement。
- 没有 OS 层文件系统 / 网络权限拦截。

所以当前权限管理主要是：

```text
业务层 allow / prompt / block
+ 工具实现里的局部路径和稳定性保护
```

而不是：

```text
PermissionProfile
+ platform sandbox enforcement
```

## 当前可利用的基础

新方案不需要从零开始。当前 Maka 已有这些可复用基础：

### 可以直接保留

- `PermissionMode`：继续作为用户可理解的高层模式。
- `ToolCategory`：继续作为风险分类和审批文案输入。
- `PermissionEngine` 的 parked prompt / remember-for-turn 机制。
- `ToolRuntime` 的 tool_call / tool_result / permission_request 事件流程。
- Bash 的 streaming、timeout、abort、bounded output。
- 文件工具的 path containment、symlink 防护、write lock、Edit matcher。
- `WorkspaceExecutor` / `LocalWorkspaceExecutor` 作为工具副作用适配层。

### 需要升级

- `permissionMode` 需要编译成默认 `PermissionProfile`。
- `PermissionEngine` 需要从纯 category matrix 升级为 profile-aware / sandbox-aware。
- `ToolRuntime` 需要引入 `ToolOrchestrator` 或等价编排层。
- `shell-exec` 需要支持 argv-based runner，以便执行 sandbox-wrapped command。
- 文件工具需要基于 active profile 做 read / write / deny 检查。

### 需要新增

- `PermissionProfile`。
- `FileSystemSandboxPolicy`。
- `NetworkSandboxPolicy`。
- protected metadata 规则。
- `SandboxManager`。
- macOS Seatbelt policy generator。
- Linux sandbox backend。
- sandbox 状态进入 runtime/model context 的展示。

## 当前已完成内容如何处理

### 保留，但重新定位

`WorkspaceExecutor` / `LocalWorkspaceExecutor` 保留。

它们已经把 Bash / Read / Write / Edit / Glob / Grep 的副作用抽成了一层，
这仍然有价值。但它不再是 sandbox 主模型，而是工具执行适配层。

```text
旧定位：
  WorkspaceExecutor 是 sandbox 抽象中心

新定位：
  WorkspaceExecutor 是工具副作用执行接口
  PermissionProfile + SandboxManager 才是 sandbox 权限中心
```

`buildBuiltinTools({ executor })` 也保留。后续可以让 Bash executor 内部走
sandbox-wrapped spawn，或者让 tool impl 通过 `ToolOrchestrator` 决定执行方式。

### 保留的行为契约

这些已有能力不能回退：

- Bash streaming stdout/stderr。
- Bash timeout。
- abort signal。
- bounded tail output。
- 进程树终止。
- Read/Write/Edit 的 path containment。
- symlink escape 防护。
- Edit 的精确 / 模糊匹配语义。
- Write/Edit 同文件串行锁。

### 需要修改的内容

`WorkspaceExecutorFacts` 需要降级。

当前它表达：

```ts
isolation
writesAffectHost
writeBack
network
secrets
```

这些信息仍然有用，但不适合作为主要权限决策依据。新方案中主要决策输入应改成：

```text
active PermissionProfile
+ sandbox backend availability
+ approval policy
+ tool risk category
```

`executionFacts` 可以先保留，用于 telemetry、debug、兼容测试，但不作为长期权限模型中心。

`PermissionEngine` 需要升级。

现在它主要是：

```text
permissionMode x tool category -> allow / prompt / block
```

后续应变成：

```text
permissionMode / approval policy
+ PermissionProfile
+ sandbox enforcement availability
+ tool category
-> allow / prompt / block
```

尤其要修正：

```text
execute.shell_unsafe = allow
```

这个策略只有在 sandbox 可 enforce 时才合理。没有 sandbox 时，`shell_unsafe`
应该 prompt 或 block。

### 非目标或废弃

以下内容不做：

- WorktreeExecutor。
- diff/write-back。
- sandbox cwd 映射。
- workspace copy lifecycle。
- apply patch UI。

这些概念都来自旧的 worktree/write-back 方案。Maka 当前没有实现它们；只有继续旧
worktree 方案时才会需要：

- sandbox cwd 映射：真实 cwd 和 sandbox 副本 cwd 之间的路径映射。例如用户看到
  `/Users/me/repo`，实际命令跑在 `/tmp/maka-worktree-123/repo`，runtime 需要在
  prompt、event、artifact、diff 之间转换路径。
- workspace copy lifecycle：创建、同步、维护、清理 workspace 副本或 worktree 的生命周期。
- apply patch UI：展示 sandbox 副本相对真实 workspace 的 diff，并让用户选择
  apply 或 discard 的界面。

当前方案直接在真实 workspace 上运行受 sandbox 限权的进程，因此不需要这些模块。

废弃旧文档中的核心假设：

```text
sandbox = worktree workspace + write-back
```

应改成：

```text
sandbox = PermissionProfile 约束下的平台权限拦截
```

`docs/agent-runtime-sandbox-executor.md` 后续可以重写为“历史方案与路线切换说明”，
或者新建一篇正式设计文档取代它。

### headless 相关处理

`packages/headless` 里的 `IsolatedToolExecutor` 暂时不作为 desktop 主线依赖。

它未来可以映射到：

```text
PermissionProfile.External
```

也就是：

```text
文件系统隔离由外部 executor/container 负责；
Maka runtime 只知道这是 external sandbox，并继续处理 approval/network policy。
```

但这不是第一阶段内容。

## Codex 与 Maka 的模块对应关系

可以把 Codex 权限和 sandbox 系统拆成 9 个层次：

```text
1. User configuration entrypoints（用户配置入口）
   用户或产品入口选择 sandbox / approval / permission profile 的地方。
2. Canonical PermissionProfile（规范权限模型）
   用平台无关的数据结构描述文件系统和网络权限。
3. Profile compilation and materialization（权限编译与运行时展开）
   把配置、workspace roots 和运行时上下文编译成最终 effective profile。
4. Tool approval / orchestrator（工具审批与执行编排）
   统一决定审批、sandbox attempt、失败处理和权限升级策略。
5. SandboxManager（sandbox 选择与命令转换器）
   根据 profile 和平台能力选择 sandbox backend，并生成执行请求。
6. Platform sandbox backend（平台 sandbox 后端）
   macOS / Linux / Windows 等平台的真实权限拦截机制。
7. Exec/spawn layer（进程执行层）
   负责真正 spawn 子进程、处理 cwd/env/timeout/output/abort。
8. File tool enforcement（文件工具权限检查）
   对 Read / Write / Edit / Glob / Grep 这类非 Bash 文件操作做同源权限检查。
9. Observability and context display（可观测性与上下文展示）
   向用户、模型和诊断工具展示当前生效的权限和 sandbox 状态。
```

Maka 现在已经有其中一部分，但中心不一样。

Maka 当前的中心是：

```text
PermissionMode + ToolCategory + PermissionEngine
```

Codex 的中心是：

```text
PermissionProfile + SandboxManager + ToolOrchestrator
```

所以 Maka 要做的不是“加一个 sandbox 函数”，而是把权限中心从 category matrix
升级成 profile-based runtime policy。

### 1. User configuration entrypoints（用户配置入口）

这一层负责接收用户或产品入口选择的权限模式。它回答：

```text
用户这次希望 agent 在什么权限边界内运行？
```

Codex 中对应：

```text
CLI --sandbox
config.toml
SDK sandboxMode
app-server permissionProfile
```

Maka 当前对应：

```text
SessionHeader.permissionMode
Settings 默认权限模式
Desktop Settings 权限相关 UI
```

相关 Maka 代码：

```text
packages/core/src/permission.ts
packages/core/src/session.ts
packages/core/src/settings.ts
apps/desktop/src/main/permission-mode-default.ts
```

Maka 要做：

```text
把现有 permissionMode 映射到默认 PermissionProfile。
```

例如：

```text
explore -> read-only
ask     -> workspace-write + mutating prompt
execute -> workspace-write + sandboxed execution allow
bypass  -> danger-full-access
```

第一版可以只在 runtime 内部编译，不一定马上做 UI。

### 2. Canonical PermissionProfile（规范权限模型）

这一层是权限系统的规范语言。它回答：

```text
agent 最终被允许读哪里、写哪里、是否可以联网？
```

Codex 中对应：

```text
PermissionProfile
FileSystemSandboxPolicy
NetworkSandboxPolicy
FileSystemSandboxEntry
FileSystemAccessMode
```

Maka 当前没有等价物。

当前 `packages/core/src/permission.ts` 只有：

```text
PermissionMode
ToolCategory
PERMISSION_POLICY
categorizeBash()
ToolExecutionFacts
```

Maka 要新增：

```text
packages/core/src/permission-profile.ts
```

内容包括：

```text
PermissionProfile
FileSystemSandboxPolicy
NetworkSandboxPolicy
protected metadata
workspace roots
special paths
```

这是最核心的一步。没有这个，后面的 sandbox 只能是零散逻辑。

### 3. Profile compilation and materialization（权限编译与运行时展开）

这一层负责把用户配置和运行时上下文变成最终生效的 profile。它回答：

```text
当前 session.cwd / workspace roots 下，最终 effective PermissionProfile 是什么？
```

Codex 做的是：

```text
用户配置 + workspace roots + requirements
-> effective PermissionProfile
```

Maka 目前没有这个阶段。现在工具只拿到：

```text
header.cwd
header.permissionMode
```

Maka 要做：

```text
packages/core/src/permission-profile-compiler.ts
或 packages/runtime/src/permission-context.ts
```

输入：

```text
session cwd
permissionMode
platform capability
future settings
```

输出：

```text
active PermissionProfile
```

第一版可以非常简单：

```text
workspaceRoots = [session.cwd]
profile = compilePermissionMode(permissionMode, workspaceRoots)
```

### 4. Tool approval / orchestrator（工具审批与执行编排）

这一层负责编排一次工具调用。它回答：

```text
这个 tool call 是否需要提示用户？
应该先用 sandbox 跑吗？
sandbox 失败后怎么处理？
```

Codex 中对应：

```text
ToolOrchestrator
default_exec_approval_requirement()
sandboxed first attempt
sandbox denial handling
optional escalation
```

Maka 当前对应：

```text
packages/runtime/src/tool-runtime.ts
packages/runtime/src/permission-engine.ts
packages/core/src/permission.ts
```

现在 Maka 的流程是：

```text
ToolRuntime
  -> PermissionEngine.evaluate()
  -> allow/prompt/block
  -> tool.impl()
```

要改成更接近：

```text
ToolRuntime
  -> ToolOrchestrator
      -> PermissionEngine / approval decision
      -> resolve active PermissionProfile
      -> decide sandbox attempt
      -> execute tool under sandbox/profile
```

第一版不一定要完全新建大 orchestrator，也可以先抽一个小模块：

```text
packages/runtime/src/tool-orchestrator.ts
```

先只管 Bash，后续再覆盖文件工具。

### 5. SandboxManager（sandbox 选择与命令转换器）

这一层负责把抽象权限转换成具体执行请求。它回答：

```text
当前 profile 和平台能力下，应该用哪种 sandbox？
原始命令要被转换成什么 argv？
```

Codex 中对应：

```text
SandboxManager::should_sandbox()
SandboxManager::select_initial()
SandboxManager::transform()
```

Maka 当前没有等价物。`WorkspaceExecutor` 不是这个东西。

Maka 要新增：

```text
packages/runtime/src/sandbox/sandbox-manager.ts
```

职责：

```text
输入:
  SandboxCommand
  PermissionProfile
  cwd
  platform capability

输出:
  SandboxExecRequest
```

例如 macOS 上：

```text
输入:
  program: /bin/sh
  args: ['-lc', command]
  cwd: /Users/.../repo
  profile: workspace-write

输出:
  command:
    /usr/bin/sandbox-exec -p <sbpl> -- /bin/sh -lc <command>
```

它只做“转换”，不负责权限业务判断，也不负责 UI。

### 6. Platform sandbox backend（平台 sandbox 后端）

这一层是真正的底层权限拦截机制。它回答：

```text
怎么把 PermissionProfile 翻译成 macOS / Linux 的系统级 sandbox 规则？
```

Codex 中对应：

```text
macOS Seatbelt
Linux bubblewrap + seccomp
Windows restricted token
```

Maka 当前没有等价物。

Maka 这轮只做：

```text
v1 macOS Seatbelt
v2 Linux bubblewrap + seccomp
Windows 不做
```

建议文件：

```text
packages/runtime/src/sandbox/macos-seatbelt.ts
packages/runtime/src/sandbox/linux-sandbox.ts
```

macOS 第一版职责：

```text
PermissionProfile -> SBPL policy string
```

不是直接 spawn。spawn 仍交给 shell runner。

### 7. Exec/spawn layer（进程执行层）

这一层负责真正启动子进程和收集结果。它回答：

```text
最终 argv 如何 spawn？
stdout / stderr / timeout / abort / process tree kill 怎么处理？
```

Codex 中对应：

```text
ExecRequest
spawn_child_async
sandbox wrapper argv
```

Maka 当前对应：

```text
packages/runtime/src/shell-exec.ts
packages/runtime/src/workspace-executor.ts
```

现在 Maka 的 shell runner 是：

```ts
spawn(command, { shell: true, cwd })
```

sandbox 后最好拆出一个 argv runner：

```text
runProcessWithBoundedTail({
  command: string[]
  cwd
  env
  timeoutMs
  abortSignal
  emitOutput
})
```

然后 Bash 可以走：

```text
SandboxManager.transform()
  -> argv
  -> runProcessWithBoundedTail(argv)
```

这样不要再把 sandbox wrapper 拼成一个大 shell 字符串，避免 quoting 问题。

### 8. File tool enforcement（文件工具权限检查）

这一层负责 Bash 之外的文件工具权限一致性。它回答：

```text
Node 主进程直接执行 Read / Write / Edit 时，如何遵守同一份 PermissionProfile？
```

Codex 对文件 API 也会通过 sandbox context / fs-helper。

Maka 第一版可以不做 fs-helper，但必须做 profile check。因为 Read / Write / Edit
是 Node 主进程直接 fs 操作，不会自动被 `sandbox-exec` 限制。

Maka 当前文件工具在：

```text
packages/runtime/src/builtin-tools.ts
packages/runtime/src/workspace-executor.ts
```

要补：

```text
Read / Glob / Grep:
  check readable roots / deny-read

Write / Edit:
  check writable roots
  block protected metadata
```

这一步不是平台 sandbox，但很重要。

### 9. Network policy and proxy（网络策略与代理）

这一层负责网络能力控制。它回答：

```text
命令能不能联网？
如果能联网，是否必须经过受管代理和域名/方法审批？
```

Codex 的网络很完整：

```text
NetworkSandboxPolicy
managed network proxy
HTTP/SOCKS proxy
domain/method approval
MITM / credential broker
```

Maka 第一版不要直接复刻完整网络代理。先做：

```text
NetworkSandboxPolicy = restricted | enabled

macOS Seatbelt:
  restricted -> deny network*
  enabled -> allow network*
```

后续再做 managed proxy。

## Maka 需要做的内容清单

最小主线：

```text
1. 新增 PermissionProfile 类型
2. 新增 permissionMode -> PermissionProfile compiler
3. 新增 protected metadata policy
4. 新增 SandboxManager
5. 新增 macOS Seatbelt policy generator
6. 给 shell-exec 增加 argv runner
7. Bash 通过 SandboxManager 执行
8. 文件工具接入 profile read/write check
9. PermissionEngine 改成 sandbox-aware
10. runtime/model context 展示当前 sandbox 状态
```

## 一张对应表

| Codex 部分 | Maka 当前对应 | Maka 需要新增/修改 |
| --- | --- | --- |
| `PermissionProfile` | 没有 | `packages/core/src/permission-profile.ts` |
| FS / Network policy | `ToolExecutionFacts` 很弱 | 新 FS / Network policy 类型 |
| config compile | `permissionMode` | `permissionMode -> profile` compiler |
| TurnContext permissions | `SessionHeader.cwd` / `permissionMode` | runtime active permission context |
| ToolOrchestrator | `ToolRuntime + PermissionEngine` | 抽 `ToolOrchestrator` 或先 Bash 专用 orchestrator |
| SandboxManager | 没有 | `packages/runtime/src/sandbox/sandbox-manager.ts` |
| macOS Seatbelt | 没有 | `macos-seatbelt.ts` |
| Linux sandbox | 没有 | 第二阶段实现 |
| Windows sandbox | 没有 | 暂不支持 |
| exec / spawn | `shell-exec.ts` | 增加 argv runner + sandbox wrapped exec |
| fs-helper | 没有 | 第一版不做，文件工具先做 profile check |
| managed network | Tavily / web-search 是另一条线 | 第一版只做 network restricted / enabled |
| protected metadata | 没有系统规则 | `.git` / `.agents` / `.codex` deny-write |

## 核心理解

可以用三句话理解新方案：

```text
PermissionProfile 是“允许什么”的规范语言。
SandboxManager 是“怎么把允许什么变成平台执行限制”的翻译器。
ToolOrchestrator 是“什么时候允许、什么时候提示、什么时候用 sandbox 跑”的编排器。
```

Maka 当前缺的正是这三块。
