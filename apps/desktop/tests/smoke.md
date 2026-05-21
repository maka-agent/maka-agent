# Maka desktop smoke test plan

Manual end-to-end paths that the V0.2 UI / credential / lifecycle work
relies on. Each path lists the precondition, the steps, and the
*observable* signal that proves the path is intact. If any of these
regress, that's the floor we lost — fix before shipping.

## Setup

Either start clean (`rm -rf ~/Library/Application\ Support/maka` on
macOS, equivalent path on Windows / Linux) or use an existing workspace
and follow the per-path preconditions. All paths happen in a single
launched build (`npm --workspace @maka/desktop run dev` or a packaged
build).

---

## Path 1 — First launch with no real model

**Precondition.** Clean install, no enabled LlmConnection in settings.

**Steps.**
1. Launch Maka.
2. Don't type into the composer; just look at the chat surface.

**Pass signal.**
- The chat surface renders **OnboardingHero** (the "Welcome to Maka"
  card with six featured provider tiles), not the `EmptyChatHero`
  ("想一起做点什么？") or a blank screen.
- Clicking any provider tile opens Settings · 模型.
- "先用 FakeBackend 走一遍流程 →" focuses the composer.

**Fail signals.**
- Empty chat hero shown despite no enabled connection.
- Onboarding hero shown forever even after connection is enabled.

---

## Path 2 — Add a connection and verify it

**Precondition.** Workspace exists; you have a real provider API key
(Anthropic / OpenAI / DeepSeek / Z.ai / etc.).

**Steps.**
1. ⌘K → "设置 · 模型" → Enter (PR64 palette routing).
2. Add an Anthropic connection, paste API key, save.
3. Switch to "设置 · 账号" via the nav.
4. Observe the new connection row: it should say **已配置 · 未验证**
   in an info-tone badge (no green check yet).
5. Click "测试连接" on that row.
6. Wait for the toast.

**Pass signal.**
- Success toast: "连接已验证" + latency + tested model.
- Row badge flips to **已验证可用** in green/success tone.
- Row card border + background shifts to success.
- Default connection (if set in Settings · 通用 or models flow) has a
  small "默认" pill on the name line.
- `lastTestAt` formatted timestamp visible under the badge.

**Fail signals.**
- Test button stuck disabled or spinning forever.
- Status doesn't refresh without closing/reopening Settings.
- Badge ever shows "disabled + verified" or any mixed label.

---

## Path 3 — Failing credential surfaces in chat header

**Precondition.** A previously verified connection. The session you
open uses this connection.

**Steps.**
1. Settings · 模型 → pick the connection → corrupt the API key
   (replace with a clearly bogus value) → save.
2. Settings · 账号 → click "测试连接" on that row.
3. Wait for the failure toast.
4. Close Settings, return to chat with that connection active.

**Pass signal.**
- Account row badge becomes **需要重新登录** (warning tone) or
  **连接出错** (destructive tone) depending on the underlying
  errorClass (401/403 → needs_reauth; 5xx/timeout/network → error).
- `lastTestMessage` shows a generalized phrase like
  `Authentication failed` / `Request timed out` — never a raw provider
  body or API key.
- Chat header now shows a small clickable pill matching the row tone
  ("需要重新登录" warning or "上次连接失败" destructive).
- Clicking the pill jumps directly to Settings · 账号.

**Fail signals.**
- Chat header alert missing when the row already shows the failure.
- Generalized message includes raw `sk-...` / Bearer token / URL with
  query secret.
- Connection auto-disabled after a single failure (failure should be a
  status, not a lifecycle change — user disables manually).

---

## Path 4 — Streaming + delete-active-session safety

**Precondition.** At least one verified connection. Active session has
the model picked.

**Steps.**
1. Send a prompt; the model starts streaming.
2. Verify the composer toolbar swaps in **"Maka 正在思考…"** with the
   pulsing accent dot, the Send button disappears, and the only
   primary action is a red **Stop** button.
3. Try pressing Esc inside the textarea — it should call onStop and
   the stream should cancel.
4. Send a fresh prompt and let it run.
5. Delete the currently-active session mid-stream. Options, easiest
   first:
   - **IPC-level (preferred for automated test runs)**: from DevTools
     console, fire `window.maka.sessions.remove(activeSessionId)`. The
     `sessions:changed { reason: 'deleted', sessionId }` broadcast is
     the contract under test, not the right-click affordance.
   - **GUI**: from a *second* Maka window pointed at the same workspace
     (open a new BrowserWindow if needed), right-click the row → 删除
     → confirm. The original window must observe the broadcast.

**Pass signal.**
- The sidebar removes the row (via `sessions:changed` broadcast).
- The chat surface clears: active session unset, messages emptied,
  no stuck streaming bubble.
- No "send into a deleted session" error follows; the composer remains
  responsive and the user can start a new chat.

**Fail signals.**
- Composer keeps showing the streaming hint after the underlying
  session is gone.
- Renderer crashes or shows the previous session's messages on top of
  an empty title.
- Tool activity from the deleted session keeps streaming into the new
  one.

---

## Path 5 — PermissionDialog destructive path

**Precondition.** A connection that lets the model invoke tools (e.g.
default agent setup). User is in **Ask** permission mode.

**Important — do not actually run the destructive command.** The goal is
to verify the *dialog presentation*, not to delete real files. Either:
- Ask the assistant to *propose* the action so it surfaces a
  PermissionRequest, then **Deny**. Or
- Inject a synthetic permission request via DevTools by simulating the
  IPC event so the dialog mounts without any tool actually pending.

**Steps.**
1. Cause the runtime to produce a destructive PermissionRequest
   (e.g. tell the model "我会自己跑，先告诉我你打算执行什么 rm 命令"
   so it issues an `fs_destructive` request you can refuse), or inject
   a synthetic request in DevTools.
2. Wait for the PermissionDialog to appear.

**Pass signal.**
- Dialog icon is **AlertOctagon** (red), label reads
  **不可恢复的文件系统操作**.
- Summary section shows the exact shell command in a code block + a
  timeout meta line if the runtime supplied one.
- Below the "本轮对话内记住选择" checkbox, the red emphasis note
  **"这类操作不可恢复，确认前请再读一遍上面的参数。"** is visible.
- The primary button reads **"我已确认，允许"** in destructive tone
  (red), not the usual blue "允许".
- The "记住本轮" caption explicitly says
  "(同类型工具不再询问，关闭/切换对话后失效)".
- Clicking Deny does not run the command; the assistant gets a denial
  signal.

**Fail signals.**
- The dialog renders the action with neutral / info tone (no red
  treatment) for an obviously destructive operation.
- "记住本轮" persists across sessions or app restarts (should be
  per-turn only).
- Permission dialog can be dismissed with Esc (it shouldn't be — Esc
  is explicitly disabled for permission decisions).

---

## When to run

- Before merging any large UI / runtime / credential / permission
  change to main.
- After any change that touches `LlmConnection`, `sessions:changed`
  payload shape, `ConnectionUiStatus` derivation, or PermissionDialog
  rendering.
- Before tagging a release.

Each path is < 1 minute. The full run is < 5 minutes. Worth doing.
