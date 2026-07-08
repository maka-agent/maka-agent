# maka-cu-helper — Phase-1 Computer Use dispatch backend (PR-RUNTIME-CU)

A minimal native helper the Maka main process spawns to perform **Tier-1,
public-API, genuinely-background** host computer-use on macOS: Accessibility
action dispatch (AXPress / AXSetValue) + screen capture. It performs **no**
private SkyLight SPI and **no** global `CGEventPost` HID-tap, so it never moves
the real cursor or steals window focus.

## Why a helper process
- **TCC inheritance**: spawned via `posix_spawn` as a child of Maka's main
  process, it runs under Maka.app's code identity and inherits its granted
  Accessibility + Screen-Recording permissions — no second prompt.
- **Crash isolation** and a clean, auditable trust boundary (mirrors the Path 18
  "signed helper bundle" prior art). Inline-in-main is also allowed by the
  contract; a helper is defense-in-depth.

## Protocol — NDJSON over stdio
One JSON request object per line in; one JSON response per line out. Responses
follow `@maka/core` `ComputerUseActionOutcome`:
- success: `{ "ok": true, "tier": "ax", "verified": <bool|null>, ... }`
- failure: `{ "ok": false, "error": <S17 code>, "message": "..." }`

S17 error codes: `permission_missing | overlay_failed | invalid_coordinate |
capture_failed | sensitivity_blocked | aborted | timeout`.

### Ops
| request | does |
|---|---|
| `{"op":"preflight"}` | reports live TCC accessibility + screenRecording |
| `{"op":"screenshot","out":"/abs/path.png","display":1?}` | captures a display to PNG; returns dims+byteLength; oversize (>2MB) → `sensitivity_blocked` (S15b) |
| `{"op":"click","x":N,"y":N}` | coordinate → AXElementAtPosition → **app-scoped** AXPress → best-effort verify |
| `{"op":"type","text":"...","pid":N?}` | AXSetValue on the target app's focused element, with readback verify |
| `{"op":"key","text":"return","pid":N?}` | posts a key to a pid via CGEventPostToPid (no global cursor move) |

## Load-bearing behaviour (empirically grounded, macOS 26.5)
- **AXPress can return `success` while doing nothing.** Every mutating op reports
  `verified`; a hit-test element reference is treated as unverified (`verified:false`)
  and the runtime/model MUST re-screenshot to confirm. Window-control buttons
  (traffic lights) are pressed via their window attribute, not the hit-test ref.
- **Actions dispatch on app-scoped elements**, not the system-wide
  element-at-position reference (which reads reliably but no-ops on AXPress).
- Background AX reads are transiently flaky → all reads retry with a messaging
  timeout.

## Build (dev)
```
./build.sh   # → build/maka-cu-helper  (ad-hoc signed)
```

## Productionization TODO (NOT done here — the biggest new-infra item)
- Developer-ID sign + **notarize** with a stable identity (TCC grants bind to
  code identity; ad-hoc/hash-changing binaries lose the grant on rebuild).
- Hardened runtime; bundle usage descriptions (`NSAccessibilityUsageDescription`,
  screen-recording rationale) on the host app; ship the helper inside Maka.app.
- Add an `electron-builder`/packaging step (the repo has none yet) that carries
  the helper + entitlements and codesigns it in CI.
- Swap `screencapture` shell-out for ScreenCaptureKit `SCScreenshotManager` to
  capture a specific occluded window without raising it.
- Abort: honor a `{"op":"abort"}` / stdin close within <100ms mid-gesture (S18).

This helper is the Tier-1 dispatch backend behind the runtime's future
`CuDispatchBackend` interface. Tier-2 (private-SkyLight coordinate injection for
Electron/Chromium) and Tier-3 (foreground fallback) plug in behind the same seam.
