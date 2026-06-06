# 04 — Alma permissions runtime: autoApprove + 5 bypass channels + Bash's AI risk analyzer

> Source-grounded against `~/Downloads/alma-re/readable/main.js`.
> Pinned open question in round-2 [`04-permissions-runtime.md`](../alma-deep-dive-yuejing-round-2/04-permissions-runtime.md):
> "does `autoApproveToolRequests` cover ALL tools or still gate
> destructive ones at runtime?" — this note answers and traces the
> full bypass ladder plus the orthogonal Bash AI command analyzer.

## TL;DR

`autoApproveToolRequests` is a **flat universal skip**: when ON,
EVERY tool approval request returns auto-approved without any
risk-level check. There's no destructive-tool carve-out at the
permission gate level.

BUT Bash is special — it has a SEPARATE pre-gate AI command
analyzer (`main.js:22884`) that produces a `needsPermission`
boolean per command. If the analyzer says "safe" (read-only),
no permission request is created in the first place, regardless
of `autoApprove`. So:

- Read-only Bash commands: silent execute always (analyzer
  bypass, not approval bypass).
- Modifying Bash commands: would prompt; auto-approved if
  `autoApprove` ON.
- Non-Bash tools: would prompt; auto-approved if any of the
  5 bypass channels (next section) match.

## The 5 bypass channels (OR chain)

`lh(input)` at `main.js:19345-19462` is the central approval
function. After the headless-mode short-circuit (next section), it
runs a 5-deep OR chain:

```js
return (
  autoApproveSettingOn()                          // (1)
    || input.metadata?.isSubagent === true        // (2)
    || botSourceBypass(input.metadata?.source)    // (3)
    || botThreadBypass(input.threadId)            // (4)
    || cronThreadBypass(input.threadId)           // (5)
  ? { approved: true, action: "allow_once", ... }
  : allowPolicyHit(ih(input))                      // (6) policy cache
  ? { approved: true, action: "allow_always", ... }
  : queueAndAskUser(input)                         // (7) interactive
);
```

### Channel 1 — `security.autoApproveToolRequests` setting

`main.js:19383-19392`:

```js
function () {
  try {
    const e = To.getSettings();
    if (!e) return false;
    const t = JSON.parse(e.settingsData);
    return t?.security?.autoApproveToolRequests === true;
  } catch { return false; }
}
```

Reads the settings DB row, parses, checks one boolean. **No
exemption list, no risk-level whitelist** — flat true → bypass
ALL. This is the answer to the round-2 open question.

### Channel 2 — Subagent metadata

`main.js:19393-19395`:

```js
function (input) {
  return input.metadata?.isSubagent === true;
}
```

Subagents (the Task tool's inner runs) **never prompt**. Reasoning:
the orchestrating agent already prompted (or was bypassed); having
the subagent prompt again would be a UX dead-end (no human is
watching that subagent's modal). Cross-ref round-2 [`07-subagent-
orchestration.md`](../alma-deep-dive-yuejing-round-2/07-subagent-orchestration.md).

### Channel 3 — Bot source metadata

`main.js:19396-19409`:

```js
function (input) {
  const t = (input.metadata?.source || "").toLowerCase().trim();
  return !!t && (
    t.startsWith("telegram") ||
    t === "discord" ||
    t === "feishu" ||
    t === "cron" ||
    t === "heartbeat"
  );
}
```

When the tool call originated from a bot integration (Telegram,
Discord, Feishu) or an autonomous source (cron, heartbeat) — there's
no human at a keyboard. Approving is the only sensible default.
The string match is loose: `telegram` starts-with is enough,
covering future `telegram_v2` etc.

### Channel 4 — Bot thread mapping (via thread ID)

`main.js:19410-19436`:

Look up the thread in `Ku` (the bot thread mapping table) by
threadId. If the thread maps to a Telegram/Discord/Feishu chat,
bypass. The redundancy with channel 3 is intentional: channel 3
catches tool calls that explicitly TAGGED themselves; channel 4
catches calls that happen INSIDE a bot-chat thread but forgot the
source tag.

### Channel 5 — Cron thread

`main.js:19437-19444`:

```js
function (threadId) {
  if (!threadId) return false;
  try {
    const t = To.getThreadById(threadId);
    return !!t && (
      !!t.metadata?.isCron ||
      t.title?.startsWith("⏰ Cron:")
    );
  } catch { return false; }
}
```

Thread is recognized as cron if metadata flag set OR title starts
with the `⏰ Cron:` emoji prefix. The title fallback is a
hardening: even if a future thread loses the metadata flag,
title-based detection still works.

## Channel 6 — Per-policy auto-allow cache

When the user picks "Allow always" in the modal, the dispatcher
stores ALLOWED policy keys in the in-memory `th` Set
(`main.js:19217`, `19335-19336`). Future requests whose policy
keys overlap with `th` auto-resolve as `allow_always`.

`ih(input)` (`main.js:19228-19253`) computes the policy keys:

| Source | Keys produced |
|---|---|
| `bash` | `bash:thread:<threadId\|global>:command:<command>` + `bash:thread:<threadId\|global>:all` |
| `acp` (Claude/Codex bridge) | `acp:thread:<threadId\|global>:tool:<kind\|toolName>` + `acp:thread:<threadId\|global>:all` |
| anything else (built-in non-Bash tools, MCP) | `[]` (empty) |

Three observations:
- **Bash and ACP only.** Built-in tools and MCP tools cannot use
  the per-policy cache. They prompt every time unless one of the
  5 bypass channels matches. This is the "narrow allow_always"
  design — destructive scope is limited to where it's useful.
- **Per-thread scoping.** Policy keys are `<source>:thread:<id>:…`
  so an `allow_always` doesn't bleed across threads. New thread,
  new prompt.
- **`:all` fallback alongside the specific key.** When you allow a
  specific command, BOTH the command-specific key and the all-key
  get added — but the user UI must control this (else "allow this
  one command" turns into "allow all Bash"). Open question.

## Channel 7 — Interactive modal queue

`ch()` at `main.js:19273-19343`: pops the queue, broadcasts a
`tool-approval-dialog-show` IPC to ALL non-destroyed windows,
sets a timeout (clamped to 120s max), stores the resolve fn in
`eh` keyed on requestId. When the user clicks, the IPC handler
`tool-approval-dialog-respond` (registered once via `oh` latch)
looks up the resolve and dispatches with the user's `action`.

Important behaviors:
- **Single-flight: `nh` holds the in-flight request**; the queue
  serializes prompts. New requests stack behind it.
- **No-window detection**: if no window is alive, the request
  resolves immediately as `deny` with reason `"no-window"`. This
  is the headless-without-the-env-flag case.
- **Resolution broadcast**: `ah(requestId, result)` sends
  `tool-approval-dialog-resolved` to every window so other open
  modal instances can dismiss themselves. Nice cross-window UX.

## Headless mode

`main.js:19346-19354` is checked FIRST, before the OR chain:

```js
if (process.env.ALMA_HEADLESS === "1") {
  const e = (process.env.ALMA_TOOL_APPROVAL || "auto") !== "deny";
  return { approved: e, action: e ? "allow_once" : "deny", ... };
}
```

Two env-var contract:
- `ALMA_HEADLESS=1`: enables the short-circuit.
- `ALMA_TOOL_APPROVAL=deny`: deny everything.
- `ALMA_TOOL_APPROVAL=anything else` or unset: approve
  everything.

So headless CI mode can either approve-everything (default for
agentic workflows) or deny-everything (for safety on untrusted
prompts). No intermediate "ask anyway" option.

## Bash's AI command analyzer (the pre-gate)

This is the answer to the SECOND part of the round-2 open
question: "does autoApprove still gate destructive ones at
runtime?" Answer: no — the **AI analyzer** does the per-command
risk classification BEFORE the approval system is even consulted.

`main.js:22884` is the analyzer prompt. Excerpt:

> Commands that are SAFE and do NOT need permission (return
> needsPermission: false):
> - Read-only commands: ls, pwd, cat, head, tail, …
> - Information commands: date, cal, uptime, whoami, id, …
> - Text processing (read-only): grep, awk, sed (without -i), …
> - Git read commands: git status, git log, git diff, …
>
> Commands that NEED permission (return needsPermission: true):
> - File modification: rm, mv, cp, mkdir, rmdir, …
> - Git write commands: git add, git commit, git push, …
> - Package management: npm install, pip install, …
> - Network commands: curl (POST/PUT/DELETE), wget, ssh, …
> - System commands: sudo, su, systemctl, …
> - **Any unknown or complex commands**
>
> Risk levels:
> - safe: Read-only, no side effects
> - low: Minor changes, easily reversible
> - medium: Significant changes, may affect files or system state
> - high: Destructive operations, system modifications, network access

The analyzer returns JSON `{needsPermission, description,
riskLevel, mightModifyFiles}`. If `needsPermission: false`, the
Bash tool executes silently. If true, the runtime approval
pipeline (channels 1-7 above) kicks in with `riskLevel` carried
in metadata.

Validation belt-and-braces at `main.js:23178-23182`:

```js
["safe", "low", "medium", "high"].includes(i.riskLevel)
  || (i.riskLevel = "medium");                       // default unknown to medium
// Belt-and-braces: needsPermission must be true if not safe.
i.needsPermission = i.needsPermission && i.riskLevel !== "safe";
```

If the model returned an invalid risk, default to `medium`. AND
force `needsPermission` to true unless the risk is explicitly
`safe` — even if the model claimed "no permission needed" with
medium risk.

## Combined answer to the round-2 open question

| Tool | autoApproveToolRequests OFF | autoApproveToolRequests ON |
|---|---|---|
| Read-only Bash (`ls`, `git status`, …) | silent execute (analyzer says safe) | silent execute (same) |
| Modifying Bash (`rm`, `npm install`, …) | modal prompt with risk badge | bypass — silent execute |
| Built-in non-Bash (Read, Edit, …) | modal prompt | bypass — silent execute |
| MCP tools (`linear__createIssue`) | modal prompt | bypass — silent execute |
| Subagent calls of any tool | bypass (channel 2) | bypass (channel 2) |
| Bot-source / bot-thread / cron / heartbeat | bypass (channels 3-5) | bypass (channels 3-5) |

So `autoApprove` ON is genuinely flat: nothing further gates. The
"risk classification still happens" answer is YES for Bash (via
the analyzer) but the result of the classification doesn't change
the approval bypass.

## What Maka has today

Maka uses a three-mode chip (only/auto/all approval) — round-2
note 04 documented this as the WAWQAQ-rejected design ("傻逼").
The alma binary model + analyzer + bypass-channels combo is the
target architecture. Today's Maka:
- Three modes that the user has to think about
- No per-command Bash analyzer
- No bot-source / cron auto-bypass
- No allow_always cache scoped per thread

## Ranked Maka improvements

1. **Replace three-mode chip with a single
   `autoApproveToolRequests` toggle.** Documented WAWQAQ
   feedback agrees. This is a UX simplification AND an
   architectural unblock for the next items.

2. **Add the Bash AI command analyzer.** This is the actual
   risk-classification surface. Without it, `autoApprove OFF`
   makes Bash deeply annoying (every `ls` prompts), pushing
   users to turn `autoApprove ON` — which then defeats safety
   for everything else. The analyzer recovers the safety gain
   for non-Bash tools.

3. **Subagent bypass channel.** Cheapest win: a `metadata.isSubagent`
   flag at task spawn means the subagent's tool calls don't
   ever modal. Maka can adopt this even before the rest of the
   alma subagent system lands (round-2 note 07).

4. **Bot-source bypass.** If/when Maka adds bot integrations,
   the bypass-channels-3-and-4 pattern is the right baseline —
   either tag the source OR check the thread mapping, so
   one-off forgotten tags still hit channel 4.

5. **Allow_always per-policy cache, bash-only.** Limiting
   `allow_always` to Bash (with both command-specific and
   `:all` keys) is the right scoping — users want "stop asking
   about `git status`" not "stop asking about everything in
   this thread."

## Open questions for future rounds

- Does the "allow_always" UI surface BOTH the command-specific
  key and the `:all` key as separate buttons, or is it a single
  toggle that adds both? If single, that's a footgun.
- The `th` Set is in-memory only — does it survive thread
  switches? Does it survive app restart? Pattern says "always"
  but the storage says "until restart". Worth confirming.
- For ACP tools, the policy key is per-`kind` or per-`toolName`
  — does that mean Claude's `bash` tool inside ACP gets cached
  separately from the built-in `Bash`? Probably yes since the
  source string differs (`acp` vs `bash`), but the user
  shouldn't have to allow_always twice.

## Cross-refs

- Round 2: [`04-permissions-runtime.md`](../alma-deep-dive-yuejing-round-2/04-permissions-runtime.md)
  — where this open question was pinned.
- Round 2: [`05-bash-tool-family.md`](../alma-deep-dive-yuejing-round-2/05-bash-tool-family.md)
  — Bash command analyzer also discussed there in the context
  of the risk-aware modal.
- Round 2: [`07-subagent-orchestration.md`](../alma-deep-dive-yuejing-round-2/07-subagent-orchestration.md)
  — subagent metadata flag is set at task spawn there.
- Round 3: [`02-output-safety-modes.md`](./02-output-safety-modes.md)
  — different surface but same Bash-command-rewrite bypass
  pattern (`Wd(e) !== e`).
