# 04 — Memory: SQLite + sqlite-vec + Soul Tree vs Maka's MEMORY.md

**TL;DR.** Yetone has a three-store memory architecture: SQLite (49 tables incl. `memory_embeddings` via `sqlite-vec`), the `~/.config/alma/` markdown "soul tree" (SOUL/USER/MEMORY/HEARTBEAT/diary/people/chats/groups), and per-workspace `.alma-snapshots/`. Recall is via cosine vector search; a sleep loop archives memories on five reasons (exact dup, expired, orphan, similarity, llm-judged). Maka has only a single transparent `<workspace>/memory/MEMORY.md` with versioned backups — architecturally simpler and a better privacy story. The borrowable items are mostly *prompt-side* (soul/user/security framing) and *DB-side* (the `memories` scoring formula, the sleep-loop archival reasons, the `vec0` extension if we want vector recall).

---

## 1. The three stores

Per `~/Downloads/alma-re/docs/08-memory.md §1`:

| Store | Location | Format | Owner |
|---|---|---|---|
| **Primary DB** | `~/Library/Application Support/alma/chat_threads.db` (+ `-wal`, `-shm`) | SQLite (better-sqlite3 + WAL) | `To` (`Database` class at `main.js:~1840`) |
| **Vector index** | Same DB file, `memory_embeddings` virtual table | `sqlite-vec` `vec0` extension | `co` MemoryService singleton at `main.js:~850` |
| **Personality / soul tree** | `~/.config/alma/` | Markdown + JSON + binary media | Heartbeat / cron / personality / IM bridges |
| **Workspaces** | `~/Library/Application Support/alma/workspaces/<id>/` | Actual project trees + `.alma-snapshots/` for rollback | `Snapshot` service at `main.js:~29260` |
| **Misc caches** | `~/Library/Application Support/alma/{embedding-models, whisper_models, plugin-cache, ...}` | Files | various |

Maka has:

| Store | Location | Format |
|---|---|---|
| **Sessions** | `<workspace>/sessions/<sessionId>.jsonl` | JSONL via `SessionStore` (in `@maka/storage`) |
| **Local memory** | `<workspace>/memory/MEMORY.md` + `<workspace>/memory/.backups/*.md.bak.<ts>` | Markdown via `LocalMemoryService` (`apps/desktop/src/main/local-memory-service.ts`) |
| **Settings** | (workspace-scoped via `Settings` package) | JSON |

No SQLite. No vector store. No soul tree. The single-file MEMORY.md design is *intentional* — it's the user's privacy story.

---

## 2. SQLite schema highlights (worth borrowing in spirit, not in detail)

Per `~/Downloads/alma-re/docs/08-memory.md §3`, the 49 tables include:

### 2.1 Memory core

#### `memories`

```
id                TEXT PK           timestamp+random
content           TEXT NOT NULL     the memory text
metadata          TEXT NOT NULL     JSON: {source, durability ('permanent'|'temporary'), tags, importance (0-1), accessCount}
thread_id         TEXT → chat_threads(id) ON DELETE SET NULL
message_id        TEXT              source message (no FK)
user_id           TEXT              added by inline migration
created_at, updated_at TEXT NOT NULL
```

Scoring formula at `main.js:770-812`:

```
score = (durability=='permanent' ? 1e6 : 0)
      + (userId ? 1e5 : 0)
      + 1000 * importance
      + min(accessCount, 1e4)
      + floor(parse(updatedAt)/1000) / 1e9
```

This is the **recall ranking** — permanent always beats temporary, user-attributed beats orphan, importance is a 0-1000 lever, accessCount bumps frequently-recalled items.

#### `memory_archive`

Soft-deleted memories. Reasons: `exact`, `expired`, `orphan`, `similarity`, `llm`.

#### `memory_sleep_runs`

Periodic compaction passes. Tracks `examined`, `archived_exact`, `archived_expired`, `archived_orphan`, `archived_similarity`, `archived_llm`, `input_tokens`, `output_tokens`. Triggers: `manual | idle | count | scheduled`.

#### `memory_metadata`

K/V store. Holds `embedding_model` (current model name). Used to detect model changes that require a full rebuild.

#### `memory_embeddings` — `vec0` virtual table

```sql
CREATE VIRTUAL TABLE memory_embeddings USING vec0(
    memory_id TEXT PRIMARY KEY,
    embedding FLOAT[1536]   -- recreated for actual dim on first add
)
```

Default dim 1536 for `text-embedding-3-small`. On first insert, `ensureVectorTableDimensions(dim)` drops and recreates if empty.

### 2.2 FTS5 with jieba CJK tokenizer

```sql
CREATE VIRTUAL TABLE messages_fts USING fts5(
    message_id UNINDEXED,
    thread_id  UNINDEXED,
    content
);
```

Dropped & rebuilt if `fts_metadata.version < 6`. Current version: 6 (which adds jieba Chinese segmentation). Kept in sync by triggers/repository writes (`main.js:2945-3022`).

---

## 3. The sleep loop

Per `~/Downloads/alma-re/docs/22-embeddings.md` (which we did not read in full, but cross-ref from `08-memory.md §4.5`):

Five archival reasons:

1. **exact** — content equality dedup.
2. **expired** — TTL elapsed (for `durability: 'temporary'`).
3. **orphan** — source thread/message deleted.
4. **similarity** — cosine similarity above threshold (vec search).
5. **llm** — LLM judged it duplicate/redundant.

Run can be triggered by `manual | idle | count | scheduled`. Archived memories move to `memory_archive` with reason + actor; merged sets get a `merged_into` pointer. Tokens consumed for LLM-assisted decisions are billed back into the run row.

Restore: `POST /api/memories/archive/:id/restore` → `restoreFromArchive(id, opts)` at `main.js:64754`.

### 3.1 LLM-assisted dedup

`addMemoryWithLLMDedup` (`main.js:1265`):
1. Vector search (`limit=5, threshold=0.3`).
2. Ship candidates + new memory to LLM with strict JSON contract:
   ```
   {"isDuplicate": true, "reason": "…", "duplicateOf": <number>}
   {"isDuplicate": false}
   ```
3. If duplicate, the new memory is skipped and the existing one returned.

The prompt explicitly considers `durability` tags ("temporary" vs "permanent").

---

## 4. The soul tree (`~/.config/alma/`)

Per `~/Downloads/alma-re/docs/08-memory.md §7`:

```
~/.config/alma/
├── HEARTBEAT.md           # periodic check-in checklist (boilerplate written at main.js:43136)
├── SOUL.md                # AI self-identity (immutable above ## Evolved Traits)
├── USER.md                # owner profile, YAML frontmatter
├── MEMORY.md              # long-form free-text memory
├── api-spec.md            # auto-regenerated REST API spec
├── fatigue.json           # 4-level fatigue state
├── mcp.json               # static MCP server bootstrap
├── diary/                 # YYYY-MM-DD.md daily diary
├── emotions/              # base.md + context/ rolling snapshots
├── chats/                 # 1:1 chat logs from external bridges
├── groups/                # group chat logs + state.json
├── people/                # one .md per contact + frontmatter
├── selfies/               # generated self-portraits
├── skills/                # user-installable behavior plugins
├── plugins/               # third-party plugins
├── cron/                  # jobs.json + runs.json
├── missions/              # spec_artifact_path targets for agent_missions
├── reports/               # auto-generated summaries
└── tts/                   # TTS cache
```

The same `homedir()/.config/alma` is used cross-platform — Yetone ignores `app.getPath('userData')` for soul files.

### 4.1 HEARTBEAT.md

If absent, the heartbeat loop writes a boilerplate (`main.js:43133`):

```
# Heartbeat Checklist

- If the user hasn't interacted in over 4 hours (during active hours), send a brief check-in
- If nothing needs attention, reply HEARTBEAT_OK

<!-- Alma will update this file as you add periodic tasks via chat -->
```

The heartbeat loop sends the current contents to the LLM and treats `HEARTBEAT_OK` as a no-op (`main.js:42741-43003`). Empty file + no extras = skip.

### 4.2 SOUL.md evolution

Per `~/Downloads/alma-re/docs/03-prompts.md §2`, the AI can append (only to the `## Evolved Traits` section) via `alma soul append-trait "trait description"`. Rules:

- NEVER modify sections above `## Evolved Traits`
- 1 sentence per entry
- Max 1 new trait per day
- Total Evolved Traits section < 15 entries (prune stale)
- If old traits contradict recent experience, can update or remove

### 4.3 People profiles

`~/.config/alma/people/<name>.md` + `<name>.avatar.jpg`. YAML frontmatter holds cross-platform IDs (`telegram_id`, `discord_id`, `feishu_id`). Lookup priority: cross-platform ID > filename. Telegram avatar has 24h TTL auto-cache.

### 4.4 Chats and groups

`{chatId}_{YYYY-MM-DD}.log`. `groups/state.json` tracks `{lastBotReplyTime: {chatId: ts}, groupHistory: {chatId: [...]}}`.

---

## 5. Maka's MEMORY.md design

`apps/desktop/src/main/local-memory-service.ts`. The architecture:

- Single file at `<workspaceRoot>/memory/MEMORY.md`.
- Backups at `<workspaceRoot>/memory/.backups/MEMORY.md.bak.<ts>`.
- Parsed via `parseLocalMemoryMarkdown` (`@maka/core`) into `entries` + `archivedEntries`.
- Statuses: `ok | disabled | safe_mode | incognito_blocked`.
- `agentReadEnabled` flag — separate from `enabled` so the user can let the AI write but not read on the same turn (or vice versa).
- Incognito-active gates the whole thing.
- A `parsed.safeMode` flag stops the AI from reading on parser failure (corrupted markdown).

This is *better* than Yetone's design in several ways:

1. **Single file** — easy to git-track, easy to inspect, easy to back up.
2. **Workspace-scoped** — different projects get different memories.
3. **No SQLite** — no migrations, no schema versioning, no `vec0` native binary.
4. **Privacy by default** — incognito mode and `agentReadEnabled` toggle are first-class.
5. **`safe_mode` parser-failure detection** — Yetone has no equivalent; a malformed MEMORY.md would crash silently.

### 5.1 What Yetone's design teaches us

The interesting *concepts* that Maka could borrow without changing the file format:

**B-MEM-01: Append-only `## Evolved Traits` section.** Per `~/Downloads/alma-re/docs/03-prompts.md §2`, only the trailing section is AI-mutable. The rest is user-curated. Maka could pre-mark a `## Auto-recorded` section that the AI can append to and the user can edit/delete; everything above stays user-owned. Estimate: S (in `@maka/core` parser + UI).

**B-MEM-02: Active vs archived entries already in Maka.** The `archivedEntries` field exists in `LocalMemoryState`. Verify the parser supports moving entries between active/archived (it does, per the `activeEntries` accessor). No code change, but document it.

**B-MEM-03: People/contacts as a sibling file.** Yetone has `~/.config/alma/people/<name>.md`. Maka could have `<workspace>/memory/people.md` (single file with frontmatter blocks for each person). When Maka eventually adds the user-attribution feature, this is the canonical place. Estimate: M.

**B-MEM-04: Diary as `memory/diary/YYYY-MM-DD.md`.** Yetone's `diary/` is a chronological per-day reflection. Maka could expose this as an optional auto-summary at end of each session. Estimate: M.

**B-MEM-05: Heartbeat as a cron skill.** Per `main.js:42741-43003`, the heartbeat loop sends HEARTBEAT.md contents to the LLM periodically. For Maka this maps to a `/schedule` skill that triggers periodic checkup runs — already partially scaffolded by the `schedule` skill in `~/.claude/skills/`. Estimate: M.

---

## 6. Recall mechanism

### 6.1 Yetone: vector + scoring formula

`MemoryService.searchMemories` (search `main.js` for `searchMemories`):

```sql
SELECT memory_id, 1 - vec_distance_cosine(embedding, ?) AS score
FROM memory_embeddings
WHERE score >= ?
ORDER BY score DESC
LIMIT ?
```

Then JOIN back to `memories`, filter by `userIds`/`userId`, `threadId`, `tags`. Final ranking by the scoring formula from §2.1. Side effect: each retrieved memory's `accessCount` is incremented and `updatedAt` is updated. **The search itself mutates state.**

### 6.2 Yetone: post-turn extraction

Per `01-agent-loop.md §14 step 13`:

> Fire-and-forget post-processing: memory summarization (`summarizeAndStoreMemories`), suggestions, end resources, skill extraction.

After each chat turn, a separate LLM pass examines the new messages and may add memories. The actual `summarizeAndStoreMemories` prompt isn't in our reach without further grep, but the *pattern* is: every assistant turn that finishes successfully triggers a background memory write.

### 6.3 Maka: transparent re-read every turn

Per `apps/desktop/src/main/local-memory-service.ts` and the conversation context plumbing in `ai-sdk-backend.ts:368` (`system: await this.resolveSystemPrompt()`), Maka *re-reads* MEMORY.md on every turn. The user can edit it directly in any text editor. No vector search; no scoring; no archival.

This is the right call for Phase 1. The borrowable bits:

**B-MEM-06: Post-turn extraction hook.** Fire-and-forget a "did anything new happen worth remembering?" call after each successful turn. Use the tool model (per B-PROMPT-04). Estimate: M. Risk: low-med (cost of extra LLM calls).

**B-MEM-07: Access-count tracking *if* we add memory entries with IDs.** Today's MEMORY.md is just bullet points; if we add `<!-- id: ... -->` comments, we can track `lastAccessed` for the diary feature. Optional.

### 6.4 The `<context_from_earlier_conversation>` injection

Per `~/Downloads/alma-re/docs/01-agent-loop.md §19 insight 17`: compaction indicator messages render as system text in the UI but carry the summary in metadata. When rebuilding model messages, the indicator is replaced inline with a synthetic user message: `<context_from_earlier_conversation>{summary}</context_from_earlier_conversation>`. So the SDK never sees the literal "🗜️ Context Compacted" UI text.

**B-MEM-08**: When Maka adds compaction (per B-LOOP-05), use the same UI/model split. The user sees a friendly indicator; the model sees a structured tag. Estimate: S (part of the compaction borrow).

---

## 7. sqlite-vec native extension

If Maka ever adds vector recall, the loading dance is worth borrowing wholesale.

Per `~/Downloads/alma-re/docs/08-memory.md §4`:

```js
const e = (process.platform === "win32") ? "windows" : process.platform;
const packageName = `sqlite-vec-${e}-${process.arch}`;
const lib = "vec0." + (win32 ? "dll" : darwin ? "dylib" : "so");
```

Search order:
1. **Packaged Electron app**: `<resourcesPath>/app.asar.unpacked/node_modules/<packageName>/vec0.<ext>` and a parallel `.../sqlite-vec/..` path
2. **Dev**: `require.resolve('sqlite-vec')` then `path.dirname(path.dirname(...)) + <packageName>/vec0.<ext>`
3. **Fallback**: `require('sqlite-vec').getLoadablePath()`

If all paths fail it throws `"sqlite-vec extension not found. Tried paths: …"`. **Logging at every step is loud and prefixed `[sqlite-vec]`.**

The `optionalDependencies` model in the npm package means each `<platform>-<arch>` triple ships a separate package; on extension-load failure the catch at `main.js:1824` prints `"Failed to initialize memory service. Memory features will be disabled"` — the rest of the DB stays usable.

**B-MEM-09: Optional-deps native binary load pattern.** Whenever Maka adds a native binary (currently we have none other than Electron itself), use this multi-path search with loud logging and graceful disable on failure. Estimate: reference only.

---

## 8. The `keepRecentMessages` invariant

Per `~/Downloads/alma-re/docs/01-agent-loop.md §19 insight 4`:

> **`keepRecentMessages` counts user turns, not messages.** `YE` (`main.js:50030`) walks backward and only increments on `role === "user"`. So `keepRecentMessages: 4` keeps the last 4 user prompts and all the assistant/tool turns between them.

This is conceptually a *memory* decision — what to keep, what to drop. For Maka when we add compaction (B-LOOP-05), counting user turns is much more aggressive than naïve N-last; preserves full reasoning trails. Estimate: covered by B-LOOP-05.

---

## 9. Summary of borrowable items in this doc

| ID | Mechanic | Cite | Maka file | Scope | Risk |
|---|---|---|---|---|---|
| B-MEM-01 | Append-only `## Evolved Traits` style section | `main.js:61741` (SOUL prompt) + soul tree concept | `@maka/core` memory parser | S | low |
| B-MEM-02 | Active vs archived entries (already in Maka) | — | `local-memory-service.ts` | — | doc only |
| B-MEM-03 | `memory/people.md` for contacts | `main.js:32950, 33027, 33072` | new file when user-attribution lands | M | low |
| B-MEM-04 | `memory/diary/YYYY-MM-DD.md` | `main.js:43100, 43114` | new feature, optional | M | low |
| B-MEM-05 | Heartbeat cron pattern | `main.js:42741-43003` | future cron skill | M | med |
| B-MEM-06 | Post-turn memory extraction hook | `main.js` (search `summarizeAndStoreMemories`) | `ai-sdk-backend.ts` post-stream tear-down | M | low-med |
| B-MEM-07 | Per-entry IDs for access tracking | implicit | optional in parser | S | low |
| B-MEM-08 | UI/model split on compaction indicator | `main.js:58412-58420, 60695-60707` | part of compaction borrow | S | low |
| B-MEM-09 | Optional-deps native binary load pattern | `main.js:877-958` | reference only | — | — |
