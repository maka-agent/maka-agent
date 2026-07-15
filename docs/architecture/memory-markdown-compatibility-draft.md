---
doc_id: architecture.memory-markdown-compatibility
title: "Chapter 7: Legacy Is Not Approval - The MEMORY.md Compatibility Boundary"
language: en
source_language: zh-CN
counterpart: ./memory-markdown-compatibility-draft.zh-CN.md
implementation_status: current
document_status: draft
translation_status: synced
last_verified: 2026-07-13
owners:
  - maka-backend
---

# Chapter 7: Legacy Is Not Approval - The MEMORY.md Compatibility Boundary

`MEMORY.md` remains a user-visible and user-editable Markdown fact source, but old text must never be silently interpreted as confirmed structured memory. This chapter records the current `maka.local_memory.entry.v1` boundary.

## Three entry classes

| Class | Classification | Behavior |
|---|---|---|
| Structured v1 active | Has `entrySchema`, `compatSource=structured_v1`, `migrationState=not_required`, durable `source`, `scope`, `confirmedAt`, `approvedBy=user`, `approvalSurface`, and at least one `sourceRefs` item | Enters the strict durable active set and prompt |
| Legacy Markdown | Has no `entrySchema` | Original text is preserved; public state is projected as `review_required` + `legacy_active` when old metadata declared active, with `legacy_markdown` / `legacy_read_only`; readable only under explicit `workspace_compat` policy and rendered with a model-visible read-only, unconfirmed compatibility label |
| Malformed structured | Declares v1 but metadata is missing, duplicated, invalid, or inconsistent | Projected as `malformed_read_only`; locatable and recoverable in Settings, never included in prompts |

The document-level `maka-memory-version` is a monotonic revision for atomic file writes. It is not the entry schema version, and the two must not be conflated.

## Source refs

Strict durable entries use the Core source-ref contract:

- `manual_editor:MEMORY.md`
- `proposal:<proposal-id>`
- `chat_turn:<turn-id>`
- `approval_surface:<surface>`

A legacy section receives only an in-memory `legacy_section:<digest>` reference. The parser does not rewrite the source or invent confirmation.

## Lifecycle

- New manual memories and approved proposals write a complete v1 confirmation envelope.
- Proposals remain `review_required` and cannot enter durable active state.
- Archiving preserves confirmation and source refs.
- A legacy entry without a strict confirmation envelope cannot be restored directly to active; the operation returns `confirmation_required`.
- Duplicate metadata comments, duplicate keys inside one comment, invalid tokens, and unknown schemas fail closed.

## Concurrency, recovery, and rollback

Compatibility classification depends only on committed Markdown and reuses existing versioned writes, transaction journals, cross-process locks, and torn-transaction recovery. Concurrent readers and restarted services must classify the same revision identically.

This phase does not apply an in-place bulk migration. Original Markdown remains the read-only compatibility source; parse failures preserve content while blocking model access. Migration reports, backup application, and downgrade commands belong to MM-31.

## Limits

- `workspace_compat` can still make legacy active content model-visible, but both the prompt body and trace identify it as read-only compatibility data; it is not confirmed durable memory.
- The deterministic lifecycle fixture covers strict, plain legacy, old metadata, malformed v1, and archived legacy cases. Formal model benchmarks remain part of the checkpoint evaluation stage.
