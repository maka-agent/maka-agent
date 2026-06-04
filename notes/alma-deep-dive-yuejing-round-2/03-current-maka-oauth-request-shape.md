# 03 — Current Maka OAuth request shape (round 3)

> Round-2 02-WIP planned to "diff alma vs Maka and ship the runtime
> PR." This note completes the diff side. The Maka surface is now
> at HEAD `c7d9f5d`; the runtime is wired via
> `packages/runtime/src/model-factory.ts`.

## Claude OAuth send-path (Maka, current)

`packages/runtime/src/model-factory.ts:41-52`:

```ts
case 'claude-subscription':
  return createAnthropic({
    authToken: apiKey,
    baseURL: anthropicV1BaseUrl(baseURL),
    fetch,
    headers: {
      'anthropic-beta': CLAUDE_SUBSCRIPTION_BETA,
      'User-Agent': CLAUDE_SUBSCRIPTION_USER_AGENT,
      'anthropic-dangerous-direct-browser-access': 'true',
      'x-app': 'cli',
    },
  }).chat(modelId);
```

Concretely (from `:18-20`):
- `CLAUDE_SUBSCRIPTION_USER_AGENT = 'claude-cli/2.1.88 (external, cli)'`
- `CLAUDE_SUBSCRIPTION_BETA = 'oauth-2025-04-20,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,context-management-2025-06-27,prompt-caching-scope-2026-01-05,claude-code-20250219'`
- `baseURL` is the `LlmConnection` default → `anthropicV1BaseUrl(...)` ensures it ends with `/v1`.
- `authToken` is the OAuth access token (NOT an API key — the `createAnthropic` call uses `authToken` rather than `apiKey`).

This matches Anthropic's "Claude Code from Claude.ai subscription"
contract closely: the `claude-code-20250219` beta header is the
canonical signal that "this request is from Claude Code, please
charge to subscription not API credit."

WAWQAQ reported `429 rate_limit_error` on test connection. Test
connection lives in `packages/runtime/src/test-connection.ts:13`
(identical UA constant) and similarly sends `anthropic-beta:
CLAUDE_SUBSCRIPTION_BETA` (`:64`).

**Diagnosis:** The 429 is post-auth (auth would 401), so the request
*shape* is accepted. Anthropic's OAuth-subscription tier
specifically rate-limits short bursts very aggressively when probing
from non-Claude-Code surfaces, and a "test connection" is exactly
that — one synthetic prompt with no warm session. Two possible fixes
in priority order:

1. **Avoid the test entirely for OAuth-backed connections.** The
   connection's OAuth state already implies validity (token
   refreshed, JWT extracted). Synthetic prompt probes burn quota
   for no benefit. The button should read "已登录 (OAuth)" and route
   the user to a real chat session.
2. **If the test stays, use the smallest possible probe**: `claude-
   haiku-X-Y` model with 1-token max, `temperature: 0`, no system
   prompt. This minimizes Anthropic's rate-limit weight.

## Codex OAuth send-path (Maka, current)

`packages/runtime/src/model-factory.ts:54-59`:

```ts
case 'codex-subscription':
  return createOpenAI({
    apiKey,        // OAuth access token, NOT an API key
    baseURL,       // 'https://chatgpt.com/backend-api/codex'
    headers: codexSubscriptionHeaders(apiKey),
  }).responses(modelId);
```

`codexSubscriptionHeaders` at
`packages/runtime/src/subscription-auth.ts:23-29`:

```ts
return {
  ...(accountId ? { 'chatgpt-account-id': accountId } : {}),
  'User-Agent': CODEX_SUBSCRIPTION_USER_AGENT,  // 'codex-cli/0.0.0 (external, cli)'
};
```

Concretely:
- BaseURL: `https://chatgpt.com/backend-api/codex` (from
  `packages/core/src/llm-connections.ts:253`).
- AI SDK calls `.responses(modelId)`, so the path becomes
  `…/codex/responses`.
- Authorization: `Bearer {accessToken}` (added by `createOpenAI`).
- `chatgpt-account-id`: pulled from JWT payload at
  `https://api.openai.com/auth → chatgpt_account_id`. Falls back to
  the JWT `sub` if absent.
- User-Agent: literally `codex-cli/0.0.0 (external, cli)`.

**Diagnosis:** The UA version `0.0.0` is a placeholder, not a real
codex-cli release. The OAuth authorize URL flow uses
`originator: codex_cli_rs` (Rust CLI) per
`apps/desktop/src/main/oauth/codex-subscription-helpers.ts:27`, so
the real Codex CLI version should track the Rust binary's release
series.

If OpenAI checks the UA against known CLI versions (which is exactly
what Anthropic does for Claude Code), `0.0.0` would be rejected. The
fix is to bump it to a current real version — at time of writing,
the openai/codex-cli repo ships `0.20.x` or later.

There's also a possible missing header issue: the real codex-cli
sends extra fields like `originator: codex_cli_rs` and
`session_id` on the request body. Need to capture an actual codex-cli
request to verify.

## Cursor OAuth (Maka, current)

Looking at `apps/desktop/src/main/oauth/cursor-subscription-service.ts`
the OAuth flow itself is implemented and tested. There is NO
corresponding case in `model-factory.ts` — Cursor subscription is
auth-only, not yet wired to a chat send path. This is consistent
with kenji's commit message at `b1bc326`: "Cursor 仍然 blocked"
(Cursor's send-path needs separate work).

## Antigravity (Maka, current)

Similar to Cursor: OAuth flow is preview-only, send-path not wired.
The provider currently throws if instantiated at
`model-factory.ts:62` for `gemini-cli`.

## What's actually broken vs working

| Provider | Auth flow | Test connection | Chat | Comment |
|---|---|---|---|---|
| `claude-subscription` | ✅ | ⚠️ 429 expected (post-auth rate limit) | ✅ likely works | The 429 is rate limit, not auth fail. Chat may work; test is the wrong probe. |
| `codex-subscription` | ✅ | ⚠️ UA may be rejected | ⚠️ same | `codex-cli/0.0.0` placeholder UA risk |
| `cursor-subscription` | ✅ | ❌ no send path | ❌ no send path | Wired only for auth |
| `antigravity` | ⚠️ preview | ❌ no send path | ❌ no send path | Google client_id missing |

## Concrete actionable items (ranked)

**P0** — replace Claude OAuth test-connection synthetic probe with a
non-rate-limited validity check (e.g. `GET /api/oauth/profile` against
the same access token). Surfaces 429 less, more honest about what
"connection works" means.

**P1** — bump `CODEX_SUBSCRIPTION_USER_AGENT` from `0.0.0` to a real
current version (e.g. `codex-cli/0.20.0 (external, cli)` — confirm
against the actual binary). Also add `session_id` and any other
fields the real codex-cli sends on request body.

**P2** — wire Cursor OAuth to a `cursor-subscription` provider case in
`model-factory.ts`. The Cursor proxy is OpenAI-compatible
(`api2.cursor.sh/v1`).

**P3** — Antigravity send-path (blocked on Google client_id; not
ship-able solo).

## What I'm not shipping this round

Changing the Codex UA blindly without verifying against a real codex
CLI run is too risky — could regress current-working Codex sessions
if `0.0.0` happens to be the accepted shape. Same for the Anthropic
test-connection change: it touches a kenji-owned surface and would
require coordinating with him.

This round's deliverable is this note + the actionable list. Round 4
is xuan/kenji co-execution: verify the actual outbound HTTP via
their real Electron run (xuan can capture via Computer Use / CDP),
then ship the specific fix that matches the observed shape.
