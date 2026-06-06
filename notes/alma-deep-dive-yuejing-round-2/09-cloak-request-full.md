# 09 — Alma cloaked-request: every field, every block

> Source-grounded against `~/Downloads/alma-re/readable/main.js`.
> Maka has a working port (`apps/desktop/src/main/oauth/cloaked-request.ts`)
> after PR-CLAUDE-OAUTH-XAPIKEY-STRIP-0 (`17d6f53`). This note pins
> the FULL alma shape so any latent delta is documented.

## Header set

`main.js:16077-16089` — exact headers sent on every Claude OAuth
request:

```js
{
  "user-agent": id,                                          // "claude-cli/2.1.88 (external, cli)"
  "X-Claude-Code-Session-Id": c,                              // alma session id
  "anthropic-beta": this.buildAnthropicBetaHeader(n),         // model-dependent (see below)
  "anthropic-dangerous-direct-browser-access": "true",
  "anthropic-version": "2023-06-01",
  "x-app": "cli",
  "x-client-request-id": Ot.randomUUID(),                     // per-request UUID
  "Accept": s ? "text/event-stream" : "application/json",     // depends on streaming
  ...this.getStainlessHeaders(r),                             // 8 X-Stainless-* headers
}
```

### Stainless header chain

`main.js:16021-16035`:

```js
{
  "X-Stainless-Lang": "js",
  "X-Stainless-Package-Version": "0.74.0",
  "X-Stainless-Runtime": "node",
  "X-Stainless-Runtime-Version": "v22.13.0",
  "X-Stainless-Arch":
    { arm64: "arm64", x64: "x64" }[process.arch] || "x86",
  "X-Stainless-Os":
    { darwin: "MacOS", win32: "Windows", freebsd: "FreeBSD" }[process.platform] || "Linux",
  "X-Stainless-Timeout": String(Math.max(1, Math.ceil(e / 1000))),  // seconds
  "X-Stainless-Retry-Count": "0",
}
```

Pinned values to mirror in Maka:
- `Lang`: js
- `Package-Version`: 0.74.0 (the @anthropic-ai/sdk version alma's
  cloak claims to use — NOT the actual installed version)
- `Runtime`: node
- `Runtime-Version`: v22.13.0 (also hardcoded — not `process.version`)
- `Arch`, `Os`: dynamic, mapped per the lookup tables above
- `Timeout`: in seconds (1+)
- `Retry-Count`: always "0" — alma doesn't expose its retry chain

### `anthropic-beta` selection

`main.js:16016-16020`:

```js
buildAnthropicBetaHeader(e) {
  return (e || "").toLowerCase().includes("haiku")
    ? "oauth-2025-04-20,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,context-management-2025-06-27,prompt-caching-scope-2026-01-05,claude-code-20250219"
    : "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,context-management-2025-06-27,prompt-caching-scope-2026-01-05,advanced-tool-use-2025-11-20,effort-2025-11-24";
}
```

Two variants:
- **Haiku models**: shorter set without `advanced-tool-use` / `effort`.
- **Everything else**: full set including the advanced-tool-use and
  effort betas.

Maka's `cloaked-request.ts` should mirror this branch. Verify the
strings match byte-for-byte — Anthropic's beta gateway is
position-sensitive in some cases (e.g., `claude-code-20250219`
must appear first when present for Sonnet/Opus per the alma
ordering).

## Body modifications

`main.js:16037-16089` — `buildCloakedRequest(e)`. Three rewrites
applied to every outbound request body:

### 1. Inject billing header as a system block

`main.js:15993-15999`:

```js
buildBillingHeader(e) {
  const t = this.computeFingerprint(
    this.extractFirstUserMessageText(e), rd,
  );
  return `x-anthropic-billing-header: cc_version=${rd}.${t}; cc_entrypoint=cli;`;
}
```

The "billing header" is **not** an HTTP header — it's a
text block prepended to `body.system`. Format:
`x-anthropic-billing-header: cc_version=2.1.88.{fingerprint}; cc_entrypoint=cli;`

`fingerprint` is computed from the first user message text. The
practical effect: Anthropic's gateway can correlate billing per
session by inspecting the system prompt, since the header is in a
position where the model's view of the conversation includes it.

`main.js:16050-16054`: if the messages already include a block
matching `text.includes("x-anthropic-billing-header")`, alma
strips and rebuilds rather than appending a second one.

### 2. Inject Claude Code system prefix block

`main.js:16055-16063`:

```js
{
  type: "text",
  text: "You are Claude Code, Anthropic's official CLI for Claude.",
  cache_control: { type: "ephemeral" },
}
```

This is the system prompt prefix telling the model "you are Claude
Code." `cache_control: ephemeral` lets Anthropic's prompt-caching
match across turns. Like the billing header, alma de-duplicates if
a matching block already exists (`isClaudeCodePrefixBlock`).

Final system block order: **[billing, claude-code-prefix, ...user-system-blocks]**.

### 3. Stamp identity into `body.metadata.user_id`

`main.js:16065-16075`:

```js
const g = l.metadata && "object" == typeof l.metadata ? l.metadata : {};
l.metadata = {
  ...g,
  user_id: JSON.stringify({
    device_id: i,            // alma device UUID
    account_uuid: a,         // resolved from /api/oauth/profile
    session_id: c,           // per-session alma id
  }),
};
```

`metadata.user_id` is an opaque Anthropic field that alma uses to
carry a JSON object with three identity dimensions:
- `device_id`: persistent device install id
- `account_uuid`: from the user's Anthropic profile
- `session_id`: per-chat-session id

JSON-stringified. Anthropic doesn't parse it; it's just a stable
key for their billing / rate-limit attribution.

## Auth header (added by AI SDK)

`main.js:16520-16523`:

```js
const a = { ...t?.headers, ...r, authorization: `Bearer ${o}` };
delete a["x-api-key"];
```

Notice the `delete a["x-api-key"]` — this is the line that fixed
WAWQAQ's `鉴权失败` (cross-ref PR-CLAUDE-OAUTH-XAPIKEY-STRIP-0,
`17d6f53`). Without it, AI SDK's residual `x-api-key` collides with
the `Authorization: Bearer` and Anthropic 401-rejects.

## Maka delta

Cross-checked Maka's `cloaked-request.ts` against the alma
reference. After `17d6f53` the structural shape is correct:

- All 8 Stainless headers present (verified at `cloaked-request.ts:55-62`).
- `anthropic-beta` branches on haiku (verified at the same file).
- Billing block + Claude Code prefix injected as system blocks.
- `metadata.user_id` stamped with device/account/session.
- `x-api-key` deleted in the fetch wrapper.

Two potential drifts to verify:
1. **Package version pinning.** Maka's `cloaked-request.ts:56` uses
   `'0.74.0'` — confirm this matches whatever Anthropic SDK version
   alma currently ships. The version string is also part of the
   gateway's "is this a real claude-cli client" check.
2. **Runtime version**. Maka uses `process.version` while alma
   hardcodes `'v22.13.0'`. If Anthropic's gateway has a runtime
   version allowlist, dynamic `process.version` could fail on
   newer Node releases. Worth mirroring alma's hardcode for
   conservative parity.

## Cross-refs

- Round 1: [`02-tools.md`](../alma-deep-dive-yuejing-2026-05-31/02-tools.md)
  for how tool-call results flow back through the same envelope.
- Round 2: [`03-current-maka-oauth-request-shape.md`](./03-current-maka-oauth-request-shape.md)
  for the earlier point-in-time comparison against Maka's actual
  send path.
- PR-CLAUDE-OAUTH-XAPIKEY-STRIP-0 (`17d6f53`) — fixed the missing
  `x-api-key` delete this note enumerates.
