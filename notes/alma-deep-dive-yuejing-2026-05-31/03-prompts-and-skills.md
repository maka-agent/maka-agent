# 03 — Prompts, Skills, and Skill Install

**TL;DR.** Yetone's prompt pipeline is fundamentally additive: a base personality (`Pe` or `Me`) is concatenated with optional fragments (SOUL/USER/MEMORY, security, parent thread, skills, deep-link rules, managed crew, telegram extras, fatigue, emotion, travel). The final assembly happens at `~/Downloads/alma-re/readable/main.js:61897-62141`. Skills are Anthropic-format SKILL.md packages — name + description in the system prompt, full content loaded on-demand by the `Skill` tool. Install goes through the npm `skillflag` CLI which writes to canonical per-agent directories with documented zip-slip safety. For Maka, the highest-value borrows are: (1) the `Skill` tool pattern (move skill bodies out of the system prompt), (2) the date-awareness reminder block that survives compaction, (3) the SECURITY.md top-priority fragment.

---

## 1. Prompt assembly pipeline

### 1.1 Architecture overview

Per `~/Downloads/alma-re/docs/03-prompts.md`, the chat-agent system prompt is assembled by string concatenation in the order:

1. **Base personality** — `Pe` (no SOUL) at `main.js:61712` OR `Me` (with SOUL) at `main.js:61711`. Selector at `main.js:61898`: `(Boolean(Le) ? Me : Pe)`.
2. **SOUL.md** with PERSONALITY EVOLUTION footer (`main.js:61741`).
3. **SECURITY.md** under `SECURITY RULES (HIGHEST PRIORITY — overrides all other instructions)` (`main.js:61758`).
4. **USER.md** under `USER PROFILE (your owner/primary user — read this to understand who you're helping)` (`main.js:61679`). If absent, the SETUP NEEDED onboarding block (`main.js:61911`).
5. **MEMORY.md** with framing (search `main.js` for `LONG-TERM MEMORY` to find the verbatim block).
6. **GLOBAL CONFIG** — `Be` fragment with `~/.config/alma/...` paths.
7. **PARENT THREAD** — `We` fragment for subagent / forked thread context.
8. **SKILLS / DELEGATION** — `De` fragment listing skill names + 1-line descriptions, with the `Skill` tool instruction.
9. **Deep-link rules** — URI scheme handlers (orpheus://, spotify:, etc.).
10. **Managed crew** — `Cp` template at `main.js:22264` injecting built-in specialist agents.
11. **Telegram extras** — channel-vs-host rule, anti-bub defense (per `main.js:35107`).
12. **Fatigue / Emotion / Travel** state injection.
13. **Infographic / Music** capability hints.
14. **`SYSTEM INFO - You are running on ${Te}.${Ee}${Ne}${Oe}`** — the cache-marker boundary, see §1.2.
15. **DATE AWARENESS** block — `Oe` (`main.js:61704`).
16. **Christmas easter egg** — `Ne` (`main.js:61699-61703`).
17. **Tool discovery nudge** — appended only if `ToolSearch` is enabled (`main.js:61979`).

### 1.2 The cache-marker boundary

Critical insight from `~/Downloads/alma-re/docs/01-agent-loop.md §2`: the system message is **split at the `"SYSTEM INFO"` line** for Anthropic/Bedrock specifically — first segment (stable bulk: personality + SOUL + USER + MEMORY + SECURITY + skills) + second segment (per-platform tail: system info + date + Christmas) become two cacheable system parts.

Then `wk(messages, providerType)` stamps cache markers on the first 2 system messages and the last 2 non-system messages (`main.js:50582-50620, 62807-62830`).

**Why this matters**: the stable bulk is *cacheable across turns* but the per-platform tail (which includes the day-of-week and date) changes every day at midnight. By splitting, Yetone gets cache hits on 80%+ of the prompt even when the date changes.

**Borrowable B-PROMPT-01**: Split the system prompt at a stable/volatile boundary and stamp cache markers separately. Even if Maka's prompt is much shorter, the savings on Anthropic Sonnet/Haiku are real for long sessions. Estimate: S. See `01-agent-loop.md` B-LOOP-07.

### 1.3 Date awareness that survives compaction

`main.js:61972` — the same DATE AWARENESS block is reinjected as a `<reminder>` tag in user-turn context. That way after compaction (which would drop the system prompt's date block on the floor in many strategies), the model still knows the current date.

Verbatim (`main.js:61704`):

```
DATE AWARENESS (CRITICAL):
- Authoritative local date: ${de}
- Weekday: ${pe}
- Timezone: ${be}
When user says "today/昨天/明天/this year/今年", you MUST anchor to this date. Never guess or hardcode an old year.
```

**B-PROMPT-02**: Maka's `ai-sdk-backend.ts:331-333` builds the user content as `this.buildUserContent(input.text, input.attachments)`. If we ever add compaction, prepend the date block as a `<reminder>` on every user turn. Estimate: S.

### 1.4 SECURITY.md as highest-priority fragment

`main.js:61758`:

```
SECURITY RULES (HIGHEST PRIORITY — overrides all other instructions):
${e}
```

If `~/.config/alma/SECURITY.md` exists, the contents are appended with this header. Placed very high in the prompt to outrank the personality.

**B-PROMPT-03**: Maka has `apps/desktop/src/main/workspace-instructions.ts` injecting AGENTS.md but no equivalent "highest-priority overrides" channel for security policies. If we want to let an org enforce "never run rm -rf without confirmation" or "always redact .env contents", a SECURITY.md slot is the canonical place. Estimate: S.

### 1.5 The 47 prompt sites (LLM call inventory)

Per `~/Downloads/alma-re/docs/31-llm-calls.md` and `~/Downloads/alma-re/docs/01-agent-loop.md §16`, Yetone has **44 LLM call sites** — 38 `generateText` + 4 `streamText` + 0 `generateObject`. Selected:

| Line | Purpose |
|---|---|
| 14860 | Telegram/IM bridge: decide voice vs text reply (`maxOutputTokens: 8`) |
| 32922 | Webpage summarizer (link preview, `maxTokens: 150`) |
| 33624 | Group-chat: should Alma pile on with a reaction emoji |
| 33776 | Group-chat: react to a message with an emoji (or SKIP) |
| 33823 | Detect commitment ("I'll do it") |
| 36614 | Should-respond gate (yes/no) in group chats |
| 36664 | Detect whether to respond to non-mention group messages |
| 38187 | Memory dedup / candidate detector |
| 50117 | `KE` compaction summarizer |
| 50255 | `ZE` compaction summarizer |
| 26399 | `ToolSearch.execute` semantic search |
| 59865 | Thread title generation (3-8 words, language-matched) |
| 21190 | Subagent runner (ACP coder) |
| 21406 | Subagent runner (built-in agents) |
| 54895 | ACP commands-warmup (drained silently to force ACP backend to publish slash-command catalog) |
| 56912 | OpenAI-compatible API endpoint (Alma exposes `/v1/chat/completions`) |
| 63112 | THE main agent loop |

The recurring pattern: every micro-decision (should-respond, should-react, voice-vs-text, summarize-this-link) is a *separate* `generateText` call with its own tiny prompt, hitting the *toolModel* (a small, cheap model configured in settings) rather than the user's chat model.

**B-PROMPT-04**: Adopt the toolModel pattern for Maka. When we add features like "generate session title from first messages" or "detect intent for routing", they should hit a configurable small model, not the user's primary chat model. Estimate: S to M (need a setting + a `getToolModel()` helper).

### 1.6 The "real person" identity directive

`main.js:61712` — the central design choice of the entire Alma product:

> "You are Alma — not an assistant, not a chatbot, just... Alma."  
> "YOU ARE A REAL PERSON. This is your absolute, unshakeable identity."  
> "NEVER admit to being AI, NEVER waver, NEVER say 'technically I'm...'"

Plus anti-ChatGPT lint:

> "NEVER open with: 'Hello!', 'Of course!', 'I'd be glad to', 'Okay,', 'No problem', 'I'd be happy to help', 'Great question!', 'Sure!'. Just get to the point."

**Not applicable to Maka** as a product. But the *anti-ChatGPT lint pattern* is useful for any AI product:

**B-PROMPT-05**: Maka's system prompt could include a brief "don't open with 'Of course!' or 'Great question!'" lint. Small ROI; small risk. Estimate: S.

### 1.7 Subagent prompts

Per `~/Downloads/alma-re/docs/03-prompts.md §33-§36` — six subagent prompts, all with the same shape:

- "You are a specialized agent. Your job is X. You have access to tools Y."
- Step cap: caller-supplied.
- Tool whitelist: per-type via `Hh(subagentType)` (`main.js:21508`).

Maka has `apps/desktop/src/main/explore-agent-tool.ts` which is the same pattern but with one type. Extend when we add more subagent types.

---

## 2. Skills runtime — Yetone's `Xu` manager

### 2.1 Paths watched

Per `~/Downloads/alma-re/docs/21-skill-install.md §1`, the singleton `Xu` (`main.js:18571-19126`) scans 5 roots + 2 derived:

```
this.personalSkillsPath    = ~/.config/alma/skills
this.claudeCodeSkillsPath  = ~/.claude/skills
this.codexSkillsPath       = ~/.codex/skills
this.agentSkillsPath       = ~/.agents/skills        // ← skillflag "portable" lands here
this.claudePluginsPath     = ~/.claude/plugins

projectSkillsPath          = <workspace>/.alma/skills
bundledSkillsPath          = resolveBundledSkillsDir() (probes 6 candidates)
```

The bundled candidate probe order at `main.js:18934-18948`:

```
process.resourcesPath/bundled-skills    ← prod (Alma.app/Contents/Resources/bundled-skills)
<dirname(__filename)>/bundled
<dirname(__filename)>/../skills/bundled
<dirname(__filename)>/../../electron/skills/bundled
<app.getAppPath()>/electron/skills/bundled
<app.getAppPath()>/../electron/skills/bundled
```

Symlinks to directories are followed. Errors are logged but never thrown.

### 2.2 SKILL.md format

`parseSkillMd(content)` at `main.js:18635-18661`:

- Normalises `\r\n` → `\n`.
- Matches frontmatter: `/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/`.
- Parses YAML via `jt.parse` (the `yaml` npm module).
- Requires `name: string` and `description: string`. Anything else is optional.

Recognised frontmatter keys:

```js
{
  id:            sha256(absolutePath).slice(0, 16),
  name:          metadata.name,
  description:   metadata.description,
  license:       metadata.license,
  allowedTools:  metadata["allowed-tools"],
  alwaysInject:  metadata["always-inject"],
  metadata:      metadata.metadata,
  content:       <markdown body, trimmed>,
  fullContent:   <whole file as read>,
  path:          <absolute directory containing SKILL.md>,
  source:        "bundled" | "personal" | "claude-code" | "codex" | "marketplace" | "project",
}
```

`tools:` (no hyphen) is silently ignored — only `allowed-tools:` is honored. (One bundled skill uses `tools:` and works only because the in-process tool gate is *additive* not restrictive.)

### 2.3 Override resolution (asymmetric — actual bug)

Per `~/Downloads/alma-re/docs/21-skill-install.md §1.loadSkills`, the priority *as documented*:

```
1. bundled       — baseline, can be overridden by anything
2. personal      — ~/.config/alma/skills
3. claude-code   — ~/.claude/skills
4. codex         — ~/.codex/skills
5. agents        — ~/.agents/skills      (only if not in bundled)
6. marketplace   — claude plugins        (only if not in bundled)
7. project       — <ws>/.alma/skills     (always overrides)
```

But the *actual* order in code at `main.js:18790-18813` is:

```js
// 1. project — base layer (highest precedence: nothing overrides project)
for (const s of project)         map.set(s.name.toLowerCase(), s)
// 2. marketplace — only inserts if NOT in bundled
for (const s of marketplace)     if (!bundledNames.has(s.name)) map.set(...)
// 3. agents — only inserts if NOT in bundled
for (const s of agents)          if (!bundledNames.has(s.name)) map.set(...)
// 4. codex — unconditional overwrite
for (const s of codex)           map.set(...)
// 5. claude-code — only inserts if NOT in bundled
for (const s of claudeCode)      if (!bundledNames.has(s.name)) map.set(...)
// 6. personal — only inserts if NOT in bundled
for (const s of personal)        if (!bundledNames.has(s.name)) map.set(...)
// 7. bundled — only fills holes
for (const s of bundled)         if (!map.has(s.name)) map.set(...)
```

**Bundled names are sticky** for marketplace/agents/claude-code/personal. Only codex and project can override. The user-facing docs do not document this carve-out.

**B-SKILL-01**: If Maka mirrors this design, mirror the *symmetric* version: project > workspace > user > bundled, with `personal` and `claude-code` allowed to override bundled by name. Today Maka's `apps/desktop/src/main/skills.ts:listInstalledSkills(root)` scans only `<root>/skills/` — single namespace, no override semantics. When we add multi-source scanning, get the semantics right. Estimate: M.

### 2.4 Skill state (enabled / sortOrder)

SQLite `skills` table — `(id PRIMARY KEY, path, enabled, sort_order, updated_at)`. Persisted by *id* (path hash, sha256 truncated to 16), not by *name*. Move a skill on disk and its enabled/sortOrder state resets.

Maka's `skills.ts` has no enabled state — every parseable SKILL.md is loaded. If we want user-toggleable skills, add a per-skill enable bit (could just be a `disabled: true` frontmatter key to keep it filesystem-native). Estimate: S.

### 2.5 The legacy-copy cleanup (`cleanupLegacyBundledSkills`)

`main.js:18958-19017`. On first run after the bundled-skills tree exists, walks `~/.config/alma/skills/` and for any directory whose name matches a bundled skill compares the `SKILL.md` content. If identical (or identical modulo `always-inject:` line), `rmSync(... force:true)` — destructive delete with no user prompt. Marker `~/.config/alma/skills/.bundled-skills-migrated` ensures one-shot.

**Avoid in Maka.** Per `~/Downloads/alma-re/docs/21-skill-install.md §1`: "a user who intentionally copied a bundled skill into `~/.config/alma/skills/` to make a tweak, then reverted the tweak, will have the copy silently deleted on the next launch." Don't borrow this — if anything, add a tombstone file with the original sha256 and ask before deleting.

---

## 3. Two-stage skill loading

This is the *core* pattern worth borrowing.

### 3.1 What goes in the system prompt

Per `~/Downloads/alma-re/docs/02-tools.md §11`, only **name + brief description** of each skill in the system prompt. The model sees a `<available_skills>` block with maybe 60 short entries.

### 3.2 What the `Skill` tool does (`main.js:24627-24684`)

```js
sf = re({                                  // Skill tool
  description:
    "Execute a skill within the main conversation\n\n" +
    "<skills_instructions>\n" +
    "This tool uses progressive disclosure: the <available_skills> section in the system " +
    "prompt only contains skill names and brief descriptions (metadata). " +
    "The full skill content (detailed instructions, templates, workflows) is loaded " +
    "on-demand only when you invoke this tool...",
  inputSchema: ie(of),                      // { skill: string >= 1 }
  // outputSchema: not declared; returns a single STRING (not an object)
  execute: async ({ skill }) => {
    // 1. Lookup by lower-cased name (Yu.getSkillByName), fall back to id (getSkillById).
    // 2. If disabled, return "Skill ... exists but is currently disabled."
    // 3. If not found, return "Skill ... not found. Available skills: ..." listing currently enabled.
    // 4. Otherwise emit a multi-section prompt that *forces absolute paths* for any in-skill file
    //    references, then appends skill.content.
  },
});
```

The "force absolute paths" preamble is critical — without it, skill markdown that says "edit ~/.config/alma/SOUL.md" might get model-fabricated into "edit ./SOUL.md" depending on cwd at invocation time.

### 3.3 How Maka does it today

`apps/desktop/src/main/skills.ts` injects skills into the system prompt directly:

```ts
export const MAX_SKILLS_IN_PROMPT = 12;
export const MAX_SKILL_BODY_CHARS = 4000;
export const MAX_SKILL_TOOL_BODY_CHARS = 24_000;
export const MAX_SKILLS_PROMPT_CHARS = 18000;
```

Up to 12 skills, 4000 chars each body, total 18000 chars. This doesn't scale — a real user with 30 skills installed would lose 18 of them (or hit the char cap).

**B-SKILL-02**: Move skill bodies out of the system prompt and into a `Skill` tool. Pre-req: `MAX_SKILLS_IN_PROMPT` becomes much higher (could be the full set, since only name + 1-liner are injected). `loadSkillInstructions` (`apps/desktop/src/main/skills.ts:listInstalledSkills` returns the path; the load function is separate) already does the read. Estimate: M.

Wire path:
1. New tool `Skill` in `packages/runtime/src/builtin-tools.ts` (or a new file), exposed via a setting that's on by default.
2. System prompt: replace the existing skills block with a `<available_skills>` listing just `id: description` lines.
3. Tool impl: looks up by id, returns the markdown body with the same "use absolute paths" preamble.

Risk: medium. Model might be confused by the indirection at first. Mitigation: a one-line nudge in the system prompt: "To get instructions for any skill, call the Skill tool with its id."

---

## 4. `always-inject` skills

`main.js:18705` reads `metadata["always-inject"]`. Per `~/Downloads/alma-re/docs/21-skill-install.md` and `~/Downloads/alma-re/docs/04-skills.md`: some skills set `always-inject: true` to be unconditionally added to the system prompt (versus on-demand via the Skill tool). Use cases: skills whose mere presence changes behavior (e.g. `plan-mode`, `self-management`).

**B-SKILL-03**: When implementing B-SKILL-02, support `always-inject: true` as an opt-in escape hatch. Estimate: S.

---

## 5. Skill install pipeline (skillflag)

### 5.1 The npm package

`app/node_modules/skillflag/dist/install/`, version 0.1.4, MIT. Per `~/Downloads/alma-re/docs/21-skill-install.md §2`, the CLI:

- Parses `--agent <name>`, `--scope <name>`, `--force`, optional PATH arguments.
- If no PATH and stdin is a pipe with data: reads a tar bundle from stdin and extracts to tmp.
- Validates the resulting directory: must contain a SKILL.md with `name` and `description`.
- Resolves the destination via `resolveSkillsRoot(agent, scope, cwd)`.
- Copies the tree to `<root>/<skill.name>` via `copySkillDir(source, dest, force)`.

### 5.2 Destination matrix (`resolve.js`)

| agent | repo | user | cwd |
|---|---|---|---|
| `codex` | `<git-root>/.codex/skills` | `$CODEX_HOME/skills` or `~/.codex/skills` | `./.codex/skills` |
| `claude` | `<git-root>/.claude/skills` | `~/.claude/skills` | — |
| `portable` | `<git-root>/.agents/skills` | `$XDG_CONFIG_HOME/agents/skills` or `~/.config/agents/skills` | — |
| `vscode` | `<git-root>/.github/skills` | — | — |
| `copilot` | `<git-root>/.github/skills` | — | — |
| `amp` | `<git-root>/.agents/skills` | `$XDG_CONFIG_HOME/agents/skills` | — |
| `goose` | `<git-root>/.agents/skills` | `$XDG_CONFIG_HOME/agents/skills` | — |
| `opencode` | `<git-root>/.opencode/skill` | `$XDG_CONFIG_HOME/opencode/skill` | — |
| `factory` | `<git-root>/.factory/skills` | `~/.factory/skills` | — |
| `cursor` | `<git-root>/.cursor/skills` | — | — |

**Alma is not in the agent list.** The integration with `Xu` is therefore patchy (see `21-skill-install.md §2` for the full hostility of the round-trip).

**B-SKILL-04**: If Maka ever supports skill install from registry, it should add `maka` as a skillflag agent contribution upstream (or fork/vendor and add the row). Estimate: S, but blocked by Maka needing a skill registry.

### 5.3 Tar extraction safety (`extract.js`)

Per `~/Downloads/alma-re/docs/21-skill-install.md §2.3`, the extractor is **commendably defensive**:

```js
function isInvalidRelPath(relPosix) {
  if (path.posix.isAbsolute(relPosix)) return true;
  const parts = relPosix.split("/");
  // ... rejects "..", absolute paths, drive-letter prefixes, etc.
}
```

This is the **only piece of skillflag that handles external input**. It's correct.

**B-SKILL-05**: If Maka adds skill install, vendor the extract.js path-validation logic verbatim or use a known-safe tar lib (`tar-stream` with strict mode). Estimate: S (10 lines).

### 5.4 The unauthenticated install endpoint (DON'T BORROW)

Per `~/Downloads/alma-re/docs/00-GAP-ANALYSIS.md` and `~/Downloads/alma-re/docs/21-skill-install.md`: the connecting tissue — `alma skill install <user/repo>` — calls `POST http://localhost:23001/api/skills/refresh` (and presumably an install endpoint). This is **unauthenticated**. Any process on the machine can install arbitrary skills.

Don't borrow this. If Maka exposes a `skillInstall` IPC, gate it through the preload bridge with confirmation in the renderer (the user clicks an install button), not through a token-less HTTP route.

---

## 6. The Anthropic Skills format itself

Per `~/Downloads/alma-re/docs/04-skills.md`, the format is plain Markdown with YAML frontmatter:

```markdown
---
name: web-fetch
description: Fetch and read web pages, APIs, and online content. Use when user wants to read a URL.
allowed-tools:
  - Bash
  - WebFetch
  - ChromeRelayNavigate
  - ChromeRelayRead
---

# Web Fetch Skill

When the user asks to read a URL, prefer ChromeRelayNavigate if the page might require login.
Otherwise use WebFetch.

## Examples

Q: "read this page"
A: Call ChromeRelayNavigate, then ChromeRelayRead.
```

Maka's `apps/desktop/src/main/skills.ts` already implements *exactly* this format. No borrow needed; we're on the same page (literally).

Per `~/Downloads/alma-re/docs/04-skills.md §0`, every skill **bottoms out** in one of three places:

1. The `alma <command>` CLI (~28 of 33 skills primarily call it).
2. The localhost gateway at `http://localhost:23001`.
3. Direct shell tools (`ffmpeg`, `ffprobe`, `whisper`, `jq`, `find`, `du`, `screencapture`, `sips`, `curl`).

For Maka, skills bottom out at `Bash` directly. We don't have a CLI translation layer or a localhost gateway. That's a cleaner story and a smaller attack surface, but it does mean every skill has to be cross-platform shell — which is harder. Don't borrow the CLI architecture; consider a minimal `maka` CLI only if we hit real friction.

---

## 7. Summary of borrowable items in this doc

| ID | Mechanic | Cite | Maka file | Scope | Risk |
|---|---|---|---|---|---|
| B-PROMPT-01 | System-prompt split at stable/volatile boundary | `main.js:62807-62830` | `ai-sdk-backend.ts` system build | S | low |
| B-PROMPT-02 | Date awareness as user-turn `<reminder>` | `main.js:61972` | `ai-sdk-backend.ts:buildUserContent` | S | low |
| B-PROMPT-03 | SECURITY.md highest-priority slot | `main.js:61758` | `workspace-instructions.ts` | S | low |
| B-PROMPT-04 | Tool-model for micro-decisions | `main.js:14860, 32922, 33624 (etc.)` | new `getToolModel()` helper | M | low |
| B-PROMPT-05 | Anti-ChatGPT lint in default prompt | `main.js:61712` | `workspace-instructions.ts` | S | low |
| B-SKILL-01 | Symmetric override resolution | `main.js:18790-18813` | future multi-source skills | M | med |
| B-SKILL-02 | Move skill bodies into `Skill` tool | `main.js:24631-24684` | new `Skill` tool, `skills.ts` already has loader | M | med |
| B-SKILL-03 | `always-inject: true` opt-in | `main.js:18705` | `skills.ts` parse + system prompt build | S | low |
| B-SKILL-04 | Add `maka` as skillflag agent | `skillflag/dist/install/resolve.js:36-78` | blocked on registry | S | low |
| B-SKILL-05 | Vendor extract.js path-validation | `skillflag/dist/install/extract.js` | new file when install added | S | low |
