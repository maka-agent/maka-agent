# 07 — Alma provider abstraction: 16 types behind one factory

> Source-grounded against `~/Downloads/alma-re/readable/main.js`.
> Round-4 [`01-rest-api-operator-agent.md`](../alma-deep-dive-yuejing-round-4/01-rest-api-operator-agent.md)
> documented the 15 provider types from the api-spec. Round-5
> [`01-acp-bridge.md`](./01-acp-bridge.md) covered the ACP family.
> This note covers the remaining 14 types end-to-end: how a
> single factory `hd()` dispatches each type into the AI SDK
> provider abstraction, what shapes the per-type quirk handlers
> take, and which patterns are clusters of "all alike" vs
> truly unique.

## The factory: `hd(provider, modelId)`

`main.js:16423-16599`. A single async function that returns an
AI SDK `LanguageModelV1` regardless of provider type. Cross-cuts
EVERY agent loop in alma — autoCompact summary model (round-4
02), memory query rewriting (round-4 03), title generation, the
chat itself.

Universal pattern:
1. Switch on `provider.type` (string discriminator).
2. Call the relevant AI SDK factory (`createOpenAI`,
   `createAnthropic`, `createGoogleGenerativeAI`,
   `createOpenAICompatible`, etc.).
3. Pass `apiKey`, `baseURL`, and `fetch: dd` (the universal
   fetch wrapper).
4. Invoke the returned provider with `modelId`.

That last step is the unification: every AI SDK provider's
final shape is `provider(modelId) → LanguageModelV1`.

## Universal fetch hook (`dd`)

`main.js:16421` — `dd = Tr(er)`. This is the **proxy-aware
fetch**. Every provider's outgoing HTTPS call goes through
`dd`, which means:
- Proxy settings (round-4 01 api-spec) apply to ALL providers,
  not per-provider.
- User-Agent + retry settings (`network.retryAttempts`) apply
  uniformly.
- Sentry HTTP instrumentation (round-5 06) wraps everything.

Without a universal hook, alma would have to thread proxy
config through every provider's SDK individually. With it, the
provider factories don't even know proxies exist.

## Cluster 1 — OpenAI direct (`createOpenAI` family)

```js
case "openai":
  return it({apiKey, baseURL, fetch: dd})(modelId);
case "anthropic":
  return at({apiKey, baseURL, fetch: dd})(modelId);
case "google":
  return ct({apiKey, baseURL, fetch: dd})(modelId);
case "openrouter":
  return Tt({apiKey, baseURL, fetch: dd})(modelId);
case "deepseek":
  return Et({apiKey, baseURL, fetch: dd})(modelId);
```

Five identical-shape providers (`main.js:16425-16444`). Each has
a dedicated `@ai-sdk/<vendor>` package. `baseURL || undefined`
falls through to the SDK's default endpoint.

Notable: `deepseek` and `openrouter` get their own packages
(`@ai-sdk/deepseek`, `@ai-sdk/openrouter`) rather than going
through the openai-compatible adapter. They have ENOUGH quirks
that vendor-specific SDKs are cleaner.

## Cluster 2 — OpenAI-compatible (`createOpenAICompatible`)

```js
case "moonshot":   baseURL fallback "https://api.moonshot.cn/v1"
case "zai-coding-plan":  baseURL fallback "https://api.z.ai/api/coding/paas/v4"
case "ollama":     baseURL fallback "http://localhost:11434/v1", apiKey || "ollama"
case "volcengine": baseURL fallback "https://ark.cn-beijing.volces.com/api/v3"
case "custom":     baseURL required, custom headers JSON
```

Five providers using `createOpenAICompatible` (`@ai-sdk/openai-
compatible`). They all expose the OpenAI Chat Completions
shape but live at different URLs. The only per-type
customization is the URL default and `name` field for debug
logging.

`ollama` has the special `apiKey || "ollama"` — local Ollama
doesn't require auth, but the SDK demands a non-empty key. The
literal string "ollama" is the convention.

`custom` is the user-defined escape hatch. Two extras:
- `customHeaders` JSON for things like `X-Vendor: foo`.
- `useMaxCompletionTokens` — wraps fetch to rename `max_tokens`
  → `max_completion_tokens` (some OpenAI-compatible vendors
  follow the newer key name).

## Cluster 3 — Anthropic-compatible

```js
case "kimi-coding-plan":  Anthropic SDK + extra anthropic-beta header
case "claude-subscription":  Anthropic SDK + cloak fetch wrapper (round-2 09)
```

`kimi-coding-plan` (`main.js:16535-16545`) wraps Anthropic SDK
with Kimi's URL + an `anthropic-beta` header for interleaved
thinking + fine-grained tool streaming. Kimi has implemented
Anthropic's protocol, so alma reuses Anthropic SDK.

`claude-subscription` (`main.js:16493-16525`) is the most
elaborate — empty apiKey + custom fetch that:
1. Calls `ld.getAccessToken()` for OAuth Bearer (round-2 09's
   cloak path).
2. Parses request body to build cloaked headers + body
   (`buildCloakedRequest`).
3. Stamps Bearer auth, deletes any `x-api-key`.

The wrap-and-inject pattern is the same as ACP (round-5 01):
**intercept the SDK's outgoing call to inject auth/cloak that
the SDK doesn't know about.**

## Unique implementations

### `azure` (`main.js:16452-16469`)

```js
case "azure": {
  if (!baseURL) throw new Error("Base URL ... required");
  const resourceName = baseURL
    .replace(/^https?:\/\//, "")
    .replace(/\.openai\.azure\.com.*$/, "");
  const provider = kt({
    resourceName, apiKey,
    apiVersion: isResponseAPI ? undefined : (apiVersion || "2024-08-01-preview"),
    useDeploymentBasedUrls: !isResponseAPI,
    fetch: dd,
  });
  return isResponseAPI ? provider.responses(modelId) : provider.chat(modelId);
}
```

Azure OpenAI has its own SDK (`@ai-sdk/azure`) because the URL
structure is different (`<resource>.openai.azure.com/<deployment>`)
and it requires `apiVersion`. Alma extracts the resource name
from the URL by stripping protocol + domain suffix.

`isResponseAPI` flag triggers the newer Responses API
(`provider.responses(modelId)`) vs the classic Chat Completions
(`provider.chat(modelId)`). Same provider object, two endpoints.

### `aihubmix` (`main.js:16445-16451`)

```js
case "aihubmix": {
  const fetchWithCode = (url, init) => {
    const headers = new Headers(init?.headers);
    headers.set("APP-Code", "OJQA1051");
    return dd(url, {...init, headers});
  };
  return vt({apiKey, fetch: fetchWithCode})(modelId);
}
```

Aihubmix is an aggregator that requires an APP-Code header for
revenue-share tracking. The literal `"OJQA1051"` is **alma's
own APP-Code** — meaning aihubmix attributes alma users to alma
for whatever business reason. Maka adopters need their own
APP-Code if they use aihubmix.

### `copilot` (`main.js:16470-16486`)

```js
case "copilot": {
  const accountId = copilotAccountId ?? undefined;
  const cacheKey = `${id}:${accountId || ""}:${baseURL || ""}`;
  let provider = ud.get(cacheKey);
  if (!provider) {
    provider = it({
      name: "github-copilot",
      apiKey: "copilot-dynamic",
      baseURL: baseURL || "https://api.githubcopilot.com",
      headers: Jl,
      fetch: Zl(dd, accountId),  // wraps dd with account-aware auth
    });
    ud.set(cacheKey, provider);
  }
  return (await Ql.isModelUsingResponses(modelId))
    ? provider.responses(modelId)
    : provider.chat(modelId);
}
```

Copilot is the ONLY provider with CACHING. Why?
- It uses **dynamic auth** via `Zl(dd, accountId)`: the fetch
  wrapper looks up the current OAuth token at call time.
- Recreating the SDK instance per call would reinitialize
  internal state (request signing, retry counters, etc.).
- Cache key `(id, accountId, baseURL)` ensures different
  copilot accounts get separate provider instances.

`apiKey: "copilot-dynamic"` is a sentinel — the actual auth is
in the fetch wrapper, not the apiKey field. The SDK requires a
non-empty key.

The Responses-API decision is per-model (`Ql.isModelUsingResponses(
modelId)`) instead of per-provider (Azure's static flag).
Different copilot models use different APIs.

## The 5-pattern taxonomy

| Pattern | Providers | What it tells us |
|---|---|---|
| OpenAI direct | openai, anthropic, google, openrouter, deepseek | These are first-class. Quirks belong in their SDKs. |
| OpenAI-compatible | moonshot, zai-coding-plan, ollama, volcengine, custom | "OpenAI shape at our URL." Default for new entrants. |
| Anthropic-compatible | kimi-coding-plan, claude-subscription | Anthropic's shape is becoming a second standard. |
| Azure-special | azure | Different URL structure forces dedicated SDK. |
| Aggregator-with-tag | aihubmix | Header-based revenue tracking. |
| Dynamic auth | copilot | Token rotates; cache provider, fetch fresh auth per call. |
| ACP | claude-subscription via CLI, codex, cursor, antigravity | Round-5 01. |

## Pattern decisions for Maka

When Maka adds a new provider, the question tree is:

1. **Is it OpenAI direct?** Use `createOpenAI` with the vendor SDK.
2. **Is it OpenAI-shape at a different URL?** Use
   `createOpenAICompatible` with `baseURL` and a name.
3. **Is it Anthropic-shape?** Use `createAnthropic` (or
   compatible) with possibly a `headers` override for beta
   flags.
4. **Does it require dynamic auth (OAuth, short-lived
   tokens)?** Cache the provider instance, wrap fetch with
   fresh-token-per-call logic.
5. **Does it have its own URL structure (Azure-like)?** Use
   the vendor's dedicated SDK.

This is the **decision tree alma's `hd()` implements
implicitly**. Maka can codify it explicitly.

## What Maka has today

Maka's provider abstraction in `@maka/runtime/providers/`
supports OpenAI, Anthropic, Google, DeepSeek, etc. Recent
PR-OAUTH-SUBSCRIPTION-0 added Claude subscription with the
cloak pattern (round-3 03/03 covered).

What's missing (compared to alma):
- No `dd` universal proxy-aware fetch — Maka's per-provider
  factories pass fetch separately.
- No `copilot` dynamic-auth caching pattern.
- No `aihubmix` aggregator support.
- No `useMaxCompletionTokens` rename wrapper.
- No `kimi-coding-plan` interleaved-thinking beta header.

## Ranked Maka improvements

1. **Universal proxy-aware fetch hook (`dd` equivalent).**
   This is the single biggest architectural lift. Today
   Maka's provider factories thread `fetch` separately;
   centralizing it means proxy config + retry settings +
   telemetry instrumentation apply uniformly.

2. **`createOpenAICompatible` cluster pattern.** Adding a new
   "OpenAI shape at URL X" provider becomes ~5 lines. Don't
   add custom SDKs unless the vendor genuinely diverges.

3. **`useMaxCompletionTokens` rename wrapper.** Trivial code
   (10 lines), unlocks OpenAI-compatible vendors that switched
   to the newer key. Worth keeping as part of `custom`
   provider type.

4. **Copilot-style dynamic-auth caching.** When Maka adds ANY
   provider with rotating tokens (Copilot, GitHub-style OAuth
   models), cache the SDK instance + wrap fetch. Don't
   recreate the SDK per call.

5. **`isResponseAPI` per-model flag for Azure-like vendors.**
   Even if Maka doesn't ship Azure support immediately, the
   per-model API-version detection pattern generalizes to
   "which model variant of this provider does this id refer
   to?"

## Open questions for future rounds

- `Jl` (the Copilot headers object) and `Zl` (the Copilot
  fetch wrapper) aren't traced here. Probably contain GitHub
  Copilot's specific auth dance.
- `Ql.isModelUsingResponses(modelId)` — a static lookup or
  per-call API probe? If static, where's the table?
- The `claude-subscription` cloak's `sessionKey: "alma-default"`
  string. Does Maka need to track per-session keys for the
  same anti-abuse pattern, or is one constant enough?
- New providers from the AI SDK ecosystem (e.g., Cerebras,
  Mistral) — does alma add them via `custom` or wait for
  dedicated SDKs?

## Cross-refs

- Round 2: [`09-cloak-request-full.md`](../alma-deep-dive-yuejing-round-2/09-cloak-request-full.md)
  — the cloak builder used by `claude-subscription` provider.
- Round 4: [`01-rest-api-operator-agent.md`](../alma-deep-dive-yuejing-round-4/01-rest-api-operator-agent.md)
  — the api-spec's `provider.type` enum.
- Round 5: [`01-acp-bridge.md`](./01-acp-bridge.md) — ACP is
  the 16th provider type, with its own factory not in `hd()`.
- Round 5: [`05-coder-agent-auto-detection.md`](./05-coder-agent-auto-detection.md)
  — the auto-detection dispatches into the provider factory
  for ACP and built-in paths.
- Round 5: [`06-telemetry-sentry.md`](./06-telemetry-sentry.md)
  — Sentry's HTTP instrumentation is automatic ONLY if alma's
  fetch goes through the standard hook chain; `dd` is the
  link.
