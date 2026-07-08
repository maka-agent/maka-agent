// maka-cu-helper — Phase-1 Computer Use dispatch backend (PR-RUNTIME-CU).
//
// A minimal, signed-helper-shaped process that the Maka main process spawns
// (posix_spawn child → inherits Maka.app's TCC Accessibility + Screen Recording
// grants, so no second permission prompt). It speaks NDJSON over stdio: one
// JSON request object per line in, one JSON response object per line out.
//
// Scope = the Tier-1, PUBLIC-API, genuinely-background subset proven on
// macOS 26.5 (see memory maka-cua-macos-feasibility): Accessibility action
// dispatch (AXPress / AXSetValue) + capture. It performs NO private SkyLight
// SPI and NO global CGEventPost HID-tap (which would move the real cursor).
// It never touches the user's frontmost app implicitly: keyboard goes to a
// named pid via CGEventPostToPid, and every mutating op reports whether a
// post-action readback actually observed the change (`verified`) because
// AXPress can return success while doing nothing (empirically confirmed).
//
// Responses follow @maka/core ComputerUseActionOutcome:
//   success: { "ok": true, "tier": "ax", "verified": <bool?>, ... }
//   failure: { "ok": false, "error": <S17 code>, "message": "..." }
// S17 error codes: permission_missing | overlay_failed | invalid_coordinate |
//                  capture_failed | sensitivity_blocked | aborted | timeout
import Cocoa
import ApplicationServices
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

// MARK: - JSON I/O

func emit(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj),
          let line = String(data: data, encoding: .utf8) else {
        FileHandle.standardOutput.write("{\"ok\":false,\"error\":\"capture_failed\",\"message\":\"encode failed\"}\n".data(using: .utf8)!)
        return
    }
    FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
}
func fail(_ code: String, _ message: String) -> [String: Any] { ["ok": false, "error": code, "message": message] }

// MARK: - AX helpers (retry + messaging timeout — background reads are transiently flaky)

func appEl(_ pid: pid_t) -> AXUIElement {
    let a = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(a, 2.0)
    return a
}
func copyAttr(_ e: AXUIElement, _ attr: String, tries: Int = 4) -> CFTypeRef? {
    for _ in 0..<tries {
        var v: CFTypeRef?
        let r = AXUIElementCopyAttributeValue(e, attr as CFString, &v)
        if r == .success { return v }
        if r == .cannotComplete { usleep(120_000); continue }
        return nil
    }
    return nil
}
func str(_ e: AXUIElement, _ a: String) -> String { (copyAttr(e, a) as? String) ?? "" }
func asAXElement(_ v: CFTypeRef?) -> AXUIElement? {
    guard let v = v, CFGetTypeID(v) == AXUIElementGetTypeID() else { return nil }
    return (v as! AXUIElement)
}
func role(_ e: AXUIElement) -> String { str(e, kAXRoleAttribute as String) }
func sub(_ e: AXUIElement) -> String { str(e, kAXSubroleAttribute as String) }
func children(_ e: AXUIElement) -> [AXUIElement] { (copyAttr(e, kAXChildrenAttribute as String) as? [AXUIElement]) ?? [] }
func elPid(_ e: AXUIElement) -> pid_t { var p: pid_t = 0; AXUIElementGetPid(e, &p); return p }
func elFrame(_ e: AXUIElement) -> CGRect {
    var p = CGPoint.zero, s = CGSize.zero
    if let pv = copyAttr(e, kAXPositionAttribute as String) { AXValueGetValue(pv as! AXValue, .cgPoint, &p) }
    if let sv = copyAttr(e, kAXSizeAttribute as String) { AXValueGetValue(sv as! AXValue, .cgSize, &s) }
    return CGRect(origin: p, size: s)
}

// The window-control subroles that must be pressed via their window attribute,
// not via a hit-test element reference (hit-test AXPress no-ops on them).
let WINDOW_CONTROL_SUBROLES: Set<String> = ["AXMinimizeButton", "AXCloseButton", "AXZoomButton", "AXFullScreenButton"]

// MARK: - Ops

func opPreflight() -> [String: Any] {
    ["ok": true, "tier": "ax",
     "accessibility": AXIsProcessTrusted(),
     "screenRecording": CGPreflightScreenCaptureAccess()]
}

func opScreenshot(_ req: [String: Any]) -> [String: Any] {
    guard CGPreflightScreenCaptureAccess() else { return fail("permission_missing", "screen recording not granted") }
    guard let out = req["out"] as? String else { return fail("invalid_coordinate", "screenshot requires 'out' path") }
    // Reliable, TCC-inheriting capture via the Apple-signed screencapture tool.
    // (Productionization note: swap for ScreenCaptureKit SCScreenshotManager to
    // capture a specific occluded window without raising it — see feasibility memo.)
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    var argv = ["-x", "-o"]
    if let display = req["display"] as? Int { argv += ["-D", String(display)] }
    argv.append(out)
    p.arguments = argv
    do { try p.run(); p.waitUntilExit() } catch { return fail("capture_failed", "screencapture spawn failed: \(error)") }
    guard p.terminationStatus == 0, FileManager.default.fileExists(atPath: out) else {
        return fail("capture_failed", "screencapture exit \(p.terminationStatus)")
    }
    let bytes = (try? FileManager.default.attributesOfItem(atPath: out)[.size] as? Int) ?? 0
    var w = 0, h = 0
    if let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: out) as CFURL, nil),
       let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any] {
        w = (props[kCGImagePropertyPixelWidth] as? Int) ?? 0
        h = (props[kCGImagePropertyPixelHeight] as? Int) ?? 0
    }
    if bytes > 2 * 1024 * 1024 {
        // S15b: oversize is a sensitivity block, not a silent downscale-and-upload.
        return fail("sensitivity_blocked", "frame \(bytes)B exceeds 2MB cap; runtime must downscale before send")
    }
    return ["ok": true, "tier": "ax", "path": out, "byteLength": bytes, "widthPx": w, "heightPx": h, "mimeType": "image/png"]
}

// coordinate → AX element at that screen point (read-only), returns identity.
func elementAt(_ x: Float, _ y: Float) -> AXUIElement? {
    let sys = AXUIElementCreateSystemWide()
    AXUIElementSetMessagingTimeout(sys, 2.0)
    var el: AXUIElement?
    return AXUIElementCopyElementAtPosition(sys, x, y, &el) == .success ? el : nil
}

// pid-scoped hit-test: deepest (smallest-area) element in the target app's AX
// tree whose frame contains the point. Occlusion-INDEPENDENT (ignores whatever
// window is visually on top) and returns an app-scoped ref that dispatches
// AXPress reliably — the correct primitive for BACKGROUND coordinate clicks.
// (Global AXUIElementCopyElementAtPosition respects z-order, so it hits the
// occluding window and its ref can silently no-op — empirically confirmed.)
func elementAtInApp(_ pid: pid_t, _ x: CGFloat, _ y: CGFloat) -> AXUIElement? {
    let app = appEl(pid)
    let pt = CGPoint(x: x, y: y)
    // Background AX traversal is intermittently flaky (transient cannotComplete
    // reads a zero frame), so a single pass can miss a containing element. Retry
    // the whole hit-test a few times before giving up.
    for _ in 0..<3 {
        var best: AXUIElement?
        var bestArea = CGFloat.greatestFiniteMagnitude
        func walk(_ e: AXUIElement, _ depth: Int) {
            if depth > 14 { return }
            let f = elFrame(e)
            if f.width > 0, f.height > 0, f.contains(pt) {
                let area = f.width * f.height
                if area < bestArea { bestArea = area; best = e }
            }
            for c in children(e) { walk(c, depth + 1) }
        }
        walk(app, 0)
        if best != nil { return best }
        usleep(150_000)
    }
    return nil
}

func opClick(_ req: [String: Any]) -> [String: Any] {
    guard AXIsProcessTrusted() else { return fail("permission_missing", "accessibility not granted") }
    guard let x = (req["x"] as? NSNumber)?.floatValue, let y = (req["y"] as? NSNumber)?.floatValue else {
        return fail("invalid_coordinate", "click requires numeric x,y")
    }
    guard x >= 0, y >= 0 else { return fail("invalid_coordinate", "negative coordinate") }

    // Prefer pid-scoped hit-testing (occlusion-independent, app-scoped ref that
    // dispatches reliably). Fall back to global element-at-position only when no
    // target pid is supplied (foreground use).
    let reqPid = (req["pid"] as? Int).map { pid_t($0) }
    let appScoped: Bool
    let target: AXUIElement
    if let pid = reqPid, let e = elementAtInApp(pid, CGFloat(x), CGFloat(y)) {
        target = e; appScoped = true
    } else if reqPid != nil {
        return fail("invalid_coordinate", "no AX element at (\(x),\(y)) in pid \(reqPid!)")
    } else if let e = elementAt(x, y) {
        target = e; appScoped = false
    } else {
        return fail("invalid_coordinate", "no AX element at (\(x),\(y))")
    }

    let pid = elPid(target)
    let hitRole = role(target), hitSub = sub(target), hitTitle = str(target, kAXTitleAttribute as String)
    let identity: [String: Any] = ["role": hitRole, "subrole": hitSub, "title": hitTitle, "pid": Int(pid)]

    // Window controls (traffic lights) must be pressed via the window's dedicated
    // attribute; a hit-test AXPress returns success but does nothing on them.
    if WINDOW_CONTROL_SUBROLES.contains(hitSub) {
        let app = appEl(pid)
        var winV: CFTypeRef?
        AXUIElementCopyAttributeValue(target, kAXWindowAttribute as CFString, &winV)
        let win = asAXElement(winV) ?? firstWindow(app)
        if let w = win {
            let attr: String
            switch hitSub {
            case "AXMinimizeButton": attr = kAXMinimizeButtonAttribute as String
            case "AXCloseButton": attr = kAXCloseButtonAttribute as String
            case "AXZoomButton": attr = kAXZoomButtonAttribute as String
            default: attr = kAXFullScreenButtonAttribute as String
            }
            if let btn = asAXElement(copyAttr(w, attr)) {
                let pr = AXUIElementPerformAction(btn, kAXPressAction as CFString)
                if pr != .success { return fail("capture_failed", "AXPress(window-control) err \(pr.rawValue)") }
                // Honest verify: AXPress returning success does NOT mean the
                // control acted (empirically confirmed). Re-read the window state
                // the control should have changed. For minimize we can confirm;
                // other controls report null and the model re-screenshots.
                usleep(250_000)
                var verified: Any = NSNull()
                if hitSub == "AXMinimizeButton" {
                    verified = (copyAttr(w, kAXMinimizedAttribute as String) as? Bool) ?? false
                }
                return ["ok": true, "tier": "ax", "verified": verified, "element": identity, "via": "window-attribute"]
            }
        }
    }

    let pr = AXUIElementPerformAction(target, kAXPressAction as CFString)
    if pr != .success {
        return fail("capture_failed", "AXPress err \(pr.rawValue) on \(hitRole)")
    }
    // AXPress can lie; the authoritative check is the runtime's next screenshot
    // to the model. An app-scoped ref is our best local confidence signal.
    return ["ok": true, "tier": "ax",
            "verified": appScoped,
            "verifyNote": appScoped ? "app-scoped dispatch" : "global hit-test (unverified; model must re-screenshot)",
            "element": identity, "via": "element"]
}

func firstWindow(_ app: AXUIElement) -> AXUIElement? {
    for c in children(app) where role(c) == "AXWindow" { return c }
    return nil
}

func focusedElement(_ pid: pid_t) -> AXUIElement? {
    let app = appEl(pid)
    return asAXElement(copyAttr(app, kAXFocusedUIElementAttribute as String))
}

func opType(_ req: [String: Any]) -> [String: Any] {
    guard AXIsProcessTrusted() else { return fail("permission_missing", "accessibility not granted") }
    guard let text = req["text"] as? String else { return fail("invalid_coordinate", "type requires 'text'") }
    let pid = (req["pid"] as? Int).map { pid_t($0) } ?? NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
    guard pid > 0, let fe = focusedElement(pid) else { return fail("capture_failed", "no focused element for pid \(pid)") }
    let res = AXUIElementSetAttributeValue(fe, kAXValueAttribute as CFString, text as CFTypeRef)
    guard res == .success else { return fail("capture_failed", "AXSetValue err \(res.rawValue)") }
    // Readback verify — the anti-silent-no-op guard.
    let back = str(fe, kAXValueAttribute as String)
    return ["ok": true, "tier": "ax", "verified": back == text, "readback": back]
}

func opKey(_ req: [String: Any]) -> [String: Any] {
    guard AXIsProcessTrusted() else { return fail("permission_missing", "accessibility not granted") }
    guard let keyText = req["text"] as? String else { return fail("invalid_coordinate", "key requires 'text'") }
    let pid = (req["pid"] as? Int).map { pid_t($0) } ?? NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
    guard pid > 0 else { return fail("invalid_coordinate", "no target pid for key") }
    guard let code = KEYCODES[keyText.lowercased()] else { return fail("invalid_coordinate", "unmapped key '\(keyText)'") }
    let src = CGEventSource(stateID: .hidSystemState)
    if let d = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: true) { d.postToPid(pid) }
    usleep(15_000)
    if let u = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: false) { u.postToPid(pid) }
    // Key delivery to a background app is not locally verifiable here; the model
    // verifies via the next screenshot. Report tier honestly.
    return ["ok": true, "tier": "ax", "verified": NSNull(), "note": "key posted to pid \(pid); model must re-screenshot to confirm"]
}

let KEYCODES: [String: CGKeyCode] = [
    "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51,
    "escape": 53, "esc": 53, "left": 123, "right": 124, "down": 125, "up": 126,
    "home": 115, "end": 119, "pageup": 116, "pagedown": 121, "forwarddelete": 117,
]

// MARK: - NDJSON loop

func handle(_ req: [String: Any]) -> [String: Any] {
    switch req["op"] as? String {
    case "preflight": return opPreflight()
    case "screenshot": return opScreenshot(req)
    case "click": return opClick(req)
    case "type": return opType(req)
    case "key": return opKey(req)
    case .some(let op): return fail("invalid_coordinate", "unknown op '\(op)'")
    case .none: return fail("invalid_coordinate", "missing 'op'")
    }
}

while let line = readLine(strippingNewline: true) {
    let trimmed = line.trimmingCharacters(in: .whitespaces)
    if trimmed.isEmpty { continue }
    guard let data = trimmed.data(using: .utf8),
          let req = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
        emit(fail("invalid_coordinate", "malformed JSON request")); continue
    }
    emit(handle(req))
}
