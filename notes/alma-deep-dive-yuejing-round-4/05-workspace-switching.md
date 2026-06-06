# 05 — Alma workspaces: schema, default resolution, project scoping

> Source-grounded against `~/Downloads/alma-re/readable/main.js`.
> Rounds 1-3 never traced this. Round-3 [`01-skills-system.md`](../alma-deep-dive-yuejing-round-3/01-skills-system.md)
> noticed `.alma/skills` was a workspace-scoped path but didn't
> chase the workspace model itself. This note covers the
> workspaces table, default-workspace resolution, thread binding
> patterns, and project-scoped surfaces (skills, agent paths,
> sessions).

## Schema

`main.js:257-276`:

```typescript
workspaces: {
  id: string (pk)
  path: string                  // absolute filesystem path
  name: string
  isTemporary: boolean          // default false; tmp workspaces nuke their dir on delete
  showInList: boolean           // default true; hidden workspaces still exist in DB
  isWorktree: boolean           // default false; if true, a git worktree
  parentWorkspaceId: string?    // worktree backref to source workspace
  worktreeBranch: string?       // git branch for the worktree
  autoWorktree: boolean         // default false; auto-create worktree per-task
  autoWorktreeBaseBranch: string?
  prNumber: number?             // associated PR
  prUrl: string?
  prState: string?
  prBaseBranch: string?
  createdAt: ISO timestamp
  updatedAt: ISO timestamp
}
```

Two surprises:
- **Worktrees are workspaces too.** A git worktree gets its own
  row with `isWorktree: true` + `parentWorkspaceId` backref.
  Useful for "agent works on a feature branch" without touching
  the user's main checkout. Cross-ref the worktree isolation
  mode in alma's own Workflow tool documentation.
- **PR metadata is baked in.** `prNumber` / `prUrl` / `prState` /
  `prBaseBranch` on the workspace row directly. Alma can show a
  workspace's PR status without joining external tables. (Probably
  populated by a `git` + `gh` shell-out at workspace create
  time.)

## Default-workspace resolution (4 cascading layers)

Alma resolves "which workspace?" for any new thread or bot
channel through a 4-level cascade. The pattern at `main.js:19128-
19144` (from a Telegram bot path) is the cleanest example:

```js
const settings = JSON.parse(settingsBlob.settingsData);
const channelMap = settings?.[platform]?.channelWorkspaceMap;
if (channelMap) {
  const explicit = channelMap[channelId];
  if (explicit && To.getWorkspaceById(explicit)) return explicit;  // (1)
}
const fallback = settings?.general?.defaultWorkspaceId;
if (fallback && To.getWorkspaceById(fallback)) return fallback;     // (2)
return To.getOrCreateDefaultWorkspace().id;                          // (3) + (4)
```

Layered resolution:

1. **Per-channel override** (`channelWorkspaceMap`): bots can pin
   a specific Telegram group / Discord channel to a specific
   workspace. Useful for "the #infra channel = ops workspace,
   #design = research workspace." Map exists per-platform
   (`settings.telegram.channelWorkspaceMap`, etc.).
2. **User default** (`general.defaultWorkspaceId`): the
   user-picked default.
3. **Built-in default** (`getOrCreateDefaultWorkspace`): lazily
   creates `{userData}/workspaces/default` (`main.js:4909-4928`).
4. **Implicit** — if id lookup fails at step 2, falls through to
   step 3 anyway.

The same pattern appears at `main.js:42586`, `29033`, `43217`,
`62591`, `19138` — at least 6 callers reimplement it. Worth
noting as a possible round-5 refactor candidate, but probably
left inline because the surfaces sometimes need to skip the
channel-map step.

## Thread binding patterns

Threads carry **two** workspace foreign keys (`main.js:286-291`):

```typescript
workspaceId: string?          // FK → workspaces.id, ON DELETE SET NULL
artifactWorkspaceId: string?  // FK → workspaces.id, ON DELETE SET NULL
```

`workspaceId` is the **session workspace** — where Bash commands
run, where Read/Edit/Write default to, what `.alma/skills` scope
loads.

`artifactWorkspaceId` is the **artifact storage** for chat-
generated files (code snippets the agent wrote, output files,
etc.). When `enableArtifacts` is set on a thread, alma lazily
creates a workspace named `Artifacts - ${threadTitle}` at
`main.js:3757-3773`. Critically, if the referenced
`artifactWorkspaceId` no longer exists (user deleted it), the
update path creates a fresh one — never crashes on stale FK.

### Thread reassignment

Multiple paths reassign threads to the current default workspace
when a bot resumes them (`main.js:34867`, `38303`, `40676`,
`42280`, `43055`):

```js
if (existing && existing.workspaceId !== currentDefault) {
  To.updateThread(threadId, { workspaceId: currentDefault });
}
```

Pattern: when a bot recovers a long-lived thread, sync it to the
**current** default workspace, not the one it was bound to. Use
case: user changed their default; old bot threads should follow.

This is the right call for bot-flavored threads (chat with you on
Telegram = current setup). It would be WRONG for code-coupled
threads ("worked on feature-x branch, switching default to main
shouldn't move me"). The unconditional rebind suggests
bot/cron/heartbeat paths only — verified by call-site context
(all in bot/heartbeat handlers).

## Project-scoped surfaces

The workspace `.path` field unlocks `<workspace.path>/<scope>`
sub-paths for project-scoped data:

| Scope | Path | Purpose |
|---|---|---|
| Skills | `<workspace>/.alma/skills` | Project-specific skills (round-3 01). Loaded when workspace is open. |
| Agent profiles | `<workspace>/.alma/agents` (inferred from cross-refs in round-2 07) | Per-project agent overrides. |
| Session storage | passed as `workspacePath` to Bash sessions | Cwd for shell-outs. |

`isInsideSkillDirectory` (`main.js:18622`) takes the current
workspace's path and checks if a candidate file is inside one of
the 6 skill roots, INCLUDING the project root. So the project's
`.alma/skills` is treated equivalently to `~/.config/alma/skills`
for safety checks.

## ACP / Bash session per-workspace

`main.js:48110-48150`:

```js
const sessionKey = (workspaceId, threadId) => `${workspaceId}:${threadId}`;
this.sessions.set(sessionKey, {workspaceId, workspacePath, threadId, …});
// …
killSessionsForWorkspace(workspaceId) {
  for (const session of this.sessions.values()) {
    if (session.workspaceId === workspaceId) this.killSession(session.id);
  }
}
```

ACP (Claude Code / Codex / Cursor bridges) and Bash sessions are
**workspaced + threaded** in the same key. Workspace deletion
kills all its sessions across all threads. The `workspacePath`
is passed in so the spawned process can `cd` into the right
directory on start.

## Workspace-aware AI model creation

`main.js:48644`, scattered other call sites pass `workspaceId`
into `getAIModel(provider, modelId, {threadId, workspacePath})`.
Some providers care about workspace (e.g., the ACP bridge that
needs to spawn `claude` inside the project), most don't. Passing
it unconditionally is the simpler API.

## "Inactive workspace" guards

`main.js:23556-23561`:

```js
if (!session?.workspaceId) return; // can't run without one
const ws = To.getWorkspaceById(session.workspaceId);
if (!ws) return;                    // workspace was deleted
```

Defensive: every tool execution path that needs a workspace
checks BOTH that the session has one AND that the row still
exists. The ON DELETE SET NULL on the FK means deletes are
non-cascading — orphan threads survive, but tool calls bail
out.

## Worktree mode (the autoWorktree pattern)

`autoWorktree: true` on a workspace tells alma: "when an agent
starts a task here, fork a git worktree into a sister directory."
The worktree gets its own workspace row pointing back to the
parent. `worktreeBranch` records the branch name; alma can
cleanup or merge later.

This connects to the round-1 / -2 mention of `isolation:
"worktree"` in the Task tool — the auto-worktree workspace is
the runtime version of that flag.

Open question: does alma cleanup unused worktrees? Without
cleanup, hundreds of worktree workspaces could accumulate. The
spec doesn't say.

## What Maka has today

Maka has `defaultWorkspaceId` in settings and a single workspace
notion in `@maka/runtime`, but:
- No table — workspaces are inferred from filesystem paths the
  user picks at chat-create.
- No worktree support.
- No artifact workspaces.
- No per-channel mapping (Maka has no bot integrations).
- No project-scoped skill discovery (Maka has no skills).

## Ranked Maka improvements

1. **Promote workspace to a first-class DB table.** Even with
   only `(id, path, name, createdAt)`, having a single source
   of truth for "which projects has the user opened" enables
   many downstream features: recent workspaces, workspace-bound
   threads, project-scoped settings.

2. **Adopt the artifactWorkspaceId pattern.** Today agent-
   generated files land in the chat session's workspace. A
   dedicated `Artifacts - ${chat title}` workspace prevents
   pollution of the user's project tree. Particularly valuable
   for users running Maka against their main work repo.

3. **Default-workspace cascade.** The 4-level resolution
   (channel map → user default → builtin) is overkill for Maka
   today, but the SHAPE generalizes: user default → builtin
   default. Two layers, cheap.

4. **`isInsideSkillDirectory` safety check.** When Maka adopts
   skills (round-3 01 already pinned as a priority), the
   "is this file path inside an allowed root?" check is
   critical for sandboxing.

5. **Per-thread workspace binding.** Multiple Maka chats against
   the same project share state today. Binding a thread to a
   workspace at create time avoids "I started this chat for
   project X then accidentally context-switched and now the
   agent is confused."

## Open questions for future rounds

- Worktree lifecycle: does alma auto-cleanup unused
  `autoWorktree` workspaces? Without it, the workspace list
  grows monotonically.
- The unconditional thread reassignment in bot/heartbeat paths
  could surprise users who maintain workspace-pinned long-
  running bots. Is there an opt-out?
- `channelWorkspaceMap` lives in `settings[platform]` (e.g.,
  `settings.telegram.channelWorkspaceMap`). Multiple platforms
  with the SAME channel id (Telegram chat -100123 vs Discord
  channel 100123) won't collide because of the platform key —
  but what if the user uses one platform-prefix string and the
  channel id was passed in raw elsewhere? Worth a round-5 grep.
- PR metadata on the workspace row implies alma watches `gh pr
  status` or similar. Frequency? On-demand?

## Cross-refs

- Round 2: [`07-subagent-orchestration.md`](../alma-deep-dive-yuejing-round-2/07-subagent-orchestration.md)
  — `isolation: "worktree"` in the Task tool is the agent-layer
  version of `autoWorktree`.
- Round 3: [`01-skills-system.md`](../alma-deep-dive-yuejing-round-3/01-skills-system.md)
  — `<workspace>/.alma/skills` is the 6th skill root, only
  active when a workspace is open. `isInsideSkillDirectory`
  uses workspace.path.
- Round 3: [`04-permissions-runtime-risk.md`](../alma-deep-dive-yuejing-round-3/04-permissions-runtime-risk.md)
  — allow_always policy keys are scoped per-thread, not per-
  workspace. So "allow always for ls in this project" doesn't
  persist across the workspace's threads.
- Round 4: [`02-auto-compact.md`](./02-auto-compact.md) —
  compaction operates on thread messages, but the summary
  model + tool model lookups thread workspace_path through to
  the AI model provider chain.
