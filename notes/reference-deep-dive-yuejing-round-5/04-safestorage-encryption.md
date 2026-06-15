# 04 — Reference app API key encryption: Electron safeStorage + plaintext fallback

> Source-grounded against `~/Downloads/reference-source/readable/main.js`.
> Round-4 [`01-rest-api-operator-agent.md`](../reference app-deep-dive-yuejing-round-4/01-rest-api-operator-agent.md)
> noted the spec's claim "Provider API keys are stored encrypted.
> The API will not expose decrypted keys in responses." Rounds 1
> mentioned encryption but never traced. This note covers
> Electron's `safeStorage` integration end-to-end across 4
> distinct call sites, the base64 wrapping for transit, the
> plaintext-fallback semantics, and what each platform actually
> uses underneath.

## The primitive: Electron `safeStorage`

`main.js:37`:

```js
import {
  …,
  safeStorage as a,
  …
} from "electron";
```

Electron's `safeStorage` is a thin wrapper over each platform's
OS-level credential storage:

| OS | Backend | Key management |
|---|---|---|
| macOS | Keychain | App-specific key in user's login keychain |
| Windows | DPAPI | Per-user encryption via Windows Data Protection API |
| Linux | libsecret (via `gnome-keyring` / `kwallet5`) — or session-key | Fallback to plaintext (logs warning) if no secret service |

The two API calls reference app uses:
- `safeStorage.encryptString(plaintext: string) → Buffer`
- `safeStorage.decryptString(buffer: Buffer) → string`
- Plus `safeStorage.isEncryptionAvailable() → boolean` — the
  capability check.

## Four call sites, one pattern

`main.js:15554-15596` (Copilot account tokens), `15580-15596`
(token save/load), `16229-16261` (Claude subscription tokens),
`24727-24739` (MCP OAuth credentials). All four follow the
same template:

```js
// SAVE
if (!a.isEncryptionAvailable()) {
  return writeFile(path, plaintext, "utf8");      // plain fallback
}
const encrypted = a.encryptString(plaintext);
return writeFile(path, encrypted);                // raw bytes, no encoding

// LOAD
const bytes = await readFile(path);
return a.isEncryptionAvailable()
  ? a.decryptString(Buffer.from(bytes))           // assume encrypted
  : bytes.toString("utf8");                       // assume plain
```

Three observations across the call sites:

### 1. `isEncryptionAvailable()` checked at BOTH save AND load

Each site checks at WRITE time AND READ time. The states must
match — if a token was saved under a system with encryption and
loaded on a system without, decrypt would fail. The dual check
keeps the path symmetric.

But subtle: this means if a user MIGRATES their reference app data (e.g.,
sync via icloud, restore on a different machine), the
encryption state can flip. Encrypted-then-decrypted-as-plain
returns garbage bytes; plain-then-decrypted-as-encrypted throws.

The code silently catches the "key not present" error path
(`try {} catch { return null }`) for getStored*, which is the
right fail-soft — user re-authenticates if their stored token
becomes unreadable. But there's no MIGRATE helper. Round-5 risk.

### 2. Base64 wrapping for transit-via-text contexts

`main.js:24730-24738` — the MCP OAuth path wraps the encrypted
bytes in base64:

```js
function pf(plaintext) {
  return a.isEncryptionAvailable()
    ? a.encryptString(plaintext).toString("base64")
    : Buffer.from(plaintext).toString("base64");
}

function mf(b64) {
  return a.isEncryptionAvailable()
    ? a.decryptString(Buffer.from(b64, "base64"))
    : Buffer.from(b64, "base64").toString("utf8");
}
```

When does base64 matter? When the encrypted blob has to live in
a JSON column or environment variable — anywhere it needs to be
TEXT, not raw bytes. The Copilot/Claude paths use raw `Buffer`
writes to disk and skip base64. MCP stores in DB / JSON
artifacts, so base64-wraps.

This pattern is **invariant-preserving**: same `pf`/`mf` shape
whether encryption is available or not. Caller can always treat
the output as base64 text without thinking about the encryption
state.

### 3. Plaintext fallback is SILENT

`main.js:15580`:

```js
if (!a.isEncryptionAvailable())
  return void (await v.promises.writeFile(n, t, "utf8"));
```

No log. No warning. No marker in the file (e.g.,
`v1-plain:<contents>` vs `v1-encrypted:<contents>`). If
encryption was available yesterday and isn't today (user
removed gnome-keyring, downgraded macOS, etc.), the file silently
loses its encryption.

This is a deliberate UX tradeoff: reference app works on Linux without
libsecret installed (otherwise you'd need every user to install
extra packages), but the security guarantee is conditional.
The spec's "stored encrypted" is best-effort, not a promise.

The trade-off is reasonable; the lack of a marker is worth
flagging. Without a marker:
- User can't audit "is this provider's key actually
  encrypted?"
- A future migration helper would have to GUESS which files
  are encrypted vs plaintext.

## Where the provider apiKey itself is stored

`main.js:451` (schema):

```typescript
providers: {
  …
  apiKey: text("api_key").notNull(),  // stored in DB column
}
```

CRITICAL: **the provider `apiKey` column is stored in
plaintext in the SQLite DB**, NOT encrypted via safeStorage.
This contradicts the api-spec note "Provider API keys are
stored encrypted." The encrypted-on-disk paths are for OAuth
tokens (Copilot, Claude subscription) and MCP OAuth — NOT for
the api_key column.

The DB file `~/.config/reference app/reference app.db` IS protected by
filesystem permissions (user-mode 600), but ANY process with
that user's UID can read it. There's no per-app sandboxing on
macOS for the SQLite file beyond the standard Unix model.

So the spec's "stored encrypted" claim is **technically
inaccurate** for provider api_keys. It's accurate for OAuth
tokens. Worth flagging openly — round-5 candidate to confirm.

## What "do not expose" means in the API response

The api-spec says `apiKey: string  // Encrypted, do not expose`.
"Do not expose" in practice means: the REST handler that returns
the Provider object SHOULD scrub `apiKey` (or replace with a
masked version like `sk-***...***`) before sending the response
to the WebSocket / API client.

I did NOT find evidence of that scrub. The provider broadcast
helper at `main.js:59010-59014` only strips `availableModels` —
NOT `apiKey`. So either:
1. The renderer trusts itself with the plaintext key (over
   localhost — round-4 07's trust model), and the "do not
   expose" comment refers to the operator agent specifically.
2. There IS scrubbing elsewhere I missed.

Without a clear scrub call, the safe assumption is: any client
on `127.0.0.1` can read provider apiKeys via `GET /api/providers`.
This aligns with the round-4 07 localhost-trust model but means
the api-spec's "encrypted, do not expose" is misleading marketing.

## Provider key plaintext callsites

`main.js:1188`, `12560`, `14573`, `16426`, `16430`, `16551`,
`16814`, `16839` all read `t.apiKey` directly and slot it into
Bearer / x-goog-api-key / openai-config / etc. None decrypt
first — the key in `t.apiKey` is ALREADY plaintext when read
from the DB.

So the storage model is:
```
provider.apiKey: stored in SQLite plaintext
   ↓ (no decrypt needed)
provider.apiKey: passed to AI SDK provider factory
   ↓
AI SDK: stamps Authorization header
```

Linear, no encryption involved.

## What IS encrypted via safeStorage

| Surface | Path | Why encrypted |
|---|---|---|
| Copilot account tokens | `{userData}/copilot/accounts/<name>.token` | OAuth tokens are typically longer-lived + more powerful than api_keys; worth the extra layer. |
| Claude subscription tokens | `{userData}/claude_subscription/tokens.json` | Same: OAuth refresh + access tokens for Claude subscription. |
| MCP OAuth credentials | DB column (base64-wrapped) | OAuth credentials per MCP server. |

The pattern: **OAuth tokens are encrypted, api_keys are not.**
Probably because:
- Api keys are user-pasted (entered once, easy to re-paste).
- OAuth tokens are user-issued (refresh token is the long-lived
  credential — losing it forces full reauth flow).

Defensible reasoning but the API spec should say so honestly.

## Legacy token migration

`main.js:15540-15574` is the Copilot legacy token migration —
demonstrates the encryption pattern handles BOTH formats:

```js
const bytes = await readFile(legacyTokenFile);
let token;
token = a.isEncryptionAvailable()
  ? a.decryptString(Buffer.from(bytes))    // try as encrypted
  : bytes.toString("utf8");                 // else assume plain
if (!token) return;                         // give up
// migrate to per-account file
await saveAccountToken(name, token);
await unlink(legacyTokenFile);
```

So old tokens (from a previous reference app version with different
storage) can be migrated. The new storage is also conditional
on `isEncryptionAvailable()` — no upgrade in security from the
migration, just file layout.

## What Maka has today

Maka uses `safeStorage` in some paths (the `claude-subscription`
PR uses it for the OAuth tokens). But:
- The `provider.apiKey` column is plaintext, same as reference app.
- No base64-wrapper utility for transit contexts.
- No `isEncryptionAvailable()` check on read paths I've seen
  (round-5 to confirm).

## Ranked Maka improvements

1. **DO NOT advertise "stored encrypted" without checking the
   actual code path.** The api-spec's claim that didn't match
   reality is a slippery slope. Better: "stored in your user
   data directory, protected by OS file permissions. OAuth
   tokens are additionally encrypted via Electron safeStorage
   where available."

2. **Add a file marker to distinguish encrypted vs plain
   on-disk artifacts.** Even a single byte prefix (`0x01` =
   encrypted, `0x00` = plain) makes migrations and audits
   tractable. Without this, a user can't tell what state their
   stored data is in.

3. **Adopt the base64 wrapper pattern (`pf`/`mf`) for DB
   storage of sensitive blobs.** The "same shape regardless of
   encryption state" invariant simplifies caller code.

4. **Symmetric `isEncryptionAvailable()` check at save + load.**
   Without both, partial-encryption corruption is possible.

5. **Don't encrypt the `provider.apiKey` column.** This is a
   counter-recommendation — user-pasted API keys don't benefit
   from safeStorage if the user can just re-paste. Spend the
   complexity budget on OAuth tokens.

## Open questions for future rounds

- Is there a scrub layer on `GET /api/providers` that I missed?
  Worth a targeted grep for the actual handler.
- The api-spec also claims "API will not expose decrypted keys
  in responses" — does the renderer-side request also receive
  plaintext apiKey, or does the renderer use a different IPC
  channel that scrubs?
- The `requirePassword` and `sessionTimeout` settings hint at
  an in-app password lock. Is that wired up, or aspirational?
  Round-5 candidate.
- Linux `libsecret` fallback: when it's missing, does reference app show
  a one-time setup hint, or silently degrade? UX matters.

## Cross-refs

- Round 1: (not yet split into a single note) — initial
  mention of `safeStorage` as the encryption primitive.
- Round 2: [`05-bash-tool-family.md`](../reference app-deep-dive-yuejing-round-2/05-bash-tool-family.md)
  — Bash tool can read `~/.config/reference app/reference app.db` directly,
  bypassing any API-level scrub. The localhost-trust + agent-
  can-shell-out combo means "scrub via API" doesn't add
  meaningful protection.
- Round 3: [`02-output-safety-modes.md`](../reference app-deep-dive-yuejing-round-3/02-output-safety-modes.md)
  — output safety modes can compact API responses but don't
  scrub specific fields. If apiKey appears in a tool result,
  it'll reach the model.
- Round 4: [`01-rest-api-operator-agent.md`](../reference app-deep-dive-yuejing-round-4/01-rest-api-operator-agent.md)
  — the api-spec was written here. The "encrypted" claim
  should be loosened to "OAuth tokens encrypted; api_keys
  plaintext in user-protected DB."
- Round 5: [`01-acp-bridge.md`](./01-acp-bridge.md) —
  acpApiProviderId references a Provider; same apiKey
  storage model.
