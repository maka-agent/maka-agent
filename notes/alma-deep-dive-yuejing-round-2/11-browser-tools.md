# 11 — Alma built-in Browser tools (Electron-backed sandbox browser)

> Source-grounded against `~/Downloads/alma-re/readable/main.js`.
> Round 2's final subsystem note. Cross-refs round-2
> [`10-chrome-relay.md`](./10-chrome-relay.md) for the user-session-
> backed Chrome bridge and [`06-tool-routing.md`](./06-tool-routing.md)
> for the selector's preference logic between the two families.

## Why a sandbox browser

ChromeRelay (note 10) operates on the user's logged-in Chrome — for
authenticated workflows (Slack, Jira, GitHub). The built-in Browser
family is the opposite: it spawns a CLEAN Electron BrowserWindow
with no cookies, no extensions, no logged-in state. Use cases:
- Read a page the user hasn't logged into.
- Render a URL the user shares.
- Visit a site WITHOUT polluting the user's real browsing state.

Implementation choice: alma uses Electron's own BrowserWindow
(`main.js:27595-27613`) rather than Puppeteer or Playwright. This
keeps the app footprint small — no extra browser binary to ship —
at the cost of being a SEPARATE visible window the user can see
mid-task. Tradeoff is documented in the pre-loop selector's
example responses (note 06).

## Tool family (11 tools)

`main.js:28971-28980`:

| Tool | One-line | Source |
|---|---|---|
| `BrowserOpen` | Open the browser window + navigate to URL | (lifecycle anchor) |
| `BrowserClick` | Click an element by CSS selector; auto-scrolls into view | `main.js:27817` |
| `BrowserType` | Type into an input; optional Enter key press | `main.js:27838` |
| `BrowserScreenshot` | Save a screenshot of the current page | `main.js:17841` |
| `BrowserRead` | Read page content as markdown (Mozilla Readability) | `main.js:17866` |
| `BrowserReadDom` | Enumerate interactive DOM elements with CSS selector hints | `main.js:27957` |
| `BrowserBack` | History back | (in the same family) |
| `BrowserForward` | History forward | (in the same family) |
| `BrowserReload` | Reload | (in the same family) |
| `BrowserEval` | Execute arbitrary JS in the page context | (in the same family) |
| `BrowserClose` | Close the window | (in the same family) |

Three patterns directly mirror ChromeRelay (note 10):
- **`BrowserRead` preferred over `BrowserScreenshot`** for content
  extraction — markdown is more token-efficient.
- **`BrowserReadDom` returns interactive elements only** with CSS
  selectors the model can use in `BrowserClick`. Same JSON shape
  as ChromeRelay's equivalent at `main.js:27957`.
- **No state until `BrowserOpen`** (`main.js:27598-27601` throws
  "Browser window is not open. Use BrowserOpen first." on any call
  before opening). This is the single-instance lifecycle alma
  enforces — there's only ever one sandbox browser window.

## Navigation contract

`main.js:27603-27615`:

```js
async navigate(e) {
  const t = await this.ensureWindow();
  const n = setTimeout(() => {
    t.isDestroyed() || t.webContents.stop();
  }, 30_000);
  try {
    await t.loadURL(e);
  } finally {
    clearTimeout(n);
  }
  await Wg(t);                                          // wait for load completion
  const o = await t.webContents.executeJavaScript("document.title");
  return { url: t.webContents.getURL(), title: o };
}
```

Notable details:
- **30-second hard timeout** on `loadURL`. If a page hangs, alma
  calls `webContents.stop()` to bail out instead of letting the
  agent loop block.
- **Title read via `executeJavaScript`**, not from the BrowserWindow
  metadata. Catches updates from `document.title = "…"` happening
  in JS after initial load.
- **Returns `{ url, title }`** — the model gets canonical post-
  navigation state, useful for detecting redirects (e.g., login
  walls forcing a redirect to `/sign-in`).

## What Maka does today

Zero. No browser tool family. The renderer can show pages via the
artifacts pane's preview surface, but the agent loop has no way to
PROGRAMMATICALLY drive a browser.

## Ranked Maka improvements

1. **Adopt the Electron BrowserWindow pattern.** Maka already
   bundles Electron — there's no extra binary cost. A 200-line
   service class wrapping `BrowserWindow` with the 11-tool surface
   maps directly. The selector (note 06) already knows what to do
   with the resulting tool ids.

2. **Match alma's `Read` / `ReadDom` PREFER over `Screenshot`
   guidance.** This is purely a tool-description choice; mirror
   the alma copy at `main.js:27957` and the model picks the token-
   efficient option.

3. **Hard navigation timeout (30s) + `webContents.stop()`.** A
   hung page should never let the agent loop block. The pattern
   in `main.js:27603-27613` is straight-up copyable.

4. **Single-instance window lifecycle.** Throw a helpful error
   when any Browser tool is called before `BrowserOpen`. Match
   alma's exact copy so the model recovers quickly when it forgets
   to open first.

5. **Visual sandbox affordance.** Since the BrowserWindow IS
   visible to the user, give it a clear "Maka is browsing" frame
   (titlebar tag + persistent reminder) so users understand it's
   the agent acting, not a stray window from elsewhere.

## Open question

Does alma's Mozilla Readability extractor run in the page context
(via executeJavaScript) or in the main process after fetching HTML?
The token-efficiency tradeoff is the same either way, but the
implementation effort differs.

## Status

Round 2 deep-dive is now **closed at 10 notes** plus this 11th
covering the last named subsystem from
[`00-OVERVIEW.md`](./00-OVERVIEW.md). All round-1-OVERVIEW
"planned" subsystems are shipped. Future round 3 candidates pinned
inside each note's "Open questions for round 3" section.

## Cross-refs

- Round 2: [`10-chrome-relay.md`](./10-chrome-relay.md) — the
  user-session-backed counterpart with overlapping tool shapes.
- Round 2: [`06-tool-routing.md`](./06-tool-routing.md) — the
  pre-loop selector teaches the model when to use Browser vs
  ChromeRelay based on connectivity.
- Round 1: [`02-tools.md`](../alma-deep-dive-yuejing-2026-05-31/02-tools.md)
  for the tool registry shape that holds the Browser family
  alongside everything else.
