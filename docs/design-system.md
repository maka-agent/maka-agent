# Maka 设计系统契约 · design-system.md

> 编写者：@yuejing · 编辑伙伴：claude-code agents · 版本：v0.2-wave-10
>
> 这是 Maka 桌面端的设计系统**契约**，不是手册、不是规范文档、不是 marketing
> copy。它把 PR55-PR106 之间逐渐沉淀下来的隐式规则显式化，以便：
>
> - 任何 PR 改动 UI 时可以被 reviewer 和 release-gate 审计；
> - 新进的 AI agents（claude-code style）可以读完这一份就知道边界；
> - `apps/desktop/tests/smoke.md` + `apps/desktop/src/main/__tests__/*.test.ts`
>   + `scripts/check-console.mjs` 三条 release gate 有一个共同的口径。
>
> 触发本文档更新的事件：见 §10 版本与变更策略。

---

## 0. 目的与范围（Purpose + scope）

### 0.1 这是什么

本文档对应 @kenji v2 audit 的 item 6 — "**Visual system as contract**"。它是
后续 next-wave PR 的**前置条件**：

- ReasoningPanel 两态切换、tool stream pane、Settings IA 扩充第一轮、Quick
  Chat MVP 等改动落地前，相关组件契约必须在本文件登记。
- 新 PR 引入或废弃 token 时，本文件与代码必须同 PR 修改。
- 本文件是 release-gate 友好的：审计 PR 时，文档与代码的偏离 ≡ 契约违规。

### 0.2 这不是什么

- 不是一份 marketing-style "Maka 设计哲学" — 那是另一篇文档的职责。
- 不是 alma re-engineering doc 的复述，详细对照见
  `notes/maka-vs-alma-gap-v2.md`。
- 不是用户文档；用户视角的能力公告应该在 Settings 页面与 ComingSoon
  copy 内呈现，不在这里。

### 0.3 适用范围

| 表面 | 受本文档约束 |
|---|---|
| `apps/desktop/src/renderer/` 所有 React 组件 | ✅ |
| `packages/ui/src/` 共享组件 | ✅ |
| `apps/desktop/src/renderer/maka-tokens.css` token 定义 | ✅（本文件 §1 是其规范） |
| `apps/desktop/src/renderer/styles.css` 组件 recipes | ✅ |
| Settings IA + Coming Soon copy | ✅（§5 文案契约） |
| Markdown 渲染 / hljs 调色板 | ✅ |
| 后端 IPC / runtime / @maka/core 的 token 命名 | ❌（后端 contract 见 @kenji notes/）|
| 第三方依赖（lucide-react / react-markdown / rehype-highlight）内部样式 | ❌（仅约束其使用方式） |

### 0.4 核心原则

> **这些是规则。新 PR 若需打破其中任何一条，须先以同一 PR 修改本文档。**

1. **token 不二选一**：颜色/间距/字号/阴影/动效曲线/z-index 全部来自
   `maka-tokens.css`，不在组件里硬编码 hex / px / 数字曲线。
2. **5 态契约**：任何交互组件须明确 `default / hover · focus / active · pressed
   / disabled / loading · error`（不适用时显式声明），见 §3。
3. **4 态表面**：任何信息表面须同时落地 `focus / loading / error / empty` 四种
   状态，见 §6。
4. **政策即文案**：能力收缩用"不会做什么"做契约，不是"暂不支持"占位，见 §5。
5. **runtime 字符串走 redactor**：任何展示 user-typed / provider-returned 文本
   的位置须经 `packages/ui/src/redact.ts` 或 `generalizedErrorMessage`，见 §5、§8。
6. **prefers-reduced-motion 默认服从**：所有动画 / 过渡须能在 reduced-motion
   下退化为 ~0.01ms，详见 §4。

---

## 1. 基础 token（Foundational tokens）

> 单一权威：`apps/desktop/src/renderer/maka-tokens.css`。本节按"类别 → 名称 →
> 取值或公式 → 表面 → 何时不要用"格式登记。Tailwind v4 `@theme inline` 暴露
> 的别名只是镜像，不构成新 token。

### 1.0 6-色哲学（the 6-color philosophy）

```
background / foreground / accent (purple) / info (amber) / success (green) / destructive (red)
```

派生规则：
- 灰阶不是单独的 hue。`--foreground-N` 是把 foreground 按 N% 与 background 做
  `color-mix(in oklch, …)`；`--border / --hover / --active / --muted / --ring`
  是 foreground 的 alpha 叠加（`oklch(from var(--foreground) l c h / α)`）。
- 状态 tone（accent/info/success/destructive）配套的 `*-text` 变体已经把饱和
  度向 foreground 拉，专门给"在 token 背景上要可读的文字"用。
- `*-rgb` 三元组只服务于 box-shadow ring（rgba 需要分量值，不能直接吃 oklch）。
  绝对不要拿 `*-rgb` 当一般颜色变量。
- `--brand-deep` 是 Settings hero / About 页面 / on-toggle 的专用绿，**和
  `--accent` 互不通用**。允许用户重 tint accent，不会影响 Settings 的语义。

### 1.1 颜色（Color）

| Token | 用途 | 何时不要用 |
|---|---|---|
| `--background` | 顶层背景、modal 体 | 不要用作"灰底卡片"——卡片用 `--background-elevated` |
| `--background-elevated` | 卡片、Pill 内部填充 | 不要用作页面主背景 |
| `--foreground` | 主文字、Active 行文字、modal title | 不要在 `--background-elevated` 上做"略低对比" — 用 `--foreground-80` |
| `--foreground-dimmed` | 极少用 — 主要是 placeholder hover 时的过渡 | 一般用 `--foreground-50/60` 替代 |
| `--accent` | 紫色品牌、execute 模式、链接、单选 radio、user-bubble 角标 | 不要做 Settings hero（那是 `--brand-deep`），不要做 success（那是 `--success`） |
| `--info` | 琥珀，ask 模式、warning 类提示、`info_text` 文案 | 不要拿 info 表"启用中流式" — 那是 `--accent` |
| `--success` | 绿色，"已验证"、"已完成"、connected | 不要拿 success 表"已配置但未测试" — 那是 info |
| `--destructive` | 红，error、denied、fs_destructive、git_destructive | 不要因为 hover/active 看起来更"突出"就升级到 destructive |
| `--brand-deep` / `--brand-deep-hover` | Settings hero、Done CTA、provider mark | 不要侵入 chat surface，不要替代 accent |
| `--success-text` / `--info-text` / `--destructive-text` | 文字色（向 foreground 拉过） | 不要用作背景或边框 |
| `--foreground-2 / 3 / 5` | 极淡填充：sidebar、code、tool 卡片 | 不要做正文 |
| `--foreground-10 / 20 / 30` | 分割、shadow accent | 不要做正文 |
| `--foreground-40 / 50 / 60` | placeholder / caption / muted heading | 不要做主文字 |
| `--foreground-70 / 80` | 副文字、tool meta、titlebar | 不要做大段正文 |
| `--foreground-90 / 95` | 极少用 — 几乎等同主文 | 用 `--foreground` 即可 |
| `--border` | 1px 默认分割线 / 卡片外框 | 不要做 hover ring（那是 `--ring`） |
| `--border-strong` | 选中态/active 卡片框 | 不要做默认外框 |
| `--muted` | 与 border 同 α，语义上"作为背景而非分割" | 不要混用 |
| `--muted-foreground` | scrollbar hover、disabled text 的最后一层 | 不要做 caption |
| `--ring` | focus-visible 的 2px box-shadow | 不要做静态边框 |
| `--hover` | sidebar row / button ghost hover 填充 | 不要用作 active（那是 `--active`） |
| `--active` | sidebar row active / button :active | 不要做 hover（视觉会"提前"） |
| `--chat-user-bg` / `--user-message-bubble` | user 气泡背景（slate，区别于 accent） | 不要用作 assistant 气泡（assistant 不要气泡） |
| `--chat-user-foreground` | user 气泡文字 | 仅在 user-bubble 内部 |
| `--selection` | text selection 高亮 | 不要做 hover |

### 1.2 阴影（Shadow）

| Token | 公式概览 | 用法 | 不要 |
|---|---|---|---|
| `--shadow-border-opacity` | light 0.08 / dark 0.15 | 内部用，调 ring 浓度 | 不在组件直接消费 |
| `--shadow-blur-opacity` | light 0.06 / dark 0.12 | 内部用 | 不在组件直接消费 |
| `--shadow-minimal` | 1px ring + 2 层 6% blur | Composer 主框、Toast | 不做 modal |
| `--shadow-minimal-flat` | 仅 1px ring，无 blur | sidebar item card、provider chip | 不做需要漂浮感的元素 |
| `--shadow-medium` | 1px ring + 4 层 blur 渐远 | popover、dropdown、command palette | 不做行内元素 |
| `--shadow-modal` | 1px ring + 5 层 blur，最远 24px | Settings / Permission / Confirm modal | 不做非 modal |

> **硬规则**：影子的第一层永远是 1px ring（`rgba(var(--foreground-rgb), 0.06)`），
> 第二层往后才是模糊 blur。新阴影 recipe 必须遵守这个顺序，否则会和现有阴影
> 在 dark mode 互相蚕食对比。

### 1.3 排版（Typography）

| Token | 值 | 用法 |
|---|---|---|
| `--font-sans` | `"Geist Variable", system-ui, …, sans-serif` | 默认正文 / UI |
| `--font-mono` | `"Geist Mono Variable", "JetBrains Mono", …, monospace` | 代码、tool 名称、model id、provider type、token 计数 |
| `--font-default` | `var(--font-sans)` | `body` 兜底 |
| `--font-size-base` | 15px | `html` 基准；勿在组件覆盖 |
| `kbd` | mono + 0.85em + `var(--foreground-5)` 底 + 1px border | composer hint / 设置帮助 |

**规则**：
- 标识符（model id、provider type、tool name、file path、env key、API endpoint）
  必须 `<code>` 或 `var(--font-mono)`，绝不混到正文 sans。
- 文章标题、章节标题用 600 weight + `text-wrap: balance`（见
  `.maka-bubble-assistant h1..h4`）。
- `tabular-nums` 用在数字会跳动的位置（duration / token count）。

### 1.4 圆角（Radius）

| Token | 值 | 用法 |
|---|---|---|
| `--radius` | 0rem | 默认；page、layout 容器 |
| `--radius-button` | 6px | button / sidebar row / pill close button |
| `--radius-modal` | 8px | Settings / Confirm / Permission modal |
| 行内代码 | 4px hardcoded | inline `<code>`，不引 token 因为只此一处 |
| code block | 10px hardcoded | `.maka-code-block` wrapper |
| Pill / chip / round dot | 999px hardcoded | 视觉上必须圆 |
| `smooth-corners` utility | superellipse（iOS 风） | 选用，浏览器支持自动 fallback |

> 这是有意的反规范：Maka 整体 0px 直角 + 关键交互组件 6/8/10px。新 PR 不要引
> 入 "更柔和" 的 12/14/16px，那会破坏 sharp 视觉。

### 1.5 间距（Spacing）+ 密度 token

| Token | 值（comfortable） | compact / spacious | 用法 |
|---|---|---|---|
| `--spacing` | 0.25rem (4px) | 不变 | 基础步距 |
| `--ui-density-message-gap` | 18px | 12 / 26 | 每条 turn 之间 |
| `--ui-density-message-pad-x` | 24px | 20 / 32 | 消息行水平 padding |
| `--ui-density-message-pad-y` | 10px | 6 / 14 | 消息行垂直 padding |
| `--ui-density-composer-pad-y` | 18px | 12 / 24 | 输入区上下 padding |
| `--ui-density-row-pad-y` | 10px | 7 / 14 | 列表行 padding |
| `--ui-density-turn-inner-gap` | 8px（默认） | — | turn 内三段（user / tools / assistant）间隙 |

详细规则见 §2 密度契约。

### 1.6 动效（Motion）

| Token | 值 | 用法 |
|---|---|---|
| `--ease-out-strong` | `cubic-bezier(0.23, 1, 0.32, 1)` | UI 进入 / 反馈（按钮 press、modal 进入） |
| `--ease-in-out-strong` | `cubic-bezier(0.77, 0, 0.175, 1)` | 屏内运动（panel 切换） |
| `--ease-drawer` | `cubic-bezier(0.32, 0.72, 0, 1)` | iOS 抽屉 / sheet 风格 |

详见 §4。

### 1.7 z-index 阶梯

| Token | 值 | 谁在这一层 |
|---|---|---|
| `--z-base` | 0 | 普通 inline 内容 |
| `--z-sticky` | 20 | sidebar header、sticky toolbar |
| `--z-titlebar` | 40 | macOS 标题栏 / app 主标题栏 |
| `--z-panel` | 50 | 右侧 rail / artifact panel（未来） |
| `--z-dropdown` | 100 | 下拉菜单 / popover |
| `--z-tooltip` | 150 | Tooltip primitive（未来） |
| `--z-modal` | 200 | Settings / Permission / Confirm |
| `--z-overlay` | 300 | 全屏 cinematic overlay、film-grain noise 层 |

> 硬规则：任何新表面必须先在本表里登记 z 层，禁止裸 `z-index: 9999`。

### 1.8 布局尺寸（Layout）

| Token | 值 | 用法 |
|---|---|---|
| `--w-sidebar` | 260px | 左侧 nav 列宽 |
| `--w-rail` | 240px | 右侧（artifact panel 等） |
| `--h-titlebar` | 36px | 标题栏 |
| `--h-toolbar` | 40px | 二级工具栏 |
| `--h-composer-min` | 56px | composer 最小高 |

---

## 2. 密度契约（Density contract）

三档密度对应 `:root[data-ui-density="..."]`：

| 模式 | 触发 | message-gap | message-pad-x | message-pad-y | composer-pad-y | row-pad-y |
|---|---|---|---|---|---|---|
| `compact` | 显式选择 | 12px | 20 | 6 | 12 | 7 |
| `comfortable` | 默认 | 18px | 24 | 10 | 18 | 10 |
| `spacious` | 显式选择 | 26px | 32 | 14 | 24 | 14 |

**规则**：

1. **新组件必须消费 token，不能硬编码 padding/gap**。例如：
   ```css
   .maka-chat { gap: var(--ui-density-message-gap, 16px); }
   .maka-message-row { padding: 0 var(--ui-density-message-pad-x, 24px); }
   ```
   `, 16px` 的兜底值仅是字符串失败时的 fallback，正常路径必须经由 token。

2. **不要在密度切换里改 typography**。字号、行高保持稳定；只调间距、padding、
   行间 gap。否则文本 reflow 会让用户每次切换密度都"找内容找半天"。

3. **密度切换是 `<html>` 级别**：CSS attribute selector `:root[data-ui-density=…]`
   只在根节点生效。组件不要在自己内部 override 密度属性。

4. **新增密度 token** 须同 PR 在本节登记新行 + 同步三档值。

---

## 3. 组件契约（Component contracts）

每个组件登记：**tone / 使用的 token / ARIA 角色 / 键盘契约 / 5 态行为**。
行号来自 `packages/ui/src/components.tsx` 与 `packages/ui/src/toast.tsx`。

### 3.1 Button (`.maka-button`)

- **位置**：CSS recipe `apps/desktop/src/renderer/styles.css` 内（注：基础 token
  recipe 在 `maka-tokens.css` 末尾 `@layer components` 也定义了一份兜底）。
- **变体**：`data-variant="primary" | "ghost" | "destructive"`，未设置 = 默认
  （白底 + 1px border + foreground 文字）。
- **token**：背景 `--background / --hover / --active`；边框 `--border`；
  destructive 用 `oklch(from var(--destructive) … / 0.35)` border + `--destructive-text`
  文字；primary 用 `--accent` + white 文字。
- **ARIA**：原生 `<button>`，禁用态 `disabled` + `aria-disabled="true"`（推荐
  二者并存以兼容旧 AT）。
- **键盘**：`Enter` / `Space` 触发，与原生一致；不要拦截 Tab。

| 状态 | 视觉 | token |
|---|---|---|
| default | 边框 + foreground 文字 | `--background` / `--border` |
| hover | 灰底，边框不变 | `--hover` |
| focus（visible） | 2px ring + 原 border | `--ring`（全局 `*:focus-visible`） |
| active (pressed) | 更深底 | `--active` |
| disabled | opacity 0.45 + cursor: not-allowed | — |
| loading / error | **N/A** — button 自己不持有 loading 态；调用方在父表面（例如 ConnectionDetail）持有 `testing` 状态并替换 label 为"测试中…"。永远不引入"按钮自旋转"。 | — |

> 禁止：`<div onClick>` 假冒按钮。所有可点击 affordance 必须是 `<button type=…>`
> 或 `<a href=…>`。

### 3.2 Toast / ToastProvider / ConfirmDialog (`packages/ui/src/toast.tsx`)

- **位置**：`toast.tsx:77` ToastProvider；`toast.tsx:205` ConfirmDialog。
- **API**：`toast / success / error / info / warning / confirm / dismiss`，通过
  `useToast()` 取，**禁止在 ToastProvider 之外调用**（hook 会显式抛错）。
- **token**：4 个 variant 颜色绑定 info / success / warning / error；icon 来自
  lucide-react，`size={16}` 固定。
- **ARIA**：`<ol role="region" aria-live="polite" aria-label="Notifications">`
  + 每条 toast `<li>`，dismiss 按钮 `aria-label="Dismiss"`。ConfirmDialog 是
  `role="alertdialog" aria-modal="true"` + `aria-labelledby` + 可选
  `aria-describedby`。
- **键盘**：ConfirmDialog 绑全局 `Enter` → 确认；`Escape` → 取消（由
  `useModalA11y(dialogRef, () => onResolve(false))`）。toast 自身不可
  focus，仅 dismiss 按钮可 focus。
- **5 态**：
  - default：信息陈列
  - hover：toast 整体不改色；action / dismiss button 单独 hover
  - focus：dismiss / action button focus-visible 走全局 ring
  - active：dismiss / action button :active
  - disabled / loading / error：**N/A** — toast 一旦显示就是终态，4s 后或手
    动 dismiss 消失

> 强约束：`success / error / info / warning` 是**封闭 enum**；不要私造第 5 种
> variant。Error toast 的默认 duration 是 6s（其他是 4s），刻意更长。

### 3.3 Modal（useModalA11y hook + `.maka-modal-backdrop` / `.maka-modal`）

- **位置**：hook `components.tsx:75`；CSS recipe `maka-tokens.css:1225` (.maka-modal-backdrop)。
- **职责**：modal 的三件套 — 初始 focus / Tab cycle / Escape + return-focus。
- **token**：背板 `oklch(from var(--background) l c h / 0.6)` + `backdrop-filter: blur(6px)`；
  modal 体 `--background` + `--shadow-modal` + `--radius-modal`；尺寸
  `min(520px, 100vw - 48px)` × `max-height: 100vh - 80px`。
- **ARIA**：`role="dialog"` 或 `role="alertdialog"`；`aria-modal="true"`；
  `aria-labelledby` 指向 modal 标题；`aria-describedby` 指向 subtitle/description（如有）。
- **键盘**：自动 trap Tab/Shift+Tab；Escape 触发 onEscape（若提供）；非
  alertdialog 的 modal 默认允许 Escape 关闭。
- **5 态**：
  - default：show + 透明度 1 / scale 1
  - opening：`@starting-style { opacity: 0; transform: scale(0.96); }` → 220ms
    `--ease-out-strong` 进入；prefers-reduced-motion → 即时
  - focus-within：modal 内任意 focusable 元素被聚焦
  - disabled：**N/A** — modal 不可整体 disable，应在 body 内单独 disable 控件
  - loading / error：modal body 内单独负责，见 §6

### 3.4 PermissionDialog（`components.tsx:1641`）

> 这是 Maka 安全 UX 的核心，所有改动须先经 @kenji review。

- **特殊**：destructive 路径有显式的 "**我已确认，允许**" 按钮标签 + 红色
  emphasis note + destructive tone primary button。
- **token**：`data-tone="destructive"` 时 primary button 走 destructive
  variant；hint 区使用 `--info` tinted 背景；命令预览走 `.maka-code` (mono)。
- **ARIA**：`role="alertdialog"`、`aria-modal="true"`、`aria-labelledby="permissionTitle"`；
  reason 区有 `data-reason` 与 `.maka-reason-text` tone 联动。
- **键盘**：**Escape 显式禁用**（`useModalA11y(dialogRef)` 不传 onEscape）。原
  因：权限决策必须显式 allow/deny，Esc 默认 deny 会被用户误触。
- **rememberForTurn**：仅在 decision === 'allow' 时回传，且强约束为 per-turn（不
  跨 session 持久化）。
- **5 态**：
  - default：dialog mounted，单选状态为 unchecked
  - hover：button hover 走基础规则
  - focus-within：Tab cycle 在 dialog 内
  - active：button :active
  - disabled / loading / error：**N/A** — 权限决策是同步事件

**完整文案契约见 §5.3**。

### 3.5 Composer（`components.tsx:1340` forwardRef）

- **职责**：唯一的用户输入入口；流式感知（streaming = true 时 swap 工具栏 + 隐
  藏 Send + 显示 Stop）。
- **token**：背景 `--background`；focus-within border 与 box-shadow 见
  `.maka-composer-inner:focus-within`；max-height 240px hardcoded（设计取舍）。
- **ARIA**：`<form>` + `<textarea>`；toolbar 是普通容器；streaming hint 区域
  没有 `aria-live`（已有 Stop button 的 focusable 状态变化）— 这点 §9 列为待
  完善项。
- **键盘契约**：
  - `Enter` → 提交
  - `Shift+Enter` / `Alt+Enter` → 换行
  - `Escape` + streaming → 调 `onStop()`
  - IME composing 期间所有快捷键 short-circuit（`event.nativeEvent.isComposing`
    或 `event.key === 'Process'`）
- **placeholder**：`"给 Maka 发消息…"` 固定 — 不要根据 mode 改 placeholder（用户已经看
  得到 mode 切换器）。
- **5 态**：
  - default：单行高，placeholder 灰
  - hover：composer 不响应 hover（视觉过载）；focus 才升级
  - focus-within：accent 边框 + 12% accent ring
  - active：textarea active 与 focus 视觉一致
  - disabled：toolbar 写 "等待你确认权限…"；Send 灰；Send 与 Stop 都不可点
  - streaming：Toolbar swap → "Maka 正在思考… [Esc] 或点 Stop 中断" + pulsing
    accent 点；只剩 Stop 按钮；Send 隐藏；Esc 调 onStop

### 3.6 SessionListPanel + SessionRow（`components.tsx:180`, `:487`）

- **职责**：会话侧边栏。Active state + streaming pulse + unread halo。
- **token**：active row `--active`；hover row `--hover`；streaming dot
  `--accent` + box-shadow pulse；unread halo `--accent`。
- **优先级硬规则**：**streaming dot 优先于 unread halo**（PR85 验证）。即如果
  session 正在 streaming，**不**显示 unread 圆点。代码逻辑在
  `SessionRow` line ~580 + 600：`{streaming && <span … />}` 与
  `{session.hasUnread && !streaming && <span … />}`。
- **ARIA**：列表外层 nav 节点；row 是 `<button type="button">`；rename
  input `aria-label="重命名对话"`；删除按钮 `aria-label`...
- **键盘**：Arrow Up/Down 切换 row（在 SessionListPanel 容器上注册）；Enter
  打开；Delete 触发删除 confirm（通过 toast.confirm）。
- **5 态**：
  - default：text + meta
  - hover：`--hover` 背景 + 微小 translate（PR40）
  - focus：focus-visible ring
  - active（current session）：`data-active="true"` → `--active` + 左侧 accent bar
  - editing：rename input + select-all on focus
  - streaming：`data-streaming="true"` → 顶部加 pulse dot + 副文本 "Maka 正
    在思考…" 覆盖 lastMessagePreview
  - error：**N/A**（session 不会处于 error 态；CRUD 失败由 toast 表达）

### 3.7 ChatHeaderAlertBadge（`components.tsx:1050`）

- **职责**：在聊天标题栏一行小药丸表达"凭据/会话级"异常状态。
- **token**：`data-tone` 驱动 — `warning` / `destructive` / `info`，分别取
  `--info-text` / `--destructive-text` / `--info-text` + 同色 alpha 背景。
- **ARIA**：当 onClick 存在时渲染为 `<button>`；否则 `<span>`。`aria-label`
  与可见 label 同字符串。
- **键盘**：仅可点击时有 focus；按下 Enter / Space 跳转。
- **生命周期映射**（与 `connection-status.ts` 同源）：
  - `needs_reauth` → warning tone, label "需要重新登录"
  - `error` → destructive tone, label "上次连接失败"
  - 连接已删除 → destructive tone, label "连接已删除"（PR106）
  - 5 态：default / hover (button) / focus / active — 同 Button；
    disabled / loading / error 不适用

### 3.8 TurnView + TurnSummary（`components.tsx:1237` + `:1174`）

- **职责**：把"user → tools → assistant"渲染为一个 visual unit (`<section
  class="maka-turn">`)。TurnSummary 是 chip strip：model · tools · duration ·
  tokens。
- **token**：chip 走 `.maka-turn-summary-chip` recipe；`data-kind="tools"`
  着色为 accent；`data-state="in-progress"` 用 in-progress accent fill。
- **ARIA**：summary chip 是普通 span；不打 button role（不可交互）；duration
  chip 用 `font-variant-numeric: tabular-nums`。
- **关键不变量**（`materialize.ts:158-160`）：
  - `durationMs` 仅在 assistant message 落地后赋值，否则保持 undefined → UI
    渲染 **"进行中"** 字符串（不要把 Date.now() - startedAt 显式 tick）。
  - `tokens.costUsd` 仅当 > 0 时显示 tooltip；从不渲染 `$0.0000`。
- **5 态**：
  - default：完成态，chip 灰底
  - hover：chip 不响应 hover；title 提供 tooltip（model id 用 mono）
  - focus：N/A（不可交互）
  - active：N/A
  - in-progress：duration chip swap 为 "进行中"，accent fill；不显示
    duration 数字

### 3.9 ToolActivity（`components.tsx:1524`）

- **职责**：tool 调用列表 with native `<details>/<summary>` 折叠。
- **核心规则**：
  - **默认展开当且仅当** status ∈ {`pending`, `waiting_permission`, `running`,
    `errored`}（`isOpenByDefault`, line 1483）。`completed` / `interrupted` 默
    认折叠。
  - errored 行：顶部红色 `<ToolErrorBanner>`（最多 240 字符）+ copy 按钮，
    显式优先于参数 / 结果展示。
  - 输出经过 `redactSecrets` 与 `TOOL_LINE_CAP = 500` 双重过滤。
- **token**：状态点 dot 走 `.maka-tool-status-dot[data-status="…"]`；
  running 时附 box-shadow 脉动 `maka-tool-pulse`；errored 时 border / 背景皆
  转 destructive 浅色。
- **ARIA**：`<section aria-label="工具调用记录">` + 每条 details 自带语义；
  tool count 圆点 `aria-label="N 次调用"`；status label 走 `STATUS_LABEL` 表
  （5 种中文文案）。
- **键盘**：原生 details summary 支持 Enter / Space 切换。
- **5 态**：
  - default：闭合
  - hover：summary 行 hover 走 details 自带
  - focus：summary focus-visible 走全局 ring
  - active：详情区展开（`<details open>`）
  - disabled：N/A
  - loading：`running` 状态 = loading；脉动 dot 表示
  - error：`errored` 状态 = 红框 + 红 banner + 自动展开

### 3.10 ModelTable (UI-02, ProvidersPanel 子组件)

- **职责**：替代旧的"选择默认模型"下拉。`role="radiogroup"` 工作区，每行可键
  盘选中作为默认。
- **位置**：`apps/desktop/src/renderer/settings/ProvidersPanel.tsx` 内；键盘
  helper 拆出到 `model-table-keyboard.ts`（PR94），有 14 个 node:test。
- **token**：选中行 `--active` + 左侧 accent bar；search box 走 composer focus
  ring 同款。
- **ARIA**：
  - 表外层 `role="radiogroup" aria-label="模型选择"`
  - 每行 `role="radio" aria-checked={isDefault}`
  - 隐藏 default hint：`role="status"` 或普通 div + 紧邻可视位置（不要打
    `aria-live="assertive"`，太吵）
- **键盘契约**（PR92 + PR93 + PR94）：
  - `ArrowDown` / `ArrowRight`：focus 下一行 **且** select；末行 wrap 到首行
  - `ArrowUp` / `ArrowLeft`：focus 上一行 **且** select；首行 wrap 到末行
  - `Home`：跳到首行
  - `End`：跳到末行
  - 关键不变量：focus 与 selection **必须同步移动**（不能"focus only"，那是
    UI-04 早期 ARIA radiogroup 回归 bug）
- **模型来源标签**（PR91 + PR74 模型 fetch fix）：
  - `modelSource === 'fetched'` + `models.length > 0` → success tone "实时拉取的 N 个模型（X 拉取）"
  - `modelSource === 'fetched'` + `models.length === 0` → success tone "已成功调用 provider，但返回 0 个模型"
  - `modelSource === 'fallback'` → info tone "静态备用列表"
- **5 态**：
  - default：列表 + 默认选中行高亮
  - hover：行 hover 走 `--hover`
  - focus：行 focus-visible 走 ring；selection 同步移动
  - active：单选状态 `data-default="true"`
  - disabled：禁用某行（如 provider 报告该 model 不可用）→ opacity 0.5 + 不可
    focus；当前未触发
  - loading：整个 ProvidersPanel 自身处理 `loading` 态，使用 `.maka-skeleton-card` 占位
  - error：fetchModels 失败 → toast.error + 留在 fallback 模式

### 3.11 MessageCopyButton（`components.tsx:893`）

- **两种变体**：
  - **floating（无 label）**：默认。`.maka-message-copy` absolute top-right，
    opacity 0，hover/focus-within 时升起。用于 assistant bubble 末尾"复制消息"。
  - **labelled**：`label` prop 存在时，`data-labelled="true"`，inline 流，
    始终可见。用于"复制思考过程"按钮。
- **token**：复制成功 1.4s 内，`data-copied="true"` → success tone border + 浅
  success 背景 + check icon。
- **ARIA**：`aria-label` 在 default / copied 状态切换文案。
- **5 态**：default / hover / focus / active / copied（5th 是非典型）。
  disabled / loading / error 不适用 — 剪贴板 API 失败时静默回退。

### 3.12 Markdown 渲染 + 代码块

- **职责**：assistant 消息体内 markdown 渲染（`Markdown` 组件，
  `components.tsx:929`），含 remark-gfm + remark-breaks + rehype-highlight。
- **不变量**：
  - 链接 `target="_blank" rel="noreferrer noopener"`，由 main 进程拦截走系统
    浏览器（见 PR96/97 external-link-guard）。
  - inline `<code>` 用 mono + 5% foreground 背景。
  - block code 用 `.maka-code-block` wrapper：language pill header + copy 按钮
    + `<pre>`。语言来自 `language-xxx` 类，未识别时显示 `'code'`。
  - hljs 调色板（`.hljs-*` 选择器）全部从 token 派生 `oklch(from var(--accent) …)`
    系列，**不允许引入第三方 highlight.js 主题 CSS**。
- **task list 复选框**（remark-gfm）：禁用态 `<input disabled>`；选中态用
  `--accent` 填充；`cursor: not-allowed`（markdown 是只读的）。

---

## 4. 动效契约（Motion contract）

### 4.1 持续时间表

| 触发场景 | duration | easing |
|---|---|---|
| 按钮 hover / active 背景过渡 | 120ms | `ease`（系统） |
| 消息进入 (`@starting-style`) | 240ms | `ease-out` |
| Tool 进入 (`@starting-style`) | 200ms | `--ease-out-strong` |
| Modal 进入 transform + opacity | 220ms | `--ease-out-strong` |
| Modal 背板 opacity | 200ms | `ease-out` |
| Composer focus 边框 / shadow | 160ms | `ease` |
| Tool 边框 status 变化 | 160ms | `ease` |
| Tool running 脉动 box-shadow | 1500ms (loop) | `ease-in-out` |
| Cursor pulse (`maka-cursor`) | 1100ms (loop) | `ease-in-out` |
| Skeleton shimmer (`maka-shimmer`) | 1500–1600ms (loop) | `ease-in-out` |

### 4.2 硬规则

1. **只动 transform / opacity / color / background / border-color / box-shadow**。
   不要动 `top / left / width / height` — 触发 layout，永远不要。

2. **使用命名 easing token**，不要写 inline cubic-bezier。如果场景不匹配
   现有 3 个曲线，先在 §1.6 加一条 named token，再使用。

3. **`@starting-style` 优于 keyframes** — 因为 starting-style 可被中断
   （streaming 消息流到一半被 cancel 时不留 zombie keyframe）。新动画首选
   starting-style；keyframes 只用于**真正无限循环**的情况（cursor、pulse、
   shimmer）。

4. **prefers-reduced-motion: reduce** 触发 `maka-tokens.css:1380` 全局兜底：
   ```css
   *, *::before, *::after {
     animation-duration: 0.01ms !important;
     animation-iteration-count: 1 !important;
     transition-duration: 0.01ms !important;
     scroll-behavior: auto !important;
   }
   ```
   - 这是**最大锤**：组件不需要再单独写 reduced-motion 分支，**除非**默认
     行为在 reduced-motion 下要彻底关闭（如 streaming cursor 改为常亮，
     `.maka-bubble-streaming::after` 已经处理）。
   - 新动画必须能在 0.01ms duration 下还语义正确（即过渡完成后的态视觉上仍
     有意义），否则不要做。

5. **永远不要禁用 transition 完全（`transition: none`）**。emil-design-eng 原
   则：reduced-motion ≠ no motion；只是要让 AT 仍能观察 state change。

---

## 5. 文案契约（Copy contract）

> 这一节是 V0.2 polish wave 9（PR53-72）+ wave 10（PR75-106）期间从 @kenji
> 多次 review 沉淀下来的模式。任何新增文案必须满足以下全部。

### 5.1 政策声明，不是 backlog

旧的"暂不支持"占位 → 新的 **当前状态 / 会包含什么 / 不会做什么 / 下一步需要配置什么**
4 段式（PR55 模板，`SettingsModal.tsx:193 COMING_SOON_PAGES`）。

```
当前状态 — 一句话现状（"未启用 / 默认关闭 / 等待 V0.2"）
会包含什么 — 列点；具体可验证的能力
不会做什么 — 列点；安全/隐私的硬边界（policy，永久声明而非占位）
下一步需要配置什么 — 列点；用户/项目要做的事
```

**关键**："不会做什么" **不是**"暂时不做"，而是 V0.2 即便上线后也不会做。例如：
- 每日回顾："不截屏、不监听键盘、不读取其他 App 的数据"
- 开放网关："不向外网监听，默认 127.0.0.1 only；不记录 prompt 文本"

### 5.2 通用错误文案（generalizedErrorMessage）

源：`@maka/core` 的 `generalizedErrorMessage()`（xuan `01b533f`）。6 种 errorClass：

| errorClass | 用户文案 | 触发 |
|---|---|---|
| `auth` | Authentication failed / 凭据校验失败 | 401 / 403 |
| `timeout` | Request timed out / 请求超时 | abort / read timeout |
| `network` | Network error / 网络错误 | DNS / connect refused |
| `provider_unavailable` | Provider unavailable / 上游不可用 | 5xx |
| `rate_limit` | Rate limited / 速率受限 | 429 |
| `unknown` | Unexpected error / 未知错误 | 兜底 |

**硬规则**：
- 任何展示给用户的 provider 错误信息**必须**经过 `generalizedErrorMessage`，
  哪怕来源已经在 backend 走过一次。UI 层第二道防线是
  `packages/ui/src/redact.ts`（见 §5.6）。
- **禁止回显**：用户输入的 prompt / API key / URL query 参数 不得出现在错误
  toast 或日志里。

### 5.3 destructive 强调（PermissionDialog）

- destructive permission（`fs_destructive / git_destructive / privileged`）：
  - 顶部 reason text 用 `--destructive-text`，font-weight 500
  - body 内最后一段加红色 emphasis note：
    > "这类操作不可恢复，确认前请再读一遍上面的参数。"
  - 主按钮 label：`"我已确认，允许"`（不是 "允许"），按钮 variant 切到
    `destructive`
- 非 destructive：按钮 label `"允许"`，variant `primary`。

### 5.4 per-enum 文案映射

警告 / 提示文字**只能**从封闭 enum 映射，不在前端拼接用户输入。
- `connection-status.ts:87 STATUS_PRESENTATION` — 6 种 ConnectionUiStatus →
  `{label, detail, tone}`。
- `SettingsModal.tsx PERSONALIZATION_WARNING_COPY` — settings warning enum
  （`override-attempt / sensitive-pattern / control-chars`）→ 单一 toast 文案。
- `ToolActivity STATUS_LABEL` — 6 种 tool status → 中文 label。

**反例（禁止）**：
```ts
toast.error(`Failed to test ${userTypedName}: ${rawError}`);
```

### 5.5 "进行中" 而非 ticking ms

`materialize.ts:158-160`：`durationMs` 仅在 assistant 落地后赋值。UI 在
in-progress 状态显示 **"进行中"**，不要：
- 拿 `Date.now() - turn.startedAt` 跳动渲染（会触发每帧重绘）
- 渲染 "0 ms" 占位

### 5.6 fetched vs fallback

`ProvidersPanel.tsx` 模型来源标签**必须**区分：
- `modelSource === 'fetched'` → "实时拉取"（success tone）
- `modelSource === 'fallback'` → "静态备用列表"（info tone）

**禁止**：在 fallback 模式下显示 "实时拉取的 N 个模型" — 那是 PR91 关闭的
silent-fallback 回归。

### 5.7 单一语言（中文为主）

- 所有用户可见文本默认中文。Aria label 必须与可见文本同语言（PR70 完成
  localization sweep）。
- 例外白名单：
  - 技术 token name（"OAuth"、"Bearer"、"API Key"）保留英文
  - model id / provider type / file path 保留原文（mono）
  - "Maka" 品牌名

### 5.8 标识符走 mono

任何"机器字符串"在文案里出现时必须 `<code>` 包裹：model id、file path、env
key、provider type、HTTP method、HTTP header name。

> 不允许：`Provider type is openai-compatible`
> 允许：`Provider type 是 <code>openai-compatible</code>`

---

## 6. 表面状态矩阵（Surface state matrix）

每个信息表面**必须**实现以下 4 态。本表用于 release-gate 审计；下一波 PR
应优先填补 ❌ 与 🟡。

| 表面 | focus | loading | error | empty |
|---|---|---|---|---|
| Chat 主区（`.maka-chat`） | ✅ 全局 focus ring | ✅ streaming caret + composer dot | ✅ tool error banner + chat header alert | ✅ EmptyChatHero / OnboardingHero |
| 侧边栏 SessionListPanel | ✅ row focus-visible | 🟡 没有显式 list loading（首次 load 渲染同步） | ✅ session 操作失败 → toast | ✅ "尚未发送" 分组 |
| 侧边栏 Skills | ✅ | 🟡 隐式 | ✅ skills:list 失败 → toast (PR56) | ✅ "暂无技能" copy (PR9) |
| Settings · 通用 | ✅ | ✅ shimmer skeleton (PR15) | ✅ settings:update warnings toast (PR59) | N/A（始终有内容） |
| Settings · 个性化 | ✅ | ✅ | ✅ warning toast per enum | N/A |
| Settings · 主题 | ✅ | ✅ | 🟡 | ✅ light/dark/auto 永远有当前选中 |
| Settings · 模型 (ProvidersPanel) | ✅ row + chip focus | ✅ providersLoading skeleton | ✅ test toast + fetchModels toast | ✅ enabledEmptyChip "还没有供应商" |
| Settings · 模型详情 (ConnectionDetail) | ✅ | ✅ testing 态 button label swap | ✅ test connection toast | N/A（必有 1 个 connection） |
| Settings · 使用统计 | ✅ | ✅ shimmer | 🟡 | ✅ "暂无数据" copy |
| Settings · 机器人对话 | ✅ | ✅ | ✅ test bot connection toast | ✅ 各 channel 默认 disabled |
| Settings · 网络 | ✅ | ✅ | ✅ test proxy toast (PR33) | N/A |
| Settings · 数据 | ✅ | ✅ | ✅ openPath 失败 toast (PR56) | N/A |
| Settings · 账号 (AccountSettingsPage) | ✅ row focus | ✅ hasSecret 加载 | ✅ test connection toast + 6-state badge | ✅ "尚未启用任何连接" |
| Settings · 关于 | ✅ | ✅ app:info 加载 (PR16) | 🟡 (info IPC 失败不显式提示) | N/A |
| Settings · 每日回顾 / 语音模型 / 开放网关 / 搜索服务 | ✅ | N/A | N/A | ✅ Coming Soon 4 段式 |
| Composer | ✅ focus-within | ✅ streaming 态 | ✅ send 失败保留输入 (xuan 7ce8f30) | ✅ placeholder 文案 |
| PermissionDialog | ✅ trap | N/A（同步事件） | N/A | N/A |
| Modal (Settings) | ✅ | ✅ 各 panel 自己处理 | ✅ 各 panel 自己处理 | N/A |
| Command Palette (⌘K) | ✅ | 🟡 不需要 loading | ❌ 命令执行失败暂未统一 surface | ✅ "无匹配命令" copy |
| Chat Header | ✅ pill 可点击 | N/A | ✅ ChatHeaderAlertBadge (PR65 + PR106) | N/A |
| Tool Activity | ✅ summary focus | ✅ pending/running 状态 dot | ✅ ToolErrorBanner (PR58) | ✅ tool 列表为空时整段不渲染 |
| Turn Summary chips | N/A（不可交互） | ✅ "进行中" 替代 ticking | N/A | ✅ chips 全 hidden 当无信号 |

**未实装 surface（next-wave 必须按 §11 release-gate 入表）**：

下列 surface 是 @kenji v2 audit 8 系统 + @yuejing alma 差距分析提到、但尚未实装的。每条必须按 §11 release-gate mapping 同时声明 fixture scenario / screenshots / failure state / smoke path / test gate。

| 表面 | 来源 | 必须实装的 4 态 | 责任 §9.x |
|---|---|---|---|
| **Artifact pane** (Files/Terminal/Preview) | kenji item 2 | focus = pane focus ring + 三栏 tab 焦点；loading = 文件读取 spinner；error = file not found / sandbox error inline；empty = "尚无 artifact，等模型生成后展示" | §9.1 |
| **Quick Chat panel** (global hotkey BrowserWindow) | yuejing alma 差距分析 | focus = composer auto-focus on open；loading = AX 抓取进度；error = 权限缺失 / hotkey 冲突 inline；empty = 首次使用提示 | §9.7 (扩) |
| **Health Center** (统一健康面板) | kenji item 7 | focus = 各 status row keyboard 导航；loading = 巡检中 spinner；error = 巡检失败 list + generalized message；empty = 所有 sub-system 健康时显示「一切正常」 | §9.3, §9.11 |
| **Workstation shell** (session status / workspace / branch) | kenji item 1 | focus = sidebar row focus；loading = sub-thread 状态加载；error = workspace 路径无效 inline；empty = 新 session 无 workspace 时显示「未关联 workspace」 | §9.4, §9.8 |
| **First-run to value flow** | kenji item 8 | focus = 当前步骤 input focus；loading = fetch-models 进度；error = 各 step inline error；empty = N/A（流程本身就是 onboarding） | §9.12 |
| **Turn control affordances** (retry / regenerate / branch / cancel) | kenji item 4 | focus = 每个 action button focus ring；loading = action pending 状态；error = action 失败 toast；empty = N/A | §9.9 |
| **Sources / Skills / Automations** 审计面板 | kenji item 5 | focus = 各 entry focus；loading = list 加载；error = entry 验证失败；empty = "暂无来源 / 技能 / 自动化" | §9.10 |
| **ModelCatalog 扩展行**（capability/pricing/source/unsupported） | kenji item 3 | focus = row focus；loading = pricing 拉取；error = model unsupported 警告 inline；empty = capability 全空时显示 "provider 未暴露能力信息" | §9.2 (扩) |

**已实装但待修缺口（next-wave PR 候选）**：

1. SessionListPanel 首次加载 skeleton（🟡）
2. Settings · 主题 error 态（异常时未显式提示）
3. Settings · 使用统计 error 态
4. About info IPC 失败的 fallback
5. Command Palette 命令执行失败的统一 surface

---

## 7. Release-gate 钩子

### 7.1 三条 gate

| Gate | 文件 | 覆盖 |
|---|---|---|
| **manual visual** | `apps/desktop/tests/smoke.md` | 9 path（first-launch → command palette），8-10 分钟 |
| **unit** | `apps/desktop/src/main/__tests__/*.test.ts` | 87 desktop tests（redact / connection-status / materialize-turns / open-path-guard / personalization-prompt / settings-IPC / chat-readiness / connection-test-status / model-table-keyboard / external-link-guard / window-state） |
| **log discipline** | `scripts/check-console.mjs` | `console.*` 调用必须在 ALLOW map 内；workspace pretest 触发 |

### 7.2 PR 必须满足

> **任何 PR 添加新可见 UI 必须**满足下面**至少一条**：
> 1. `apps/desktop/tests/smoke.md` 加一个 path 描述
> 2. `apps/desktop/src/main/__tests__/` 加一个 unit test 测试 derived helper
> 3. 如果纯改 CSS / token / 组件 recipe 无法 unit test：
>    **必须更新本文档对应章节**

### 7.3 pretest 工作流

```
npm --workspace @maka/desktop test
  → pretest:
      ├── npm --workspace @maka/core run build
      ├── npm --workspace @maka/ui run build
      └── node ../../scripts/check-console.mjs
  → npm run build:main
  → node --test "dist/main/**/*.test.js"
```

> 新增 console 调用必须在 `check-console.mjs:32 ALLOW` map 显式登记理由。未在
> 白名单的 console.* 会让 pretest 失败。

### 7.4 何时跑

- 合并任何 UI / runtime / credential / permission 改动到 main 前
- 改动以下任一时：`LlmConnection`、`sessions:changed` payload shape、
  `ConnectionUiStatus` derivation、`TurnViewModel`、`nextRadioId`、
  PermissionDialog rendering
- 打 release tag 前

---

## 8. 反模式（Anti-patterns）

> 这是 NOT-DO 清单。出现以下任意一条 → PR review block。

### 8.1 交互元素

❌ `<div onClick={...}>` 假冒按钮 / 链接
✅ `<button type="button">` 或 `<a href="…">`

❌ 浏览器原生 `title=""` 作为唯一 affordance 描述
✅ 视觉文字 + `aria-label`；`title=` 可作为 OS-level tooltip 兜底，但
  UX 延迟（~700ms）使其不能是主要 affordance；Tooltip primitive 暂未实装
  （见 §9）

❌ Modal 没经过 `useModalA11y`
✅ 所有 modal（含 ConfirmDialog、PermissionDialog、SettingsModal）必须用
  `useModalA11y(ref, onEscape?)`

❌ PermissionDialog 允许 Escape 关闭
✅ 权限决策必须显式 — Escape 在 PermissionDialog 内屏蔽

### 8.2 视觉

❌ 硬编码 hex / oklch（`color: #1a1a1a` / `background: oklch(0.5 0.1 200)`）
✅ 使用 `maka-tokens.css` 中 token；新 token 必须先登记到 §1

❌ 硬编码 z-index 数字（`z-index: 9999`）
✅ 使用 `--z-*` 阶梯，新阶梯先登记到 §1.7

❌ 硬编码 cubic-bezier
✅ 使用 §1.6 三条 named easing

❌ 动画 `top / left / width / height`
✅ 仅 `transform / opacity / color / background / border-color / box-shadow`

❌ 引入第三方 highlight.js CSS theme
✅ `.hljs-*` 选择器来自 `maka-tokens.css`，oklch(from var(--accent) …) 系列

### 8.3 安全 / 隐私

❌ 把原始 provider error / API key / 用户输入 / URL query secret 渲染到 UI
✅ 走 `generalizedErrorMessage` (core) + `redactSecrets` (UI 二层)

❌ `console.log` 未 dev-gate
✅ `console.*` 须 `process.env.NODE_ENV === 'development'` 或登记到
  `scripts/check-console.mjs ALLOW`

❌ 后端持久化用户 typed text / provider 名 / personalization tone 到 telemetry
✅ telemetry 仅写 errorClass、redactedMessage、status code

### 8.4 国际化

❌ 在可见 UI 新增顶层英文字符串
✅ 中文优先；英文仅限 §5.7 白名单（技术 token、品牌名）

❌ aria-label 用英文，visible text 用中文（或反之）
✅ 二者同语言（PR70 已扫一遍）

### 8.5 状态语义

❌ 流式中持续 tick `duration: Date.now() - startedAt`
✅ in-progress 时显示 "进行中"，duration 仅在 assistant 落地后写

❌ 假成本 `$0.0000`
✅ `costUsd > 0` 才显示

❌ silent fallback：把 fallback model list 当 "实时拉取" 显示
✅ `modelSource: 'fetched' | 'fallback'` 显式状态，UI 严格按枚举显示

❌ 在一个 row 上同时 streaming dot + unread halo
✅ streaming 优先，unread 在 streaming 时不渲染（PR85）

---

## 9. 未尽契约（Open questions / future contracts）

@kenji、@xuan、@yuejing 已识别但尚未契约化的项。这一节是 next-wave PR 的
研究入口。

### 9.1 ArtifactRecord shape — @kenji audit item 2 · PR108 主线

> **PR108 选定**（@kenji 2026-05-22）：作为 Maka 从 chat app 跨入 workbench 的
> 第一块骨架，先于 Quick Chat / Workstation shell 落地。本小节是 PR108 backend +
> renderer + fixture + smoke 的契约入口。

#### 9.1.1 核心 record

```ts
// @maka/core/src/artifacts.ts
export type ArtifactKind = 'file' | 'diff' | 'html' | 'image' | 'pdf';

export interface ArtifactRecord {
  /** UUID generated by main; primary key. */
  id: string;
  /** Owning session — artifacts are session-scoped, not workspace-scoped. */
  sessionId: string;
  /** Turn that produced this artifact; required for "branch from turn" + "checkpoint" semantics (§9.9). */
  turnId: string;
  /** Wall-clock ms when the artifact was created. */
  createdAt: number;
  /** Display name (assistant-supplied, e.g. "report.html"); sanitized for FS safety. */
  name: string;
  /** Discriminator. UI picks renderer per kind. */
  kind: ArtifactKind;
  /**
   * Storage backing. All artifacts are **file-backed** under
   * `{workspaceRoot}/artifacts/{sessionId}/{id}-{name}`. Renderer NEVER inlines
   * artifact bytes into transcript JSONL — only the record metadata.
   *
   * Why file-backed:
   *   - HTML must run in sandboxed iframe (§9.1.5)
   *   - Large outputs (PDFs, multi-MB diffs) can't survive in JSONL
   *   - Snapshot/diff/rollback (§9.9) needs stable file identity
   */
  storagePath: string;
  /** Byte size of the file at storagePath; surfaced in UI list rows. */
  sizeBytes: number;
  /** Optional mime-type hint (e.g. 'text/html', 'application/pdf'); falls back to inference. */
  mimeType?: string;
  /** Optional generalized source description (e.g. "Bash tool output", "Edit diff"). */
  source?: string;
  /**
   * State machine. Defaults to `'live'`; `'deleted'` is a tombstone (soft-delete)
   * so undo + audit are possible. Hard delete only via Settings · 数据 explicit
   * action.
   */
  status: 'live' | 'deleted';
}
```

**决策点已确定**：
- **per-session 工作目录**：artifact 跟 session 走，不跟 workspace 走。理由：
  branch-from-turn (§9.9) 需要复制 artifacts 到新 session 而不共享。
- **snapshot 版本号**：monotonic int（`turnId` 隐式承担版本顺序，无需独立计数器）。
- **删除**：软删（`status: 'deleted'`）。永久 purge 在 Settings · 数据。

#### 9.1.2 IPC contract

```ts
// preload window.maka.artifacts
artifacts: {
  list(sessionId: string, opts?: { includeDeleted?: boolean }): Promise<ArtifactRecord[]>;
  get(artifactId: string): Promise<ArtifactRecord | null>;
  /** Read file content as text (for diff / file / html previews). */
  readText(artifactId: string): Promise<{ ok: true; text: string } | { ok: false; reason: 'not_found' | 'too_large' | 'read_failed' }>;
  /** Read file content as Buffer→base64 (for image / pdf previews). */
  readBinary(artifactId: string): Promise<{ ok: true; base64: string; mimeType: string } | { ok: false; reason: 'not_found' | 'too_large' | 'read_failed' }>;
  /** Soft delete. */
  delete(artifactId: string): Promise<void>;
  /** Subscribe to `artifacts:changed { reason: 'created' | 'deleted' | 'purged', artifactId, sessionId }`. */
  subscribeChanges(handler: (event: ArtifactChangedEvent) => void): () => void;
};
```

> **不允许通过 IPC 暴露 `storagePath` 给 renderer** — 任何文件读取都走 `readText`
> / `readBinary` helper，main 验证 path 仍在 `{workspaceRoot}/artifacts/`
> prefix 之内（防御 path traversal）。同 PR56 openPath 模式。

> 大小阈值：`readText` 上限 10MB，`readBinary` 上限 50MB。超过返回
> `'too_large'`，UI 提示"打开 Finder 查看"（复用 PR56 openPath('artifact')）。

#### 9.1.3 渲染 — 右侧 pane shell

新增 `ArtifactPane` 组件，位于 chat shell 的右侧分栏。`<aside class="maka-artifact-pane">`：

- 默认隐藏；当 session 内至少 1 个 live artifact 时显示
- 用户可手动 collapse/expand（持久化到 localStorage `maka-artifact-pane-v1` 类似
  PR54 模式）
- 宽度：默认 360px，可拖拽 280-560 范围，复用 `maka-resize-handle` 模式
- 内部三个区域：
  - **list (top, scrollable)**：`ArtifactRow[]` 按 `createdAt desc`，每行 icon
    + name + size + relative time
  - **preview (bottom, 70% height)**：选中行的 preview，按 kind 分发
  - **toolbar (bottom strip)**：「打开 Finder」「复制路径」「删除」

#### 9.1.4 Per-kind preview MVP

| kind | preview 组件 | 限制 |
|---|---|---|
| `file` | `<pre class="maka-artifact-file">` + 复用 rehype-highlight | text 文件；非文本走 `image` / `pdf` 分支 |
| `diff` | 复用 PR76 `FileDiffPreview` 但全屏版（line cap 取消，因为 pane 有 scroll） | unified diff 文本 |
| `html` | **file-backed sandboxed iframe**（见 9.1.5） | 严格 |
| `image` | `<img src="data:{mimeType};base64,{base64}">` | PR60 redact 不适用（图像不文本） |
| `pdf` | `<embed type="application/pdf">` + fallback link "在 Finder 中打开" | macOS 内置 PDF rendering，Windows/Linux 走 fallback |

#### 9.1.5 HTML preview sandbox 契约

HTML artifact 是最危险的 kind，**必须**满足：

1. **file-backed**：HTML 内容不嵌入 JSONL；preview 通过 `file://` URL 加载
2. **sandboxed iframe**：`<iframe sandbox="allow-scripts" src="file://{storagePath}">`
   - 不允许 `allow-same-origin`（防止 same-origin 攻击到 file:// 协议）
   - 不允许 `allow-top-navigation`
   - 不允许 `allow-popups`
3. **CSP override**：渲染端的全局 CSP `default-src 'self'` 会阻止 file:// 加载；
   ArtifactPane 这一个 iframe 必须在 main 注入特定 webContents partition + 单独的
   permissive CSP。**禁止**把全局 CSP 放开。
4. **导航拦截**：iframe 内任何 `<a href>` 点击走 PR96 `setWindowOpenHandler` →
   `shell.openExternal`，永不在 iframe 内导航

#### 9.1.6 Failure states

| 状态 | 触发 | UI 表现 |
|---|---|---|
| **empty** | session 内无 live artifact | pane 不渲染，整个右侧让位给 chat |
| **single live artifact** | 仅 1 个 | list 折叠成单行 + preview 直接显示 |
| **read_failed** | `readText/readBinary` 返回 `'not_found' / 'read_failed'` | preview 区显示 destructive 色「无法读取 artifact 文件 · 路径可能已被外部删除」+「在 Finder 中打开」按钮 |
| **too_large** | 超出 10MB / 50MB 阈值 | preview 区显示 info 色「文件超出预览大小 · {sizeBytes} 字节」+「在 Finder 中打开」 |
| **html_blocked** | iframe 加载失败（CSP / 路径错） | preview 区显示「HTML 预览被沙箱拒绝 · 在 Finder 中打开查看原文」 |
| **deleted** | `status: 'deleted'` 但 includeDeleted=true | 行半透明 + "已删除" badge + 「恢复」操作（在 6 小时内可恢复） |

#### 9.1.7 Gate

- **node:test**：
  - `__tests__/artifact-path-guard.test.ts` — 复用 open-path-guard 模式，钉 storagePath 必须在 artifacts/ 前缀
  - `__tests__/artifact-record.test.ts` — record 创建 / soft-delete 转换 / size 限制返回正确 reason
- **fixture scenario**：新增 `artifact-pane`，seed 一个 session 含 3 artifacts：
  `report.html`、`patch.diff`、`notes.md`（不超过 10KB）
- **smoke path**（smoke.md 新增 Path 11）：
  - 入口：用 `MAKA_VISUAL_SMOKE_FIXTURE=artifact-pane` 启动
  - 期望可见：右侧 pane 展开，三行 list，preview 选择 report.html 后渲染沙箱 iframe
  - 失败信号：HTML 渲染失败但未显式提示、preview 内的 `<a>` 改变 renderer location

#### 9.1.8 PR 拆分

@kenji 在 review 中建议 backend/core 先定义 record + fixture seed，不急 extractor。
按此 PR108 拆成三个 sub-PR（保持 atomicity）：

| Sub-PR | 范围 | 责任 |
|---|---|---|
| **PR108a** | `@maka/core` 加 `artifacts.ts` + types；`@maka/storage` 加 artifact 存储；fixture seed 数据 | @xuan |
| **PR108b** | renderer ArtifactPane shell + list + 3 preview kinds + sandbox iframe；smoke path 11 + fixture scenario `artifact-pane` | @yuejing |
| **PR108c** | tool runtime 钩子（Bash/Write/Edit 等生成 ArtifactRecord）；node:test gate | @xuan |

### 9.2 ModelCatalogEntry capability / pricing / source enum — @kenji audit item 3

当前 `ModelInfo` 仅有 `id`。需要扩展：

- `capability: 'chat' | 'tool_use' | 'vision' | 'audio' | 'embedding'`
- `pricing?: { inputPerMtok: number; outputPerMtok: number; currency: 'USD' | 'CNY' }`
- `source: 'fetched' | 'fallback' | 'user_custom'`
- UI 表现：ModelTable 列扩展 + tooltip

### 9.3 Health Center 表面分类 — @kenji audit item 7

"Health Center" 是把 connection / bot / proxy / skill 四种健康检测 surface
统一在一处。当前各自分散在 Settings 不同 panel。决策点：

- top-level nav 加 "健康中心" 还是塞进 "数据与账号"
- 自动巡检节奏（手动 / 启动时一次 / 定时）
- 失败时是否升级到全局 toast

### 9.4 Workstation shell session-status enum — @kenji audit item 1

当前 SessionSummary 没有 status，UI 通过 `streamingBySession` Map 外部判定。
未来若引入 sub-thread / long-running task：

- `'idle' | 'streaming' | 'paused' | 'errored' | 'archived'`
- sidebar row 视觉如何区分（目前 streaming 与 unread 已经在挤同一片视觉）

### 9.5 Tooltip primitive

`title=""` 是当前兜底；Tooltip primitive（基于 `<dialog>` 或 floating-ui 风格
positioning）未实装。引入时需要：

- 决定一个 `--z-tooltip` 层叠（已登记，未消费）
- 决定 hover 触发延迟（建议 500ms，与 macOS native 一致）
- 必须支持 keyboard focus 触发（不光是 hover）
- 必须支持 `aria-describedby`，与 button label 解耦

### 9.6 Streaming `aria-live`

Composer streaming 状态目前没有 `aria-live`。屏幕阅读器用户感知不到 "Maka
正在思考…"。需要决定：

- `aria-live="polite"` 还是 `"assertive"`（polite 更妥）
- 文案触发频率（每次状态切换一次，而非每个 token）

### 9.7 ChatHeader streaming aria-live + Quick Chat 入口

Quick Chat（参考 alma macOS panel + global shortcut）尚未引入；引入时
`--z-overlay` 与 `--z-modal` 的相对关系、panel BrowserWindow 的设计需要单独
契约化。

**Quick Chat 实装契约（扩）**：

- **入口**：`globalShortcut.register('CommandOrControl+Shift+Space', …)`；冲突时
  fail fast + 在 Settings · 通用 给可配置回退键
- **窗口形态**：第二个 `BrowserWindow`，`type: 'panel'`（macOS），`frame: false`，
  `transparent: true`（看是否能在保持 sandbox + CSP 的前提下做毛玻璃），失焦自动隐藏（按
  `quickChatHideOnBlur` setting；默认 true）
- **上下文抓取**：v1 不接 macOS AX（隐私边界 + 权限引导成本太高）；先做"上一次主窗口
  active session"作为隐式上下文
- **renderer 复用**：用 `#/quick-chat` hash route 让单个 React tree 渲两个窗口
- **退出**：Escape / 失焦 / 同热键再次按下
- **fixture scenario**：新增 `quick-chat-floating`，seed 一个 active session 让 panel
  能直接接入

### 9.8 Workstation shell — session 状态机（@kenji item 1）

当前 `SessionSummary` 没有显式 status；UI 通过 `streamingBySession` Map + `hasUnread`
+ `isArchived` 拼出 4 种隐式状态。引入正式状态机后契约：

| status | 触发条件 | sidebar 视觉 | 允许的下一态 |
|---|---|---|---|
| `idle` | 默认 | 行无装饰 | active / archived |
| `active` | 用户正在聊 | normal text + 当前激活高亮 | streaming / idle / archived |
| `streaming` | 流式响应中 | 脉动 accent dot + "Maka 正在思考…" preview (PR85) | idle / errored / aborted |
| `waiting` | 等待外部输入（permission / human-in-loop） | info 色 hourglass icon | streaming / aborted |
| `blocked` | 缺凭据 / `lastTestStatus = error / needs_reauth` | destructive 色 alert icon | active（修复后） |
| `review` | 长任务输出待用户审核 | 信息色 magnifying glass icon | done / streaming |
| `done` | 完成 + 已审核 | check icon | archived |
| `aborted` | 用户 cancel 或 turn-level cancel | 灰 X icon | idle |
| `archived` | 用户归档 | 半透明，不显示 status icon | unarchive → idle |

**实装入口**：
- `SessionSummary.status: SessionStatus` 添加到 `@maka/core`
- `SessionRow` 新增 `<SessionStatusIcon status />` 替代当前 unread/streaming 二元
  指示
- 状态机转换在 main side（`SessionManager`），通过 `sessions:changed` 广播
- backend contract 由 @xuan 主导（@kenji 在 audit 里强调 "状态机不能由 UI 拼"）

**Failure states**：每个 status 都要有 generalizedErrorMessage enum 对应的 reason
字段（如 `blocked` 需要 `block_reason: 'auth' | 'timeout' | 'network' | ...`）。

**Gate**：node:test 钉死合法转换矩阵；fixture scenario `workstation-statuses` 给每种
status 各 seed 1 个 session；smoke path 验 5 种 status 视觉。

### 9.9 Turn control 契约（@kenji item 4）

`retry / regenerate / branch-from-turn / cancel / checkpoint-before-tools` 是
turn-level contract，目前 Maka 只有 `stop`（通过 PR66 的 Composer Stop 按钮）。

**操作清单**：

| 操作 | 触发位置 | 持久化影响 | 不变量 |
|---|---|---|---|
| `retry` | turn footer hover action | 写新 turn，旧 turn 保留 + 标记 `retried_from` | **旧 turn 输出不可被覆盖** |
| `regenerate` | assistant message footer hover | 同 retry，但用相同 user message | **旧 turn 输出不可被覆盖** |
| `branch-from-turn` | turn header context menu | 创建新 session，复制至此 turn 的所有消息 | 原 session 不变 |
| `cancel` | streaming 中的 Stop / Esc | turn 落 `aborted` 状态，partial output 保留 | cancel 必须显式标 `aborted`，不可隐式删 |
| `checkpoint-before-tools` | 自动（如果 turn 含 destructive tool） | 在 destructive tool 之前 snapshot workspace | snapshot 失败 → 阻止 tool 调用 |

**UI 表现**：
- 每个 assistant message 底部 hover 区域显示 `↻ 重试 / 🌿 分支 / 📋 复制`
- 取消时 message 文本前端追加灰色斜体 "(已中断)"
- Branch 后 sidebar 立刻显示新 session 并自动 select

**Gate**：
- node:test 钉死 `aborted` 状态机：cancel 时 turn.status === 'aborted' 且
  partial output 不被丢弃
- smoke path `turn-control-affordances`：seed 一个含 5 个 turn 的 session，验
  retry/regenerate/branch 各一次

### 9.10 Sources / Skills / Automations 可见系统（@kenji item 5）

Maka 当前 skills 是文件系统扫描结果（`window.maka.skills.list()`），无 source、
无 automation；alma 把这三类做成可审计 + 可禁用的一等公民。

**Contract**：

| 实体 | 字段 | UI 表面 |
|---|---|---|
| `Source` | `id / name / auth / scope / lastSyncAt / status` | Settings · 来源（新 panel） |
| `Skill` | `id / name / declaredTools[] / requestedTools[] / installedAt / source` | Settings · 技能（已有，需扩 `requestedTools`） |
| `Automation` | `id / name / trigger / lastRunAt / status / lastError` | Settings · 自动化（新 panel） |

**关键不变量**：
- **skill 不等于 permission widening**：skill 声明 `allowed-tools` 仅是 *请求*，
  实际能用的工具仍受 PermissionEngine 检查；UI 表现要让用户看到 "声明" vs
  "实际授权" 的差异（参考 PR51 的 "declared / requested" 区分）
- **source 凭据不渲染原文**：与 connection apiKey 一致，masked + safeStorage
- **automation last-run 失败 → 自动禁用**？ 决策点：弱协议（仅显示 error），还是
  连续 N 次失败自动 disable？后者需要新的 backend 状态机

**Gate**：smoke path `sources-skills-automations`：seed 3 个 source、5 个 skill、
2 个 automation，验各自 panel 渲染 + 禁用切换 + last-run/sync 时间显示。

### 9.11 Health Center 表面契约（@kenji item 7 — 扩 9.3）

把 connection / bot / proxy / search / voice / open-gateway / storage 7 类健康检测
统一到一处。当前各自分散在 Settings 不同 panel + chat header alert。

**入口**：
- top-level nav 顶部固定一个 "健康中心" 图标 + badge（健康度颜色 dot）
- 任何 sub-system 出现 error 时 badge 变红，hover 显示具体分类

**面板结构**：

每个 sub-system row 显示：
1. icon + 名称
2. 当前 status（`healthy / warning / error / unknown`）
3. 最近一次 generalized message（如 "Authentication failed · 3 分钟前"）
4. action：「立即检查」「打开对应 Settings」「复制诊断信息」

**诊断 copy**：
- 必须走 redactSecrets 二层；不暴露原始 provider URL / api key / user id
- 格式：Markdown 带时间戳 + sub-system 名 + generalized message + 当前 settings
  shape（脱敏）

**Gate**：
- smoke path `health-center-overview` + `health-center-all-errors`（fixture
  scenario `health-center-degraded`，seed 7 个 sub-system 各种 status）
- node:test 钉死 diagnostics copy 不包含 raw secret（复用 PR60 redact 测试矩阵）

### 9.12 First-run to value（@kenji item 8）

4 步内从空 workspace 到第一次 smoke prompt 成功：

```
Step 1: 选 provider (preset list)
    ↓ 错误：preset 不可用 → inline error，不允许跳过
Step 2: paste API key（仅本地，safeStorage）
    ↓ 错误：key 格式不合法 → inline；test 失败 → 阻止下一步（不允许 fallback-as-success）
Step 3: auto-fetch models → 选 default
    ↓ 错误：fetch 失败 → 显示原因 + retry / 选 fallback model（必须明确标 fallback）
Step 4: 发送 smoke prompt（一句 "hi"）
    ↓ 错误：发送失败 → 不允许进入主界面，必须修复
```

**不变量**：
- 步骤间不能 silently fallback（每个失败必须 inline，并阻止下一步）
- 4 步全部完成才进主界面（OnboardingHero 替换为新的 stepper 流）
- 用户可以 Esc 跳过但需要二次确认 + 持久化 `onboarding.skipped = true`

**UI 实装**：替换当前 `OnboardingHero` 为 stepper 模式。每步独立组件，可单独
fixture seed。

**Gate**：
- fixture scenario `first-run-stepper`：seed 一个空 workspace + 一个 mock
  provider preset，让 e2e 能从空到第一条消息走完
- smoke path `first-run-stepper`：跑完 4 步 + 一个 step-3 失败分支

---

## 9b. @kenji v2 audit — 8 个系统 contract（informative，但下一波 PR 必读）

来自 @kenji 自己的 `notes/maka-alma-craft-design-gap-v2.md` +
`notes/maka-redesign-v1-contract-smoke-gate.md`。这些是 next-wave 的工作
入口，每条都要落到本文档对应小节后才动手写代码：

| # | 系统 | 一句话契约 | 在本文档对应 |
|---|---|---|---|
| 1 | **Workstation shell** | session 必须有状态机 `active / running / waiting / blocked / review / done / archive`；header + sidebar 显示 workspace / branch / status / PR，不再只靠聊天列表表达工作状态。| §3 SessionRow 扩、§9 新增 9.8 "session 状态机契约" |
| 2 | **Artifact pane** | generated file / html / image / pdf / diff 变成 `ArtifactRecord`；右侧 pane 预览；HTML 必须 file-backed + sandboxed `<iframe srcdoc>`，不能把大内容塞进 transcript。| §9 既有 ArtifactRecord 条目，需扩到 file-backed + sandbox 规则 |
| 3 | **ModelCatalogEntry** | backend 归一化 `capabilities / context / pricing / source / stale / unsupported`；UI 只展示事实，不猜；`unsupported / image-only` 不能设为 chat default。| §3 ModelTable 扩、§9 ModelCatalogEntry 条目 |
| 4 | **Turn control** | `retry / regenerate / branch-from-turn / cancel / checkpoint-before-tools` 是 turn-level contract；旧输出不可被覆盖；cancel 必须落 `aborted` 状态。| §3 TurnView 扩 + §9 新增 9.9 "Turn control 契约" |
| 5 | **Sources / Skills / Automations** | source 的 auth/scope、skill 的 allowed tools、automation 的 last-run 都必须可见、可验证、可禁用；skill 不能等于 permission widening。| §3 ToolActivity 扩 + §9 新增 9.10 |
| 6 | **Visual system contract** | 即本文档。下一波每个新 surface 必须声明 fixture scenario + light/dark/narrow screenshot + failure state。| §11 "Release-gate mapping" |
| 7 | **Health Center** | provider/credential/bot/proxy/search/voice/open-gateway/storage 的 status 和最近 generalized error 集中展示；支持 redacted diagnostics copy。| §9 新增 9.11 |
| 8 | **First-run to value** | provider preset → 本地 paste key → auto-fetch models → 选 default → 发 smoke prompt 4 步内闭环；错误 inline，不许 fallback-as-success。| §6 surface 表加入；§9 新增 9.12 |

---

## 10. 版本与变更策略（Versioning + change policy）

### 10.1 版本来源

- 本文档**不**单独 semver。隐式 versioning 由 git 提交承担。
- 顶部 frontmatter "版本：v0.2-wave-N" 跟随 wave 节奏更新；wave 切换由
  yuejing 或 reviewer 在 PR 中显式 bump。

### 10.2 新增 token

- 新增**必须**同 PR 修改 `maka-tokens.css` + 本文档 §1 对应小节。
- 新 token 必须满足：name 是 `--<category>-<role>[-<modifier>]` 形式；不超过
  3 段；下划线 / camelCase 禁用。

### 10.3 废弃 token

- 不允许直接删除。流程：
  1. PR-A：在 CSS 注释加 `/* @deprecated since v0.2-wave-X — use --new instead */`，
     在本文档 §1 对应行加 `@deprecated` 标注，列入"废弃中"
  2. PR-A+N（≥1 个 release）：在确认所有 consumer 已迁移后，PR-B 同时删除 CSS
     定义和本文档行
- 废弃期间，新代码**禁止**引用废弃 token，由 grep-based PR review 把关

### 10.4 5 态契约的破坏

- 任何对组件 §3 5 态行为的变更（如 PermissionDialog 允许 Escape）需 channel
  显式签字：@kenji + @xuan + @yuejing 三方至少两方 approve
- 签字记录写入 PR description，本文档对应小节同步更新

### 10.5 反模式追加

- 任何在 review 中第二次发现的 anti-pattern → 列入 §8
- 列入后，下一次出现可直接 block PR 而不再 case-by-case 讨论

### 10.6 文档与代码的同步

- release-gate 不机械验证文档存在性（成本过高），改用 PR review 弱协议
- reviewer 校验清单：
  1. 引入新 CSS custom property → §1 是否更新？
  2. 引入新 React 组件 → §3 是否登记？
  3. 引入新 Settings page / Surface → §6 是否登记 4 态？
  4. 引入新 anti-pattern 案例 → §8 是否补充？

---

## 11. Release-gate mapping（new-surface 验收契约）

@kenji audit item 6 的具体落地规则。任何**新引入**或**结构性重设计**的
surface（不是单纯样式 polish）必须在 PR 描述里声明以下五件事，缺一不可：

### 11.1 Fixture scenario

引用 `MAKA_VISUAL_SMOKE_FIXTURE=<scenario>` 中的某一个 scenario（@xuan
当前在做 fixture mode 底座，覆盖 7 个 canonical state：`first-run` /
`workspace-fetched` / `fallback-with-refresh-error` / `fetched-empty` /
`needs-reauth-or-error` / `turn-with-thinking` / `destructive-permission`）。

如果新 surface **需要**新 scenario，PR 必须先扩 fixture seed，再加 UI。
不允许"看起来对就行"。

### 11.2 Screenshot 矩阵（最少 3 张）

| 维度 | 取值 |
|---|---|
| Theme | light + dark（两张） |
| 视口宽度 | 990px（窄）+ 1240px（默认）— 任选一档；或两张都要 |
| 状态 | 至少一张 failure / empty / loading 中的非 happy-path |

放在 PR description 内联，便于 reviewer 扫读。文件命名建议
`docs/screenshots/<surface>-<scenario>-<theme>-<width>.png`，repo 内归档
可选。

### 11.3 Failure state 显式声明

每个新 surface PR 必须显式说明：

- **What can fail here?** 列出 ≥1 个失败分支（fetch 超时、auth 401、空响应、
  并发 race、用户取消等）。
- **How does the user see it?** 引用 §6 表格中的 error/empty 写法（不能新造
  pattern 而不入文档）。
- **Generalized message text** — 引用现有 `generalizedErrorMessage` 6 enum
  之一，或在 PR 中声明新 enum + 同 PR 更新 helper。

### 11.4 Smoke gate hook

如果新 surface 改变了已有的 9 条 smoke path，PR 必须同步 `apps/desktop/
tests/smoke.md`。如果新 surface 引入了全新的 path（如 Health Center 首屏、
Artifact pane 打开），必须**新增**一条 smoke path，覆盖以下要素：

- 入口（如何从默认状态到达这个 surface）
- 期望可见信号（≥2 个）
- 失败信号（≥1 个）

### 11.5 Test gate hook

renderer-only 视觉变更可以仅靠 smoke + screenshot 验收；带逻辑分支的（如
turn-control 的 cancel 状态机、ModelCatalog 的 unsupported gate、session
状态机的转换规则）必须有 node:test 单元测试钉死分支。

参考已有契约 gate：

- `__tests__/connection-status.test.ts` — ConnectionUiStatus 6 态 + 优先级
- `__tests__/materialize-turns.test.ts` — TurnViewModel projection
- `__tests__/model-table-keyboard.test.ts` — ARIA radiogroup keyboard 行为
- `__tests__/redact.test.ts` — UI 二级 redactor
- `__tests__/open-path-guard.test.ts` — IPC allow-list + structured reason
- `__tests__/external-link-guard.test.ts` — URL scheme whitelist
- `__tests__/window-state.test.ts` — sanitize bounds

### 11.6 Reviewer checklist（粘到 PR description）

```markdown
- [ ] Fixture scenario: <name>（或 N/A + 理由）
- [ ] Screenshots: light + dark + (failure/empty/loading)
- [ ] Failure state: <列举 + generalized message enum>
- [ ] smoke.md updated（或 N/A + 理由）
- [ ] node:test added/updated（或 N/A + 理由）
- [ ] §1 tokens / §3 component contract / §6 surface 表格已同步
- [ ] check-console.mjs 通过（pretest）
- [ ] typecheck + build + tests 全绿
```

### 11.7 例外

只动文档 / 注释 / commit message 的 PR 不需要走 11.1–11.5；reviewer
checklist 仍要勾。

仅修 bug 不引入新 surface 的 PR 走最小修复 + 单测，不需要 11.1–11.4，但
仍需 11.5（即"该 bug 在 test 里被钉住"）。

---

## 附录 A — 当前依赖快照（informative）

| 依赖 | 版本 | 范围 |
|---|---|---|
| react / react-dom | ^19.2.1 | UI |
| electron | ^39.2.7 | shell |
| lucide-react | — | icon 唯一来源 |
| react-markdown + remark-gfm + remark-breaks | — | assistant markdown |
| rehype-highlight | — | code 高亮 |
| @fontsource-variable/geist + geist-mono | ^5.2.x | 字体 |

> 字体托管：Geist Variable + Geist Mono Variable 自包，本地 fallback 链 ⊇
> system-ui。不要再引入额外字体。

---

## 附录 B — 关键文件索引

| 主题 | 路径 |
|---|---|
| Token 定义 | `apps/desktop/src/renderer/maka-tokens.css` |
| 组件 recipe | `apps/desktop/src/renderer/styles.css` |
| 共享 React 组件 | `packages/ui/src/components.tsx` |
| Toast + Confirm | `packages/ui/src/toast.tsx` |
| UI redactor | `packages/ui/src/redact.ts` |
| TurnViewModel + materialize | `packages/ui/src/materialize.ts` |
| Connection 6-state | `apps/desktop/src/renderer/connection-status.ts` |
| Settings 主入口 | `apps/desktop/src/renderer/settings/SettingsModal.tsx` |
| ProvidersPanel + ModelTable | `apps/desktop/src/renderer/settings/ProvidersPanel.tsx` |
| ModelTable 键盘 helper | `apps/desktop/src/renderer/settings/model-table-keyboard.ts` |
| smoke gate | `apps/desktop/tests/smoke.md` |
| desktop unit tests | `apps/desktop/src/main/__tests__/*.test.ts` |
| console 审计 | `scripts/check-console.mjs` |

— END —
