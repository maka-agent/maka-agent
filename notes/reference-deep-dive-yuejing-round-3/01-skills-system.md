# 01 — Reference app skills system (SKILL.md discovery + Skill / SlashCommand tools)

> Source-grounded against `~/Downloads/reference-source/readable/main.js`.
> First note of round 3. Round 1 and round 2 both skipped the skills
> system; rounds touched it only obliquely (subagent allowlists in
> round-2 [`07-subagent-orchestration.md`](../reference app-deep-dive-yuejing-round-2/07-subagent-orchestration.md)).
> This note covers loader, persistence, collision precedence, prompt
> injection, and the `Skill` / `SlashCommand` tool surface end-to-end.

## What a "skill" is in reference app

A skill is a directory containing `SKILL.md` — a YAML-frontmatter +
markdown file (`main.js:18635-18661`). Frontmatter contract:

| Field | Required | Purpose |
|---|---|---|
| `name` | yes | Human-readable identifier. Lookups go by name (lower-cased). |
| `description` | yes | One-liner; injected into the system prompt as `- "name": description`. |
| `license` | no | Surfaced to UI; doesn't gate execution. |
| `allowed-tools` | no | Per-skill tool allowlist for the agent loop. |
| `always-inject` | no | If `true`, the skill's body is auto-injected into every thread. Otherwise only its `name`/`description` line is. |
| `metadata` | no | Free-form. |

Missing `name` or `description` → skill is skipped with a
`[Skills]` console warning (`main.js:18650-18655`). YAML parse
errors are caught and logged but never fatal (`main.js:18656-18661`).

## Six discovery roots, ranked precedence

`main.js:18612-18620`:

```js
getAllSkillRootPaths(workspace) {
  const t = [
    this.personalSkillsPath,        // ~/.config/reference app/skills
    this.claudeCodeSkillsPath,      // ~/.claude/skills
    this.codexSkillsPath,           // ~/.codex/skills
    this.agentSkillsPath,           // ~/.agents/skills
    this.claudePluginsPath,         // ~/.claude/plugins
  ];
  return (workspace && t.push(this.getProjectSkillsPath(workspace)), t);
}
```

Plus a 6th `<workspace>/.reference app/skills` when a workspace is open. The
load pipeline (`main.js:18762-18814`) scans each root, collects
results, and merges them with **a deliberate precedence ladder**.

Bundled skills (`scanBundledSkills()` — packaged with the app) get
treated as a NAMESPACE LOCK: anything in `bundledNames` wins, and
any other source whose `name.toLowerCase()` matches a bundled name
is **skipped** (`main.js:18790-18812`). The merge order for non-
collisions then layers:

1. project (`.reference app/skills`) — newest writes
2. marketplace plugins
3. agent skills (`~/.agents/skills`)
4. codex (`~/.codex/skills`)
5. claude-code (`~/.claude/skills`)
6. personal (`~/.config/reference app/skills`)
7. bundled

The Map is built bottom-up so personal/codex skills **shadow**
project/marketplace skills of the same name unless bundled. This is
the opposite of what users probably assume — worth flagging.

## Persistent enable/disable

Skills exist on disk (read-only as far as reference app is concerned), but
the user can toggle `enabled` and reorder them. State lives in the
`skills` SQLite table (`main.js:1901-1908`):

```sql
CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_skills_enabled ON skills(enabled);
CREATE INDEX IF NOT EXISTS idx_skills_path ON skills(path);
```

The `id` is the first 16 hex chars of `sha256(path)` (`main.js:18632-18634`)
— so renaming a skill directory creates a NEW row; the old `enabled`
state is orphaned in the table. That's a real bug seed.

`chat_threads` has a per-thread `skill_ids` JSON column
(`main.js:2265`, `300`) — lets a specific session pin a different
skill subset than the global enabled set.

## 30s in-memory cache

`main.js:18582`, `18751-18757`:

```js
static CACHE_TTL_MS = 3e4;
async loadSkills(workspace) {
  if (this.skills.size > 0 &&
      Date.now() - this.lastLoadTime < CACHE_TTL_MS &&
      workspace === this.lastWorkspacePath) {
    return Array.from(this.skills.values());
  }
  // … full rescan
}
```

The cache key is `(loaded, ttl, workspace)`. Switching workspaces
invalidates it. The agent loop's hot path that fetches skills (every
user turn) is the reason for this cache — without it, every send
would re-scan 6 directories.

`invalidateCache()` is called from `updateSkillEnabled` and from
`refresh()` (when the user explicitly hits "rescan"). Notable
omission: `updateSkillSortOrder` does NOT invalidate. The cache
holds in-memory sortOrder updates, but a `refresh()` after a
rename will see SQLite state.

## Prompt-injection surface (the why)

`main.js:18898-18911`:

```js
buildSkillsContext(skillIds) {
  let t = skillIds && skillIds.length > 0
    ? skillIds.map(id => this.skills.get(id))
              .filter(s => s !== undefined && s.enabled)
    : this.getEnabledSkills();
  return t.length === 0
    ? ""
    : t.map(s => `- "${s.name}": ${s.description}`).join("\n");
}
```

This is the "menu" the model sees in its system prompt — just the
name/description lines, NOT the body. Bodies are only loaded when:
- `always-inject: true` — auto-injected at thread start.
- The model invokes the `Skill` tool with a specific name.

The Skill tool (`main.js:17854`, `26296-26297`) is described to the
model as:

> Invoke skills for extended capabilities (web search, memory, voice,
> todos, notebooks, etc.)

Calling `Skill` returns the skill body. The pre-loop tool selector
(round-2 [`06-tool-routing.md`](../reference app-deep-dive-yuejing-round-2/06-tool-routing.md))
considers `Skill` as a candidate when the user message hints at a
named capability.

## `SlashCommand` tool

`main.js:17855`, `26298-26299`:

> Execute custom slash commands - useful when user types slash commands

Slash commands are the user-facing trigger that maps `/foo` typed
into the composer into a Skill or workflow invocation. The model
sees `SlashCommand` as a tool it can pick when the user message
contains slash command syntax. This is the lightweight path —
slash commands are usually short one-shot capabilities; full skills
are richer multi-step workflows.

## Subagent allowlist binding

`main.js:20419, 20431, 20442, 20446, 20455`:

The seven subagent specialists (round-2 note 07) each declare an
`allowed-tools` set. Five of them include `Skill` — meaning a
subagent can invoke skills mid-run. The exception is `app-guide`,
which gets `["Glob", "Grep", "Read", "Skill", "WebSearch",
"WebFetch"]` — Skill in, Bash out (so it can read but not write or
execute).

This is the cross-cutting pattern: skills are a delivery channel
for capability without ballooning the built-in tool surface.

## Skill extraction prompt (the meta loop)

`main.js:60061` includes the prompt for the skill **extraction**
agent — reference app analyzes completed conversations and decides whether
to auto-create a new skill from the workflow. Excerpt:

> EXTRACT when the conversation demonstrates:
> - A multi-step workflow that could be reused (e.g., "deploy to
>   staging", "set up a new React component with tests")
> - Domain-specific procedures with non-obvious steps
> - A tool usage pattern combining multiple tools in a specific way
> - A process the user is likely to repeat in future conversations
> - Specialized knowledge about a codebase, API, or system
>
> DO NOT extract when:
> - The conversation is a simple Q&A or chat
> - The task is highly specific to a one-time situation
> - The workflow is trivial (1-2 simple steps)
> - An existing skill already covers this workflow adequately

The decision is structured JSON `{worthy, skillName, skillDescription,
reasoning, existingSkillToUpdate}`. The bar is high; the prompt
warns "Be VERY selective - most conversations should NOT produce a
skill." This is the LEARNING LOOP: reference app watches its own use, codifies
patterns, hands them back to itself as future skills.

## What Maka has today

- No `skills` table.
- No SKILL.md scan path.
- No `Skill` or `SlashCommand` tool.
- No prompt-time injection of capability descriptions.

Skills are routed into Maka today through hard-coded built-in tools
(WebSearch, etc.) — every capability is a code change. Skills as a
data-driven runtime would be a strict architectural upgrade.

## Ranked Maka improvements

1. **Adopt the SKILL.md format.** YAML frontmatter is the
   ecosystem-compatible choice (`~/.claude/skills` works with
   Claude Code; `~/.codex/skills` with Codex CLI). Maka can
   piggyback the same directory contract and inherit skills
   users already wrote for other tools. ~150-line scanner.

2. **Prompt-time menu injection only, body load on demand.** The
   `buildSkillsContext` pattern (name/desc only in system prompt,
   body on Skill-tool call) keeps prompt cost flat as the skill
   library grows. Critical for users who'll accumulate dozens.

3. **Bundled-name lock.** The collision precedence pattern at
   `main.js:18790` is the right default for built-in skills Maka
   ships in-app — user override on disk shouldn't silently break
   a shipped capability.

4. **Skill DB persistence.** The `(id, path, enabled, sort_order,
   updated_at)` schema is small and clean. Per-thread skill_ids
   JSON column lets sessions pin different subsets — important
   for `/goal`-style workflows that want a focused tool surface.

5. **Skill extraction loop (later).** The auto-create-skill-from-
   conversation pattern (`main.js:60061`) is a Phase 3 feature
   but worth pinning. Once Maka ships skill INVOCATION, the
   extraction agent closes the learning loop.

## Open questions for round 3 of round-3

- Does reference app's loader detect skills whose path was rewritten (e.g.,
  user renamed `~/.claude/skills/foo/` → `~/.claude/skills/bar/`)
  and migrate the row, or does the old row become orphan? The
  `id` is `sha256(path)`, so today it's an orphan. Confirm.
- Are there any precedence asymmetries inside the project skill
  scan when a `.reference app/skills/foo` shadows the same skill in
  `.claude/skills/foo`? The merge order says yes (project wins
  over claude-code unless bundled), but this could surprise users.
- What happens if `allowed-tools` includes a tool that the current
  agent allowlist doesn't have? Does Skill execution silently drop
  the unavailable tool or refuse?

## Cross-refs

- Round 2: [`06-tool-routing.md`](../reference app-deep-dive-yuejing-round-2/06-tool-routing.md)
  — pre-loop selector considers `Skill` and `SlashCommand` as
  candidate tools.
- Round 2: [`07-subagent-orchestration.md`](../reference app-deep-dive-yuejing-round-2/07-subagent-orchestration.md)
  — subagent allowlists that grant `Skill`.
- Round 2: [`08-mcp-client.md`](../reference app-deep-dive-yuejing-round-2/08-mcp-client.md)
  — MCP tools are the OTHER data-driven capability channel;
  Skills are higher-level (workflow) and MCP is lower-level (tool).
