# 03 — Alma memory recall: Recall + OperateMemory + autoRetrieve pipeline

> Source-grounded against `~/Downloads/alma-re/readable/main.js`.
> Round 1 mentioned the memory system existed; rounds 2 and 3
> never traced it. This note covers the two memory tools plus the
> pre-turn auto-retrieve pipeline (query rewriting → embedding →
> vector search → context injection) and the default settings.

## The two tools

`main.js:17853` (the `Yd` exact-mode allowlist from round-3 02):

```js
"Recall",
```

And in the tool selector example responses (`main.js:29668`):

> "What did we discuss about the API design?": {"tools":
> ["Recall"], "reasoning": "User asking about past conversations
> requires memory retrieval"}
>
> "Remember that I prefer TypeScript over JavaScript": {"tools":
> ["OperateMemory"], "reasoning": "User explicitly asking to
> store a preference"}

**Recall** — Read memories.
**OperateMemory** — Add/update/delete memories.

Both are `exact` mode (round-3 02 — never compacted), reflecting
that memory operations need verbatim fidelity. A truncated
"User likes…" memory would be worse than no memory.

## Settings — defaults are aggressive

`main.js:59679-59705`:

```js
getMemorySettings() {
  const e = {
    enabled: true,
    autoSummarize: true,
    autoRetrieve: true,
    maxRetrievedMemories: 5,
    similarityThreshold: 0.1,        // !! very permissive
    queryRewriting: true,
  };
  // …overrides from settings.memory…
}
```

Defaults all ON. **`similarityThreshold: 0.1` is the surprise** —
typical cosine-similarity defaults are 0.5–0.7. 0.1 is "almost
anything close to the query is fair game." This works only
because query rewriting (next section) normalizes the embedding
space first.

Settings shape (round-4 01 api-spec template):

```typescript
memory: {
  enabled: boolean;
  autoSummarize: boolean;
  autoRetrieve: boolean;
  maxRetrievedMemories: number;   // 1-20
  similarityThreshold: number;    // 0-1
  queryRewriting?: boolean;
  summarizationModel?: string;    // for OperateMemory autoSummarize
  toolModel?: string;             // for query rewriting
  embeddingModel?: string;        // for vector search
}
```

Three separate model slots — alma encourages users to pick
different (cheaper/faster) models for memory housekeeping than
for chat.

## Pre-turn `retrieveMemoriesForContext` pipeline

`main.js:59760-59814` is the central retrieval routine, called
BEFORE the agent loop generates a response.

```js
async retrieveMemoriesForContext(query, threadId, onProgress, userId, toolModel) {
  // 1. Incognito guard
  const thread = To.getThreadById(threadId);
  if (thread?.isIncognito) {
    return { context: "", usedMemories: [] };   // privacy: never recall in incognito
  }

  // 2. Settings gate
  const settings = this.getMemorySettings();
  if (!settings.enabled || !settings.autoRetrieve) {
    return { context: "", usedMemories: [] };
  }

  // 3. Embedding provider required
  const provider = this.getEmbeddingProvider();
  if (!provider) return { context: "", usedMemories: [] };

  // 4. Optional query rewriting (LLM call)
  let q = query;
  if (settings.queryRewriting) {
    q = await this.rewriteQueryForMemorySearch(query, toolModel);
  }

  // 5. Embed + search
  const embedding = await co.generateEmbedding(q, provider);
  const linkedUserIds = userId ? this.resolveLinkedUserIds(userId) : undefined;
  const hits = await co.searchMemories(embedding, {
    limit: settings.maxRetrievedMemories,
    threshold: settings.similarityThreshold,
    userIds: linkedUserIds,
  });

  // 6. Format for system prompt injection
  if (hits.length > 0) {
    return { context: ao(hits), usedMemories: hits.map(m => ({id: m.id, content: m.content})) };
  }
  return { context: "", usedMemories: [] };
}
```

Notable details:
- **Incognito threads return empty** before any LLM call. No
  embedding generation either — saves an API call AND preserves
  privacy.
- **`onProgress` callback** emits 3 stages: `retrieving` →
  `ready` (with `retrievedMemories` list) → final. Broadcast to
  the UI so the user sees "Retrieving memories…" toast.
- **`resolveLinkedUserIds(userId)`**: when a `userId` is passed
  (e.g., bot integrations pass the chat-user's id), expand to
  all linked accounts (e.g., same person across
  Telegram/Discord/Feishu). Memories from any linked account
  count.
- **Empty-result is silent**: no "No relevant memories" injection
  into context. The agent just gets no memory context.

## Query rewriting — the hidden win

`main.js:59706-59758`. The reason `similarityThreshold: 0.1`
works is the rewriter. The prompt (`main.js:59739`) is short
but specific:

> You are a query optimizer for semantic memory search.
> Transform the user's message into English search terms.
>
> ## Key Rules
> 1. ALWAYS output in English, regardless of input language
> 2. Think: what stored facts would answer this question?
> 3. Memories are stored like: "User's name is John", "User
>    works as engineer", "User likes Python"
> 4. For broad queries about the user, list multiple specific
>    attributes
>
> ## Examples
>
> "我叫什么" → "User's name is"
> "What's my job?" → "User works as occupation job"
> "我喜欢吃什么" → "User likes food eat"
> "介绍一下我" → "User's name is, User works as, User likes, User lives in"
> "Help me with React" → "User React programming frontend"
> "我住在哪里" → "User lives in location city"
> "Remember my favorite color?" → "User's favorite color is"
> "你还记得我的爱好吗" → "User's hobbies are, User likes"
> "Tell me about myself" → "User's name is, User works as, User lives in, User likes"
> "What do you know about me?" → "User's name, User works, User lives, User likes, User prefers"
>
> ## Output
> English only. Match the storage format. No quotes around output.

This is a **fact-shape projector**. The user query is mapped into
the EXACT subject-verb-object shape memories are stored in
(`"User's X is Y"`). That gives the embedding vector something
very specific to match against — even with a 0.1 threshold,
hits that survive are good.

The Chinese → English mapping is critical. Without it, a Chinese
query against English-stored memories would have a poor
embedding distance. By forcing the query into English first,
alma decouples query language from storage language.

Failure mode: if no tool model is configured or invalid,
rewriter logs and returns the original query. Soft fallback,
no error to user.

## Embedding model registration

`main.js:16799-16800`, `45635`, `46036`, `58595`, `58761`,
`64849-64850` are the spots where `memory.embeddingModel` is
read and registered. The model lives separately from the chat
provider chain — alma has its own embedding provider abstraction
(`Rd.generateEmbedding`, `co.generateEmbedding`) that wraps
provider-specific embedding calls.

Set explicitly via settings. If unset, falls back to a per-
provider default (e.g., OpenAI's `text-embedding-3-small`).
Critical: settings can switch embedding models at runtime, but
existing memories are NOT re-embedded. Mixing embeddings from
two models in the same vector space is broken — the cosine
similarity comparison only works within one model's space.

Open question: does alma re-embed on model change, or just
warn the user? Worth checking in a future round.

## Anti-incognito pattern repeated

The `isIncognito` thread flag short-circuits multiple subsystems:
- `retrieveMemoriesForContext` (this note)
- Memory extraction during conversation (autoSummarize, not
  traced here)
- Bot reaction storage (round 1 mentioned)

A single boolean on the thread tells every privacy-relevant
subsystem "act as if memory doesn't exist." This is the right
shape: privacy-by-omission, not privacy-by-redaction.

## Linked user IDs

`resolveLinkedUserIds` (`main.js:59782` call site) is the bot-
integration glue. The user typing in Telegram has a different
`userId` than the same user typing in Discord, but they're
**linked** through alma's people-profile system (`alma people
append`, mentioned in `main.js:62108` Telegram prompt). When the
agent retrieves memories on behalf of a specific user, it
queries across all linked IDs.

This means a fact you told alma in Telegram surfaces when you
ask the same question in Discord. Cross-platform identity is
deliberate.

## What Maka has today

Maka has a basic memory system in `@maka/runtime/memory/` — a
single tool, similar storage shape. But:
- No query rewriting LLM step.
- Single `similarityThreshold` that defaults higher (~0.5).
- No incognito mode.
- No linked-user cross-platform retrieval.
- Embedding provider is hardcoded (no settings slot).

## Ranked Maka improvements

1. **Add query rewriting with a fact-shape projector.** This is
   the single biggest retrieval quality improvement. Even
   without the cross-lingual support (Maka is mostly English-
   speaking users today), the "What did we discuss about X?"
   → "User's X is" projection dramatically improves embedding
   similarity. ~30 lines + a tool model setting.

2. **Lower default similarity threshold to ~0.2–0.3 if query
   rewriting lands.** The 0.1 alma uses is too aggressive
   without rewriting, but 0.5 misses too many soft matches.
   Tune empirically.

3. **Incognito-mode short-circuit.** A single `isIncognito` flag
   on the thread that every memory subsystem checks. Privacy
   feature users actually understand. Cost: one column on the
   thread table.

4. **Separate embedding model setting.** Hardcoded embedding
   provider means users can't switch to a faster/cheaper model.
   The 5-row Settings → Memory panel that emerges (enabled +
   threshold + max + queryRewriting + embeddingModel) is the
   right surface area.

5. **Optional `onProgress` callback in retrieval.** Broadcast
   "Retrieving memories…" so the user sees what the agent is
   doing before generation starts. Same pattern as round-4 02
   autoCompact's `context_compaction_started` telemetry event.

## Open questions for future rounds

- Does alma re-embed memories when the user switches embedding
  models, or just leave them stranded in the old model's vector
  space? The "different models = incompatible vectors" rule is
  load-bearing.
- The `OperateMemory` tool internals aren't traced here. What's
  the storage shape? Is dedup done at write time or at recall
  time? Does conflict ("user moved jobs") get resolved by
  versioning or overwrite?
- `autoSummarize` is set ON by default but no tool surface for
  it is documented. Is there a periodic background extractor
  that distills conversation → facts → memories without the
  agent calling OperateMemory? Likely yes — Maka should know.
- The `linkedUserIds` resolution implies a people-profile graph
  table. What's its shape? Can a user OPT OUT of cross-platform
  linking?

## Cross-refs

- Round 2: [`02-send-response-flow-WIP.md`](../alma-deep-dive-yuejing-round-2/02-send-response-flow-WIP.md)
  — memory retrieval happens BEFORE the streamText call in the
  send→response flow.
- Round 3: [`02-output-safety-modes.md`](../alma-deep-dive-yuejing-round-3/02-output-safety-modes.md)
  — Recall and OperateMemory are both in the `Yd` exact-preserve
  set; results are never compacted.
- Round 3: [`04-permissions-runtime-risk.md`](../alma-deep-dive-yuejing-round-3/04-permissions-runtime-risk.md)
  — OperateMemory in subagents is bypass-channel 2 (no modal).
- Round 4: [`01-rest-api-operator-agent.md`](./01-rest-api-operator-agent.md)
  — `POST /api/memories/search` (`main.js:53126`) is the REST
  surface that lets the renderer (and alma-operator agent) hit
  the same vector-search path.
- Round 4: [`02-auto-compact.md`](./02-auto-compact.md) — both
  systems are context-window pressure relief, but in opposite
  directions: autoCompact strips old content, recall injects
  relevant content.
