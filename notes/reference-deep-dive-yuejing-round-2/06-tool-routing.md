# 06 — Reference app tool routing: pre-loop selector + in-loop ToolSearch

> Source-grounded against `~/Downloads/reference-source/readable/main.js`.
> Two distinct routing layers Maka doesn't have today. Cross-refs
> round-2 [`05-bash-tool-family.md`](./05-bash-tool-family.md) (which
> mentioned ToolSearch in passing).

## The two layers

Reference app runs **two independent LLM-driven routers** to decide which
tools a given turn can see:

| Layer | When | Caller | Output | Source |
|---|---|---|---|---|
| **Tool selection assistant** | Pre-loop, per user message | Renderer / orchestrator | Initial `activeTools` set | `main.js:29668` |
| **ToolSearch** | In-loop, model-invoked | The agent itself, mid-conversation | New tool ids to merge into the active set | `main.js:26283-26410` |

Both routers can include the same three universes — built-in tools,
MCP server tools, plugin tools — but they answer different
questions:
- The selector says "before we start, what does the user likely
  need?"
- The searcher says "the user just asked me to do X, do I have a
  tool for it that wasn't already loaded?"

## Layer 1: pre-loop tool-selection assistant

`main.js:29668` — a large multi-line system prompt sent to a small
auxiliary model (likely the `prepareStep` model selected by
`fd(providerId, modelId)`). It receives the user's message and the
list of all available tools, returns:

```json
{
  "tools": ["Read", "Edit", "Grep", "TodoWrite"],
  "reasoning": "Bug fix requires reading, editing code, and tracking progress"
}
```

Excerpts from the prompt (the full block is ~3,800 chars — see line
29668):

- Returns an empty array for plain conversation (no tools).
- For code-related tasks, includes `Read, Edit, Write, Grep,
  Glob`.
- For ANY web/internet task, **must include BOTH `WebSearch` AND
  `WebFetch`** — reference app is opinionated about this.
- For multi-step tasks (3+ steps), bug fixes, refactors, etc., 
  **must include `TodoWrite`**.
- For command execution, includes `Bash`.
- For past-conversation / memory questions, includes `Recall`.
- For explicit remember/forget asks, includes `OperateMemory`.
- Always pair `Task` with `TaskOutput`.
- When ChromeRelay is connected, **prefer ChromeRelay tools over
  Browser** for any interactive web work.
- When asked about Reference app itself, route to `Task` (with `app-guide`
  subagent) + `TaskOutput`.

The prompt includes ~20 worked example responses showing the
expected output shape. This is a teaching-by-pattern approach — the
small router model doesn't need to be very capable because the
prompt does most of the work.

**Why this works for Maka size-wise**: with N tools (Maka currently
has ~15), feeding all descriptions every turn would burn ~2k tokens
of the *user-facing* model's budget. Running this on a smaller,
cheaper auxiliary model and passing only the SELECTED tools forward
saves both money and the main model's context.

## Layer 2: in-loop ToolSearch

`main.js:26283-26410` — the model-callable tool. Input schema:

```js
{
  query: string,
  type: 'builtin' | 'mcp' | 'plugin' | 'all',   // default 'all'
}
```

What it does:
1. Looks up the tool router model via `fd(providerId, modelId)` —
   could be the same auxiliary model as the pre-loop selector.
2. Builds a system prompt that lists every tool in the requested
   universe(s), keyed by id with a one-line description from `tg`
   (the in-source registry of `name → description`).
3. Calls the model with the prompt + `Search query: "${query}"`.
4. Parses the response as JSON `{ tools: [...], reasoning: string }`.
5. Returns the matched tool ids to the agent.

The agent then knows the ID and can call the tool directly in a
subsequent step (the tool is registered globally, ToolSearch just
surfaces its existence).

This unlocks discovery beyond the pre-loop selection — if the user
mid-conversation says "actually scroll down on that page", and
ChromeRelayScroll wasn't pre-selected, the model can call
ToolSearch("scroll browser") and find it on demand.

## What Maka does today

Maka:
- All registered tools are visible to the agent on every turn (no
  pre-loop selection).
- No in-loop discovery — if a tool exists it's already loaded.
- Tool list is small (~15) so this is not yet wasteful.

Concrete changes for Maka, ranked by ROI:

1. **Add the pre-loop selector when tool count exceeds ~25 or
   when MCP servers start contributing tools.** Until then, the
   selector adds latency without saving tokens. The threshold isn't
   arbitrary: at ~25 tools the descriptions alone start eating >1k
   tokens of every turn.

2. **Add a `ToolSearch` tool as soon as MCP is wired.** MCP server
   tool counts can balloon (every Linear/GitHub/Notion server adds
   10+ tools). Without ToolSearch, models forget which MCP server
   has which capability and ask wrong-tool things.

3. **Adopt reference app's "always pair X with Y" rules in the selector
   prompt verbatim.** WebSearch+WebFetch, Task+TaskOutput,
   Bash+BashOutput pairings encode hard-won product knowledge.
   Cheap to copy, expensive to rediscover.

4. **Use a smaller model for the router(s).** Anything that's good
   at JSON output (Claude Haiku, GPT-4o-mini, Gemini Flash) works.
   The cost difference matters across thousands of turns.

## Open questions for round 3 of round-2

- Does the pre-loop selector run on EVERY user message or only when
  the active tool set is empty / changes? Need to find the
  controller code.
- How does the orchestrator merge the selector's output with
  user-explicit "always enable these" preferences (e.g., a power
  user who always wants Bash)? Likely a `preferences ∪ selector`
  union, but TBD.
- Does ToolSearch's output get cached so repeated queries on the
  same conversation don't re-pay the router cost?

## Cross-refs

- Round 1: [`02-tools.md`](../reference app-deep-dive-yuejing-2026-05-31/02-tools.md)
  for the tool registry shape (the `tg` description map this note
  references).
- Round 2: [`05-bash-tool-family.md`](./05-bash-tool-family.md) —
  the `Bash` + `BashOutput` pairing this note's example list
  comes from.
- Round 2: [`04-permissions-runtime.md`](./04-permissions-runtime.md)
  — pre-loop selection feeds into the permission engine; risk
  classifications need the selected set first.
