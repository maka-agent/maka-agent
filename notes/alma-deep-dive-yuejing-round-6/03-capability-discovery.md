# 03 — Alma model capability discovery: 4-tier resolution

> Source-grounded against `~/Downloads/alma-re/readable/main.js`.
> Round-5 [`07-provider-abstraction.md`](../alma-deep-dive-yuejing-round-5/07-provider-abstraction.md)
> showed providers are unified behind a single factory. This note
> covers HOW alma knows which models support vision, function
> calling, image output, reasoning, etc. — a 4-tier cascade
> through pattern match, in-memory cache, DB cache, and a
> public capabilities API.

## The 5 capabilities

The `capabilities` shape (from round-4 api-spec):

```typescript
capabilities?: {
  vision?: boolean;
  imageOutput?: boolean;
  functionCalling?: boolean;
  functionCallingViaXml?: boolean;
  jsonMode?: boolean;
  streaming?: boolean;
  reasoning?: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
}
```

Why does alma care? Each capability gates behavior:
- `vision` → user can attach images
- `imageOutput` → model returns images (route to artifact pane)
- `functionCalling` → tools available in this turn
- `streaming` → render text progressively vs all-at-once
- `reasoning` → emit reasoning blocks to the UI
- `contextWindow` → autoCompact (round-4 02) threshold math

So capability resolution runs HOT — every send → response flow
calls it.

## The default

`main.js:13355`:

```js
const Oc = { streaming: true };
```

If nothing is known about a model, alma assumes it streams.
That's the safe default — letting non-streaming models fall
through to streaming code paths would just buffer the response.

## Tier 1 — Regex override patterns

`main.js:13359-13396`:

```js
const Mc = [
  {pattern: /nano-banana/i, capabilities: {reasoning, imageOutput, streaming, functionCalling: false}},
  {pattern: /gemini-.*image/i, capabilities: {vision, imageOutput, reasoning, streaming, functionCalling: false}},
  {pattern: /grok.*imag(e|ine)/i, capabilities: {imageOutput, streaming: false, functionCalling: false}},
  {pattern: /^(?:chatgpt-image|gpt-image)/i, capabilities: {vision, imageOutput, streaming: false, functionCalling: false}},
  {pattern: /^model-router$/i, capabilities: {vision, functionCalling, streaming}},
];
```

5 hardcoded special cases — mostly **image-generation models**
that need explicit `functionCalling: false` to keep tool calls
out of the request. Without these overrides, alma would pass
the tool registry to nano-banana and get a 400 error.

Three patterns to notice:
- **Image-output models** typically have `streaming: false` and
  `functionCalling: false`. They produce a single image, not a
  stream of tokens; they can't call tools mid-generation.
- **Special routers** (`model-router`): assumed to be a
  general-purpose chat model.
- **Permissive regexes** (`/nano-banana/i`, `/gemini-.*image/i`)
  — match across provider/model id formats.

## Tier 2 — In-memory cache `Sc`

`main.js:13289`:

```js
Sc = { data: <modelId → capabilities>, fetchedAt: <epoch> };
```

After successful fetch, capabilities live in memory keyed both
by:
- bare `modelId` (`gpt-4o`)
- provider-qualified `providerId:modelId` (`openai:gpt-4o`)

Both keys insert SAME capabilities object. Cross-provider name
collisions (e.g., a custom "gpt-4o" alias) are then explicitly
disambiguated via the qualified key.

`fetchedAt` is a 10-minute TTL (`6e5` ms at `main.js:13340`):

```js
if (Sc && (Date.now() - Sc.fetchedAt) < 6e5) return;  // cache hit
```

In-process single-flight via `Ac` promise (`main.js:13340-13347`)
— if a refresh is already running, await it instead of starting
a parallel fetch. Classic stale-while-revalidate when stale
data is available: return the stale, refresh in background.

## Tier 3 — DB cache

`main.js:13313-13338` is the warmup path. On `xc()` first call:

```js
if (!loadedFromDB) {
  const rows = To.getAllModelCapabilitiesCache();
  if (rows.length > 0) {
    const data = {};
    let oldestTime = Date.now();
    for (const row of rows) {
      data[row.id] = row.capabilities;
      const t = new Date(row.fetchedAt).getTime();
      if (t < oldestTime) oldestTime = t;
    }
    Sc = { data, fetchedAt: oldestTime };  // use OLDEST timestamp
  }
}
```

DB cache populated by previous successful fetches via
`bulkSetModelCapabilitiesCache` (`main.js:13291`). Survives app
restarts so capability data isn't relost on each launch.

Notable: `fetchedAt` is the **OLDEST** entry's timestamp.
Logic: if the oldest entry is 11 minutes old, the whole cache
counts as stale (because anything could have updated upstream).
Conservative.

## Tier 4 — Public API: `models.dev/api.json`

`main.js:13270`:

```js
await fetch("https://models.dev/api.json", {signal: abortSignal});
```

`models.dev` is a community-curated public capabilities catalog.
Lists most major providers + models + capabilities. Free, no
auth. Alma fetches once per 10 minutes when cache stale.

The response shape:
```json
{
  "openai": {
    "id": "openai",
    "models": {
      "gpt-4o": {
        "id": "gpt-4o",
        "input_modalities": ["text", "image"],
        "tool_call": true,
        ...
      }
    }
  }
}
```

Alma transforms via `_c(t)` (a normalizer) into its own
capabilities shape, populates both `<modelId>` and
`<providerId>:<modelId>` keys, persists to DB.

## Resolution function `Dc(modelId, providerId)`

`main.js:13402-13438`:

```js
async function Dc(modelId, providerId) {
  if (!modelId || typeof modelId !== "string") return Oc;       // fallback default

  // Tier 1: regex override patterns
  for (const {pattern, capabilities} of Mc) {
    if (pattern.test(modelId)) return Pc(modelId, capabilities); // apply per-model overrides too
  }

  await xc();  // ensure cache loaded

  // Tier 2/3: cache lookup (modelId or providerId:modelId)
  const cached = lookupCache(modelId, providerId);
  if (cached) return Pc(modelId, cached);

  // Tier 4 fallback: longest-substring match
  const matched = longestKnownSubstring(modelId);
  if (matched) {
    const cap = Sc?.data[matched];
    if (cap) return Pc(modelId, cap);
  }

  // Default
  return Pc(modelId, Oc);
}
```

The longest-substring fallback (`main.js:13423-13433`) is
clever: if `gpt-4o-2024-08-06` isn't directly known but
`gpt-4o` is, use `gpt-4o`'s capabilities. The 4-letter snippet
that matches the longest known key wins.

Useful because providers often release dated variants of a
model without updating models.dev immediately. The dated
variant inherits its base model's capabilities.

## Pc(modelId, capabilities) override layer

`main.js:13397-13401`:

```js
const Rc = [
  {pattern: /^chatgpt-4o-latest$/i, overrides: {functionCalling: false}},
];

function Pc(modelId, capabilities) {
  for (const {pattern, overrides} of Rc) {
    if (pattern.test(modelId)) return {...capabilities, ...overrides};
  }
  return capabilities;
}
```

ANOTHER regex pass that applies OVERRIDES on top of whatever
the cache or pattern-match returned. The single entry
`/^chatgpt-4o-latest$/i` forces `functionCalling: false` —
suggesting OpenAI's `chatgpt-4o-latest` variant doesn't support
function calling reliably even though `gpt-4o` does. Alma
overrides post-hoc.

Two-layer override pattern: `Mc` is "model has these
capabilities", `Rc` is "model has these EXCEPTIONS."

## Manual refresh: `POST /api/providers/:id/models/fetch`

`main.js:53086`:

```js
this.app.post("/api/providers/:id/models/fetch",
  this.fetchProviderModels.bind(this));
```

User can force a refresh via Settings UI or operator agent
curl (round-4 01). The handler at `main.js:15230-15233+` runs
the provider's `fetchModels()` function (if defined) — which
hits the provider's own API endpoint listing available models.
Falls back to per-provider hardcoded model lists if API doesn't
support discovery.

This is distinct from the models.dev capability fetch — manual
refresh discovers WHAT MODELS the provider offers; the
capability cache decides WHAT EACH MODEL CAN DO.

## DB schema

`main.js:589`:

```typescript
capabilities: text("capabilities", {mode: "json"}).$type().notNull(),
fetchedAt: text(...),
```

Stored as JSON in the providers + models tables. The
capabilities column survives schema migrations because the
shape evolves (alma added `functionCallingViaXml` and
`reasoning` in later versions).

## What Maka has today

Maka has rudimentary capability data baked into provider
factories. The dynamic discovery + models.dev integration isn't
present.

## Ranked Maka improvements

1. **Pattern-match overrides for image models.** Even before
   adopting full capability discovery, hardcoding
   `functionCalling: false` for image-output models (nano-
   banana, gemini-image, gpt-image, grok-image) prevents tool
   passing errors. ~10 lines.

2. **Longest-substring fallback for unknown dated variants.**
   When `gpt-4o-2024-08-06` shows up, fall back to `gpt-4o`'s
   capabilities. Generalizes across model families.

3. **Two-layer regex (pattern → overrides) for post-hoc
   fixes.** When a model variant has a known bug, the override
   pattern (`Rc`-equivalent) is the patch surface. Don't bake
   fixes into the main cache.

4. **DB + in-memory dual cache with stale-while-revalidate.**
   The 10-minute TTL + DB persistence + in-process single-flight
   pattern is the right shape for ANY expensive lookup. Memory
   for hot path, DB for restart, periodic refresh for
   freshness.

5. **`models.dev` integration as a dependency.** Free public
   catalog. Maka doesn't have to maintain its own per-model
   capabilities table. Cost: one HTTP fetch per 10 min, and
   trusting community-curated data.

## Open questions for future rounds

- The `models.dev` schema `_c(t)` normalizer isn't traced.
  What fields does models.dev expose vs alma's internal shape?
- When a provider's `fetchModels()` returns models NOT in the
  capability cache, what happens? Default `Oc = {streaming:
  true}` is permissive but doesn't include `contextWindow` —
  autoCompact would use a fallback constant.
- The `chatgpt-4o-latest` `functionCalling: false` override
  feels like a specific bug fix. Is there a CHANGELOG of
  override additions? Without one, knowing WHY an override
  exists is hard.

## Cross-refs

- Round 4: [`02-auto-compact.md`](../alma-deep-dive-yuejing-round-4/02-auto-compact.md)
  — capability resolution feeds `contextWindow` to the
  threshold calculator.
- Round 4: [`01-rest-api-operator-agent.md`](../alma-deep-dive-yuejing-round-4/01-rest-api-operator-agent.md)
  — `POST /api/providers/:id/models/fetch` is in the operator
  agent's tool surface.
- Round 5: [`07-provider-abstraction.md`](../alma-deep-dive-yuejing-round-5/07-provider-abstraction.md)
  — the `hd()` factory uses capabilities to decide whether to
  request streaming, pass tools, etc.
- Round 6: [`01-title-generation.md`](./01-title-generation.md)
  — uses the same tool model resolution that depends on
  capability data for context window math.
