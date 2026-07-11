import Cocoa
import CoreGraphics
import Darwin

setbuf(stdout, nil)

guard let initialApplication = NSWorkspace.shared.frontmostApplication else {
  print("ERROR\tno frontmost application")
  exit(1)
}

var candidateFrontmostPid = initialApplication.processIdentifier
var candidatePointerPosition = NSEvent.mouseLocation
var stableSince = Date()

while Date().timeIntervalSince(stableSince) < 0.5 {
  autoreleasepool {
    let currentFrontmostPid = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1
    let currentPointerPosition = NSEvent.mouseLocation
    let pointerStep = hypot(
      currentPointerPosition.x - candidatePointerPosition.x,
      currentPointerPosition.y - candidatePointerPosition.y
    )
    if currentFrontmostPid != candidateFrontmostPid || pointerStep > 1.0 {
      candidateFrontmostPid = currentFrontmostPid
      candidatePointerPosition = currentPointerPosition
      stableSince = Date()
    }
  }
  usleep(5_000)
}

let originalFrontmostPid = candidateFrontmostPid
let originalPointerPosition = candidatePointerPosition
var previousPointerPosition = originalPointerPosition
print("READY\t\(originalFrontmostPid)\t\(originalPointerPosition.x)\t\(originalPointerPosition.y)")

func secondsSincePhysicalPointerInput() -> Double {
  let eventTypes: [CGEventType] = [
    .mouseMoved,
    .leftMouseDragged,
    .rightMouseDragged,
    .otherMouseDragged,
  ]
  return eventTypes
    .map { CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: $0) }
    .min() ?? .greatestFiniteMagnitude
}

while true {
  autoreleasepool {
    let currentFrontmostPid = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1
    let currentPointerPosition = NSEvent.mouseLocation

    if currentFrontmostPid != originalFrontmostPid {
      print("CHANGE\tfrontmost PID changed: \(originalFrontmostPid) -> \(currentFrontmostPid)")
      exit(2)
    }

    let pointerStep = hypot(
      currentPointerPosition.x - previousPointerPosition.x,
      currentPointerPosition.y - previousPointerPosition.y
    )
    let physicalPointerIdle = secondsSincePhysicalPointerInput()
    if pointerStep > 4.0 && physicalPointerIdle > 0.05 {
      print(
        "CHANGE\treal pointer jumped without recent HID input: "
          + "(\(previousPointerPosition.x),\(previousPointerPosition.y)) -> "
          + "(\(currentPointerPosition.x),\(currentPointerPosition.y)); "
          + "step \(pointerStep)px; HID idle \(physicalPointerIdle)s"
      )
      exit(3)
    }
    previousPointerPosition = currentPointerPosition
  }

  usleep(5_000)
}
