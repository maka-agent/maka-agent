# 06 — Bots & Integrations: Telegram / Discord / Feishu / WeChat

**TL;DR.** Yetone runs all four bots inside the *same Electron main process* with a clean three-layer pattern: raw Bot class (network) → Bridge class (WS to localhost + ALMA_CHAT_ID/THREAD_ID env injection) → Express agent loop. Per-platform state files live in `~/.config/alma/groups/state.json`. The four bridges share thread mapping, duplicate suppression, owner identity, and the `generate_response` WS protocol. Maka has 5 bots scaffolded but with much simpler bridges — most don't poll long, most don't deduplicate, and the channel-mapping story is less explicit. Borrows: the 30s health-check loop, owner-platform-ID YAML frontmatter, channel-mapping table, the duplicate-suppression Set+TTL pattern, the WeChat QR-login flow (which is already in place).

---

## 1. Yetone's bot architecture

Per `~/Downloads/alma-re/docs/16-bots.md §1`:

```
Platform           ┌─────────────────────────────┐
   ↑↓ network      │ Bot class  (fb, Fb, Gb, iv) │  raw API calls, long-poll,
                   │  - receives updates         │  state file under
                   │  - parses messages          │  ~/.config/alma/groups/
                   │  - exposes onMessage()      │
                   └────────────┬────────────────┘
                                │ callback
                   ┌────────────▼────────────────┐
                   │ Bridge class (Rb / Wb / Hb / lv)
                   │  - opens WS to localhost    │
                   │  - turns incoming msg into  │
                   │    `generate_response`      │
                   │  - consumes `message_delta` │
                   │    + `generation_completed` │
                   │  - calls back into Bot to   │
                   │    deliver text/voice/file  │
                   └────────────┬────────────────┘
                                │ WS frames over ws://127.0.0.1:port/ws/threads
                                ▼
                       Express / streamText loop
```

Each bridge runs in the same process but connects to itself via WebSocket. This is *deliberate*: the WS is the universal "submit prompt / receive deltas" pipe, so each bridge reuses it rather than reinventing the agent loop.

### 1.1 Per-platform classes

Per `~/Downloads/alma-re/docs/16-bots.md` opening table:

| Platform | Library | Transport | Bot class | Bridge class | Init | Status |
|---|---|---|---|---|---|---|
| Telegram | raw Bot API (`fetch`) | HTTPS long-poll `/getUpdates` | `fb` (L31925) | `Rb` "MessageBridge" (L34563) | `initializeTelegramBot` L69634 | fully implemented, deepest feature set |
| Discord | `discord.js` ^14 | Gateway WebSocket | `Fb` (L37156) | `Wb` "DiscordBridge" (L37921) | `initializeDiscordBot` L69665 | parity with Telegram minus stickers-by-emoji |
| Feishu (Lark) | `@larksuiteoapi/node-sdk` ^1.59 | Lark WSClient | `Gb` (L39744) | `Hb` "FeishuBridge" (L40432) | `initializeFeishuBot` L69713 | text + image + file + reactions; no stickers, no voice |
| WeChat | raw iLink HTTP | HTTPS long-poll `getupdates` | `iv` (L41488) | `lv` "WeixinBridge" (L42114) | `initializeWeixinBot` L69743 | DM only, QR-code login, no group, no reactions |

### 1.2 Boot sequence

`main.js:65440-65451`:

```js
this.startHeartbeat(),
this.initializeTelegramBot(),
this.initializeDiscordBot(),
this.initializeFeishuBot(),
this.initializeWeixinBot();
```

Each initializer is a no-op if the platform is disabled or missing credentials.

### 1.3 Hot restart on settings change

`PUT /api/settings` (`main.js:58799-58816`) — broadcasts `settings_updated`, then for each section that was touched:

```js
d.telegram && this.restartTelegramBot()...
d.discord  && this.restartDiscordBot()...
d.feishu   && this.restartFeishuBot()...
d.weixin   && this.restartWeixinBot()...
```

Each `restartXxxBot()` (`main.js:69660-69764`) is textbook: `await bridge.stop()`, null the field, re-run the initializer.

Per-platform state files (`STATE_FILE = ~/.config/alma/groups/state.json`) preserve `groupHistory`, `lastBotReplyTime`, `skippedMessages` across restarts.

### 1.4 Process-crash resilience

Crashes are Electron-level (whole app re-launches). Within a running process, each bridge installs a health-check timer:

- Telegram `Rb.startHealthCheck` (`main.js:34696`): every 30s, if `bot.isRunning()` is false, `await this.bot.start()` again.
- Feishu `Hb.startHealthCheck` (`main.js:40536`): same shape, 30s.
- Discord `Wb.startHealthCheck` (`main.js:37952`): same shape, 30s — guards against gateway disconnects that discord.js gave up on.
- WeChat `lv` (`main.js:42119`): no health-check timer; the WeChat poll loop is resilient by design.

---

## 2. Maka's bot story

`packages/runtime/src/bots/`:

```
base-adapter.ts          76 lines
bot-registry.ts
bot-test.ts
dingtalk-bridge.ts
discord-bridge.ts        598 lines
proxied-fetch.ts
qq-bridge.ts
simple-bridge.ts
types.ts
wechat-bridge.ts         324 lines
```

`apps/desktop/src/main/wechat-scan-login.ts` (129 lines) handles the WeChat QR scan-login dance via the iLinkAI ClawBot endpoints.

The Maka bots all extend `BaseBotAdapter` (`packages/runtime/src/bots/base-adapter.ts`):

```ts
export class BaseBotAdapter {
  protected running = false;
  protected readiness: BotReadiness;
  protected reason?: string;
  protected identity?: BotIdentity;
  protected startedAt?: number;
  // emits statusChange events
}
```

Compared to Yetone:

- **No central process** — each bot is a separate adapter; the registry just tracks them.
- **No state file persistence** — `running` is in-memory; `recentlySentMessages` per-bridge.
- **No health-check timer** — Maka's `WechatBridge.start` does a single probe at startup; if the bridge dies later, nothing restarts it.
- **No WebSocket back to itself** — adapters call into the SessionManager directly, which is *cleaner* than Yetone's "WS to my own port" trick.

---

## 3. The borrows from Yetone bots

### 3.1 Health-check loop (B-BOT-01)

**Per-bot 30s health check.** Yetone's Telegram/Discord/Feishu bridges all run a 30s timer that probes `bot.isRunning()` and restarts if false.

Maka has `WechatBridge` (`packages/runtime/src/bots/wechat-bridge.ts:74` — `void this.streamLiveMessages(...)`) that runs forever, but if the long-poll dies it just stops emitting messages. No restart.

For each Maka bot, add a 30s health check that:
1. Checks `running === true`.
2. If yes but no message received in the last N minutes, attempt a status probe.
3. If probe fails, `await stop(); await start();`.

Estimate: S per bot. Risk: medium (could cause restart loops if the underlying issue is persistent — needs exponential backoff).

### 3.2 Channel mapping table (B-BOT-02)

Per `~/Downloads/alma-re/docs/08-memory.md §3.10`:

```sql
CREATE TABLE channel_mappings (
  id              TEXT PK,
  platform        TEXT CHECK IN ('telegram','discord','feishu','weixin'),
  external_chat_id TEXT NOT NULL,
  external_user_id TEXT,
  thread_id       TEXT → chat_threads(id) ON DELETE CASCADE,
  ...
);
```

Lookup helper `Vu.getOrCreateMapping(platform, chatId, userId)` (`main.js:19147`).

Maka stores per-session info in `SessionHeader`; there's no separate channel-mapping table because there's no SQLite. The information flow is:

- Bot receives a message with platform-specific IDs.
- Bot needs to find the right Maka session (or create one).
- Today, this is per-bridge ad-hoc.

**B-BOT-02**: Centralize channel mapping. Add `header.channels?: { telegram?: {chatId, userId}, discord?: {channelId, userId}, ... }` to `SessionHeader`. Move the lookup-or-create dance into a shared helper. Estimate: M.

### 3.3 Duplicate-suppression `Set` + TTL (B-BOT-03)

Per `~/Downloads/alma-re/docs/16-bots.md §7`:

> each bridge maintains its own `recentlySentThreads` / `recentlySentMessages` Sets/Maps, though they carry similar TTLs of 10–30 s (L37930, L36570, L34612).

The pattern: when sending a message, push the `(chatId, messageId)` into a Set with a `setTimeout` to remove after the TTL. When receiving an incoming message, check if it's our own echo. If yes, ignore.

Maka has `recentlySentMessages` in `WechatBridge` (search the file). Verify all bridges have it.

**B-BOT-03**: Audit all 5 Maka bot bridges for duplicate suppression. Standardize via a helper:

```ts
class DuplicateSuppressor {
  private set = new Set<string>();
  mark(key: string, ttlMs: number) {
    this.set.add(key);
    setTimeout(() => this.set.delete(key), ttlMs);
  }
  has(key: string) { return this.set.has(key); }
}
```

Estimate: S (the helper); M (audit + apply per-bot).

### 3.4 Owner-platform-ID YAML frontmatter (B-BOT-04)

Per `~/Downloads/alma-re/docs/08-memory.md §7.3` and `~/Downloads/alma-re/docs/16-bots.md §6`, USER.md and people/*.md use:

```yaml
---
name: jake
telegram_id: '123456789'
discord_id: '987654321'
feishu_id: 'ou_abc...'
weixin_id: 'wxid_xyz...'
---
```

Owner identification is done by looking up the platform ID in USER.md's frontmatter. No hardcoded numeric IDs anywhere in code.

Maka's local-memory has YAML support but doesn't standardize an "owner identification" scheme.

**B-BOT-04**: When Maka adds multi-bot routing, pick the same frontmatter keys (`telegram_id`, `discord_id`, etc.) for forward compatibility with anyone who's used this pattern. Estimate: S.

### 3.5 Per-platform system prompt fragments (B-BOT-05)

Per `~/Downloads/alma-re/docs/03-prompts.md §1` and `~/Downloads/alma-re/docs/16-bots.md §9`:

- Group chat prompt at `main.js:35075` — `[From: name (@username)]` prefix parsing, 4-layer memory, "three sentences max" rule, anti-filler "Silence is infinitely better than filler".
- Telegram channel prompt at `main.js:35107` — explicit "you live on the user's `${platform}` computer, not inside Telegram" distinction; multi-bot identity reinforcement ("don't get called bub").

For Maka, when a bot bridge invokes a session, it can pass an additional system prompt fragment per channel:

```ts
const systemContext = {
  channel: { platform: 'wechat', chatType: 'group', chatId, isOwner: false },
  // ...
};
```

`SystemPromptContext` (`ai-sdk-backend.ts:220-224`) already has `sessionId`, `cwd`, `workspaceRoot`. Add `channel?: { platform, chatType, isOwner }`.

**B-BOT-05**: Plumb channel context into system prompt. Estimate: S (interface change) + M (write per-platform fragments).

### 3.6 `ALMA_THREAD_ID` / `ALMA_CHAT_ID` env injection (B-BOT-06)

Per `02-tools.md §5.3` (and `main.js:23350-23365`): Bash env includes `ALMA_THREAD_ID` and `ALMA_CHAT_ID`. The `send-file` skill (`~/Applications/Alma.app/Contents/Resources/bundled-skills/send-file/SKILL.md`) uses these to route attachments back to the originating chat.

When a Maka skill wants to send a file back to the WeChat user, today it has no clean way to know "what chat sent me." Inject `MAKA_CHAT_PLATFORM`, `MAKA_CHAT_ID`, `MAKA_CHAT_USER_ID` into the Bash env when the session was created by a bot bridge.

Estimate: S. Already covered by B-TOOLS-06 in the tools note — this is the bot-specific use case.

### 3.7 The WeChat QR login (Maka already has)

Maka's `apps/desktop/src/main/wechat-scan-login.ts` is *already* a reverse of the same iLink endpoints Yetone uses. The header comment cites `main.js:41518-41600` (which is the WeChat bot class `iv`).

The implementation looks clean:
- `wechatUinHeader()` — same base64-encoded random uint32 trick.
- Two endpoints: `GET /ilink/bot/get_bot_qrcode?bot_type=3` and `GET /ilink/bot/get_qrcode_status?qrcode=<token>`.
- Returns structured `{qrcodeUrl, qrToken}` then `{status: 'waiting'|'expired'|'confirmed', credentials?}`.
- Network through `globalThis.fetch` which respects Electron session proxy.

No borrow needed; verified mirror. Possible *forward-port* of new features from Yetone:

- Yetone's `iv` class polls every ~3s via the same `/getupdates` style endpoint after login. Verify Maka's `WechatBridge.streamLiveMessages` does the same.
- Per `~/Downloads/alma-re/docs/16-bots.md §5`, Yetone caches credentials at `~/.config/alma/weixin/credentials.json` (not in settings). Maka should consider: WeChat credentials in `BotChannelSettings` are passed by value; if the user revokes the token, there's no automatic recovery path.

### 3.8 The OpenAI-compatible endpoint (`/v1/chat/completions`) (B-BOT-07)

Per `~/Downloads/alma-re/docs/01-agent-loop.md §17` and `main.js:56912`:

> OpenAI-compatible API endpoint (Alma exposes `/v1/chat/completions`) — streams text-only chunks back as SSE for external API clients.

External programs can use Yetone as an LLM gateway. The chat is routed through the same `streamText` loop.

**B-BOT-07**: Expose a `/v1/chat/completions` endpoint as a Maka feature. Useful for:
- External CLIs scripting Maka without IPC.
- LangChain / LlamaIndex / other tools to consume Maka as an OpenAI provider.

Estimate: M. Risk: medium (need auth — Yetone's is token-less and that's a bug).

---

## 4. Patterns Yetone has that Maka should NOT borrow

### 4.1 Bots calling localhost over WebSocket

The "WS to my own port" pattern (`main.js:34788, 38782, 40612, 42214`) is deliberate but quirky. It treats the bridge as an external client. Maka's adapters calling SessionManager directly is cleaner.

### 4.2 No central event bus

> No shared in-memory event bus — cross-platform messaging (`alma discord send` from a Telegram thread) goes through HTTP to the Express server (e.g. `POST /api/discord/channels/:id/send`, L52238), so the originating bridge stays uninvolved.

This forces every cross-platform path to go through HTTP. Maka should keep its in-memory event bus (via SessionManager's async queue).

### 4.3 No auth on internal `/api/*` routes

Per `~/Downloads/alma-re/docs/00-GAP-ANALYSIS.md`: most of the 238 Express routes are unauthenticated. Maka has no Express. Good.

### 4.4 `/api/voice/send` shell-injects `chatId`

```js
execSync(`curl ... ?chat_id=${chatId} ...`)
```

This is a literal command-injection vuln if `chatId` is attacker-controlled. Maka's `wechat-bridge.ts` uses `fetch` + `JSON.stringify` and is correct.

---

## 5. Sticker / reaction integrations

Per `~/Downloads/alma-re/docs/16-bots.md §11`:

- Telegram + Discord have sticker auto-indexing at `~/.config/alma/stickers/index.json`.
- 1-in-5 incoming messages get an emoji reaction (per `main.js:33781` — separate small-model LLM call to pick the emoji).

**B-BOT-08**: When/if Maka adds reactions, route through the tool model (B-PROMPT-04) for the choice. Cheap. Estimate: M.

---

## 6. Activity indicators (typing)

Per `~/Downloads/alma-re/docs/16-bots.md §10`: Each bridge sends a "typing..." indicator at the platform's standard cadence while the agent is generating. Telegram: `sendChatAction(typing)` every 5s. Discord: gateway typing event. Feishu: `is_typing: true` in message payload. WeChat: no typing API.

**B-BOT-09**: For each bot bridge, surface a "typing" indicator that's reset on each `text_delta` event from the session. Estimate: S per bot.

---

## 7. Summary of borrowable items in this doc

| ID | Mechanic | Cite | Maka file | Scope | Risk |
|---|---|---|---|---|---|
| B-BOT-01 | 30s health-check + auto-restart | `main.js:34696, 40536, 37952` | each `*-bridge.ts` | S each | med |
| B-BOT-02 | Channel mapping table | `main.js:19147`, schema at `08-memory.md §3.10` | `SessionHeader` + new helper | M | low |
| B-BOT-03 | Duplicate-suppression Set+TTL helper | `main.js:34612, 36570, 37930` | new `runtime/src/bots/dedup.ts` | S helper, M per-bot apply | low |
| B-BOT-04 | Owner platform IDs in MEMORY.md frontmatter | `08-memory.md §7.3` | `@maka/core` memory parser | S | low |
| B-BOT-05 | Per-platform system prompt fragments | `main.js:35075, 35107` | `SystemPromptContext` + writing the fragments | S iface + M content | low |
| B-BOT-06 | `MAKA_CHAT_PLATFORM/ID/USER_ID` env injection | `main.js:23350-23365` | `builtin-tools.ts:165-169` | S | low |
| B-BOT-07 | `/v1/chat/completions` OpenAI-compatible endpoint | `main.js:56912` | new app-side route | M | med (auth) |
| B-BOT-08 | Reaction-emoji LLM call | `main.js:33776, 33624` | future feature | M | low |
| B-BOT-09 | "Typing" indicators per bridge | `~/Downloads/alma-re/docs/16-bots.md §10` | each `*-bridge.ts` | S | low |
