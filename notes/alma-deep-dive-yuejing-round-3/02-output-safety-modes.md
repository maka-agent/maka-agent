# 02 — Alma output safety modes (compact / exact / passthrough)

> Source-grounded against `~/Downloads/alma-re/readable/main.js`.
> Pinned in round-2 [`02-send-response-flow-WIP.md`](../alma-deep-dive-yuejing-round-2/02-send-response-flow-WIP.md)
> as a surface mentioned but not traced. This note traces the
> selection algorithm, the 8-profile budget table, the cascading
> truncation strategy, and the in-band `[alma-output-safety: …]`
> override marker end-to-end.

## The three modes

Defined by `Vd` validator at `main.js:17876-17878`:

| Mode | What happens | When picked |
|---|---|---|
| `passthrough` | Tool result returned UNCHANGED (no JSON stringify, no truncation). | Screenshots / binary / image+audio results — anything where the bytes ARE the result. |
| `exact` | Tool result kept verbatim but recursively walked for binary-key protection. NO truncation. | Tools where every character matters: `Read`, `ReadSettings`, `Task`, `TodoWrite`, etc. (the `Yd` set, `main.js:17844`.) |
| `compact` | Per-string-type budget applied + truncation cascade with shrink loop. | Default for textual data tools: `Bash`, `Grep`, `Glob`, `WebFetch`, `BrowserRead`, etc. (the `Jd` set, `main.js:17862`.) |

## Mode selection algorithm

`main.js:18141-18152` (the inner function inside the dispatch
wrapper at `mu`):

```js
function pickMode(toolName) {
  return Xd.get(toolName)                           // 1. explicit per-tool override
    || (qd.has(toolName)                            // 2. screenshot family
        || toolName.endsWith("Screenshot"))
      ? "passthrough"
      : Yd.has(toolName)                            // 3. "preserve exactly" allowlist
        ? "exact"
        : Jd.has(toolName) || toolName.includes("__")  // 4. textual-data allowlist + MCP tools
          ? "compact"
          : "exact";                                // 5. fallback: exact
}
```

Read the precedence in order:

1. **`Xd` per-tool runtime override** (`main.js:17843`, set via
   `Qd` helper at `main.js:17894-17896`). Empty by default; this
   is where the in-band marker writes (next section).
2. **Screenshot family** (`qd` set + name suffix) → always
   `passthrough`. Bytes can't be truncated.
3. **`Yd` exact-preserve allowlist** (`main.js:17844-17861`):
   `AttemptCompletion`, `CreateThread`, `DeleteThread`,
   `EnterPlanMode`, `ExitPlanMode`, `Read`, `ReadSettings`,
   `ReadThread`, `Recall`, `Skill`, `SlashCommand`, `Task`,
   `TaskOutput`, `TodoWrite`, `ToolSearch`, `UpdateSettings`.
4. **`Jd` compact allowlist** (`main.js:17862-17875`): `Bash`,
   `BashOutput`, `BrowserEval`, `BrowserRead`, `BrowserReadDom`,
   `ChromeRelayEval`, `ChromeRelayRead`, `ChromeRelayReadDom`,
   `Glob`, `Grep`, `WebFetch`, `WebSearch`. Plus ANY tool whose
   name contains `__` — the MCP namespacing convention. So all
   MCP tool results default to compact unless explicitly set
   elsewhere. Cross-ref round-2 [`08-mcp-client.md`](../alma-deep-dive-yuejing-round-2/08-mcp-client.md)
   on `serverName__toolName`.
5. **Fallback** for anything unknown: `exact`. Safer default —
   newly-added tools get full output until someone classifies
   them.

## The in-band override marker

`main.js:17842`:

```js
Hd = /\[alma-output-safety:\s*(exact|compact|passthrough)\s*\]/i
```

`Kd` parser at `main.js:17879-17893` strips the marker from a text
payload and returns `{ text, mode }`. The mode is then written into
the `Xd` Map via `Qd`. This is how prompts (tool descriptions,
skill bodies, user messages) DECLARATIVELY change the safety mode
of a downstream tool call — without a runtime config object passed
through. Think of it as a one-line capability annotation that the
prompt itself can emit.

This is the "non-obvious" part of the system: a skill body can
write `[alma-output-safety: passthrough]` at its top, and the next
tool call will return verbatim instead of being compacted. Same
for compact-on-an-otherwise-exact tool. The override is GLOBAL per
toolName, not per-call — set it, get it forever (until `Qd(name,
undefined)` deletes it). Open question: does alma clear these
between threads?

## Compact-mode: 8 budget profiles

When mode is `compact`, the dispatch picks a profile object based
on the tool name (`main.js:18154-18172`):

| Tool | Profile | `maxSerializedChars` | Special limits |
|---|---|---|---|
| `Bash`, `BashOutput` | `eu` (`main.js:17942`) | 3,800 | `stdout`/`stderr` 1500 chars, 120 lines |
| `WebFetch`, `BrowserRead`, `ChromeRelayRead` | `tu` (`main.js:17948`) | 25,000 | `markdown` 20,000 chars, 1500 lines |
| `BrowserReadDom`, `ChromeRelayReadDom` | `nu` (`main.js:17954`) | 25,000 | `elements` 20,000 chars, 1500 lines |
| `WebSearch` | `ou` (`main.js:17960`) | 3,400 | `snippet`/`summary` 220; `markdown` 500 chars, 60 lines |
| `Grep` | `su` (`main.js:17971`) | 5,000 | `preview` 220; `rawOutput` 1400 chars |
| `Glob` | `ru` (`main.js:17976`) | 9,000 | `defaultStringChars` 180, `minStringChars` 80 (lots of short paths) |
| MCP tools (name contains `__`) | `iu` (`main.js:17982`) | 2,600 | `defaultStringChars` 1000 |
| Default (everything else) | `Zd` (`main.js:17897`) | 6,000 | head-tail strategy on most types |

`Zd` is the BASE profile (`main.js:17897-17941`); every other
profile spreads `Zd` and overrides specific fields. The base sets
`defaultStringChars: 900` and `minStringChars: 220` — strings
shrink to 220 minimum before the outer loop bails.

`Zd.strategies` declares **how** each string type truncates:

| Type | Strategy | Why |
|---|---|---|
| `stdout`, `stderr`, `rawOutput` | `tail` | Errors/progress live at the END. |
| `content` (Read/file), `preview`, `result`, `output` | `head-tail` | Want context from both ends; middle compacted out. |
| `markdown`, `elements`, `formattedContext` | `head` | Web/DOM extractions: most relevant info comes first. |

## Truncation cascade

`lu` (`main.js:17994-18062`) is the truncator for a single string.
Inputs: tool name `e`, parent-key `t`, the string `n`, profile `o`,
shrink factor `s` (starts at 1, decays in 0.8× steps).

1. ANSI/CR/LF normalization (strips colors and CRLF).
2. Compute per-key char budget = `max(minStringChars, floor(profile.stringLimits[type] * s))`.
3. If both line count ≤ `lineLimits[type]` and char count ≤ budget,
   return as-is.
4. Build truncation marker text:
   `\n...[alma compacted N chars; <hint>]...\n`
   where `<hint>` is tool-specific:
   - `Read` + `content` → `"; use offset/limit for the next slice"`
   - `Bash`/`BashOutput` + `stdout`/`stderr` → `"; rerun narrower commands or use BashOutput filter"`
   - `WebSearch` + `markdown` → `"; reduce max_results or disable include_markdown"`
5. Apply line truncation with `head` / `tail` / `head-tail`
   strategy (`main.js:18029-18040`). The `head-tail` cut takes
   65% from the head + 35% from the tail with the marker between.
6. If still over the char budget, apply char truncation with the
   same strategy (`main.js:18042-18059`).

The marker text is **important**: it teaches the model how to
recover. "WebSearch returned 12k of markdown; you got 500 chars
because the prompt limit is tight; rerun with `include_markdown:
false` if you want broader coverage." This is contract design —
truncation is not silent.

## Tree-walk + outer shrink loop

`du` (`main.js:18063-18086`) walks the tool result tree, applying
`lu` at each string leaf. Key behaviors:
- **`Gd` set** (`main.js:17834-17840`): keys `image_base64`,
  `audio_base64`, `file_base64`, `blob`, `binary` are returned
  verbatim — no truncation on encoded binary.
- **`uu` set** (`main.js:18087`): objects whose `.type` is
  `image`/`audio`/`image-data`/`file-data` get their `data`/`blob`
  fields preserved verbatim while still walking other fields.
- **Circular guard**: WeakSet rejects cycles with `"[Circular]"`.
- **Walk-stack tracks parent key** so `lu` knows which string-type
  budget to consult.

The OUTER LOOP at `main.js:18173-18178`:

```js
let s = 1, r = du(toolName, result, profile, s);
while (au(r).length > profile.maxSerializedChars && s > 0.35) {
  s = Number((0.8 * s).toFixed(2));
  r = du(toolName, result, profile, s);
}
```

Re-walks the entire tree with smaller shrink factors until the
serialized JSON fits the profile's total cap OR the shrink factor
drops below 0.35 (~35% of base limit per string). After that, alma
just emits whatever it has.

This is the "graceful degradation under prompt pressure" pattern:
strings shrink uniformly, then bail. Better than hard-truncating
the JSON envelope.

## Bash command escape hatch

`main.js:18131-18139`:

```js
if (("Bash" === e || "BashOutput" === e) && t && "object" == typeof t) {
  const e = n?.command;
  if (e && Wd(e) !== e) return t;  // command was MODIFIED (alma rewrote it)
}
```

If alma's command analyzer rewrote the user's Bash command
(e.g., wrapped with a timeout, added safety flags), the result
bypasses compaction. The reasoning: if alma is going to introduce
behavior, it shouldn't ALSO shrink the output — the user/agent
needs to see what the rewritten command actually did.

## What Maka has today

The `@maka/runtime` agent loop returns tool results verbatim
through the message stream. There's no:
- Budget profile family per tool category
- Per-string-type budget vs strategy table
- In-band override marker
- Shrink loop with outer cap

The renderer truncates for display purposes (markdown card
collapse, expand-to-see-full), but the truncation is purely a UI
concern — the model still sees the full payload, which can blow
prompt budget on large `WebFetch`/MCP outputs.

## Ranked Maka improvements

1. **Adopt the 3-mode classifier with safe-by-default `exact`.**
   The simplest version (`exact` for Read/Recall/Task, `compact`
   for Bash/WebFetch/Browser/MCP, `passthrough` for screenshots)
   is ~80 lines. Even without per-profile budgets, just having
   the mode dispatch makes the next two improvements much easier.

2. **Adopt the in-band marker `[alma-output-safety: …]`.** This
   is the killer feature: skills/prompts can declare per-tool
   safety mode without a config object. It also makes adopting
   alma's skill ecosystem easier — alma-format skills that use
   the marker won't silently misbehave.

3. **Profile family for compact mode.** Maka can copy `Zd` as
   the default, then layer Bash/WebFetch/WebSearch/MCP profiles.
   The `head-tail` strategy with 65/35 split is the non-obvious
   tuning — it solves "error messages live at the end, but I
   also need the start of the request."

4. **Tool-specific recovery hints in the truncation marker.**
   This is small text but BIG behavior: the model knows what to
   do when truncated. Without hints, it often retries the same
   query and gets the same truncation.

5. **Outer shrink loop with floor.** The `0.8×` decay until
   `0.35×` floor is alma's escape hatch for unexpectedly large
   responses. Without it, prompt overflow on a single 100k MCP
   response can wedge a turn.

## Open questions for round 3 of round-3

- Does alma clear `Xd` (the per-tool runtime mode override) between
  threads? The `Qd` setter is global; if a previous skill set
  `passthrough` on `WebSearch`, does a new thread inherit that?
- The `Bash` command-rewrite bypass uses `Wd(e) !== e` to detect
  modification. What if `Wd` is identity for some commands? Is
  there a way to force compaction-after-rewrite if the agent
  decides post-hoc?
- MCP tools all share the `iu` 2,600-char profile by default. Does
  this become a bottleneck for chatty MCP servers (Linear,
  Notion)? Round-2 note 08 mentioned MCP outputs can be large.

## Cross-refs

- Round 2: [`02-send-response-flow-WIP.md`](../alma-deep-dive-yuejing-round-2/02-send-response-flow-WIP.md)
  — where this surface was first mentioned but not traced.
- Round 2: [`05-bash-tool-family.md`](../alma-deep-dive-yuejing-round-2/05-bash-tool-family.md)
  — Bash's `eu` profile (1500/120 stdout) interacts with this.
- Round 2: [`08-mcp-client.md`](../alma-deep-dive-yuejing-round-2/08-mcp-client.md)
  — MCP tools default to `iu` profile via the `__` name check.
- Round 3: [`01-skills-system.md`](./01-skills-system.md) — skill
  bodies can emit the `[alma-output-safety: …]` marker.
