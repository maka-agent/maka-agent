# Agent Runtime Codex-Style Sandbox Todo

这份文档是 Maka 参考 Codex 实现权限管理和 sandbox 权限兜底的分阶段工程任务清单。

关联背景文档：

- `docs/sandbox/agent-runtime-codex-sandbox-alignment.md`
- `docs/sandbox/agent-runtime-codex-sandbox-status.md`
- `docs/sandbox/agent-runtime-sandbox-executor.md`

当前实施计划：

- `docs/sandbox/agent-runtime-codex-sandbox-phase-7-8-plan.md`

当前路线已经明确：

```text
主线：PermissionProfile + SandboxManager + 平台 sandbox enforcement
第一平台：macOS Seatbelt
第二平台：Linux bubblewrap + seccomp
不做：Windows
不做：worktree / diff / write-back / apply patch UI
```

## 目标

在 Maka runtime 中建立 Codex-style 权限管理系统：

- 用 `PermissionProfile` 描述 agent 能读哪里、写哪里、是否能联网。
- 用 `SandboxManager` 把权限语义转换成平台 sandbox 执行请求。
- 用平台 sandbox backend 做底层权限拦截。
- 让 Bash 和文件工具都遵守同一份 active permission profile。
- 让 `execute` 模式不再依赖 Bash regex 分类作为安全边界。

## 非目标

本轮不做：

- WorktreeExecutor。
- workspace 副本。
- diff/write-back。
- apply patch UI。
- sandbox cwd 映射。
- Windows sandbox。
- Docker / remote executor。
- Codex-style unsandboxed retry。
- 完整 managed network proxy。

## 阶段总览

```text
Phase 0: 清理旧方案假设
Phase 1: PermissionProfile 数据模型
Phase 2: permissionMode -> PermissionProfile compiler
Phase 3: SandboxManager 骨架
Phase 4: macOS Seatbelt policy generator
Phase 5: argv-based shell runner
Phase 6: Bash 接入 sandboxed execution
Phase 7: 文件工具接入 profile enforcement
Phase 7.5: 统一 WorkspaceExecutor factory / runtime tool assembly
Phase 7.6: background Bash 接入 sandbox
Phase 7.7: 文件工具接入 OS sandboxed worker/helper
Phase 7.8: 补齐 headless / isolated / child agent 默认接线
Phase 8: sandbox-aware PermissionEngine / policy
Phase 9: runtime/model context 与 diagnostics
Phase 10: Linux sandbox backend / helper / distribution
```

## Phase 0: 清理旧方案假设

目标：让文档和 issue 语义不再把 worktree/write-back 当成当前实现方向。

范围：

- `docs/sandbox/agent-runtime-sandbox-executor.md`
- `docs/sandbox/agent-runtime-codex-sandbox-alignment.md`
- GitHub issue 后续评论

任务：

- [ ] 在旧方案文档顶部标注：这是历史方案，当前路线已切换到 Codex-style permission profile + platform sandbox enforcement。
- [ ] 明确写出当前不做 WorktreeExecutor。
- [ ] 明确写出当前不做 diff/write-back。
- [ ] 明确写出当前不做 apply patch UI。
- [ ] 明确写出当前 `workspace-write` 是直接写真实 workspace，并依赖 sandbox 限制越权访问。
- [ ] 在 GitHub issue 下追加评论，说明实现方向已经从 worktree/write-back 调整为 permission profile + platform sandbox。

验收标准：

- 新旧文档读起来不会让人误以为 Maka 已经实现或将要实现 worktree sandbox。
- `workspace-write` 的定义清楚：真实 workspace 直接写入，sandbox 限制访问边界。

测试建议：

- 文档检查即可。
- 搜索 `worktree`、`write-back`、`apply patch`，确认这些词只出现在历史方案或明确非目标上下文中。

## Phase 1: PermissionProfile 数据模型

目标：在 core 层建立平台无关的规范权限模型。

建议文件：

- 新增：`packages/core/src/permission-profile.ts`
- 修改：`packages/core/src/index.ts`
- 测试：`packages/core/src/__tests__/permission-profile.test.ts`

核心类型：

```text
PermissionProfile
FileSystemSandboxPolicy
FileSystemSandboxEntry
FileSystemAccessMode
FileSystemSandboxKind
FileSystemSpecialPath
NetworkSandboxPolicy
```

任务：

- [x] 定义 `PermissionProfile.Managed`，包含 file system policy 和 network policy。
- [x] 定义 `PermissionProfile.Disabled`，表示不启用 Maka-managed sandbox。
- [x] 定义 `PermissionProfile.External`，表示文件系统隔离由外部环境负责，Maka 仍可表达 network policy。
- [x] 定义 `FileSystemSandboxKind`：`restricted`、`unrestricted`、`external_sandbox`。
- [x] 定义 `FileSystemAccessMode`：`read`、`write`、`deny`。
- [x] 定义 `FileSystemSandboxEntry`：path/special + access。
- [x] 定义 `NetworkSandboxPolicy`：`restricted`、`enabled`。
- [x] 定义 special paths：`:root`、`:workspace_roots`、`:tmpdir`、`:slash_tmp`、`:minimal`。
- [x] 定义 protected metadata 名称：`.git`、`.agents`、`.codex`。
- [x] 实现基础 matcher：判断某个 path 是否可读、可写、被 deny。
- [x] 实现 protected metadata 判断：workspace-write 下默认 deny-write。
- [x] 从 `@maka/core` 导出这些类型和 helper。

> 具体方案：Phase 1 只在 `@maka/core` 中定义平台无关的权限规则语言，不做 runtime enforcement，不启动 sandbox，不访问真实文件系统。
>
> `PermissionProfile` 使用 `managed` / `disabled` / `external` 三种顶层形态。`managed` 表示 Maka 管理权限语义，包含 file system policy 和 network policy；`disabled` 只表示 Maka 不启用自己的权限管理或 sandbox 管理；`external` 表示文件系统隔离由外部环境负责，Maka 仍可表达 network policy。
>
> `danger-full-access` 不表达成 `disabled`。它表达成一个明确的 `managed` profile：`fileSystem.kind = unrestricted`，`network.kind = enabled`。这样 diagnostics 和后续 runtime 都能区分“用户明确选择最高权限”和“Maka 权限管理关闭”。
>
> `FileSystemSandboxEntry` 使用 discriminated union：`kind: 'path'` 表示具体绝对路径，`kind: 'special'` 表示 `:workspace_roots`、`:tmpdir` 这类 symbolic path。后续 runtime 或 profile resolver 负责保证传入 matcher 的 path 和 special context 已经合法、规范化。
>
> Phase 1 matcher 只做纯字符串判断，假设传入 path 已经是规范化后的绝对路径。相对路径解析、`realpath`、symlink escape、路径是否存在、macOS/Linux 差异都放到后续 runtime enforcement 处理。
>
> matcher 规则固定为：`deny` 优先级最高；`write` 隐含 `read`；目录匹配必须按 path segment 边界进行，避免 `/repo` 错误匹配 `/repo2`。
>
> network policy 第一版只包含 `restricted` 和 `enabled`。`restricted` 表示默认不允许直接网络访问，`enabled` 表示允许网络访问。managed proxy、domain allowlist 等能力留到后续扩展。
>
> protected metadata 第一版固定为 `.git`、`.agents`、`.codex`。`workspace-write` 下默认对 workspace root 下面任意层级的这些目录执行 deny-write，但仍允许 read。
>
> Phase 1 同时提供 `createReadOnlyPermissionProfile()`、`createWorkspaceWritePermissionProfile()`、`createDangerFullAccessPermissionProfile()` 三个 factory。Phase 2 的 `permissionMode -> PermissionProfile` compiler 后续直接复用这些 factory。

验收标准：

- core 层可以单独表达 read-only、workspace-write、danger-full-access。
- protected metadata 规则不依赖 runtime 或 desktop。
- 不引入 Node-only runtime 依赖到 core 的纯类型逻辑中，除非现有 core 已接受相同依赖模式。

测试建议：

- `read-only`：workspace 内可读不可写。
- `workspace-write`：workspace 内普通文件可写。
- `workspace-write`：workspace 外不可写。
- `workspace-write`：`.git` / `.agents` / `.codex` 默认不可写。
- `danger-full-access`：文件系统 unrestricted。

## Phase 2: permissionMode -> PermissionProfile compiler

目标：把 Maka 现有四档 permission mode 编译成默认 active permission profile。

建议文件：

- 新增：`packages/core/src/permission-profile-compiler.ts`
- 修改：`packages/core/src/index.ts`
- 测试：`packages/core/src/__tests__/permission-profile-compiler.test.ts`

输入：

```text
permissionMode
session cwd
workspace roots
platform capability
future settings
```

第一版输入可以简化成：

```text
permissionMode
cwd
```

任务：

- [x] 定义 compiler 输入类型，例如 `CompilePermissionProfileInput`。
- [x] 第一版将 `workspaceRoots` 默认设为 `[session.cwd]`。
- [x] 实现 `explore -> read-only`。
- [x] 实现 `ask -> workspace-write`。
- [x] 实现 `execute -> workspace-write`。
- [x] 实现 `bypass -> danger-full-access`。
- [x] 为 `ask` / `execute` 保留 approval policy 差异，不把所有语义塞进 profile。
- [x] 输出包含 profile、workspace roots、network policy、用于 diagnostics 的 profile name。

> 具体方案：Phase 2 在 `@maka/core` 中新增一个纯 compiler，用来把 Maka 现有的 `PermissionMode` 编译成 Codex-style active `PermissionProfile`。它是 Maka 现有业务层权限模式和后续 sandbox enforcement 之间的适配层。
>
> 第一版输入采用 `mode + cwd`，同时预留可选 `workspaceRoots`。当调用方没有传入 `workspaceRoots` 时，compiler 使用 `[cwd]` 作为默认 workspace roots。`cwd` 和 `workspaceRoots` 都由 runtime/session 提供；compiler 不访问真实文件系统，不做 `realpath`，不处理 symlink，也不做平台相关路径规范化。
>
> 输出采用编译结果对象，而不是只返回 `PermissionProfile`。建议结构包含：`mode`、`profileName`、`profile`、`workspaceRoots`、`network`。其中 `mode` 保留给现有 `PermissionEngine` / policy matrix 继续做 `allow` / `prompt` / `block` 审批判断；`profileName`、`workspaceRoots`、`network` 供后续 diagnostics、model context 和 sandbox backend 使用。
>
> 映射关系固定为：`explore -> read-only`，`ask -> workspace-write`，`execute -> workspace-write`，`bypass -> danger-full-access`。`ask` 和 `execute` 不拆分 profile，二者共享同一个 `workspace-write` sandbox 能力边界。
>
> `ask` / `execute` 的差异不进入 `PermissionProfile`。它们的差异仍然由现有 `PermissionEngine` 和 `PERMISSION_POLICY` 表达：`ask` 对写文件和 shell 更偏向 `prompt`，`execute` 对普通写入和普通 shell 更偏向 `allow`，但危险操作仍可继续 `prompt`。
>
> `createReadOnlyPermissionProfile()`、`createWorkspaceWritePermissionProfile()`、`createDangerFullAccessPermissionProfile()` 继续保持无参数 factory。它们返回稳定的标准 profile 模板；真实 workspace 路径不塞进这些 factory，而是由 compiler 输出的 `workspaceRoots` 提供给 matcher 和后续 sandbox backend。
>
> Phase 2 不处理 approval policy 重构、不处理 platform capability、不处理 future settings、不启动 sandbox、不改变 runtime tool execution。`platform capability` 和用户配置覆盖留给后续 runtime/sandbox 阶段；Phase 2 只建立 core 层稳定、可测试的 mode-to-profile 编译边界。

验收标准：

- 现有 `PermissionMode` 仍是用户可理解的入口。
- core 可以从 session cwd 生成 active profile。
- `ask` 和 `execute` 可以使用同一 workspace-write profile，但保留不同 approval 行为。

测试建议：

- 每个 permission mode 都有固定 profile 输出。
- `explore` 生成 restricted/read-only。
- `ask` 和 `execute` 生成 workspace-write，但不要丢失 mode 信息。
- `bypass` 生成 disabled 或 unrestricted profile，具体命名在实现中保持一致。

## Phase 3: SandboxManager 骨架

目标：在 runtime 层建立 sandbox 选择和命令转换边界。

建议文件：

- 新增目录：`packages/runtime/src/sandbox/`
- 新增：`packages/runtime/src/sandbox/sandbox-manager.ts`
- 新增：`packages/runtime/src/sandbox/types.ts`
- 修改：`packages/runtime/src/index.ts`
- 测试：`packages/runtime/src/__tests__/sandbox-manager.test.ts`

核心类型：

```text
SandboxType
SandboxCommand
SandboxExecRequest
SandboxablePreference
SandboxTransformRequest
SandboxTransformResult
```

任务：

- [x] 定义 `SandboxType`：`none`、`macos-seatbelt`、`linux`。
- [x] 明确 Windows unsupported。
- [x] 定义 `SandboxCommand`：program、args、cwd、env、profile。
- [x] 定义 `SandboxExecRequest`：argv、cwd、env、sandbox type、effective profile。
- [x] 实现 `shouldSandbox(profile, preference, platform)`。
- [x] 实现 `selectInitial(profile, platform)`。
- [x] 实现 `transform()` 骨架。
- [x] 当 profile 是 `disabled` 或 unrestricted 时允许 `none`。
- [x] 当 profile 需要 sandbox 但平台不支持时 fail closed。
- [x] macOS 平台先路由到 macOS Seatbelt backend。
- [x] Linux 平台先返回 unsupported 或 feature-gated stub，等 Phase 10 实现。

> 具体方案：Phase 3 只建立 runtime 层的 sandbox 选择和 command transform 边界，不接现有 Bash tool，不启动真实平台 sandbox，不改变当前 Maka 的运行行为。
>
> `SandboxManager` 的职责限定为：根据 active `PermissionProfile`、`SandboxablePreference` 和 platform 选择 sandbox 类型；把 argv-based command 转换成最终执行请求；在 sandbox 必需但不可用时 fail closed。它不负责 UI、不负责审批、不负责 telemetry、不负责命令执行，也不负责 unsandboxed retry 编排。
>
> 第一版引入 `SandboxablePreference = auto | require | forbid`，语义对齐 Codex。`auto` 由 `PermissionProfile` 决定是否需要 sandbox；`require` 强制需要平台 sandbox，平台或 backend 不可用则失败；`forbid` 直接选择 `none`。`forbid` 是 runtime 内部参数，不暴露给 UI / settings；未来只能由 explicit approval / unsandboxed retry orchestration 产生。
>
> 第一版不实现 unsandboxed retry，但保留接口语义。未来如果 sandboxed attempt 因 sandbox denial 失败，`ToolOrchestrator` / `PermissionEngine` 可以在用户批准后以 `SandboxablePreference.forbid` 再发起一次执行。`SandboxManager` 只接受 preference 并选择 sandbox，不判断用户是否已经批准。
>
> command 采用 argv-based 形状：`program`、`args`、`cwd`、`env`、`profile`、`pathContext`。`pathContext` 显式携带 `workspaceRoots`、`tmpdir`、`slashTmp`、`minimalRoots` 等 symbolic path 解析上下文，供后续 macOS/Linux backend 把 `:workspace_roots`、`:tmpdir` 这类 profile entry 转换成真实路径。后续 Bash tool 接入时，可以把 shell string 包成 `/bin/zsh -lc <command>` 作为内层 argv，再交给 `SandboxManager.transform()` 生成最终 argv。Phase 3 不改当前 `runShellWithBoundedTail(command, { shell: true })` 路径。
>
> `selectInitial()` 和 `transform()` 都使用 result union，不通过 throw 表达可预期的 sandbox 选择失败。失败原因第一版包含 `unsupported_platform`、`backend_not_available`、`backend_not_implemented`、`sandbox_required`、`invalid_request`，用于后续 UI、diagnostics、telemetry 和 ToolOrchestrator 编排。
>
> backend 通过 constructor injection 注入：`SandboxManager` 接收 `SandboxBackend[]`，Phase 3 测试用 fake macOS backend 验证选择和委托；Phase 4 再加入真实 `MacosSeatbeltBackend`。
>
> 平台策略第一版固定为：`darwin + restricted/require -> macos-seatbelt`，没有 macOS backend 时 `backend_not_available`；`linux + restricted/require -> backend_not_implemented`，等 Phase 10；`win32` 和其他平台在需要 sandbox 时返回 `unsupported_platform`。`danger-full-access`、`disabled`、顶层 `external` profile 以及 `forbid` 都选择 `none`。
>
> 顶层 `PermissionProfile.External` 表示文件系统隔离由外部环境负责，Phase 3 不叠加 Maka 本地 platform sandbox。即使 external profile 仍携带 network policy，第一版也只保留该语义，不在 `SandboxManager` 中实现 network-only enforcement。
>
> 实现结果：Phase 3 已新增 `packages/runtime/src/sandbox/types.ts`、`sandbox-manager.ts`、`sandbox/index.ts`，并从 `@maka/runtime` barrel 和 `@maka/runtime/sandbox` subpath 导出 `SandboxManager` 与 sandbox 类型。
>
> 实现结果：`SandboxManager` 已支持 `auto` / `require` / `forbid`，`darwin` 受限 profile 选择 `macos-seatbelt`，缺少 backend 时返回 `backend_not_available`；`linux` 受限 profile 返回 `backend_not_implemented`；`win32` 和其他 unsupported platform 在需要 sandbox 时返回 `unsupported_platform`；`danger-full-access`、`disabled`、`external` 与 `forbid` 选择 `none`。
>
> 未实现内容：Phase 3 仍未接 Bash tool、未接文件工具、未实现 argv runner、未实现 unsandboxed retry、未实现 Linux backend，也没有改变现有 Maka tool execution 行为。

验收标准：

- 上层不直接知道 `sandbox-exec` 细节。
- `SandboxManager` 只负责选择和转换，不负责 UI，不负责审批。
- sandbox 不可用时不会静默降级到 host shell。

测试建议：

- macOS + workspace-write -> `macos-seatbelt`。
- Linux + workspace-write -> `linux` 或明确 unsupported stub。
- unsupported platform + workspace-write -> fail closed。
- danger-full-access -> `none`。

## Phase 4: macOS Seatbelt policy generator

目标：实现 `PermissionProfile -> SBPL` 的 macOS 后端。

建议文件：

- 新增：`packages/runtime/src/sandbox/macos-seatbelt.ts`
- 测试：`packages/runtime/src/__tests__/macos-seatbelt.test.ts`
- 可选 smoke：`packages/runtime/src/__tests__/macos-seatbelt-smoke.test.ts`

任务：

- [x] 生成基础 SBPL policy。
- [x] 支持 workspace readable roots。
- [x] 支持 workspace writable roots。
- [x] 支持 tmpdir / slash_tmp write。
- [x] 支持 protected metadata deny-write。
- [x] 支持 network restricted。
- [x] 支持 network enabled。
- [x] 固定使用 `/usr/bin/sandbox-exec`，不要从 PATH 查找。
- [x] 确认 policy string 不把未转义路径直接拼进危险位置。
- [x] 提供 `createSeatbeltExecArgs()`，输出 `['-p', policy, '--', ...innerArgv]` 或完整 wrapper argv。

> 具体方案：Phase 4 实现 macOS Seatbelt backend，但仍不接现有 Bash tool，不执行真实 runtime sandbox path，也不改变当前 Maka 的运行行为。它只负责把 active `PermissionProfile` 和 Phase 3 `SandboxCommand.pathContext` 转换成 SBPL policy 与 `/usr/bin/sandbox-exec` wrapper argv。
>
> Phase 4 引入 Maka-owned base SBPL policy，参考 Codex 的 Seatbelt 设计思想。base policy 承担 shell、系统库、基础 macOS runtime 兼容性；业务权限仍由后续 read/write/network policy section 追加表达。base policy 不提前放开 `network*`。
>
> Phase 4 明确实现：`MacosSeatbeltBackend`、`buildSeatbeltPolicy()`、`createSeatbeltExecArgs()`、`createDefaultSandboxManager()`、固定 `/usr/bin/sandbox-exec`、`PermissionProfile + pathContext -> SBPL`、readable/writable roots、tmpdir/slash_tmp roots、protected metadata deny-write、network restricted/enabled、contract tests、macOS-only smoke tests。
>
> Phase 4 明确不实现：Bash tool 接入、argv runner、自动 runtime sandbox 执行、Linux backend、Windows sandbox、managed network/proxy、unsandboxed retry、Read/Write/Edit/Glob/Grep 文件工具的 profile enforcement。
>
> 普通 root path 不直接拼进 SBPL policy。Phase 4 对齐 Codex，使用 `-DREADABLE_ROOT_0=/path`、`-DWRITABLE_ROOT_0=/path` 传给 `sandbox-exec`，policy 中使用 `(param "READABLE_ROOT_0")` / `(param "WRITABLE_ROOT_0")` 引用，降低路径字符串注入风险。
>
> protected metadata 第一版固定使用 `.git`、`.agents`、`.codex`。它们不通过单独顶层 deny 覆盖，而是在 writable root 的 allow rule 中使用 `require-not regex` 排除。regex 覆盖 workspace root 下任意层级的 protected metadata 名称，包含第一次创建 `.codex` 目录的场景。root 和 metadata name 都必须做 regex escape。
>
> read/write 映射第一版固定为：`read-only` 允许读取 `workspaceRoots`，不允许写；`workspace-write` 允许读写 `workspaceRoots`、`tmpdir`、`slashTmp`，并对 workspace writable roots 加 protected metadata deny-write。Phase 4 不给 workspace-write 增加业务上的 `:root` read；系统运行所需的只读访问放在 base policy 中。
>
> network policy 第一版只实现 `restricted` 和 `enabled`：`restricted -> (deny network*)`，`enabled -> (allow network*)`。不实现 managed network proxy、domain allowlist、loopback port exception、MITM CA 或 network env rewriting。`enabled` 只做 policy contract test，不要求真实联网 smoke 成功。
>
> `MacosSeatbeltBackend` 只处理 `managed + fileSystem.kind = restricted` profile。`disabled`、`external`、`danger-full-access` / unrestricted 应该已经由 Phase 3 `SandboxManager` 选择 `none`；如果错误传到 backend，backend 返回 `ok: false` / `invalid_request`，不在 backend 内部降级成 host execution。
>
> Phase 4 smoke test 可以真实调用 `/usr/bin/sandbox-exec`，但必须 macOS-only，非 macOS 或缺少 binary 时自动 skip。smoke 只覆盖稳定场景：workspace 内普通文件写入成功、workspace 外写入失败、protected metadata 写入失败、network restricted 失败。
>
> 实现结果：Phase 4 已新增 `packages/runtime/src/sandbox/macos-seatbelt.ts` 和 `default-sandbox-manager.ts`。`buildSeatbeltPolicy()` 会生成 Maka-owned base policy、macOS platform defaults、read/write root section、protected metadata `require-not regex`、network section，并把普通 root path 通过 `-DREADABLE_ROOT_N` / `-DWRITABLE_ROOT_N` 参数传入 `sandbox-exec`。
>
> 实现结果：`MacosSeatbeltBackend` 已实现 `SandboxBackend`，只接受 `managed + restricted` profile；`danger-full-access` / unrestricted 等应由 `SandboxManager` 选择 `none` 的 profile 如果误传到 backend，会返回 `invalid_request`，不会降级到 host shell。
>
> 实现结果：`createDefaultSandboxManager()` 已默认注册 `MacosSeatbeltBackend`，并从 runtime barrel 和 sandbox subpath 导出。新增 contract tests 覆盖 policy 形状、path escaping、network policy、backend 包装和 default manager；新增 macOS-only smoke 覆盖 workspace 内写入成功、workspace 外写入失败、protected metadata 写入失败、network restricted 失败。
>
> 实现注意：macOS smoke 使用 `realpath` 后的 workspace root。当前 backend 假设 `pathContext.workspaceRoots`、`tmpdir` 等路径已经由后续 runtime enforcement 做过规范化；未规范化的 `/var/folders` 这类 symlink path 可能无法匹配 Seatbelt 实际看到的 `/private/var/folders`。
>
> 未实现内容：Phase 4 仍未接 Bash tool、未实现 argv runner、未把现有 runtime execution 切到 sandbox、未实现 Linux/Windows、未实现 managed network/proxy、未实现 unsandboxed retry，也未实现 Read/Write/Edit/Glob/Grep 文件工具的 profile enforcement。

验收标准：

- macOS backend 可以独立从 profile 生成 sandbox wrapper argv。
- workspace-write 允许写 workspace 普通文件。
- workspace-write 默认阻止写 `.git` / `.agents` / `.codex`。
- network restricted 下普通网络访问被拒绝。

测试建议：

- policy string contract test。
- path escaping test。
- macOS-only smoke：
  - workspace 内写文件成功。
  - workspace 外写文件失败。
  - protected metadata 写入失败。
  - network restricted 下 `curl` 或 Node socket 失败。
- 非 macOS 环境自动 skip smoke。

## Phase 5: argv-based shell runner

目标：让 Maka 能执行 sandbox wrapper argv，而不是把 wrapper 拼成 shell 字符串。

建议文件：

- 修改：`packages/runtime/src/shell-exec.ts`
- 测试：`packages/runtime/src/__tests__/workspace-executor.test.ts`
- 测试：`packages/runtime/src/__tests__/shell-exec.test.ts`，如果需要新增

任务：

- [x] 新增 `runProcessWithBoundedTail()` 或等价函数。
- [x] 输入 argv：`command: string[]` 或 `program + args`。
- [x] 保留 cwd。
- [x] 保留 env。
- [x] 保留 timeout。
- [x] 保留 abort signal。
- [x] 保留 stdout/stderr streaming。
- [x] 保留 bounded tail output。
- [x] 保留 POSIX process group termination。
- [x] 保留 Windows taskkill 逻辑，但 Windows sandbox 本轮不实现。
- [x] 保留现有 `runShellWithBoundedTail()`，作为 shell-string compatibility path。

> 具体方案：Phase 5 只在 `packages/runtime/src/shell-exec.ts` 增加 argv-based process runner，不改变现有 `WorkspaceExecutor.exec()`、Bash tool 或 ToolRuntime 行为。现有命令继续走 `runShellWithBoundedTail(command)`；Phase 6 再把 Bash 接到 `SandboxManager.transform() -> runProcessWithBoundedTail(argv)`。
>
> 新增公开 API：`runProcessWithBoundedTail(argv: readonly string[], options: BoundedProcessOptions): Promise<BoundedProcessResult>`。`argv[0]` 是 program，`argv.slice(1)` 是 args，执行时使用 `spawn(program, args, { shell: false })`，不会把 argv 再拼回 shell string。`argv` 为空表示调用方没有提供可执行程序，属于“进程无法启动”类错误，直接 reject 明确错误；命令本身非 0 exit code 仍然 resolve result，保持现有 runner 契约。
>
> 类型命名采用通用 process 语义：新增 `BoundedProcessOptions` 与 `BoundedProcessResult`，并保留 `BoundedShellOptions`、`BoundedShellResult` 作为兼容别名。内部抽共享执行函数，统一处理 stdout/stderr streaming、bounded tail、live output cap、timeout、abort、POSIX process group termination、Windows `taskkill` 和 exit result 归一化。两个公开函数只负责选择不同 spawn 方式：shell-string path 使用 `shell: true`，argv path 使用 `shell: false`。
>
> Phase 5 明确不实现 sandbox 接入、不改变 Bash tool 调用路径、不处理内置 Read/Write/Edit/Glob/Grep 的 OS sandbox 兜底。它只补齐“可以直接执行 Phase 4 产出的 sandbox wrapper argv”的底层能力。

验收标准：

- 现有 Bash 行为不回退。
- 新 argv runner 可以执行普通命令。
- 新 argv runner 可以执行 wrapper command，例如 `/usr/bin/env ...`。
- timeout / abort / output caps 与旧 runner 行为一致。

测试建议：

- argv runner stdout/stderr。
- non-zero exit code。
- timeout。
- abort。
- large output tail retention。
- process tree kill 行为沿用现有测试。

## Phase 6: Bash 接入 sandboxed execution

目标：让 Bash tool 在 active profile 需要 sandbox 时，通过 `SandboxManager` 执行。

建议文件：

- 修改：`packages/runtime/src/builtin-tools.ts`
- 修改：`packages/runtime/src/workspace-executor.ts`
- 新增或修改：`packages/runtime/src/tool-orchestrator.ts`
- 测试：`packages/runtime/src/__tests__/builtin-tools.test.ts`
- 测试：`packages/runtime/src/__tests__/tool-runtime.test.ts`，如已有相关覆盖则扩展

任务：

- [x] 定义 Bash 执行所需的 permission context 输入。
- [x] 让 Bash impl 能拿到 active `PermissionProfile`。
- [x] Bash command 转换成 `/bin/sh -lc <command>` 内层 argv。
- [x] 调用 `SandboxManager.transform()` 得到最终 argv。
- [x] 使用 argv runner 执行。
- [x] 保留 terminal result shape：cwd、cmd、exitCode、stdout、stderr。
- [x] sandbox denial 返回清晰错误。
- [x] 不做 unsandboxed retry。
- [x] sandbox 必需但不可用时 fail closed 或明确 prompt/block。

> 范围决定：Phase 6 第一版只接 foreground Bash，也就是没有 `shellRuns` 时的 `buildExecutorBashTool() -> WorkspaceExecutor.exec()` 路径。它用于普通短命令，一次 tool call 内等待命令结束并返回 terminal result。
>
> Phase 6 第一版暂不接 background Bash，也就是有 `shellRuns` 时的 `buildBackgroundBashTool() -> ShellRunProcessManager.runBash()` 路径。background Bash 还涉及 long-running task、runtime ref、durable shell run record、`Read(ref)`、`StopBackgroundTask`、observe/yield 和后台进程生命周期，后续需要单独补齐 sandbox-aware 启动逻辑。
>
> 后续补齐项：background Bash 必须接入同一套 active `PermissionProfile`、`SandboxManager.transform()` 和 argv-based spawn，不能长期停留在 host shell execution。实现时需要保持后台任务 ref、输出 tail、停止任务、超时/abort 和 durable record 行为不回退。
>
> 后续补齐项：当前 Maka 没有统一的 `WorkspaceExecutor` factory。`desktop`、`cli`、`headless` 和测试分别在各自入口组装 tools / executor，Phase 6 不做这层重构。等 sandbox 主链路完成后，需要单独补一个 runtime tool/executor assembly 阶段，统一 desktop / cli 的 tool 构建入口，把 active `PermissionProfile`、`SandboxManager`、foreground Bash、background Bash 和后续文件工具 enforcement 接到同一条默认运行时路径。
>
> 具体方案：Phase 6 新增 `SandboxedCommandWorkspaceExecutor` wrapper，采用 C2 动态上下文方案。它持有 `inner: WorkspaceExecutor` 和 `getSandboxContext()`；只覆盖 `exec()`，其他 `WorkspaceExecutor` 方法全部委托 `inner`。命名使用 `Command`，明确第一版只 sandbox command execution，不表示 Read / Write / Edit / Glob / Grep 已经获得 OS sandbox 兜底。
>
> `getSandboxContext()` 每次 `exec()` 时动态返回当前 active sandbox context，至少包含 `profile`、非空 `workspaceRoots`、`sandboxManager`，并可携带 `preference`、`platform`、`pathContext`。Phase 6 采用 fail-closed：缺少 context、缺少 `workspaceRoots`、`workspaceRoots` 为空都直接抛出 structured error，不回退到 host shell。`bypass` / `danger-full-access` 也应返回 context，由 `SandboxManager.transform()` 明确选择 `none`，而不是通过缺少 context 隐式绕过 sandbox。
>
> `WorkspaceExecInput` 增加可选 `env`。`SandboxedCommandWorkspaceExecutor.exec()` 把 Bash command 固定包成 `/bin/sh -lc <command>` 内层 argv，调用 `SandboxManager.transform()` 生成最终 argv，再用 Phase 5 的 `runProcessWithBoundedTail()` 执行。runner 支持构造函数注入，默认使用真实 runner，测试使用 fake runner 验证最终 argv、cwd、env、timeout、abort、streaming 参数。
>
> transform 失败时抛出带字段的 `WorkspaceCommandSandboxError`，`code = 'SANDBOX_COMMAND_BLOCKED'`，`reason` 为 `missing_context`、`missing_workspace_roots` 或 `SandboxTransformFailureReason`，并保留 `sandboxType`、`requiresSandbox` 等诊断字段。Phase 6 不做 unsandboxed retry；sandbox 必需但不可用时 fail closed。
>
> Phase 6 第一版测试以 unit tests 为主，不强制 macOS smoke。测试覆盖：fake `SandboxManager` 收到 `/bin/sh -lc <command>`；fake runner 执行最终 argv；`cwd` / `env` / `timeout` / `abortSignal` / `emitOutput` 传递不丢；missing context fail closed；missing / empty `workspaceRoots` fail closed；transform failure 抛 structured error；非 exec 文件方法委托 `inner`；`buildBuiltinTools({ executor: sandboxed })` 下 Bash terminal result shape 不变；`buildBuiltinTools({ shellRuns })` background Bash 不受 Phase 6 改动影响。

验收标准：

- Bash 在 macOS workspace-write 下默认经过 `sandbox-exec`。
- Bash 不再只依赖 `categorizeBash()` 作为安全边界。
- streaming、timeout、abort 仍可用。

测试建议：

- fake SandboxManager 注入，确认 Bash 调用 transform。
- fake runner 注入，确认最终 argv 被执行。
- macOS smoke：workspace 内写入成功，workspace 外写入失败。
- denied case 产生 recoverable tool error。

## Phase 7: 文件工具接入 profile enforcement

目标：让 Read / Write / Edit / Glob / Grep 遵守同一份 active profile。

建议文件：

- 修改：`packages/runtime/src/builtin-tools.ts`
- 修改：`packages/runtime/src/workspace-executor.ts`
- 新增：`packages/runtime/src/permission-profile-enforcement.ts`，或放在 sandbox/permission-context 相关模块
- 测试：`packages/runtime/src/__tests__/builtin-tools.test.ts`
- 测试：`packages/runtime/src/__tests__/workspace-executor.test.ts`

任务：

- [x] 为 file tools 注入 active profile。
- [x] `Read` 检查 readable roots。
- [x] `Read` 检查 deny-read。
- [x] `Glob` / `Grep` 检查搜索根可读。
- [x] `Write` 检查 writable roots。
- [x] `Write` 阻止 protected metadata。
- [x] `Edit` 检查 writable roots。
- [x] `Edit` 阻止 protected metadata。
- [x] 保留 realpath containment。
- [x] 保留 symlink escape 防护。
- [x] 保留 file write lock。
- [x] 保留 Edit matcher 行为。

验收标准：

- Node 主进程内的文件工具不会绕过 PermissionProfile。
- 文件工具和 Bash 对 workspace-write 的理解一致。
- protected metadata 在 Bash sandbox 和文件工具 enforcement 中都被保护。

测试建议：

- read-only 下 Write/Edit 失败。
- workspace-write 下普通 Write/Edit 成功。
- workspace-write 下写 `.git/config` 失败。
- workspace 外 Read/Write 失败。
- symlink escape 仍失败。

> 具体方案：Phase 7 新增 `ProfileEnforcedWorkspaceExecutor` wrapper，包住 `inner: WorkspaceExecutor`。它不改变 `Read` / `Write` / `Edit` / `Glob` / `Grep` 的工具流程，只在 executor 边界执行 active `PermissionProfile` 判断。`builtin-tools.ts` 第一版尽量不改或只做极小调整；工具层仍负责 write lock、Edit matcher 和当前 tool result shape。
>
> `ProfileEnforcedWorkspaceExecutor` 使用动态 context：`getProfileContext() -> WorkspaceProfileEnforcementContext | undefined`。context 至少包含 `profile` 和非空 `workspaceRoots`，可选携带 `pathContext`：`root`、`tmpdir`、`slashTmp`、`minimalRoots`。`tmpdir` 和 `slashTmp` 默认使用 runtime 当前值：`os.tmpdir()` 和 `/tmp`。文件工具 enforcement 不依赖 `SandboxManager`，只依赖 core 的 `canReadPath()` / `canWritePath()`。
>
> Phase 7 采用 fail-closed：一旦使用 `ProfileEnforcedWorkspaceExecutor`，缺少 profile context、缺少 `workspaceRoots` 或 `workspaceRoots` 为空都直接拒绝，不回退到 inner executor。`danger-full-access` / unrestricted 也应该通过明确 profile 表达允许，而不是通过缺少 context 绕过。
>
> Phase 7 采用双层检查。`resolveExistingPath()` / `resolveWritablePath()` 在 inner realpath containment 和 symlink escape 防护之后做提前检查；`readFile()` / `writeFile()` / `globFiles()` / `grepFiles()` 在最终操作前再次检查。这样既能尽早给出清晰错误，也能防止未来调用方绕过 resolve 后直接调用读写/搜索方法。
>
> 方法映射：`resolveExistingPath()` 和 `readFile()` 做 read 检查；`resolveWritablePath()` 和 `writeFile()` 做 write 检查；`globFiles()` 检查 `cwd` 可读；`grepFiles()` 检查搜索根 `path` 可读；`writeLockKey()` 只委托 inner，不做 profile 检查；`exec()` 只委托 inner，不受 Phase 7 影响。
>
> Phase 7 新增结构化错误 `WorkspaceProfilePermissionError`，`code = 'WORKSPACE_PROFILE_PERMISSION_DENIED'`。字段包含 `operation: 'read' | 'write' | 'search'`、`path`、`reason: 'missing_context' | 'missing_workspace_roots' | 'read_denied' | 'write_denied'`、可选 `profileName`。protected metadata 第一版不单独扩展 reason，仍归入 `write_denied`。
>
> `Glob` / `Grep` 第一版只检查搜索根可读，不做结果级 profile filtering。当前 Maka profile 尚未引入复杂 deny-read 子路径或 deny-read glob；搜索根检查已能表达现阶段 read-only / workspace-write 的读边界。未来如果引入更细粒度 deny-read，需要重新设计搜索工具逐文件 enforcement，优先考虑 sandboxed helper，而不是只过滤 `rg` 输出。
>
> 测试策略：`workspace-executor.test.ts` 重点覆盖 wrapper 自身，包括 context 缺失 fail closed、read-only 写入拒绝、workspace-write 普通写入允许、protected metadata 写入拒绝、workspace 外读写拒绝、Glob/Grep 搜索根检查、`writeLockKey()` 和 `exec()` 委托 inner。`builtin-tools.test.ts` 做少量集成覆盖，确认 `buildBuiltinTools({ executor: profileEnforcedExecutor })` 下 file tools 走同一套 enforcement，同时保留 write lock 和 Edit matcher 行为。Phase 7 不做 macOS smoke，因为它是 Node 主进程内 profile enforcement，不是平台 sandbox backend。
>
> 实现结果：Phase 7 已在 `packages/runtime/src/workspace-executor.ts` 新增 `ProfileEnforcedWorkspaceExecutor`、`WorkspaceProfileEnforcementContext` 和 `WorkspaceProfilePermissionError`，并从 runtime barrel 导出。该 wrapper 覆盖 `resolveExistingPath()`、`resolveWritablePath()`、`readFile()`、`writeFile()`、`globFiles()`、`grepFiles()`，同时让 `exec()` 和 `writeLockKey()` 继续委托 inner executor。
>
> 实现结果：Phase 7 已覆盖 `workspace-executor.test.ts` 和 `builtin-tools.test.ts`。测试验证了 fail-closed、read-only 拒绝写入、workspace-write 允许普通写入、protected metadata 写入拒绝、workspace 外读写拒绝、Glob/Grep 搜索根检查，以及 file write lock / Edit matcher 行为不回退。
>
> 未实现内容：Phase 7 仍未把 `ProfileEnforcedWorkspaceExecutor` 接入 Maka 默认 session/runtime startup；仍未实现 background Bash sandbox；仍未实现 `Glob` / `Grep` 结果级过滤；仍未实现文件工具 OS sandboxed helper。默认接线和更强的文件工具 OS 兜底留给后续阶段。

## Phase 7.5: 统一 WorkspaceExecutor factory / runtime tool assembly

目标：把 Phase 1-7 已实现的 profile、sandbox command wrapper、file profile enforcement 组合成默认 runtime 可使用的 executor/tool assembly。

建议文件：

- 新增：`packages/runtime/src/workspace-executor-factory.ts`
- 修改：`packages/runtime/src/index.ts`
- 修改：`packages/runtime/package.json`
- 修改：`apps/desktop/src/main/main.ts`
- 修改：`packages/cli/src/runtime-bootstrap.ts`
- 测试：`packages/runtime/src/__tests__/workspace-executor-factory.test.ts`

任务：

- [x] 新增统一 `createPermissionAwareWorkspaceExecutor()`。
- [x] 使用 `compilePermissionProfile()` 从 `permissionMode + cwd` 生成 active profile。
- [x] 默认 `workspaceRoots = [cwd]`，并允许调用方显式传入。
- [x] 组合 `LocalWorkspaceExecutor -> SandboxedCommandWorkspaceExecutor -> ProfileEnforcedWorkspaceExecutor`。
- [x] 新增 `buildPermissionAwareBuiltinTools()`，把 permission-aware executor 注入 `buildBuiltinTools()`。
- [x] desktop `ai-sdk` backend 按当前 session header 构造 permission-aware builtin tools。
- [x] CLI `ai-sdk` backend 按当前 session header 构造 permission-aware builtin tools。
- [x] session cwd 在 runtime assembly 边界做 realpath/absolute path 规范化。
- [x] 保留 `shellRuns` 存在时的 background Bash 路径。

验收标准：

- 默认 runtime tool assembly 不再只能手动注入 wrapper。
- foreground Bash toolset 可以默认走 `SandboxedCommandWorkspaceExecutor`。
- Read / Write / Edit / Glob / Grep 可以默认走 `ProfileEnforcedWorkspaceExecutor`。
- 切换 permission mode 后，下一轮 backend 重建时会重新编译 active profile。
- `shellRuns` 存在时不破坏现有 background Bash / StopBackgroundTask 行为。

测试建议：

- factory 单元测试：`ask` / `execute` 生成 workspace-write。
- factory 单元测试：`explore` 生成 read-only 并拒绝写入。
- factory 单元测试：`bypass` 生成 danger-full-access 且不要求 sandbox backend。
- builtin tools 集成测试：foreground Bash 使用 sandbox transform。
- builtin tools 集成测试：file tools 使用 profile enforcement。
- builtin tools 集成测试：`shellRuns` 存在时 background Bash 保持现状。

> 具体方案：Phase 7.5 新增 `workspace-executor-factory.ts`，把已有三块能力收束到一个默认 assembly 边界：`compilePermissionProfile()` 负责把当前 session 的 `permissionMode + cwd` 转成 active profile；`SandboxedCommandWorkspaceExecutor` 负责 foreground command execution 的 sandbox transform；`ProfileEnforcedWorkspaceExecutor` 负责 Node 主进程内 file tools 的 profile enforcement。factory 不新增权限语义，只组合已有模块。
>
> 组合顺序固定为 `LocalWorkspaceExecutor -> SandboxedCommandWorkspaceExecutor -> ProfileEnforcedWorkspaceExecutor`。这样 `exec()` 先进入 command sandbox wrapper；文件读写搜索先进入 profile enforcement，再委托给 local executor 做真实文件系统访问、realpath containment 和 symlink escape 防护。`danger-full-access` 仍通过 profile 显式表达 unrestricted，而不是通过缺少 context 绕过 wrapper。
>
> desktop 和 CLI 的 `ai-sdk` backend factory 改为按当前 `ctx.header.permissionMode` 和 `ctx.header.cwd` 构造 builtin tools。`setPermissionMode()` 已经会 dispose backend，因此用户切换 mode 后，下一轮会重建 backend，并重新生成 active profile。runtime assembly 边界会把 session cwd 规范化成 realpath/absolute path，再传给 profile matcher 使用。
>
> 未实现内容：Phase 7.5 不改变 `PermissionEngine` policy matrix；不实现 background Bash sandbox；不接 headless / isolated executor；不让 child agent tools 按 child session profile 动态构造；不实现文件工具 OS sandboxed helper。由于 desktop/CLI 当前传入 `shellRuns`，默认 Bash 仍走 background Bash 路径，file tools 已接入 permission-aware executor；没有 `shellRuns` 的 foreground toolset 会使用 sandbox-aware executor。
>
> 实现结果：Phase 7.5 新增 `createPermissionAwareWorkspaceExecutor()` 和 `buildPermissionAwareBuiltinTools()`，并从 runtime barrel 和 package subpath 导出。新增 `workspace-executor-factory.test.ts` 覆盖 profile 编译、foreground Bash sandbox transform、read-only 写入拒绝、workspace-write protected metadata 拒绝、bypass no-sandbox、以及 `shellRuns` 存在时 background Bash 保持现状。

## Phase 7.6: background Bash 接入 sandbox

目标：让 desktop / CLI 默认使用的 background Bash 也经过 active `PermissionProfile` 和 `SandboxManager`，补齐 foreground Bash 与默认 Bash 之间的安全边界差异。

建议文件：

- 修改：`packages/runtime/src/shell-run-manager.ts`
- 修改：`packages/runtime/src/shell-tools.ts`
- 修改：desktop / CLI 的 `ShellRunProcessManager` assembly
- 测试：`packages/runtime/src/__tests__/shell-run-manager.test.ts`
- 测试：desktop / CLI runtime assembly contract tests

任务：

- [ ] 为 `ShellRunProcessManager` 注入必需的 session-aware async sandbox context provider。
- [ ] provider 根据 `ShellRunBashInput.sessionId` 获取当前 session 的 permission mode、cwd 和 workspace roots。
- [ ] 在 runtime assembly/provider 层编译 active profile，不在 `ShellRunProcessManager` 内编译权限。
- [ ] provider 使用显式 result union；context/provider 失败时 fail closed。
- [ ] 从 `ShellRunBashInput` 删除 `cwd`，由 provider 返回 canonical cwd 作为唯一权威值。
- [ ] desktop / CLI 的 foreground、background 和 filesystem 路径复用同一个 process-level `SandboxManager`。
- [ ] 将原始 command 包装成 `/bin/sh -lc <command>` 内层 argv。
- [ ] 调用 `SandboxManager.transform()` 生成最终执行请求。
- [ ] 注入只接受 argv 的 `ShellRunProcessSpawner`，background Bash 固定使用 `spawn(program, args, { shell: false })`。
- [ ] context 缺失、workspace roots 无效、transform 失败时不创建 record、不 spawn、不回退 host shell。
- [ ] sandbox backend 不可用或 transform 失败时返回结构化错误。
- [ ] durable shell run record 继续保存用户原始 command，不保存 wrapper argv。
- [ ] 保留 `yield-time_ms`、background task ref、`Read(ref)` 和 `StopBackgroundTask`。
- [ ] 保留 stdout/stderr tail、timeout、abort、stop 和 process tree termination。
- [ ] permission mode 发生变化时，先终止该 session 的 background shell runs，再更新 session header。
- [ ] 不实现 unsandboxed retry。

> 具体方案：直接扩展现有 `ShellRunProcessManager`，不再新增另一套 background process manager。manager 继续拥有 live process、输出 tail、durable record、yield、observe 和 termination 生命周期，只把启动子进程前的 command transform 改成可注入的 sandbox-aware 路径。
>
> `ShellRunProcessManager` 是 process-level 实例，而 permission profile 属于 session。sandbox context provider 因此必须接收 `ShellRunBashInput`，并允许异步读取 session header。provider 返回显式 result union；成功结果包含 canonical `cwd`、`profile`、`workspaceRoots`、共享 `SandboxManager`、platform/path context。manager 不理解 `PermissionMode`，也不调用 `compilePermissionProfile()`。
>
> provider 是构造 `ShellRunProcessManager` 的必需依赖，不保留 legacy host-shell fallback。`bypass` 也必须返回有效的 `danger-full-access` context，再由 `SandboxManager` 明确选择 `none`；不能通过缺少 provider/context 隐式绕过 sandbox。
>
> context/validation/transform 全部成功后才能生成 shell run id、spawn 和创建 durable record。使用可注入的 argv spawner以验证最终 wrapper argv，同时保留现有 live child handle、process group、yield、Stop、timeout 和 abort 生命周期。
>
> permission mode 切换会改变 session 安全边界。无论收紧还是放宽，`SessionManager.setPermissionMode()` 都先终止该 session 现有 background shell runs；termination 失败则不更新 mode，避免旧权限进程继续运行。

验收标准：

- desktop / CLI 默认 Bash 在 macOS restricted profile 下经过 `sandbox-exec`。
- background Bash 和 foreground Bash 使用同一份 active profile 与 workspace roots。
- background task 生命周期和返回结果不因 sandbox 接入而回退。
- sandbox 必需但不可用时不会执行 host command。

测试建议：

- fake sandbox manager 验证收到 `/bin/sh -lc <command>`。
- fake spawn/launcher 验证执行最终 argv 且 `shell: false`。
- provider/context failure、empty roots、invalid argv 均在 spawn 前失败。
- restricted profile transform 失败时不创建 shell run record。
- quick command、yield 后台任务、Read、Stop、timeout、abort 和大输出 tail 回归测试。
- permission mode 切换先 terminate background runs，再更新 header。

## Phase 7.7: 文件工具接入 OS sandboxed worker/helper

目标：在现有 Node 主进程 profile enforcement 之外，为 `Read / Write / Edit / Glob / Grep` 增加平台 sandbox 的底层兜底。

建议范围：

- 新增：平台无关的 filesystem operation request/response contract
- 新增：sandboxed filesystem worker/helper 或等价 subprocess 边界
- 修改：`ProfileEnforcedWorkspaceExecutor` 下层文件操作实现
- 修改：runtime tool/executor assembly
- 测试：filesystem worker contract tests
- 测试：macOS-only filesystem sandbox smoke tests

任务：

- [ ] 定义结构化 filesystem operation contract，不把文件操作拼成 shell command。
- [ ] 拆分 `WorkspaceCommandExecutor` 与复合 `WorkspaceFileOperations`，移除隐式 local filesystem fallback。
- [ ] 让 one-shot worker 接收一次完整的 `read`、`write`、`edit`、`glob` 或 `grep` operation。
- [ ] Edit 的 resolve/read/match/write 在同一个 worker invocation 中完成。
- [ ] worker 通过同一份 active profile、workspace roots 和 `SandboxManager` 启动。
- [ ] restricted profile 下派生 operation-scoped effective profile：read/search 收窄为 read-only，write/edit 保留 active write policy。
- [ ] danger-full-access / external 保持原 profile 语义，不借 operation profile 隐式改变 bypass/external。
- [ ] 第一版先实现 macOS Seatbelt 下的 worker execution。
- [ ] worker 使用单文件 Node bundle，由 `@maka/runtime` 统一构建和拥有。
- [ ] desktop 通过 Electron executable + `ELECTRON_RUN_AS_NODE=1` 启动；CLI 通过 Node executable 启动。
- [ ] worker launch spec/provider 显式提供 argv、最小 env、runtime readable roots 和 executable roots。
- [ ] worker 只接收最小环境 allowlist，不继承 host secrets、`NODE_OPTIONS`、proxy 或 `RIPGREP_CONFIG_PATH`。
- [ ] 使用 stdin 单 JSON request、stdout 单 JSON response 的 versioned protocol，并双向 schema 校验。
- [ ] operation error 通过结构化 response 表达；bootstrap/crash/protocol failure 使用非零 exit。
- [ ] 请求上限 16 MiB、响应上限 8 MiB、stderr tail 上限 1 MiB，默认 hard timeout 120 秒。
- [ ] `rg` 在 runtime 中解析 canonical executable；worker 使用 argv + `shell: false`，找不到时只让 Grep 返回 `grep_unavailable`。
- [ ] 保留 `ProfileEnforcedWorkspaceExecutor` 作为业务层预检查，不用 OS sandbox 替代它。
- [ ] 保留 realpath containment 和 symlink escape 防护。
- [ ] 保留 file write lock 和 Edit matcher 行为。
- [ ] 让 worker 错误区分 profile denial、sandbox denial、invalid request 和 filesystem error。
- [ ] 明确 worker 的生命周期、并发、超时、abort 和输出大小限制。
- [ ] Linux backend 完成后让同一 worker contract 自动复用 Linux sandbox。

> 具体方案：文件工具不能通过 Bash wrapper 自动获得 OS sandbox，因为它们当前直接在 Node 主进程调用 filesystem API。Phase 7.7 增加一个受 sandbox 约束的 subprocess/helper 边界，让真实文件系统操作发生在 sandbox 内；主进程保留 profile matcher、参数校验、锁和结果编排。
>
> 这不是重写 Read / Write / Edit / Glob / Grep 的 tool schema，也不把所有文件操作改成 shell 命令。目标是把现有 executor 的真实 filesystem operation 下沉到结构化 worker，并让 macOS/Linux backend 只负责限制 worker 进程。
>
> worker 第一版采用 one-shot 模式：一次 tool call 启动一个 sandboxed process，处理一个复合 operation 后退出。不采用 session persistent worker 或共享 pool，避免 profile 生命周期、IPC 并发和跨 session 状态复杂度。
>
> 文件接口拆成独立的 `WorkspaceCommandExecutor` 与 `WorkspaceFileOperations`。builtin assembly 分别注入 command、background shell 和 file operation dependency；不保留“缺少 worker 时自动创建 LocalWorkspaceExecutor”的 host fallback。测试如需 host filesystem，必须显式创建 test/local implementation。
>
> `@maka/runtime` 将 worker 构建成 `dist/workers/filesystem-worker.js` 单文件。CLI 从 runtime package 解析；packaged Electron 将同一文件作为独立 resource 复制到 `process.resourcesPath/workers/`。worker/runtime/rg 的只读与 executable mapping roots 由 runtime-owned launch spec 注入 Seatbelt，模型不能控制这些路径。
>
> worker env 采用最小 allowlist，只保留受控的 `TMPDIR`、locale，以及 desktop 必需的 `ELECTRON_RUN_AS_NODE=1`。`rg` 使用 runtime 解析的绝对路径，不依赖 PATH。stdout 只输出协议 response，diagnostics 写 bounded stderr。

验收标准：

- Node 主进程 profile enforcement 与 OS sandbox 形成两层保护。
- macOS 下文件工具无法借助实现漏洞写 workspace 外或 protected metadata。
- 文件工具现有结果形状、锁、Edit matcher 和 symlink 防护不回退。

测试建议：

- worker contract 单元测试。
- worker bundle/resolver 在 runtime、CLI development 和 packaged desktop resource contract 中可用。
- protocol version、request id、invalid JSON、overflow、timeout、abort 和 process tree kill。
- read-only 下 Write/Edit 被拒绝。
- workspace-write 下普通 Write/Edit 成功。
- workspace 外写入和 protected metadata 写入被 Seatbelt 拒绝。
- symlink escape、timeout、abort 和并发写锁回归测试。

## Phase 7.8: 补齐其他默认 runtime 接线

目标：让所有本地 agent/runtime 入口使用同一套 permission-aware executor、sandbox context 和 filesystem worker，避免只有 desktop / CLI 主 session 生效。

任务：

- [ ] 将静态 `childTools` 改为按临时 child header 动态构造的 async factory。
- [ ] child agent tools 使用 `definition.permissionMode` 编译 profile，不直接继承 parent profile。
- [ ] child cwd/workspace roots 继承 parent 且只能收窄，不能扩大。
- [ ] desktop child Read/Glob/Grep 使用 Phase 7.7 filesystem worker。
- [ ] headless/isolated executor 正式表达为 `PermissionProfile.External`，不重复叠加本地 Seatbelt。
- [ ] model-backed headless 缺少 explicit external isolation 时继续 fail closed。
- [ ] 明确 parent/child agent 的 workspace roots 继承和收窄规则。
- [ ] 审计所有 `buildBuiltinTools()`、`createLocalWorkspaceExecutor()` 和 `ShellRunProcessManager` 构造位置。
- [ ] 对无法提供 active context 的本地 managed runtime fail closed。

验收标准：

- 所有本地 managed runtime 入口都无法绕过默认 permission-aware assembly。
- child agent 不会因为复用 parent tool instance 获得错误的 profile 或 workspace roots。
- external/remote runtime 的责任边界有明确表达，不与本地 sandbox 混淆。

测试建议：

- headless runtime contract test。
- child agent active profile test。
- child definition mode 比 parent 更窄时不会继承 parent 的更高权限。
- external headless 不调用本地 Seatbelt，缺少 isolation assertion 时拒绝启动。
- runtime entrypoint audit test 或 source contract test。

## Phase 8: sandbox-aware PermissionEngine / policy

目标：让权限决策理解 active profile 和 sandbox availability，而不是只看 mode x category。

建议文件：

- 修改：`packages/core/src/permission.ts`
- 修改：`packages/runtime/src/permission-engine.ts`
- 测试：`packages/core/src/__tests__/permission.test.ts`
- 测试：`packages/runtime/src/__tests__/permission-engine.test.ts`

任务：

- [ ] 扩展 `PreToolUseInput`，加入 active profile summary 或 sandbox availability。
- [ ] 定义动态 `ActiveSandboxCapabilities`，command/filesystem 状态分别表达 available、not_required、external、unavailable。
- [ ] tool 静态声明 `sandboxRequirement`：none、command、filesystem、external。
- [ ] backend/session assembly 构建时生成 capability snapshot；permission mode/cwd/backend 重建时重新 probe。
- [ ] 定义平台无关的 sandbox capability/availability 结果，不只根据 `process.platform` 判断。
- [ ] availability 可以表达 backend 未注册、executable 缺失、平台能力不足和 probe 失败。
- [ ] runtime 把完整 capability 映射成最小 `PreToolUseSandboxContext`，由 core `preToolUse()` 执行纯 capability gate。
- [ ] 保留现有 `PermissionMode` 输入。
- [ ] 保留 `ToolCategory` 分类。
- [ ] capability gate 满足后继续使用现有 mode x category matrix，不重写矩阵。
- [ ] 调整 `execute.shell_unsafe`：只有 command capability 满足时才进入现有 allow 决策。
- [ ] sandbox 可 enforce 时，允许普通 workspace mutating shell 自动执行。
- [ ] sandbox 必需但不可用时直接 block，不产生无法改变结果的普通 approval prompt。
- [ ] `fs_destructive` 继续 prompt 或更保守。
- [ ] `git_destructive` 继续 prompt 或更保守。
- [ ] `privileged` 继续 prompt 或更保守。
- [ ] `bypass` 仍保留危险全权限语义。
- [ ] turn-start snapshot 只用于 policy；真实执行仍重新获取 context、transform、校验 launch spec 并 fail closed。
- [ ] 定义共享 sandbox error metadata，并保留 command/background/filesystem 领域错误类型。
- [ ] error serializer 默认不输出 policy、argv、env、文件内容或 edit strings。

验收标准：

- `execute` 模式不再把 regex 漏判作为唯一安全边界。
- 没有 sandbox enforcement 时，unknown/mutating shell 更保守。
- 现有 ask/explore/bypass 的基本用户语义不被破坏。

测试建议：

- `execute + shell_unsafe + sandbox available -> allow`。
- `execute + shell_unsafe + sandbox unavailable -> block`。
- backend 已注册但 capability probe 失败时不视为 sandbox available。
- `execute + rm -> prompt`。
- `explore + shell_unsafe -> block`。
- `ask + shell_unsafe -> prompt`。
- `bypass + shell_unsafe -> allow`。
- `ask + file_write + filesystem unavailable -> block`，不先 prompt。
- capability snapshot available 但执行时 launch 失败 -> tool fail closed，不回退 host。

## Phase 9: runtime/model context 与 diagnostics

目标：让用户、模型和诊断工具知道当前实际权限和 sandbox 状态。

建议文件：

- 修改：`packages/runtime/src/ai-sdk-backend.ts`
- 修改：`packages/runtime/src/system-prompt` 相关模块，如实际存在
- 修改：`apps/desktop/src/main/system-prompt-main.ts`
- 可选：`apps/desktop/src/main/capability-snapshot.ts`
- 测试：对应 runtime / desktop contract tests

任务：

- [ ] 在 model context 中展示 active profile 名称。
- [ ] 展示 workspace roots。
- [ ] 展示 filesystem policy：read-only / workspace-write / danger-full-access。
- [ ] 展示 protected metadata。
- [ ] 展示 network policy。
- [ ] 展示 sandbox backend：`macos-seatbelt` / `linux` / `none` / `unsupported`。
- [ ] 在 diagnostics 或 capability snapshot 中暴露 sandbox availability。
- [ ] 确保 context 不泄露敏感路径以外的凭据或 env。

验收标准：

- 模型知道自己是否处在 read-only / workspace-write / danger-full-access。
- 用户能诊断某条命令为什么被 sandbox 拒绝。
- 支持平台和不支持平台的状态都能清楚展示。

测试建议：

- system prompt/context snapshot contract test。
- capability snapshot test。
- sandbox unavailable 状态展示测试。

## Phase 10: Linux sandbox backend / helper / distribution

目标：在 macOS command execution、background Bash、文件工具 worker 和默认 runtime 接线稳定后，使用同一份 `PermissionProfile` 接入 Linux 底层权限兜底。

平台边界：

```text
PermissionProfile / SandboxCommand / tools / runtime assembly
  -> SandboxManager
       ├─ darwin -> MacosSeatbeltBackend
       └─ linux  -> LinuxSandboxBackend
  -> SandboxExecRequest / launcher
  -> common process lifecycle
```

> 分岔只发生在 platform backend 和必要的平台 launcher/helper。Linux 不新增另一套 PermissionProfile、Bash tool、file tool 或 WorkspaceExecutor；transform 完成后的执行、streaming、timeout、abort 和 background process lifecycle 继续复用通用 runtime 能力。

### Phase 10.1: Linux capability detection 与 helper 方案

任务：

- [ ] 确认第一版技术栈：bubblewrap filesystem view + network namespace + `no_new_privs` + seccomp。
- [ ] 确认 helper 实现语言、构建方式和发布策略。
- [ ] 决定优先使用 system `bwrap`、bundled `bwrap`，或支持二者并做 capability probe。
- [ ] 探测 Linux kernel、user namespace、bubblewrap 和 seccomp 可用性。
- [ ] 定义 capability result 和稳定诊断原因。
- [ ] 明确 helper 缺失、版本不满足、user namespace 禁用、seccomp 不可用时的 fail-closed 行为。
- [ ] 明确不同 CPU architecture 的 binary 产物和校验策略。

> 推荐边界：TypeScript `LinuxSandboxBackend` 把 profile 和 path context 转成 launcher request；native helper 负责 `no_new_privs`、seccomp、需要保留的 file descriptors、bubblewrap setup 和最终 exec。这样不需要让所有上层 tool 和 runner 理解 Linux syscall 细节。

验收标准：

- capability probe 不启动用户命令。
- Linux 可用性不只根据 `process.platform === 'linux'` 判断。
- 所有 capability failure 都能返回可诊断且 fail-closed 的结果。

### Phase 10.2: LinuxSandboxBackend contract 与 SandboxManager 接入

建议文件：

- 新增：`packages/runtime/src/sandbox/linux-sandbox.ts`
- 修改：`packages/runtime/src/sandbox/sandbox-manager.ts`
- 修改：`packages/runtime/src/sandbox/default-sandbox-manager.ts`
- 测试：`packages/runtime/src/__tests__/linux-sandbox.test.ts`
- 测试：`packages/runtime/src/__tests__/sandbox-manager.test.ts`

任务：

- [ ] 实现 `LinuxSandboxBackend implements SandboxBackend`。
- [ ] 消费现有 `PermissionProfile`、`SandboxCommand` 和 `SandboxPathContext`。
- [ ] 在 default manager 中注册 macOS 和 Linux backend。
- [ ] `selectInitial()` 在 Linux backend 已注册且 capability 可用时选择 `linux`。
- [ ] backend 未注册时返回 `backend_not_available`。
- [ ] backend 已注册但 capability 不可用时返回明确 failure reason。
- [ ] `transform()` 输出通用 launcher argv；如确实需要额外 FD/cleanup metadata，再显式扩展 launcher request，不把平台字段扩散到 tools。
- [ ] unrestricted / disabled / external profile 继续由 manager 选择 `none`，不进入 Linux backend。

验收标准：

- 上层 Bash、文件工具和 runtime assembly 不出现 Linux 专用分支。
- fake capability/backend contract tests 可以在非 Linux 平台执行。
- sandbox 必需但 Linux backend 不可用时不会降级到 host execution。

### Phase 10.3: bubblewrap filesystem view

任务：

- [ ] 构建默认只读的系统 filesystem view。
- [ ] read-only profile 下 workspace 只读。
- [ ] workspace-write profile 下 workspace roots 可写。
- [ ] workspace 外路径不可写。
- [ ] tmpdir 和 `/tmp` 按 profile 提供可写视图。
- [ ] 保留执行 shell、系统 binary、动态链接器和基础运行库所需的只读 mounts。
- [ ] 规范化 cwd、workspace roots、tmpdir 和 symlink target。
- [ ] 对 mount target 创建、清理和并发行为给出明确策略。

验收标准：

- Linux read-only 下 workspace 可读不可写。
- Linux workspace-write 下普通 workspace 文件可写。
- workspace 外写入失败。
- cwd、tmp 和常用系统命令可以正常工作。

### Phase 10.4: protected metadata 与路径绕过防护

任务：

- [ ] 对已存在的 `.git`、`.agents`、`.codex` 建立 readonly/masked view。
- [ ] 对不存在的 protected metadata 路径阻止首次创建。
- [ ] 支持 workspace 内任意层级的 protected metadata 名称。
- [ ] 防止通过 symlink、canonical path 差异或 nested mount 绕过。
- [ ] 处理 protected path 下存在 writable descendant 的冲突规则。
- [ ] 确保 cleanup 不删除用户原有路径或并发 sandbox 创建的 mount target。

验收标准：

- protected metadata 已存在时不可修改。
- protected metadata 不存在时不可创建。
- symlink 和嵌套目录不能绕过 deny-write。

### Phase 10.5: network namespace、no_new_privs 与 seccomp

任务：

- [ ] `network.restricted` 下隔离网络 namespace。
- [ ] `network.enabled` 下保留正常网络能力。
- [ ] 在 helper 中设置 `PR_SET_NO_NEW_PRIVS`。
- [ ] 安装并验证 seccomp filter。
- [ ] 明确 seccomp 与 system/setuid bubblewrap 的启动顺序和兼容性。
- [ ] 阻止可以破坏 sandbox 边界的高风险 syscall/操作。
- [ ] 将 seccomp/helper setup failure 映射成结构化 sandbox error。

验收标准：

- network restricted 下普通直接联网失败。
- network enabled 下网络不被 sandbox policy 主动阻止。
- seccomp/filter 安装失败时不会继续执行用户命令。

### Phase 10.6: 分发、集成与 Linux smoke tests

任务：

- [ ] 把 helper/bundled resource 纳入 desktop、CLI 和发布产物。
- [ ] 支持目标 Linux architecture，并验证 executable permission。
- [ ] 明确 system/bundled bwrap 的选择和版本兼容策略。
- [ ] 增加 Linux-only command sandbox smoke tests。
- [ ] 让 Phase 7.7 filesystem worker contract 复用 Linux backend。
- [ ] 增加 Linux-only filesystem worker smoke tests。
- [ ] 非 Linux 环境自动 skip 真实 smoke，但继续运行 contract tests。
- [ ] 在 diagnostics 中暴露 Linux backend、helper 和 capability 状态。

验收标准：

- 安装后的 desktop / CLI 不依赖开发机目录即可找到 helper。
- Linux 下 foreground Bash、background Bash 和 filesystem worker 使用同一 backend。
- read-only、workspace-write、protected metadata 和 network policy 都通过真实 Linux smoke。
- bubblewrap/helper 不可用时错误清晰且 fail closed。

## 里程碑

```text
M1: PermissionProfile 模型存在，但 runtime 行为不变。
M2: permissionMode 可以编译成 active PermissionProfile。
M3: SandboxManager 可以选择和转换 sandbox request。
M4: macOS Seatbelt 可以独立生成并验证策略。
M5: foreground Bash 在 macOS 下可以经过 sandbox。
M6: 文件工具遵守同一 PermissionProfile，并接入 desktop / CLI 默认 assembly。
M7: background Bash 在 macOS 下默认经过 sandbox。
M8: 文件工具真实 filesystem operation 在 macOS sandboxed worker 中执行。
M9: headless / isolated / child agent 默认接线完成。
M10: execute 模式不再依赖 shell_unsafe regex 作为安全边界。
M11: runtime/model context 可以展示当前 sandbox 状态。
M12: Linux command 与 filesystem worker backend 接入。
```

## 建议实施顺序

前七个基础阶段已经完成或进入默认 assembly。后续优先保持每个阶段可测试、可回滚，并坚持先完成 macOS 主线，再接 Linux：

```text
1. 完成 background Bash sandbox，消除 desktop / CLI 默认 Bash 的 host execution 缺口。
2. 实现 macOS sandboxed filesystem worker，让文件工具获得 OS 级兜底。
3. 补齐 headless / isolated / child agent 默认 runtime 接线。
4. 让 PermissionEngine 理解 active profile 和真实 sandbox availability。
5. 增加 runtime/model diagnostics，暴露 backend 与 capability failure。
6. 确定 Linux helper、bubblewrap 和 seccomp 的构建/分发方案。
7. 实现 Linux backend 的 filesystem view、protected metadata 和 network/seccomp。
8. 让 foreground Bash、background Bash 和 filesystem worker 在 Linux 上复用同一 backend。
9. 完成 Linux 发布产物和真实 smoke tests。
```

关键原则：

- 不把 Bash regex 当安全边界。
- 不静默从 sandbox 降级到 host shell。
- 不在第一版做 unsandboxed retry。
- 不引入 worktree/write-back 相关实现。
- macOS 和 Linux 只在 platform backend / launcher/helper 层分岔。
- 不为 Linux 复制 PermissionProfile、Bash tool、file tool 或 WorkspaceExecutor。
- 文件工具保留业务层 profile enforcement，同时增加 OS sandboxed worker 作为兜底。
- Linux availability 必须经过 capability probe，不能只检查 platform。
- 每个阶段都必须有 focused tests。
