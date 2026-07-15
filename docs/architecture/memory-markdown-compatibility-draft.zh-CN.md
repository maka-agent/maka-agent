---
doc_id: architecture.memory-markdown-compatibility
title: "第七章：Legacy Is Not Approval——MEMORY.md 兼容边界"
language: zh-CN
source_language: zh-CN
counterpart: ./memory-markdown-compatibility-draft.md
implementation_status: current
document_status: draft
translation_status: synced
last_verified: 2026-07-13
owners:
  - maka-backend
---

# 第七章：Legacy Is Not Approval——MEMORY.md 兼容边界

`MEMORY.md` 仍是用户可见、可编辑的 Markdown 事实源，但旧文本不能被静默解释为已经确认的结构化记忆。本章记录 `maka.local_memory.entry.v1` 的当前实现边界。

## 三类条目

| 类型 | 判定 | 行为 |
|---|---|---|
| Structured v1 active | 具备 `entrySchema`、`compatSource=structured_v1`、`migrationState=not_required`、durable `source`、`scope`、`confirmedAt`、`approvedBy=user`、`approvalSurface` 和至少一个 `sourceRefs` | 进入 strict durable active 集合和 prompt |
| Legacy Markdown | 没有 `entrySchema` | 原文保留，公共状态投影为 `review_required` + `legacy_active`（若旧 metadata 声明 active），并标记 `legacy_markdown` / `legacy_read_only`；只在显式 `workspace_compat` 策略下读取，并在模型可见 prompt 中标注“只读兼容、尚未确认” |
| Malformed structured | 声明 v1，但 metadata 缺失、重复、非法或互相矛盾 | 投影为 `malformed_read_only`；Settings 可定位和修复，绝不进入 prompt |

文档级 `maka-memory-version` 是原子文件写入使用的单调 revision，不是 entry schema version。二者不能混用。

## Source refs

严格 durable entry 使用 Core 定义的 source-ref contract：

- `manual_editor:MEMORY.md`
- `proposal:<proposal-id>`
- `chat_turn:<turn-id>`
- `approval_surface:<surface>`

Legacy section 只在内存投影中获得 `legacy_section:<digest>`，parser 不会回写原文，也不会伪造 confirmation。

## 生命周期

- 新增手工记忆和审核通过的记忆必须写出完整 v1 confirmation envelope。
- proposal 保持 `review_required`，不能进入 durable active。
- archive 必须保留 confirmation 和 source refs。
- 缺少严格 confirmation envelope 的 legacy entry 不能直接 restore 为 active，返回 `confirmation_required`。
- 重复 metadata comment、同一 comment 内重复 key、非法 token 和未知 schema 均 fail closed。

## 并发、恢复与回滚

兼容分类只依赖已提交 Markdown，复用现有 versioned writes、transaction journal、跨进程锁和 torn transaction recovery。多个 reader 或重启后的 service 对同一 revision 必须得到相同分类。

本阶段不执行原地批量迁移。原始 Markdown 始终是 read-only compatibility source；解析失败时保留内容并禁止模型读取。迁移报告、备份应用和 downgrade 命令属于 MM-31。

## 限制

- `workspace_compat` 仍可让 legacy active 内容进入模型，但 prompt body 和 trace 都会明确标记它是只读兼容数据；它不属于 confirmed durable memory。
- 当前 deterministic lifecycle fixture 验证 strict、plain legacy、old metadata、malformed v1 和 archived legacy 五类；正式模型 benchmark 仍由 checkpoint 评测阶段执行。
