import Cocoa
import CoreGraphics
import Darwin

let eventTypes: [CGEventType] = [
    .keyDown,
    .leftMouseDown,
    .rightMouseDown,
    .otherMouseDown,
    .mouseMoved,
    .leftMouseDragged,
    .rightMouseDragged,
    .otherMouseDragged,
]

func physicalInputAge() -> Double {
    eventTypes.map { eventType in
        CGEventSource.secondsSinceLastEventType(
            .hidSystemState,
            eventType: eventType
        )
    }.min() ?? .infinity
}

switch CommandLine.arguments.dropFirst().first {
case "age":
    print(physicalInputAge())
case "pulse":
    guard let source = CGEventSource(stateID: .hidSystemState),
          let event = CGEvent(
              mouseEventSource: source,
              mouseType: .mouseMoved,
              mouseCursorPosition: NSEvent.mouseLocation,
              mouseButton: .left
          )
    else {
        fputs("failed to create physical-input pulse\n", stderr)
        exit(1)
    }
    event.post(tap: .cghidEventTap)
    usleep(20_000)
    print(physicalInputAge())
default:
    fputs("usage: cu-physical-input-probe <age|pulse>\n", stderr)
    exit(2)
}
