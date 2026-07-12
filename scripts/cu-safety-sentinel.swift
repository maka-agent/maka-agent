import Cocoa
import CoreGraphics
import Darwin
import Foundation

setbuf(stdout, nil)

let sampleIntervalMicros: useconds_t = 5_000
let stableBaselineSeconds = 0.5
let inputGraceSeconds = 0.012

func monotonicMilliseconds() -> Double {
  ProcessInfo.processInfo.systemUptime * 1_000
}

func secondsSincePhysicalInput(_ eventTypes: [CGEventType]) -> Double {
  eventTypes
    .map { CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: $0) }
    .min() ?? .greatestFiniteMagnitude
}

let pointerEventTypes: [CGEventType] = [
  .mouseMoved,
  .leftMouseDragged,
  .rightMouseDragged,
  .otherMouseDragged,
]

let mouseFocusEventTypes: [CGEventType] = [
  .leftMouseDown,
  .rightMouseDown,
  .otherMouseDown,
]

func observation(
  elapsedSeconds: Double?,
  eventType: String
) -> [String: Any] {
  let pointerIdle = secondsSincePhysicalInput(pointerEventTypes)
  let mouseFocusIdle = secondsSincePhysicalInput(mouseFocusEventTypes)
  let keyboardIdle = secondsSincePhysicalInput([.keyDown])
  let physicalWindow = elapsedSeconds.map { $0 + inputGraceSeconds }
  let commandTabActive =
    CGEventSource.flagsState(.hidSystemState).contains(.maskCommand)
    && CGEventSource.keyState(.hidSystemState, key: 48)
  let physicalFocusInput = physicalWindow.map {
    mouseFocusIdle <= $0 || (keyboardIdle <= $0 && commandTabActive)
  } ?? false

  return [
    "type": eventType,
    "atMs": monotonicMilliseconds(),
    "frontmostPid": Int(NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1),
    "cursor": [
      "x": Double(NSEvent.mouseLocation.x),
      "y": Double(NSEvent.mouseLocation.y),
    ],
    "physicalPointerIdleMs": pointerIdle * 1_000,
    "physicalFocusIdleMs": min(mouseFocusIdle, keyboardIdle) * 1_000,
    "physicalPointerInput": physicalWindow.map { pointerIdle <= $0 } ?? false,
    "physicalFocusInput": physicalFocusInput,
  ]
}

func emit(_ value: [String: Any]) {
  do {
    let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    guard let line = String(data: data, encoding: .utf8) else {
      throw NSError(domain: "cu-safety-sentinel", code: 1)
    }
    print(line)
  } catch {
    fputs("cu-safety-sentinel: failed to encode observation: \(error)\n", stderr)
    exit(1)
  }
}

guard NSWorkspace.shared.frontmostApplication != nil else {
  emit([
    "type": "error",
    "atMs": monotonicMilliseconds(),
    "message": "no frontmost application",
  ])
  exit(1)
}

var candidatePid = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1
var candidateCursor = NSEvent.mouseLocation
var stableSince = ProcessInfo.processInfo.systemUptime

while ProcessInfo.processInfo.systemUptime - stableSince < stableBaselineSeconds {
  autoreleasepool {
    let currentPid = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1
    let currentCursor = NSEvent.mouseLocation
    let cursorStep = hypot(
      currentCursor.x - candidateCursor.x,
      currentCursor.y - candidateCursor.y
    )

    if currentPid != candidatePid || cursorStep > 1.0 {
      candidatePid = currentPid
      candidateCursor = currentCursor
      stableSince = ProcessInfo.processInfo.systemUptime
    }
  }
  usleep(sampleIntervalMicros)
}

emit(observation(elapsedSeconds: nil, eventType: "sample"))

var previousSampleTime = ProcessInfo.processInfo.systemUptime
while true {
  usleep(sampleIntervalMicros)
  autoreleasepool {
    let now = ProcessInfo.processInfo.systemUptime
    emit(observation(
      elapsedSeconds: now - previousSampleTime,
      eventType: "sample"
    ))
    previousSampleTime = now
  }
}
