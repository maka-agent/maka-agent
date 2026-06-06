# 05 — Mozilla Readability execution context (page vs main process)

> Source-grounded against `~/Downloads/alma-re/readable/main.js`.
> Pinned open question in round-2 [`10-chrome-relay.md`](../alma-deep-dive-yuejing-round-2/10-chrome-relay.md)
> and [`11-browser-tools.md`](../alma-deep-dive-yuejing-round-2/11-browser-tools.md):
> does alma's Readability extractor run in the page context (via
> `executeJavaScript`) or in the main process after fetching HTML?
> Answer: **page context, always**, via `webContents.executeJavaScript`
> across 4 call sites. Markdown conversion happens in main process.

## TL;DR pipeline

```
main process                 BrowserWindow page context
─────────────                 ─────────────────────────
spawn BrowserWindow      ─→
loadURL + wait load      ─→
                              [page loads, runs scripts]
sweep selectors          ─→   document.querySelectorAll(…).remove()
inject Readability       ─→   window.Readability = <bundled IIFE>
invoke Readability       ─→   new Readability(document.cloneNode(true))
                                .parse()
                              ←─ {title, content, textContent}
turndown HTML→md         …
trim + summary + snippet …
return result            ─→ caller
destroy BrowserWindow    …
```

So Readability ALWAYS runs in the BrowserWindow's page context;
the main process only orchestrates and post-processes.

## Four call sites, two patterns

| # | Tool | Source | Document arg | Why |
|---|---|---|---|---|
| 1 | WebSearch per-result fetcher | `main.js:27040-27106` | bare `document` | BrowserWindow is destroyed at `.destroy()` right after extraction (`main.js:27103`). DOM mutation by Readability is irrelevant. |
| 2 | WebFetch | `main.js:27397-27429` | `document.cloneNode(true)` | Page lifetime extends beyond extraction; mutation would corrupt subsequent reads. |
| 3 | BrowserRead (sandbox browser) | `main.js:27692-27701` | `document.cloneNode(true)` | User's sandbox window lives across multiple tool calls; preserve it. |
| 4 | ChromeRelayRead | `main.js:28163-28171` | `document.cloneNode(true)` | User's REAL Chrome tab — preserving DOM is critical (the user is still on the page!). |

**The asymmetry IS the design.** WebSearch creates a throwaway
BrowserWindow per result (`main.js:27039-27103`), so it can hand
Readability the live `document` and skip the clone overhead. The
other three call sites all use `document.cloneNode(true)` because
the page outlives the extraction.

This matters: Readability's algorithm **mutates the DOM during
parsing** — it removes script/style/nav nodes, replaces some
elements, normalizes structure. Without `cloneNode(true)`, a
later `BrowserClick` on the same page would target nodes that no
longer exist.

## Pre-sweep selector list (cleanup before Readability)

`main.js:27040-27042`:

```js
await t.webContents.executeJavaScript(
  `(function() {
     const selectors = ${JSON.stringify(lg)};
     selectors.forEach(s => document.querySelectorAll(s).forEach(el => el.remove()));
   })()`
);
```

`lg` (and `Ng` for WebFetch) are arrays of selectors that get
stripped before Readability runs. This is a **two-stage cleanup**:
1. Coarse-grained DOM removal in JS (selectors targeting
   navigation, ads, share widgets, comment trees).
2. Fine-grained content extraction by Readability.

The selector lists are NOT visible to Readability — they're
preemptive deletes. Even though Readability has its own removal
logic, the alma authors found enough noisy pages (cookie banners
inside `<article>`, sticky headers cloned into the article body)
that a pre-pass helps.

## Lazy-loaded + memoized Readability bundle

Each call site has the same memoization pattern (`main.js:27044-
27052`, `27401-27411`, `27692-27695`, `28001-28005`):

```js
(() => {
  if (vg) return vg;                              // memoized cache
  const e = ig.resolve("@mozilla/readability/Readability.js"),
        t = Ee(e, "utf8");                         // sync read from disk
  return (vg = `
    (() => {
      const module = { exports: {} };
      const exports = module.exports;
      ${t}
      window.Readability = module.exports || exports;
    })();
  `, vg);
})()
```

Three observations:
- **Disk read happens once per process.** First call resolves the
  module, reads the file, builds the wrapper string. Subsequent
  calls reuse `vg`.
- **CommonJS-in-script trick.** Readability is a CJS package
  (`module.exports`); the wrapper fakes `module` and `exports`
  so the same source works inside `executeJavaScript`. The
  `window.Readability = module.exports || exports` line is the
  bridge.
- **Each surface has its own cache var** (`vg`, `Mg`, `jg`, `by`).
  Four call sites = four memos. Single shared cache would have
  worked; the duplication is probably tree-shake/codegen rather
  than intent.

## Per-call invocation shape

Once the bundle is injected, every call site uses the same
invocation pattern (slight differences in returned fields):

```js
(function() {
  const Readability = window.Readability;
  if (typeof Readability !== 'function') return null;
  const reader = new Readability(<document or document.cloneNode(true)>);
  const parsed = reader.parse();
  if (!parsed) return null;
  return { title: parsed.title, content: parsed.content,
           textContent: parsed.textContent };
})()
```

WebFetch (`main.js:27414`) also returns `contentLength` for
logging. ChromeRelayRead (`main.js:28171`) drops `textContent` —
only `title` + `content`. Tiny differences, same shape.

## Two-tier fallback hierarchy

After Readability returns, the call sites all check for null and
fall back to broader extraction:

**WebSearch fallback** (`main.js:27060-27061`):

```js
n = i?.content ?? (await t.webContents.executeJavaScript("document.body.innerHTML"));
```

Bare `document.body.innerHTML` dump if Readability failed.

**WebFetch fallback** (`main.js:27424-27425`):

```js
r = await t.webContents.executeJavaScript(`(function() {
  const selectors = ['main', 'article', '[role="main"]', '.content',
                     '#content', '.post', '.article'];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el && el.innerHTML.length > 500) return el.innerHTML;
  }
  return document.body ? document.body.innerHTML : '';
})()`);
```

Two-tier: try common semantic-content selectors with a 500-char
length floor, fall back to `body.innerHTML`. The length floor is
a quality gate — a 200-char `<main>` is probably a header, not
the article.

So WebFetch is more thoughtful than WebSearch on the fallback
path. This makes sense: WebSearch is many-results-many-fetches
(speed matters); WebFetch is the deeper read.

## HTML → markdown conversion happens in main process

After Readability returns HTML content, alma converts it to
markdown using `turndown` (`main.js:27063-27068`):

```js
a = ag.turndown(n)
       .split("\n")
       .map(e => e.trimEnd())
       .join("\n")
       .replace(/\n{3,}/g, "\n\n")
       .trim();
```

This is **main-process Node code**, not page context. The
multi-step normalization (trim trailing space per line, collapse
3+ newlines to 2, trim overall) cleans turndown's slightly-noisy
output.

After turndown:
- `a` = full markdown
- `l = a.slice(0, 6000)` with `…` suffix if longer
- `d = l.slice(0, 1500)` for snippet
- `bg(d)` summarizes (probably trimming again)

The token-budget cascade aligns with round-3 [`02-output-safety-
modes.md`](./02-output-safety-modes.md) — the `tu` profile for
`WebFetch` / `BrowserRead` / `ChromeRelayRead` allows 20k
markdown chars / 1500 lines / 25k total. The post-Readability
trim to 6000 chars happens BEFORE the safety-mode profile
applies — so this is the per-call cap, not the per-prompt cap.

## Why this matters for Maka

Maka doesn't have ANY of this today. If/when Maka adds a
WebFetch-like tool, two implementation paths exist:

1. **DOM-less.** Server-side fetch + `cheerio` HTML parsing in
   main process. Cheap, but no JS rendering — SPAs and lazy-
   loaded content fail.
2. **Page-context.** Same Electron BrowserWindow pattern alma
   uses. JS runs, lazy loads complete, Readability extracts in-
   page. More expensive (BrowserWindow spawn) but works on
   modern web.

Alma chose #2 across all 4 surfaces. The cost is one
BrowserWindow spawn + 1s timeout wait per fetch
(`main.js:27039`). The benefit is reliable extraction on
JS-heavy pages.

## Ranked Maka improvements

1. **Page-context Readability, not main-process HTML parsing.**
   Cheerio-based extraction will silently fail on SPA-rendered
   pages. The alma pattern is well-engineered; reuse the same
   wrapper-string + executeJavaScript bridge. ~50 lines.

2. **`document.cloneNode(true)` whenever the page outlives the
   call.** This is the non-obvious correctness rule. Sandbox
   Browser, ChromeRelay, and any long-lived BrowserWindow must
   clone. Throwaway BrowserWindows can skip.

3. **Pre-sweep selector list.** Even before Readability lands,
   the upstream selector-strip pattern (`script`, `style`,
   `nav`, common ad classes, sticky headers) is a 30-line cheap
   improvement to any HTML-to-text extraction. Reusable for
   cheerio-based MVP too.

4. **Two-tier fallback (semantic selectors with length floor →
   body.innerHTML).** Quality matters when models hallucinate
   missing content. Floor at 500 chars is the right magic
   number per alma's tuning.

5. **Trim cascade after turndown.** Multiple small normalizations
   (trim trailing-space per line, collapse 3+ newlines) make a
   real readability difference for the LLM. Easy to skip; worth
   keeping.

## Open questions for future rounds

- Does Readability inside ChromeRelay introduce a security risk?
  ChromeRelay runs JS in the user's REAL Chrome tab (round-2
  10) — Readability mutates a CLONE, but the injection itself
  evaluates code with full page-context privileges. If a page
  hooks `Element.prototype.cloneNode`, it could observe the
  Readability invocation. Probably low-stakes (it's open-source
  code with known shape), but worth noting.
- The four memoization caches (`vg`, `Mg`, `jg`, `by`) are
  effectively the same bundle — is there a memory cost to four
  duplicate copies of the Readability source (~50KB minified)?
  Negligible at runtime, but worth a single-bundle refactor.
- Does the pre-sweep selector list `lg` (for WebSearch) vs `Ng`
  (for WebFetch) differ deliberately or accidentally? Both
  serve the same purpose; consolidating would prevent drift.

## Cross-refs

- Round 2: [`10-chrome-relay.md`](../alma-deep-dive-yuejing-round-2/10-chrome-relay.md)
  — where this question was pinned. ChromeRelayRead is one of
  the four call sites.
- Round 2: [`11-browser-tools.md`](../alma-deep-dive-yuejing-round-2/11-browser-tools.md)
  — also pinned this question. BrowserRead is another call site.
- Round 3: [`02-output-safety-modes.md`](./02-output-safety-modes.md)
  — the `tu` profile applies AFTER Readability + turndown
  return; the 6000-char trim happens BEFORE the safety mode.
