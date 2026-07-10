# Mobbin 设计语言提取 — 2026-07-11

> 提取来源：mobbin.com 首页（Framer 站点，内嵌产品 UI 的 1:1 DOM 复刻）+ 产品 UI 截图。
> 方法：Chrome extension 实测 `getComputedStyle`（`/discover` 需登录，本文所有数值来自
> 公开页面的真实计算样式，非目测）。
> 用途：maka 全局视觉重构（feat/mobbin-restyle）的唯一参照。UX/流程/DOM 结构不动，只改视觉。

## 1. 色彩 — 单色近乎禁欲

Mobbin 的第一特征是**几乎无彩**。内容截图自带颜色，界面本身退到纯中性：

| 角色 | 实测值 | 备注 |
|---|---|---|
| 画布 | `rgb(255,255,255)` 纯白 | 产品区块外壳为浅灰段落时用 `rgba(64,64,64,0.06)` |
| 墨色 | `rgb(20,20,20)` (#141414) | 标题与正文同源，靠字重/字号分层 |
| 次级墨 | `rgba(20,20,20,~0.6)` 视觉观察 | Section 标签（"Categories"）是明显更浅的灰 |
| 表面洗色 | `rgba(64,64,64,0.06)` | 大面积面板（demo 外壳、卡片底） |
| 控件洗色 | `rgba(64,64,64,0.08)` | 分段控件槽、搜索框填充 |
| 边框 | `rgba(65,65,65,0.16)` 1px | 次级按钮描边，唯一的描边语言 |
| 主 CTA | 纯黑底 `#141414` + 白字 | 无品牌色按钮 |
| 半透明 chrome | `rgba(237,237,237,0.64)` + `backdrop-filter: blur(48px)` | 悬浮导航胶囊 |

**要点**：没有"品牌蓝按钮"。主操作 = 黑色药丸；强调靠形状（pill）与对比（黑/白），
不靠色相。状态色只留给真正的状态（这与 maka 已有的 status-color-restraint 规则 #651 同向）。

## 2. 字体排印 — 一款自研 grotesk 撑全场

实测 `document.fonts`：**M Saans**（自研 variable grotesk，权重轴 300/380/456/570/600/652/900）、
**Recital**（衬线，editorial 点缀用）、**Geist Mono**（数字/代码）、Inter 兜底。

实测类型标尺（频次排序）：

| 层级 | 实测 | 特征 |
|---|---|---|
| Display XL | 80px / w652 / ls -0.6px / lh 1.0 | 巨大、紧排、行高 1 |
| Display L | 56px / w652 / ls -0.6px / lh 1.0 | 同上 |
| Heading | 32px / w652 / ls normal | |
| Card title | 24px / w652 / lh 1.25 | 产品 UI 分类链接同级 |
| Body emphasis | 16px / w456 / ls -0.16px | "半粗"的 UI 强调 |
| Body | 16px / w300 / **ls +0.2px** | 轻字重 + 微正字距（拉丁文案） |
| Label/按钮 | 16px / w600 / ls +0.2px | CTA 文字 |
| Small | 14px / w300 / ls +0.2px | 辅助说明 |

**规律**：大字紧排（负字距、lh 1.0），小字松排（正字距）；权重两极化（很轻的正文 vs 很重的
标题），中间态少。衬线只做一处点缀，从不用于 UI。

**maka 适配注**：CJK 不能收字距（roadmap §4.1 禁令仍有效），w300 在 13px CJK 会发虚。
落地时取"精神"而非数值：标题加重（600→650 视觉档）、display 行高压到 1.0-1.1、
拉丁 label 加 +0.02em、正文保持 400。

## 3. 形状 — 药丸为王，圆角分三档

| 元素 | 实测 | 备注 |
|---|---|---|
| 按钮（主/次） | r 999px，高 44px | "Join for free" 122×44 黑药丸；次级同形透明+16% 描边 |
| 分段控件 | 槽 r 99px（8% 洗色），活动片 r 99px 白底 | 白片带 `0 1px 2px rgba(0,0,0,.04)` |
| 搜索框 | 药丸，灰填充无描边 | |
| 小 chip（New/Updated） | r 99px，灰底 | |
| 卡片 | r 16px（内容卡）/ r 20px（截图卡） | |
| 大面板/外壳 | r 24px | demo 区块外壳 |
| 悬浮导航 | r 30px，高 60px | |

**规律**：可交互 = 药丸；容器 = 16/20/24 大圆角；没有 4-8px 的"小圆角"中间态。
maka 现值 control 6 / surface 8 / modal 12 → 目标 control=pill、surface 12→16、modal 20。

## 4. 高度/阴影 — 比"扁平"多一口气

- Chip/活动分段片：`rgba(0,0,0,0.04) 0 1px 2px`
- 悬浮卡（手机截图卡）：`rgba(0,0,0,0.04) 0 8px 40px`（大 blur、极低不透明度、无多层堆叠）
- 大多数表面：**无阴影**，靠洗色差与 1px 16% 描边分层
- Chrome：半透明 + blur(48px)，靠通透感而非阴影浮起

maka 现有 5 层堆叠 shadow recipe → 收敛为 Mobbin 两档：`--shadow-minimal`（0 1px 2px 4%）
与 `--shadow-medium`（0 8px 40px 4%）。dark mode 仍按现规则塌缩为 ring。

## 5. 动效 — 少而软

- 全站交互过渡实测只有一种：`color, background 0.2s ease`。
- 大动效全部是滚动驱动的 reveal（营销页专属，产品 UI 无）。
- 没有 bounce/spring；hover 无位移、无缩放（营销页 CTA 也不动）。

maka 现有 motion token（120/150/180/280ms + 强曲线）已经比 Mobbin 精致，**保留时长档**，
但 hover 反馈幅度收敛：去掉 hover 缩放/上浮（--scale-hover / --lift-hover 使用点收敛），
press 缩放保留（触觉反馈）。

## 6. 图标 — 几何 outline，细节收敛

产品 UI 图标（搜索、书签、罗盘、滤镜）都是 ~1.5-2 stroke 几何 outline，无填充、无双色。
maka 已完成 lucide stroke=2 统一（icon-governance），方向一致，无需换库。尺寸 16 保持。

## 7. 布局手感

- 悬浮 pill 导航居中，不通栏；产品 UI 顶栏通栏但极简（logo + 2 tab + 居中搜索 + 右侧 3 icon）。
- 大留白：section 间距 ≥ 96px（营销页）；产品 UI 密度与 maka 接近。
- 卡片网格 gap 视觉 ~24px，卡片内 padding ~16-20px。

## 8. maka 落地映射（token 级）

| maka token | 现值 | 目标值 | 理由 |
|---|---|---|---|
| `--radius-control` | 6px | 999px（按钮/chip/输入类）
| `--radius-surface` | 8px | 12px | 卡片、面板 |
| `--radius-modal` | 12px | 20px | 模态、大面板 |
| `--shadow-minimal` | 3 层堆叠 | ring + 0 1px 2px 4% | Mobbin chip 影 |
| `--shadow-medium` | 5 层堆叠 | ring + 0 8px 40px 4% | Mobbin 浮卡影 |
| `--action` | 淡蓝 chip | `--foreground`（黑药丸）+ 白字 | 主 CTA 单色化 |
| `--accent` | logo 蓝 | 保留（链接/运行态/焦点） | 状态语义不动 |
| 标题字重 | 600 | 650 | display/heading 视觉档 |
| display 行高 | 1.25 | 1.1 | 大字紧排 |
| 分段控件 | 边框式 | 灰槽 8% + 白活动片 + 1px2px 影 | Mobbin 签名控件 |
| sidebar 面板 | 实色 near-white | 半透明 + blur | 通透 chrome |

不动的：spacing 标尺、icon 体系、motion 时长档、状态色语义、全部 UX/DOM。
