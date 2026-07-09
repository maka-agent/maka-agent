# Agent Runtime Codex-Style Sandbox 当前状态

更新时间：2026-07-09

本文档用于回答当前 sandbox 方向已经做了什么、实现了哪些模块、还缺哪些内容。它是当前状态快照，不替代分阶段 todo：

- `docs/sandbox/agent-runtime-codex-sandbox-alignment.md`
- `docs/sandbox/agent-runtime-codex-sandbox-todo.md`

当前分支：`feat/runtime-permission-profile-sandbox`

当前路线：

- 参考 Codex 思路，采用 `PermissionProfile + SandboxManager + platform sandbox enforcement`。
- 不做 worktree。
- 不做 workspace copy lifecycle。
- 不做 diff/write-back。
- 不做 apply patch UI。
- `workspace-write` 直接写真实 workspace，依赖 permission profile 和 sandbox 限制越权访问。
- 第一平台是 macOS Seatbelt；Linux 后续做；Windows 暂不做。

## 当前代码状态

目前已提交到分支上的主要能力覆盖 Phase 1 到 Phase 7。当前工作区正在推进 Phase 7.5：统一 `WorkspaceExecutor` factory 和默认 runtime tool assembly。

当前工作区里还有两个和本 sandbox 主线无关的脏项，需要后续单独处理：

- `docs/superpowers/plans/2026-06-24-runtime-ledger-backfill.md` 当前显示为删除。
- `docs/sandbox/agent-runtime-sandbox-executor.md` 当前显示为未跟踪文件。

## 已实现内容

### Phase 1：PermissionProfile 数据模型

位置：

- `packages/core/src/permission-profile.ts`
- `packages/core/src/__tests__/permission-profile.test.ts`
- `packages/core/src/index.ts`

已实现：

- `PermissionProfile` 顶层形态：
  - `managed`
  - `disabled`
  - `external`
- 文件系统策略：
  - `restricted`
  - `unrestricted`
  - `external_sandbox`
- 文件访问模式：
  - `read`
  - `write`
  - `deny`
- special paths：
  - `:root`
  - `:workspace_roots`
  - `:tmpdir`
  - `:slash_tmp`
  - `:minimal`
- network policy：
  - `restricted`
  - `enabled`
- protected metadata：
  - `.git`
  - `.agents`
  - `.codex`
- 标准 profile factory：
  - `createReadOnlyPermissionProfile()`
  - `createWorkspaceWritePermissionProfile()`
  - `createDangerFullAccessPermissionProfile()`
  - `createExternalPermissionProfile()`
- 纯 matcher：
  - `canReadPath()`
  - `canWritePath()`
  - `isDeniedPath()`
  - `isProtectedMetadataPath()`

重要边界：

- core 层 matcher 只做纯字符串路径判断。
- core 层不访问真实文件系统。
- core 层不做 `realpath`、symlink 处理、平台路径规范化。
- `danger-full-access` 表达为 `managed + unrestricted + network enabled`，不是 `disabled`。

### Phase 2：permissionMode 到 PermissionProfile compiler

位置：

- `packages/core/src/permission-profile-compiler.ts`
- `packages/core/src/__tests__/permission-profile-compiler.test.ts`
- `packages/core/src/index.ts`

已实现：

- `compilePermissionProfile()`
- `CompilePermissionProfileInput`
- `CompiledPermissionProfile`
- 默认 `workspaceRoots = [cwd]`
- 映射关系：
  - `explore -> read-only`
  - `ask -> workspace-write`
  - `execute -> workspace-write`
  - `bypass -> danger-full-access`

重要边界：

- `ask` 和 `execute` 使用同一个 `workspace-write` profile。
- `ask` 和 `execute` 的审批差异仍留在现有 `PermissionEngine` / policy matrix 中，不塞进 profile。
- compiler 不做 runtime enforcement，不启动 sandbox。

### Phase 3：SandboxManager 骨架

位置：

- `packages/runtime/src/sandbox/types.ts`
- `packages/runtime/src/sandbox/sandbox-manager.ts`
- `packages/runtime/src/sandbox/index.ts`
- `packages/runtime/src/__tests__/sandbox-manager.test.ts`
- `packages/runtime/src/__tests__/sandbox-export.test.ts`
- `packages/runtime/src/index.ts`

已实现：

- `SandboxType`：
  - `none`
  - `macos-seatbelt`
  - `linux`
- `SandboxablePreference`：
  - `auto`
  - `require`
  - `forbid`
- `SandboxCommand`
- `SandboxExecRequest`
- `SandboxTransformRequest`
- `SandboxTransformResult`
- `SandboxBackend`
- `SandboxManager.shouldSandbox()`
- `SandboxManager.selectInitial()`
- `SandboxManager.transform()`

平台选择策略：

- `darwin + restricted profile -> macos-seatbelt`
- `linux + restricted profile -> backend_not_implemented`
- `win32` 和其他平台在需要 sandbox 时返回 `unsupported_platform`
- `danger-full-access`、`disabled`、`external`、`forbid` 选择 `none`

重要边界：

- `SandboxManager` 只负责选择 sandbox 和转换命令。
- 它不负责 UI。
- 它不负责审批。
- 它不执行命令。
- 它不实现 unsandboxed retry。
- sandbox 必需但不可用时 fail closed，不静默降级到 host shell。

### Phase 4：macOS Seatbelt backend

位置：

- `packages/runtime/src/sandbox/macos-seatbelt.ts`
- `packages/runtime/src/sandbox/default-sandbox-manager.ts`
- `packages/runtime/src/__tests__/macos-seatbelt.test.ts`
- `packages/runtime/src/__tests__/macos-seatbelt-smoke.test.ts`
- `packages/runtime/src/__tests__/default-sandbox-manager.test.ts`
- `packages/runtime/src/index.ts`

已实现：

- `MacosSeatbeltBackend`
- `buildSeatbeltPolicy()`
- `createSeatbeltExecArgs()`
- `createDefaultSandboxManager()`
- 固定使用 `/usr/bin/sandbox-exec`
- Maka-owned base SBPL policy
- macOS platform defaults
- readable roots policy
- writable roots policy
- `tmpdir` / `/tmp` write
- protected metadata deny-write
- network restricted / enabled
- `-DREADABLE_ROOT_N` / `-DWRITABLE_ROOT_N` 参数化 root path
- macOS-only smoke tests

重要边界：

- backend 只接受 `managed + restricted` profile。
- unrestricted / disabled / external 应在 `SandboxManager` 选择阶段走 `none`。
- backend 不做路径 realpath，依赖 runtime 传入规范化 path context。
- Linux backend 尚未实现。

### Phase 5：argv-based process runner

位置：

- `packages/runtime/src/shell-exec.ts`
- `packages/runtime/src/__tests__/shell-exec.test.ts`
- `packages/runtime/src/index.ts`

已实现：

- `runProcessWithBoundedTail(argv, options)`
- 保留 `runShellWithBoundedTail(command, options)`
- 共享 bounded output tail 逻辑
- 共享 stdout/stderr streaming
- 共享 timeout
- 共享 abort signal
- 共享 POSIX process group termination
- 保留 Windows `taskkill` 逻辑
- 支持 wrapper-style argv，例如：

```ts
['/usr/bin/sandbox-exec', '-p', policy, '--', '/bin/sh', '-lc', command]
```

重要边界：

- `runProcessWithBoundedTail()` 使用 `spawn(program, args, { shell: false })`。
- 它不会把 argv 再拼成 shell string。
- Phase 5 本身不改变现有 Bash 默认路径。

### Phase 6：foreground Bash sandbox wrapper

位置：

- `packages/runtime/src/workspace-executor.ts`
- `packages/runtime/src/__tests__/workspace-executor.test.ts`
- `packages/runtime/src/__tests__/builtin-tools.test.ts`
- `packages/runtime/src/index.ts`
- `docs/sandbox/agent-runtime-codex-sandbox-todo.md`

当前状态：

- 已在工作区实现。
- 已通过 build、定向测试和 `@maka/runtime` 全量测试。
- 尚未 commit。

已实现：

- `WorkspaceCommandSandboxContext`
- `WorkspaceCommandSandboxContextProvider`
- `WorkspaceCommandSandboxManager`
- `WorkspaceCommandRunner`
- `WorkspaceCommandSandboxError`
- `SandboxedCommandWorkspaceExecutor`
- `WorkspaceExecInput.env`
- foreground Bash command 转成 `/bin/sh -lc <command>`
- 调用 `SandboxManager.transform()` 得到最终 argv
- 使用 `runProcessWithBoundedTail()` 执行最终 argv
- 保留 terminal result shape：
  - `cwd`
  - `cmd`
  - `exitCode`
  - `stdout`
  - `stderr`
- sandbox context 缺失时 fail closed
- `workspaceRoots` 缺失或为空时 fail closed
- transform 失败时抛出结构化 `WorkspaceCommandSandboxError`
- 不做 unsandboxed retry

重要边界：

- Phase 6 第一版只覆盖 foreground Bash。
- foreground Bash 指没有 `shellRuns` 时的 `buildExecutorBashTool() -> WorkspaceExecutor.exec()` 路径。
- background Bash 尚未接入 sandbox。
- `SandboxedCommandWorkspaceExecutor` 目前只覆盖 `exec()`。
- `Read / Write / Edit / Glob / Grep` 已由 Phase 7 的 `ProfileEnforcedWorkspaceExecutor` 覆盖。
- 当前已有统一 `WorkspaceExecutor` factory。
- desktop / CLI 的默认 builtin tool assembly 已接入 permission-aware executor；headless、child agent、background Bash 还没接完。

## Maka 当前仍保留的既有保护

这些不是新 sandbox profile 系统的一部分，但 Phase 7 之后仍需要保留：

- `PermissionEngine` 继续负责业务层审批。
- `ToolCategory` 和现有 policy matrix 继续决定 `allow` / `prompt` / `block`。
- `categorizeBash()` 仍存在，但目标是让它不再成为唯一安全边界。
- `LocalWorkspaceExecutor.resolveExistingPath()` 保留：
  - 相对路径限制
  - `realpath`
  - cwd containment
  - symlink escape 防护
- `LocalWorkspaceExecutor.resolveWritablePath()` 保留：
  - 相对路径限制
  - parent realpath
  - cwd containment
  - symlink-parent escape 防护
- file write lock 仍在 `builtin-tools.ts` 层使用。
- `Edit` matcher 行为仍由 `computeEditedSource()` 保持。

## 当前剩余内容与 Phase 7.5 状态

### Phase 6 剩余项

- background Bash 接入 sandbox。
- long-running shell run 的 sandbox-aware spawn。
- `Read(ref)` / `StopBackgroundTask` / observe / durable shell run record 行为保持不回退。

### Phase 7：文件工具接入 profile enforcement

目标：让 Node 主进程内的文件工具也遵守同一份 active `PermissionProfile`。

当前状态：

- 已在当前工作区实现 `ProfileEnforcedWorkspaceExecutor`。
- 已实现 active profile context 注入。
- 已实现 `Read` readable roots / deny-read 检查。
- 已实现 `Glob` / `Grep` 搜索根可读检查。
- 已实现 `Write` / `Edit` writable roots 检查。
- 已实现 protected metadata 写入阻止。
- 已保留 realpath containment。
- 已保留 symlink escape 防护。
- 已保留 file write lock。
- 已保留 Edit matcher 行为。
- 已提交。

实现方式：

- 用 `ProfileEnforcedWorkspaceExecutor` 包住 `inner: WorkspaceExecutor`。
- wrapper 做 profile enforcement。
- inner 继续做真实文件系统访问、realpath containment、symlink 防护、glob、grep。
- 采用双层检查：
  - `resolveExistingPath()` / `resolveWritablePath()` 提前检查。
  - `readFile()` / `writeFile()` / `globFiles()` / `grepFiles()` 最终检查。
- `exec()` 和 `writeLockKey()` 继续委托 inner executor。
- `Glob` / `Grep` 第一版只检查搜索根可读，不做结果级过滤。

### Phase 7.5：统一 WorkspaceExecutor factory / runtime tool assembly

目标：让已经完成的 profile、sandbox command wrapper、file profile enforcement 在默认 runtime 入口中自动组合。

当前状态：

- 已新增 `createPermissionAwareWorkspaceExecutor()`。
- 已新增 `buildPermissionAwareBuiltinTools()`。
- 已实现默认组合顺序：`LocalWorkspaceExecutor -> SandboxedCommandWorkspaceExecutor -> ProfileEnforcedWorkspaceExecutor`。
- 已从 runtime barrel 和 `@maka/runtime/workspace-executor-factory` subpath 导出。
- desktop `ai-sdk` backend 已按当前 session header 构造 permission-aware builtin tools。
- CLI `ai-sdk` backend 已按当前 session header 构造 permission-aware builtin tools。
- runtime assembly 边界已对 session cwd 做 realpath/absolute path 规范化。

仍未完成：

- desktop / CLI 传入 `shellRuns` 时，默认 Bash 仍走 background Bash 路径，还没有 sandbox-aware spawn。
- headless / isolated executor 路径还没有统一接入 factory。
- child agent tools 还没有按 child session active profile 动态构造。
- `PermissionEngine` 还没有理解 sandbox availability。

### Phase 8：sandbox-aware PermissionEngine / policy

待实现：

- 让 `PermissionEngine` 理解 active profile 和 sandbox availability。
- 避免只依赖 `mode x category`。
- 明确 `ask` / `execute` 的 approval policy 差异。
- 明确 sandbox denial、sandbox unavailable、policy denial 的不同错误语义。
- 为未来 unsandboxed retry 留编排位置。

### Phase 9：runtime/model context 与 diagnostics

待实现：

- 在 runtime diagnostics 中暴露 active profile。
- 暴露 sandbox type。
- 暴露 workspace roots。
- 暴露 network policy。
- 暴露 unsupported platform / backend unavailable 等原因。
- 给模型上下文提供清晰的能力边界描述。

### Phase 10：Linux sandbox backend

待实现：

- Linux backend。
- bubblewrap / seccomp 方案落地。
- Linux path context 映射。
- Linux contract tests。
- Linux smoke tests。

### 其他后续项

- managed network proxy / network allowlist。
- Codex-style unsandboxed retry。
- 文件工具 OS sandbox 兜底。
- remote runtime / external sandbox 的正式接入语义。
- Windows sandbox 暂不规划。

## 当前主链路理解

目前已经具备的能力可以理解为：Maka 已经有了描述权限、选择 sandbox、生成 macOS sandbox 命令、执行 sandbox 命令、文件工具 profile enforcement、以及 desktop / CLI 默认 tool assembly 的基础接线。

已经具备的内容：

- 可以把用户当前的权限模式转换成标准权限描述。例如 `explore` 会变成 read-only，`ask` / `execute` 会变成 workspace-write，`bypass` 会变成 danger-full-access。
- 可以用一份统一的权限描述表达文件系统和网络边界。例如 workspace-write 表示可以写真实 workspace 和临时目录，但默认不能写 `.git`、`.agents`、`.codex`。
- 可以判断当前命令是否需要 sandbox。如果是需要限制的 profile，macOS 会选择 Seatbelt；最高权限模式会选择不加 sandbox。
- 可以把一个普通命令包装成 macOS `sandbox-exec` 能执行的形式。
- 可以直接执行这种 wrapper argv，而不是把它重新拼成 shell 字符串。
- macOS Seatbelt backend 已经能拦住 workspace 外写入、protected metadata 写入和受限网络访问。

Phase 6-7.5 当前能力：

- foreground Bash 已经可以走 sandbox 执行路径。
- 这里的 foreground Bash 指普通短命令，也就是一次 Bash tool call 等命令结束后直接返回结果的路径。
- 它会先把用户命令放进 `/bin/sh -lc <command>`，再交给 sandbox manager 包装，最后用 argv runner 执行。
- 没有 `shellRuns` 的 foreground toolset 可以通过默认 factory 自动使用这条路径。
- Read / Write / Edit / Glob / Grep 已经可以通过默认 factory 自动使用 `ProfileEnforcedWorkspaceExecutor`。
- desktop / CLI 的 `ai-sdk` backend 已按 session header 构造 permission-aware builtin tools。

还没有完成的默认接入：

- background Bash 还没有接入 sandbox。
- headless / isolated executor 还没有接入统一 factory。
- child agent tools 还没有按 child session active profile 动态构造。
- `PermissionEngine` 还没有根据 sandbox availability 调整 allow/prompt/block。

## 按 Codex 模块划分的完成度

这条路线确实是在参考 Codex 的 sandbox 设计，但当前 Maka 只实现了其中一部分核心切片。可以把 Codex 的设计拆成下面这些模块来看：

| Codex 模块 | Maka 当前对应内容 | 当前状态 | 说明 |
| --- | --- | --- | --- |
| 用户入口与配置解析 | `PermissionMode`、session mode、runtime startup | 部分完成 | Maka 已经有 `explore` / `ask` / `execute` / `bypass` 这些用户可理解的模式，也已经能把 mode 编译成 profile；desktop / CLI builtin tools 已基础接入 active profile，headless / child agent 还没接完。 |
| 规范权限模型 | `PermissionProfile`、file system policy、network policy | 已完成基础版 | 已能表达 read-only、workspace-write、danger-full-access、external、restricted/unrestricted、protected metadata 和 network restricted/enabled。 |
| 权限 profile 编译与约束 | `compilePermissionProfile()` | 已完成基础版 | 已实现 mode 到标准 profile 的映射；尚未实现 Codex 那种自定义 `[permissions]`、profile 继承、requirements 约束、项目 trust 默认策略。 |
| 临时授权与权限合并 | 暂无完整对应模块 | 未完成 | Codex 支持单次命令 additional permissions，并把用户批准的额外权限临时合并进 profile。Maka 当前还没有做这层。 |
| 审批与重试编排 | 现有 `PermissionEngine`，未来 sandbox-aware policy | 部分已有，sandbox 语义未完成 | Maka 已有业务层 allow/prompt/block；但它还没有理解 active profile、sandbox availability、sandbox denial，也没有 Codex-style unsandboxed retry。 |
| 执行请求与 spawn 层 | `runProcessWithBoundedTail()`、`SandboxedCommandWorkspaceExecutor`、`createPermissionAwareWorkspaceExecutor()` | 部分完成 | 已能执行 sandbox wrapper argv；foreground toolset 可通过默认 factory 走这条路径。desktop / CLI 默认 Bash 因为仍使用 background Bash，所以还需要后续接 `ShellRunProcessManager`。 |
| SandboxManager | `SandboxManager` | 已完成骨架 | 已能判断是否需要 sandbox、选择 macOS/Linux/unsupported、转换命令；不负责审批、不负责 UI、不执行命令。 |
| macOS Seatbelt 后端 | `MacosSeatbeltBackend` | 已完成基础版 | 已能生成 SBPL 和 `/usr/bin/sandbox-exec` wrapper，覆盖 workspace 写入、protected metadata、network restricted/enabled，并有 macOS smoke test。 |
| Linux 后端 | 计划中的 Linux backend | 未完成 | 后续 Phase 10 才做 bubblewrap/seccomp。 |
| Windows 后端 | 本轮无 | 不做 | 当前明确暂不实现 Windows sandbox，只保留接口和 unsupported 语义。 |
| 受管网络代理 | 暂无 | 未完成 | 目前只有 network policy 的 `restricted/enabled` 语义和 macOS sandbox 的网络限制；没有 Codex 那种 managed proxy、域名策略、方法策略、MITM、网络审批。 |
| exec-server / remote runtime | 暂无 | 未完成 | Codex 会把 sandbox intent 传给远端执行端重新 materialize。Maka 当前没有接这层。 |
| 文件系统 helper / 文件工具 enforcement | `ProfileEnforcedWorkspaceExecutor` | 已完成 Node 主进程 enforcement 基础版 | Codex 的远端文件 API 会通过 sandboxed fs-helper 兜底。Maka Phase 7 先做 Node 主进程内的 profile enforcement；Phase 7.5 已接入 desktop / CLI 默认 builtin tools，但还不是 OS 级 fs-helper。 |
| 可观测性与模型上下文 | 计划中的 diagnostics/model context | 未完成 | 后续需要把 active profile、workspace roots、sandbox type、network policy、backend unavailable 等信息展示给 runtime、用户和模型。 |

所以当前 Maka 的完成度可以概括为：

- `权限模型`：基础版已完成。
- `权限模式到 profile 的编译`：基础版已完成。
- `sandbox 选择层`：基础版已完成。
- `macOS 平台后端`：基础版已完成。
- `argv 执行能力`：已完成。
- `foreground Bash sandbox wrapper`：已完成；没有 `shellRuns` 的 foreground toolset 可以通过默认 factory 接入。
- `文件工具 enforcement`：已完成基础版，并已接入 desktop / CLI 默认 builtin tool assembly。
- `默认 runtime 接线`：desktop / CLI 基础接线已完成；headless / child agent 还没接。
- `background Bash`：还没做。
- `sandbox-aware PermissionEngine / retry / diagnostics / Linux / network proxy / remote executor`：还没做。

## 模块架构图

```mermaid
graph TD
  Settings[用户设置 / Session PermissionMode]
  Compiler[compilePermissionProfile\nmode -> active profile]
  Profile[CompiledPermissionProfile\nprofile / workspaceRoots / network]
  RuntimeAssembly[Permission-aware runtime assembly\ncreatePermissionAwareWorkspaceExecutor]

  PermissionEngine[PermissionEngine\n业务层 allow / prompt / block]
  ToolRuntime[ToolRuntime / builtin tools]

  Bash[Foreground Bash\n无 shellRuns 时走 wrapper]
  BackgroundBash[Background Bash\n未接入 sandbox]
  FileTools[Read / Write / Edit / Glob / Grep\ndesktop/CLI 默认 profile enforcement]

  CommandExecutor[SandboxedCommandWorkspaceExecutor\n只覆盖 exec()]
  FileEnforcer[ProfileEnforcedWorkspaceExecutor\n已实现基础版]
  LocalExecutor[LocalWorkspaceExecutor\n真实文件系统访问 + realpath/symlink 防护]

  CoreMatcher[core permission-profile matcher\ncanReadPath / canWritePath]

  SandboxManager[SandboxManager\n选择 sandbox + transform argv]
  MacSeatbelt[MacosSeatbeltBackend\nPermissionProfile -> SBPL]
  LinuxBackend[Linux backend\nPhase 10]
  ProcessRunner[runProcessWithBoundedTail\nargv runner]
  ShellRunner[runShellWithBoundedTail\nlegacy shell string path]
  HostOS[Host OS process / file system]

  Settings --> Compiler --> Profile
  Profile --> RuntimeAssembly
  RuntimeAssembly --> CommandExecutor
  RuntimeAssembly --> FileEnforcer
  Profile --> PermissionEngine
  PermissionEngine --> ToolRuntime

  ToolRuntime --> Bash
  ToolRuntime --> BackgroundBash
  ToolRuntime --> FileTools

  Bash --> CommandExecutor
  CommandExecutor --> SandboxManager
  SandboxManager --> MacSeatbelt
  SandboxManager -. planned .-> LinuxBackend
  MacSeatbelt --> ProcessRunner
  LinuxBackend -. planned .-> ProcessRunner
  ProcessRunner --> HostOS

  BackgroundBash -->|current host path| ShellRunner
  ShellRunner --> HostOS

  FileTools --> FileEnforcer
  FileEnforcer -. uses .-> CoreMatcher
  FileEnforcer --> LocalExecutor
  LocalExecutor --> HostOS
```

图中含义：

- 实线表示当前已经存在或已接入的代码路径。
- 虚线表示计划中或尚未默认接入的路径。
- 当前最关键缺口是 background Bash：desktop / CLI 默认带 `shellRuns`，所以 Bash 仍走 background host path；file tools 已经进入默认 profile enforcement。

## 建议的下一步顺序

1. 将 background Bash 接入 sandbox-aware argv spawn。
2. 调整 `PermissionEngine` / policy matrix，使其理解 sandbox availability。
3. 增加 runtime diagnostics 和 model context。
4. 补 headless / child agent 默认 assembly。
5. 继续推进 Linux backend。

## 验证记录

截至本文档编写时，Phase 7 / 7.5 工作区改动已运行过：

```bash
npm --workspace @maka/runtime run typecheck
npm --workspace maka-agent run typecheck
npm --workspace @maka/desktop run typecheck
```

结果：通过。

也运行过：

```bash
npm --workspace @maka/runtime run build && node --test packages/runtime/dist/__tests__/workspace-executor.test.js packages/runtime/dist/__tests__/builtin-tools.test.js
```

结果：52 个测试通过。

也运行过：

```bash
npm --workspace @maka/runtime run build && node --test packages/runtime/dist/__tests__/workspace-executor-factory.test.js
```

结果：6 个测试通过。

也运行过：

```bash
npm --workspace maka-agent run build && node --test packages/cli/dist/__tests__/runtime-bootstrap.test.js
```

结果：7 个测试通过。

也运行过：

```bash
npm --workspace @maka/desktop run build:main
node --test apps/desktop/dist/main/__tests__/default-permission-mode-contract.test.js apps/desktop/dist/main/__tests__/session-startup-recovery-contract.test.js apps/desktop/dist/main/__tests__/session-send-resolve.test.js apps/desktop/dist/main/__tests__/bot-runtime-consistency-contract.test.js
```

结果：14 个测试通过。

最终使用非沙箱执行运行过：

```bash
npm --workspace @maka/runtime test
```

结果：1007 个测试通过。

补充：普通 sandbox 环境下运行完整 runtime 测试会因为本地监听端口和嵌套 `sandbox-exec` smoke 被外层 sandbox 拒绝而失败；提升权限重跑后通过。
