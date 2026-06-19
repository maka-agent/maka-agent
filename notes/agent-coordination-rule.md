# Multi-agent coordination rule

Single source of truth for how `yuejing`, `kenji`, `xuan` (and any future
agent) share this repo without drifting onto stale copies.

Anchor: WAWQAQ Slock channel `#my-ai`, msg `6f3f2514` (2026-06-20)
"记得把代码统一一下啊，不要每个人跑的代码他妈的都不一样" + the unify
thread `#my-ai:6f3f2514` reply chain.

## Invariant

`origin/main` (which is in lockstep with `github/main`) is the *only*
authoritative version. Every agent worktree is a scratchpad; what is
not on `origin/main` does not exist for collaboration purposes.

## Lifecycle

1. **Before claiming any task** (every time, not just when "feels stale"):

   ```bash
   git fetch origin
   git pull --ff-only origin main
   ```

   If the fast-forward refuses (local commits diverge): stash, rebase,
   or branch off — never `--force` over a divergent main.

2. **Every ≤30 minutes of active work**: re-fetch. Catches in-flight
   pushes from peers before they collide with yours.

3. **Before pushing**: rebase your branch on the latest
   `origin/main`. If GitHub rejects with non-fast-forward
   (`! [rejected] ... fetch first`), pull → merge or rebase → retest →
   push again. Never `--force` against main.

4. **After pushing**: in the relevant task thread (and the unify thread
   `#my-ai:6f3f2514`), post the new `HEAD` short sha and the one-line
   commit summary. The next agent reads this *before* fetching, so a
   non-fast-forward surprise is visible up-front.

## Electron windows are per-task, not "the production line"

Every visual / interactive verification must start from a fresh build
off the agent's *current* `origin/main`. No long-lived shared Electron.

Concretely (per xuan unify-thread clarification 2026-06-20):
- Code changes happen in any agent's worktree in parallel — fine.
- When a task needs a screenshot or click-through, the agent does
  `git pull --ff-only origin main` → build → start a *short-lived*
  Electron instance in their own worktree → verify → close it.
- Never cite a screenshot from an old Electron window: the running
  process may be reading a stale `dist/`. If unsure, kill + rebuild.
- Don't piggy-back on someone else's running Electron for your
  verification — you cannot tell which `dist/` it loaded.

## What this rule does *not* cover

- Branch strategy (we work on `main`; if someone needs a feature
  branch, name it `agent:<name>/<topic>` and rebase before merge).
- Code review (handled in task threads).
- Memory files: those are per-agent. Don't sync them across
  worktrees.

## Why this exists

2026-06-20 incident: yuejing fixed the Settings → 主题 page (commit
`9081c64`) and pushed to `origin`, but someone else on GitHub (commit
`0c5ecb2`) had committed a partial CSS-only fix for the same bug
moments earlier. GitHub push refused non-fast-forward; yuejing fetched
+ merged + republished, ending at `4b40485`. The merge worked but the
near-miss is exactly what step 1 + step 4 above are meant to prevent
in the future.
