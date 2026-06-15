# 04 — Reference app permission runtime (tool approval machinery)

> WAWQAQ called out Maka's three-mode 只读 / 确认 / 执行 design as
> "傻逼 / 多余" (msg `bdb272f7`). This note traces reference app's actual
> implementation against `~/Downloads/reference-source/readable/main.js` so
> we have a source-grounded reference for what to converge to.

## Punchline

Reference app's permission runtime is **binary, not three-mode**:

- Per-call: `allow_once` / `allow_always` / `deny` / `deny_with_reason`.
- Global: a single `security.autoApproveToolRequests` toggle (the
  "Shift+Tab auto-accept" surface) — when on, every request returns
  `allow_once` without prompting.

There is no equivalent of Maka's three-mode 只读 / 确认 / 执行. The
"only ask for dangerous ops" semantics is encoded *per tool* via its
risk classification, not by a renderer-side mode chip.

## Source pins

### Per-call action vocabulary

`main.js:19365-19378` — the IPC handler validating the user's
response from the tool-approval dialog:

```js
if ("boolean" == typeof e)
  return { action: e ? "allow_once" : "deny" };
if (e && "object" == typeof e) {
  const t = e.action;
  if (
    "allow_once" === t ||
    "allow_always" === t ||
    "deny" === t ||
    "deny_with_reason" === t
  )
    return { action: t, reason: rh(e.reason) };
}
return { action: "deny" };
```

The renderer can send back either a raw boolean (`true` → allow_once,
`false` → deny) or a structured object whose `action` must be in the
four-value enum. Anything malformed defaults to `deny` — fail-closed,
the same hard gate Maka uses.

### Global auto-approve

`main.js:19384-19389` — reads `security.autoApproveToolRequests` off
the settings store:

```js
const e = To.getSettings();
if (!e) return !1;
const t = JSON.parse(e.settingsData);
return !0 === t?.security?.autoApproveToolRequests;
```

This is the binary "everything is allow_once" switch. The UI
surface for it is the Shift+Tab toggle reference app is known for.

### Headless override

`main.js:19345-19354` — when running in CI / headless:

```js
if ("1" === process.env.ALMA_HEADLESS) {
  const e = "deny" !== (process.env.ALMA_TOOL_APPROVAL || "auto");
  return {
    requestId: sh(),
    approved: e,
    reason: e ? "approved" : "rejected",
    action: e ? "allow_once" : "deny",
  };
}
```

Default in headless is "allow_once" unless `ALMA_TOOL_APPROVAL=deny`
is set explicitly. Useful for CI smoke runs that need tools to
actually execute without a human in the loop.

### Tool-side deny propagation

`main.js:19617`, `19644`, `22995`, `23254`, `23255` — the `denyReason`
gets surfaced both as a tool-result `output` and as a system message
back to the model (e.g. `[Bash Permission] Command denied by user:
${denyReason}`). The model sees WHY it was blocked, so it can
either reformulate or stop attempting.

## What Maka does differently (and how to converge)

Maka today:
- Three modes: 只读 (ask), 探索 (explore), 执行 (execute) — chip in
  chat header.
- Each tool has a `permissionLevel` classification that interacts
  with the mode to decide whether to ask.
- One `permissionEngine` evaluates per turn.

Concrete simplifications that match reference app:

1. **Drop the three-mode chip entirely.** Replace with the single
   `autoApproveToolRequests` boolean (default false). Same
   information density, no false granularity.

2. **Add `allow_always` to the dialog's choice set.** Currently
   Maka's permission dialog only shows allow / deny (or "remember
   for turn"). `allow_always` for a per-tool decision that
   persists across turns matches reference app's semantics and unblocks
   the "stop pestering me about Read on this project" workflow.

3. **Keep the per-tool risk classification.** Even without modes,
   the engine should still default to "ask" for destructive
   operations (Bash with state-mutating commands, Write, Delete)
   and "auto-allow" for read-only (Grep, Glob, Read). This is
   purely server-side and doesn't need user-facing mode chips.

4. **Surface `denyReason` back to the model.** Maka's permission
   dialog currently lets the user type a deny reason; verify it
   gets into the next turn's prompt as `[Tool Permission] denied:
   ${reason}` so the model can adapt.

5. **Replicate the headless override.** Useful for visual-smoke
   scenarios that need real tool execution. Env var:
   `MAKA_TOOL_APPROVAL=allow_once|deny`, default to deny when
   headless.

## Open question

How does reference app decide WHICH tools auto-approve when
`autoApproveToolRequests` is true? Is it literally every tool, or
does it still gate destructive (Bash with sudo, Write outside
project, etc.)? Need to trace the tool registry's risk metadata.
Round 3 of round-2 (yes, recursive) — TBD.

## Cross-refs

- Round 1: [`02-tools.md`](../reference app-deep-dive-yuejing-2026-05-31/02-tools.md)
  for the tool registry shape.
- Round 1: [`09-symbol-recovery.md`](../reference app-deep-dive-yuejing-2026-05-31/09-symbol-recovery.md)
  for the `To` (databaseService) symbol used at line 19385.
