# 06 — Reference app telemetry: Sentry error reporting + WS broadcasts (clarifying the `Gt()` confusion)

> Source-grounded against `~/Downloads/reference-source/readable/main.js`.
> Round-4 [`02-auto-compact.md`](../reference app-deep-dive-yuejing-round-4/02-auto-compact.md)
> mentioned `Gt("context_compaction_started", …)` events as if
> Gt were a telemetry function. This note corrects that
> misreading AND traces the actual telemetry surface: Sentry
> error reporting at startup, with credential-redacting
> `beforeSend` and dev escape hatch.

## The two systems

Reference app has **two distinct event systems** that look superficially
similar:

| System | Purpose | Where it goes | Used for |
|---|---|---|---|
| **WebSocket broadcasts** (round-4 07) | In-app multi-client state sync | local WS clients (renderer windows) | live UI updates |
| **Sentry telemetry** | Error / crash / performance reporting | sentry.io ingest | post-hoc debugging by reference app team |

The `Gt("context_compaction_started", …)` calls I cited in
round-4 02 are **WebSocket broadcasts**, NOT Sentry events. The
`Gt` name was a local function alias.

## The `Gt` correction

`main.js:62893`:

```js
const Gt = this.broadcastThreadSync.bind(this),
```

So inside the chat-generation function, `Gt` is a local
shorthand for `broadcastThreadSync` — i.e., a `/ws/threads`
broadcast (round-4 07). The renamed alias is purely for
keystroke economy in the hot function.

When I wrote in round-4 02 "Gt() event broadcaster," I should
have said "broadcastThreadSync, aliased locally as Gt." The
behavioral observation about telemetry was wrong — these events
never leave the user's machine.

## Sentry init

`main.js:209` imports `@sentry/electron/main`. `main.js:71572-
71583` is the init:

```js
yn.init({
  dsn: "https://d6d12e1b5a6744f646725d7539440852@o441417.ingest.us.sentry.io/4510488586485760",
  release: `reference app@${app.getVersion()}`,
  environment: app.isPackaged ? "production" : "development",
  tracesSampleRate: 0.1,
  enabled: app.isPackaged || process.env.SENTRY_DEBUG === "true",
  beforeSend: (event) => {
    if (event.request?.headers) {
      delete event.request.headers.Authorization;
      delete event.request.headers["X-Api-Key"];
    }
    return event;
  },
});
console.log("Sentry initialized for main process");
```

5 details, each load-bearing:

### 1. DSN identifies the reference app project

`o441417` is the Sentry organization id; `4510488586485760` is
the project id. Errors go to reference app's own dashboard. If Maka
adopts Sentry, **regenerate the DSN** — otherwise Maka errors
land in reference app's bucket.

### 2. `release` ties errors to app version

`reference app@${app.getVersion()}` — Sentry can group errors by
release. When a v2.1.4 release ships a regression, the spike
in errors shows up clustered by version.

### 3. Environment split

`isPackaged ? "production" : "development"` — distinguishes
errors from real users (packaged app) vs developer dev-loop
(npm run dev). Sentry's UI filters by env so dev noise doesn't
pollute prod dashboards.

### 4. Sampling rate

`tracesSampleRate: 0.1` — 10% of performance transactions are
sent. Errors are always sent; transactions (perf traces) are
sampled. The 10% rate keeps Sentry quota usage modest while
still surfacing perf regressions in aggregate.

### 5. `enabled` flag — dev escape hatch

```js
enabled: app.isPackaged || process.env.SENTRY_DEBUG === "true"
```

In a dev `npm run dev` session, Sentry is OFF by default. Set
`SENTRY_DEBUG=true` to enable in dev — for testing the error
pipeline itself. The default prevents:
- Developer experimentation throwing fake errors at the prod
  dashboard.
- Network calls to Sentry slowing dev cycles.
- Privacy leakage of dev-machine state.

## The `beforeSend` credential redaction

The most important security move in the file:

```js
beforeSend: (event) => {
  if (event.request?.headers) {
    delete event.request.headers.Authorization;
    delete event.request.headers["X-Api-Key"];
  }
  return event;
}
```

When an error occurs inside an HTTP call that Sentry
auto-instruments, the breadcrumb / error event includes the
REQUEST. By default, that includes ALL headers — including
`Authorization: Bearer sk-…` for OpenAI, or `X-Api-Key: …` for
Anthropic-style flows.

Without `beforeSend`: **user API keys silently leak to sentry.io
on every error.** Catastrophic.

The redaction is two specific headers. Notable misses:
- `Cookie` (would matter for OAuth-cookie-based flows)
- `Proxy-Authorization` (would matter for proxied flows with auth)
- Body fields (e.g., a request body with `{apiKey: "..."}` would
  not be redacted)
- URL query params (`?api_key=...`)

So the redaction is "good enough for the common case" but not
exhaustive. Worth being aware of when grading the "stored
encrypted, not exposed" trust model from round-5
[`04-safestorage-encryption.md`](./04-safestorage-encryption.md).

## What's automatically captured

`@sentry/electron/main` auto-instruments:
- Unhandled exceptions (uncaughtException, unhandledRejection)
- Native crashes (via Electron's crashReporter integration)
- HTTP requests (with `beforeSend` filter)
- Console logs at error level (configurable)

Manual calls (`yn.captureException`, `yn.captureMessage`,
`yn.addBreadcrumb`) are NOT widely used in main.js. The
strategy is: instrument the harness once, let it auto-capture.

## Performance traces (`tracesSampleRate: 0.1`)

When a transaction begins (e.g., user sends a message →
streamText starts), Sentry can record:
- Duration
- Child spans (sub-operations)
- Tags + breadcrumbs

10% sampling means 9/10 user turns produce no perf trace.
Aggregate enough to spot trends, light enough to not blow
quota.

## What Maka has today

Maka has NO Sentry integration. Errors go to the local
electron-log file. The trade-off:
- **Pro**: zero data exfiltration. Maka's privacy story is
  cleaner.
- **Con**: no aggregate visibility into real-user errors. The
  Maka team learns about bugs only when users report them.

## Ranked Maka improvements

1. **Adopt the `beforeSend` credential-redaction pattern IF
   Maka adds error telemetry.** Without it, a single
   unhandled exception in an HTTP call ships user API keys to
   the telemetry service. Even a privacy-first Maka should
   plan this BEFORE adding any third-party telemetry.

2. **Dev escape hatch via env var.** `SENTRY_DEBUG=true` is
   the right pattern: off-by-default in dev, enable on
   demand for pipeline testing. Avoid the "telemetry always
   on, even in dev" trap.

3. **Separate WS broadcast vocabulary from telemetry
   vocabulary.** Reference app's `Gt()` local alias caused me to
   misread the system. Maka should NOT alias telemetry
   functions inside hot loops — clarity matters more than
   keystrokes.

4. **`release` tag with `${app.getVersion()}`.** If Maka adds
   any error reporting, tagging by app version is the
   cheapest way to detect regression spikes after a release.

5. **Extend redaction beyond headers.** `Cookie`,
   `Proxy-Authorization`, request body fields named
   `apiKey`/`api_key`/`token`, URL query strings — all should
   be in the redaction list. The reference app redaction is a 5-minute
   patch but worth doing right the first time.

## Open questions for future rounds

- Is there a renderer-side Sentry too? `@sentry/electron`
  ships both `main` and `renderer` packages. Round-5 candidate
  to grep the renderer bundle.
- Does the `beforeSend` filter trigger before HTTP error
  events from MCP servers (which can also have auth headers)?
  Or only main-process HTTP calls?
- What's the user-visible toggle for telemetry? Many users
  want to opt out; the api-spec doesn't mention a
  `security.enableTelemetry` flag. Round-5 candidate.
- `tracesSampleRate: 0.1` is a 10:1 sampling. For perf
  regressions visible in 1% of users (e.g., specific GPU /
  OS combo), is 10% enough? Sentry's documentation suggests
  100% for low-traffic apps.

## Cross-refs

- Round 4: [`02-auto-compact.md`](../reference app-deep-dive-yuejing-round-4/02-auto-compact.md)
  — the `Gt("context_compaction_started", …)` I called
  "telemetry" is actually WebSocket broadcast. This note
  corrects the framing.
- Round 4: [`07-websocket-sync.md`](../reference app-deep-dive-yuejing-round-4/07-websocket-sync.md)
  — the actual broadcast helper `broadcastThreadSync`
  (aliased as `Gt`) is documented there.
- Round 5: [`04-safestorage-encryption.md`](./04-safestorage-encryption.md)
  — credential redaction in error events is the FOURTH place
  user API keys could leak (DB plaintext + provider response
  + WS broadcast + Sentry); plain bare-naked DB is the only
  one reference app doesn't redact.
