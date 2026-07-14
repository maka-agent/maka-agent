# Agent Runtime Codex-Style Sandbox Todo

> Archived on 2026-07-13. Phases 1–4 landed in PR #631; the remaining enforcement work moved to issue #843.

这份文档是 Maka 参考 Codex 实现权限管理和 sandbox 权限兜底的分阶段工程任务清单。

关联背景文档：

- `docs/sandbox/agent-runtime-codex-sandbox-alignment.md`

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
Phase 8: sandbox-aware PermissionEngine / policy
Phase 9: runtime/model context 与 diagnostics
Phase 10: Linux sandbox backend
```

## Phase 0: 清理旧方案假设

目标：让文档和 issue 语义不再把 worktree/write-back 当成当前实现方向。

范围：

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

- [ ] 新增 `runProcessWithBoundedTail()` 或等价函数。
- [ ] 输入 argv：`command: string[]` 或 `program + args`。
- [ ] 保留 cwd。
- [ ] 保留 env。
- [ ] 保留 timeout。
- [ ] 保留 abort signal。
- [ ] 保留 stdout/stderr streaming。
- [ ] 保留 bounded tail output。
- [ ] 保留 POSIX process group termination。
- [ ] 保留 Windows taskkill 逻辑，但 Windows sandbox 本轮不实现。
- [ ] 保留现有 `runShellWithBoundedTail()`，作为 shell-string compatibility path。

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

- [ ] 定义 Bash 执行所需的 permission context 输入。
- [ ] 让 Bash impl 能拿到 active `PermissionProfile`。
- [ ] Bash command 转换成 `/bin/sh -lc <command>` 内层 argv。
- [ ] 调用 `SandboxManager.transform()` 得到最终 argv。
- [ ] 使用 argv runner 执行。
- [ ] 保留 terminal result shape：cwd、cmd、exitCode、stdout、stderr。
- [ ] sandbox denial 返回清晰错误。
- [ ] 不做 unsandboxed retry。
- [ ] sandbox 必需但不可用时 fail closed 或明确 prompt/block。

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

- [ ] 为 file tools 注入 active profile。
- [ ] `Read` 检查 readable roots。
- [ ] `Read` 检查 deny-read。
- [ ] `Glob` / `Grep` 检查搜索根可读。
- [ ] `Write` 检查 writable roots。
- [ ] `Write` 阻止 protected metadata。
- [ ] `Edit` 检查 writable roots。
- [ ] `Edit` 阻止 protected metadata。
- [ ] 保留 realpath containment。
- [ ] 保留 symlink escape 防护。
- [ ] 保留 file write lock。
- [ ] 保留 Edit matcher 行为。

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

## Phase 8: sandbox-aware PermissionEngine / policy

目标：让权限决策理解 active profile 和 sandbox availability，而不是只看 mode x category。

建议文件：

- 修改：`packages/core/src/permission.ts`
- 修改：`packages/runtime/src/permission-engine.ts`
- 测试：`packages/core/src/__tests__/permission.test.ts`
- 测试：`packages/runtime/src/__tests__/permission-engine.test.ts`

任务：

- [ ] 扩展 `PreToolUseInput`，加入 active profile summary 或 sandbox availability。
- [ ] 保留现有 `PermissionMode` 输入。
- [ ] 保留 `ToolCategory` 分类。
- [ ] 调整 `execute.shell_unsafe`：不再无条件 allow。
- [ ] sandbox 可 enforce 时，允许普通 workspace mutating shell 自动执行。
- [ ] sandbox 不可 enforce 时，`shell_unsafe` prompt 或 block。
- [ ] `fs_destructive` 继续 prompt 或更保守。
- [ ] `git_destructive` 继续 prompt 或更保守。
- [ ] `privileged` 继续 prompt 或更保守。
- [ ] `bypass` 仍保留危险全权限语义。

验收标准：

- `execute` 模式不再把 regex 漏判作为唯一安全边界。
- 没有 sandbox enforcement 时，unknown/mutating shell 更保守。
- 现有 ask/explore/bypass 的基本用户语义不被破坏。

测试建议：

- `execute + shell_unsafe + sandbox available -> allow`。
- `execute + shell_unsafe + sandbox unavailable -> prompt/block`。
- `execute + rm -> prompt`。
- `explore + shell_unsafe -> block`。
- `ask + shell_unsafe -> prompt`。
- `bypass + shell_unsafe -> allow`。

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

## Phase 10: Linux sandbox backend

目标：在 macOS 主线稳定后，接入 Linux 权限兜底。

> 实现结果：Linux backend 使用系统 `bubblewrap`，不额外分发 native helper。`linux-capability.ts` 会执行一次最小 user/PID namespace 启动探针并缓存结果，避免只检查文件存在。缺少 bwrap、user namespace 被 AppArmor/内核策略禁止或探针失败时，Bash 不获得 sandbox 自动批准；用户明确批准后走现有 host execution。
>
> `LinuxBubblewrapBackend` 将 active `PermissionProfile + SandboxPathContext` 转换成 bwrap argv：系统运行目录只读挂载，workspace 按 profile read/write 挂载，临时目录使用独立 tmpfs，restricted network 同时使用 network namespace 和 seccomp。seccomp cBPF 由 TypeScript 在运行时生成，通过继承 FD 3 传给 `bwrap --seccomp 3`，当前审计并支持 x64/arm64；其他架构 fail closed。
>
> CLI 与 Desktop 在 Linux 上注入 `createBuiltinSandboxManager()`。前台和可转后台 Bash 都从当前 `permissionMode + cwd` 编译 effective profile，以 `/bin/sh -lc <command>` 作为内层 argv，最终 wrapper 以 `shell: false` 执行。缺少 sandbox 时 `execute.shell_unsafe` 不会自动放行，而是保留权限 prompt；用户批准后使用原有 host shell。若 capability 已确认可用但 transform 随后失败，仍 fail closed，不做静默降级。
>
> 已知限制：runtime 会有界扫描并把启动时已存在的任意层级 `.git/.agents/.codex` 重新只读挂载，但 bubblewrap 无法在不创建宿主 mountpoint 的情况下同时阻止尚不存在的同名路径首次创建。显式 `deny` entry 当前返回 `invalid_request`，不会弱化后继续执行。后续可用 Landlock 或 bundled native helper 完整表达不存在路径与更复杂的嵌套 carve-out。

建议文件：

- 新增：`packages/runtime/src/sandbox/linux-sandbox.ts`
- 可能新增 helper package 或 bundled helper，取决于实现语言和发布策略
- 测试：`packages/runtime/src/__tests__/linux-sandbox.test.ts`
- Linux-only smoke tests

任务：

- [x] 确认 Linux backend 技术方案：bubblewrap + seccomp。
- [x] 确认 helper 分发方式：首版依赖系统 bwrap，seccomp cBPF 由 runtime 生成并通过 FD 传递，不分发 native helper。
- [x] 实现 filesystem view：workspace read/write，workspace 外限制。
- [x] 实现 protected metadata deny-write（已存在路径；不存在路径限制见上文）。
- [x] 实现 tmp write。
- [x] 实现 network restricted。
- [x] 实现 network enabled。
- [x] 接入 `SandboxManager.selectInitial()`。
- [x] 接入 `SandboxManager.transform()`。
- [x] Linux 不可用时禁用自动批准；用户明确批准后走 host execution。

验收标准：

- Linux 下 workspace-write 可以写 workspace 普通文件。
- Linux 下 workspace-write 不能写 workspace 外文件。
- Linux 下 protected metadata 默认不可写。
- Linux 下 network restricted 可阻止直接联网。

测试建议：

- Linux-only smoke。
- bubblewrap 不可用时错误清晰。
- seccomp/network 限制 smoke。
- 非 Linux 环境自动 skip。

## 里程碑

```text
M1: PermissionProfile 模型存在，但 runtime 行为不变。
M2: permissionMode 可以编译成 active PermissionProfile。
M3: SandboxManager 可以选择和转换 sandbox request。
M4: macOS Seatbelt 可以独立生成并验证策略。
M5: Bash 在 macOS 下默认经过 sandbox。
M6: 文件工具遵守同一 PermissionProfile。
M7: execute 模式不再依赖 shell_unsafe regex 作为安全边界。
M8: runtime/model context 可以展示当前 sandbox 状态。
M9: Linux backend 接入。
```

## 建议实施顺序

优先保持每个阶段可测试、可回滚：

```text
1. 先加模型，不改行为。
2. 再加 compiler，不改行为。
3. 再加 SandboxManager，不执行真实 sandbox。
4. 再加 macOS Seatbelt policy generator，并用 smoke 验证。
5. 再改 shell runner，保持旧 Bash 行为不回退。
6. 再让 Bash 走 sandbox。
7. 再让文件工具遵守同一 profile。
8. 最后收紧 PermissionEngine 的 execute 策略。
```

关键原则：

- 不把 Bash regex 当安全边界。
- 不静默从 sandbox 降级到 host shell。
- 不在第一版做 unsandboxed retry。
- 不引入 worktree/write-back 相关实现。
- 每个阶段都必须有 focused tests。
