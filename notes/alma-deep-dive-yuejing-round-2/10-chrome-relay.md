# 10 — Alma ChromeRelay: bridge to the user's real Chrome browser

> Source-grounded against `~/Downloads/alma-re/readable/main.js`.
> Round 2. Cross-refs round-2 [`06-tool-routing.md`](./06-tool-routing.md)
> for how the pre-loop selector decides ChromeRelay vs built-in
> Browser tools.

## Why ChromeRelay exists

Built-in browser tools (BrowserOpen / BrowserClick / etc.) run in
an isolated browser context — no user cookies, no logged-in
sessions. Useful for "render a page I haven't authenticated to."

ChromeRelay is the OPPOSITE: it connects to the user's actual
running Chrome and operates on the user's real tabs with real
cookies and real logins. This is the only way to support
"draft a Jira ticket" or "send a Slack message" without re-asking
the user to log in.

The pre-loop selector (round-2 06) is explicitly taught about this
trade-off: when ChromeRelay is connected, it MUST be preferred for
any interactive web task. When disconnected, fall back to built-in
Browser tools.

## Tool family

`main.js:17868-17869`, `28619-28762`, `28982`:

| Tool | One-line | Source |
|---|---|---|
| `ChromeRelayListTabs` | Enumerate open Chrome tabs (title, url, id) | `main.js:28982` |
| `ChromeRelayNavigate` | Navigate a tab to a URL; creates a new tab if `tabId` omitted | `main.js:28619` |
| `ChromeRelayClick` | Click an element by CSS selector | `main.js:28637` |
| `ChromeRelayType` | Type into a form input | (paired with Click) |
| `ChromeRelayScreenshot` | Visual screenshot of a tab (resized preview + full saved to disk) | `main.js:28679` |
| `ChromeRelayRead` | **PREFERRED** for reading content — Mozilla Readability extraction → markdown | `main.js:28745` |
| `ChromeRelayReadDom` | List interactive DOM elements with CSS selector hints | `main.js:28762` |
| `ChromeRelayEval` | Execute arbitrary JS in the tab's page context | `main.js:17868` |
| `ChromeRelayScroll` | Scroll a tab by direction + amount | (in the same family) |
| `ChromeRelayBack` / `ChromeRelayForward` / `ChromeRelayUpload` | History + file upload | (in the same family) |

Two design choices to highlight:
- **`ChromeRelayRead` is preferred over `Screenshot`** for reading
  content (`main.js:28745`). This matters for token efficiency: a
  screenshot is multiple kilobytes of base64; clean markdown is
  often <500 tokens.
- **`ChromeRelayReadDom`** returns interactive elements only — not
  the whole DOM. The model gets a curated list with CSS selectors
  it can immediately use in `ChromeRelayClick`.

## Auth surface

`main.js:28466-28474` shows the auth wiring:

```js
…
t.chromeRelayAuthToken && (Ty = t.chromeRelayAuthToken);
…
n.chromeRelayAuthToken = e;
To.saveSettings(JSON.stringify(n));
```

`chromeRelayAuthToken` is persisted in alma settings. The Chrome
extension reads it on first connect and uses it to mutually
authenticate. Without the token, the relay refuses to bind.

This is the missing piece for "secure bridge to my browser" — the
token lets alma trust that the connecting extension is the user's
authorized one, not some malicious page.

## Fallback hierarchy

`main.js:28339`:

```js
"[ChromeRelay] AX tree failed, falling back to JS extraction:",
```

ChromeRelay first asks Chrome's Accessibility tree (the same
structured representation Apple's VoiceOver consumes). If that
fails (e.g., a heavily-JS-rendered SPA before mount), it falls
back to JS DOM querying. Pattern: prefer accessible tree, degrade
to DOM.

## What Maka has today

Zero. No Chrome bridge, no extension, no auth token, no tools.

## Ranked Maka improvements

1. **Skip until MCP lands.** ChromeRelay is the highest-leverage
   web automation pattern, but building it requires shipping AND
   installing a Chrome extension — an order of magnitude harder
   than any other note 06–08 item. MCP servers (e.g.,
   `@modelcontextprotocol/server-playwright`) get you 80% of the
   capability via stdio with no extension shipping needed.

2. **If shipping ChromeRelay later, prioritize `Read` over
   `Screenshot`.** Token efficiency matters. The Mozilla
   Readability extractor is a small dependency (`@mozilla/readability`
   npm). Markdown output is what models work best with.

3. **Adopt the AX tree → DOM fallback pattern.** Even for the
   future built-in Browser tools or for any "read a page" feature,
   the AX tree is cleaner than scraping. Cross-ref note 01
   Computer Use's compact AX tree format which is the same idea
   applied to native macOS apps.

4. **Mutual auth via persisted token.** When Maka gets ANY
   external companion app — browser extension, mobile companion,
   anything — the alma pattern of `<service>AuthToken` in settings
   + token check at every transport handshake is the right
   baseline.

## Open question

Does the ChromeRelay protocol go over WebSocket, native messaging,
or a local HTTP server? The auth token persistence tells us it's a
shared secret but doesn't tell us the transport. Worth tracing —
the choice constrains what the Chrome extension can do.

## Cross-refs

- Round 1: [`02-tools.md`](../alma-deep-dive-yuejing-2026-05-31/02-tools.md)
  for the tool registry shape that holds ChromeRelay alongside
  built-in Browser tools.
- Round 2: [`06-tool-routing.md`](./06-tool-routing.md) — the
  pre-loop selector's ChromeRelay vs Browser switching logic.
- Round 2: [`01-computer-use.md`](./01-computer-use.md) — the
  compact AX tree format is the same idea ChromeRelay applies to
  Chrome.
