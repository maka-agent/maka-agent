// Maka's Codex-style agent cursor.
//
// Confirmed from the shipped Codex Computer Use native binary:
// - AgentCursor is a normalized SwiftUI Shape with the exact path below.
// - FogCursorStyle uses the hosting view center as its hotspot.
// - MotionConfiguration.live supplies the thresholds and spring constants below.
// - Long moves use independent position, axis, rotation, and stretch springs.
//
// The stripped binary does not retain the candidate-path scoring function, so
// planCursorPath structurally reproduces the 20-candidate cubic planner using
// the recovered handles/arc constants. Geometry, hotspot, thresholds, and
// spring/style constants are exact for the inspected 2026-07-16 build.
import { makaBrandPalette, type Palette, rgba } from './palette.js';

const PI = Math.PI;
const TAU = PI * 2;
const SENTINEL = -200;

export const CODEX_CURSOR_MOTION = {
  clickAngle: -44 * PI / 180,
  candidateCount: 20,
  boundsMargin: 20,
  startHandle: 0.41960295031576633,
  endpointHandle: 0.15,
  arcSize: 0.27655231880642772,
  arcFlow: 0.5783555327868779,
  straightPathDistanceThreshold: 10,
  springResponseScaler: 0.9,
  springResponseMin: 0.12,
  springResponseMax: 2.2,
  springDampingFraction: 0.9,
  scootDistanceThreshold: 196,
  scootPositionResponse: 0.24,
  scootPositionDampingFraction: 0.84,
  scootPositionSettleVelocity: 12,
  scootAxisResponse: 0.07,
  scootAxisDampingFraction: 0.82,
  scootBaseRotationResponse: 0.09,
  scootBaseRotationDampingFraction: 0.86,
  scootStretchResponse: 0.095,
  scootStretchDampingFraction: 0.72,
  scootStretchMin: 0,
  scootStretchPivotX: 0.5,
  scootStretchXAmount: 0.38,
  scootSquashYAmount: 0.18,
  scootRotationResponse: 0.055,
  scootRotationDampingFraction: 0.76,
  scootRotationMax: 76 * PI / 180,
  terminalTangentBlendStart: 0.99,
} as const;

export const CODEX_CURSOR_GLYPH = {
  size: 14,
  shadowBlur: 9,
  // Normalized AgentCursor.path(in:) coordinates recovered from the native
  // function's read-only floating-point constants.
  start: [0.00599, 0.15864] as const,
  curve1: [
    [0.15158, 0.00627],
    [-0.02364, 0.06456],
    [0.06169, -0.02474],
  ] as const,
  line1: [0.87634, 0.25652] as const,
  curve2: [
    [0.88794, 0.48095],
    [0.97594, 0.29096],
    [0.9834, 0.43547],
  ] as const,
  line2: [0.59343, 0.62108] as const,
  line3: [0.45955, 0.92925] as const,
  curve3: [
    [0.2451, 0.91717],
    [0.41611, 1.02925],
    [0.27801, 1.02146],
  ] as const,
} as const;

type Point = readonly [number, number];
type Viewport = { width: number; height: number };

interface SpringValue {
  value: number;
  velocity: number;
  target: number;
  response: number;
  damping: number;
}

class CubicCursorPath {
  constructor(
    readonly p0: Point,
    readonly p1: Point,
    readonly p2: Point,
    readonly p3: Point,
  ) {}

  sample(tIn: number): Point {
    const t = clamp(tIn, 0, 1);
    const u = 1 - t;
    const a = u * u * u;
    const b = 3 * u * u * t;
    const c = 3 * u * t * t;
    const d = t * t * t;
    return [
      a * this.p0[0] + b * this.p1[0] + c * this.p2[0] + d * this.p3[0],
      a * this.p0[1] + b * this.p1[1] + c * this.p2[1] + d * this.p3[1],
    ];
  }

  tangent(tIn: number): Point {
    const t = clamp(tIn, 0, 1);
    const u = 1 - t;
    return [
      3 * u * u * (this.p1[0] - this.p0[0])
        + 6 * u * t * (this.p2[0] - this.p1[0])
        + 3 * t * t * (this.p3[0] - this.p2[0]),
      3 * u * u * (this.p1[1] - this.p0[1])
        + 6 * u * t * (this.p2[1] - this.p1[1])
        + 3 * t * t * (this.p3[1] - this.p2[1]),
    ];
  }
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

function wrapAngle(value: number): number {
  let result = value;
  while (result > PI) result -= TAU;
  while (result < -PI) result += TAU;
  return result;
}

function setAngleTarget(spring: SpringValue, target: number): void {
  spring.target = spring.value + wrapAngle(target - spring.value);
}

function stepSpring(spring: SpringValue, dt: number): void {
  const response = Math.max(0.001, spring.response);
  const omega = TAU / response;
  const stiffness = omega * omega;
  const damping = 2 * spring.damping * omega;
  const steps = Math.max(1, Math.ceil(dt / (1 / 240)));
  const h = dt / steps;
  for (let i = 0; i < steps; i++) {
    spring.velocity += (
      stiffness * (spring.target - spring.value) - damping * spring.velocity
    ) * h;
    spring.value += spring.velocity * h;
  }
}

function springSettled(spring: SpringValue, valueEpsilon = 0.001, velocityEpsilon = 0.01): boolean {
  return Math.abs(spring.target - spring.value) <= valueEpsilon
    && Math.abs(spring.velocity) <= velocityEpsilon;
}

function makeSpring(value: number, response: number, damping: number): SpringValue {
  return { value, velocity: 0, target: value, response, damping };
}

function settleSpring(spring: SpringValue, value: number): void {
  spring.value = value;
  spring.velocity = 0;
  spring.target = value;
}

function directCursorPath(start: Point, end: Point): CubicCursorPath {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  return new CubicCursorPath(
    start,
    [start[0] + dx / 3, start[1] + dy / 3],
    [start[0] + dx * 2 / 3, start[1] + dy * 2 / 3],
    end,
  );
}

function viewportOverflow(
  path: CubicCursorPath,
  start: Point,
  end: Point,
  viewport: Viewport | null,
): number {
  if (!viewport) return 0;
  const margin = CODEX_CURSOR_MOTION.boundsMargin;
  const minX = Math.max(0, Math.min(margin, start[0], end[0]));
  const minY = Math.max(0, Math.min(margin, start[1], end[1]));
  const maxX = Math.min(viewport.width, Math.max(viewport.width - margin, start[0], end[0]));
  const maxY = Math.min(viewport.height, Math.max(viewport.height - margin, start[1], end[1]));
  let overflow = 0;
  for (let index = 0; index <= 32; index++) {
    const [x, y] = path.sample(index / 32);
    overflow += Math.max(0, minX - x) ** 2;
    overflow += Math.max(0, x - maxX) ** 2;
    overflow += Math.max(0, minY - y) ** 2;
    overflow += Math.max(0, y - maxY) ** 2;
  }
  return overflow;
}

function planCursorPath(
  start: Point,
  end: Point,
  departureAngle: number,
  viewport: Viewport | null,
): CubicCursorPath {
  const config = CODEX_CURSOR_MOTION;
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const distance = Math.hypot(dx, dy);
  if (distance <= config.straightPathDistanceThreshold) {
    return directCursorPath(start, end);
  }

  const directAngle = Math.atan2(dy, dx);
  const direction: Point = [Math.cos(directAngle), Math.sin(directAngle)];
  const departure: Point = [Math.cos(departureAngle), Math.sin(departureAngle)];
  const perpendicular: Point = [-direction[1], direction[0]];
  const desiredSign = Math.sin(wrapAngle(directAngle - departureAngle)) >= 0 ? 1 : -1;
  const desiredArc = Math.min(distance * config.arcSize, 120) * desiredSign;

  let bestPath: CubicCursorPath | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  let bestOverflow = Number.POSITIVE_INFINITY;
  for (let i = 0; i < config.candidateCount; i++) {
    const normalized = i / (config.candidateCount - 1);
    const arc = (normalized * 2 - 1) * Math.abs(desiredArc);
    const p1: Point = [
      start[0] + departure[0] * distance * config.startHandle
        + perpendicular[0] * arc * config.arcFlow,
      start[1] + departure[1] * distance * config.startHandle
        + perpendicular[1] * arc * config.arcFlow,
    ];
    const p2: Point = [
      end[0] - direction[0] * distance * config.endpointHandle
        + perpendicular[0] * arc * (1 - config.arcFlow),
      end[1] - direction[1] * distance * config.endpointHandle
        + perpendicular[1] * arc * (1 - config.arcFlow),
    ];
    const candidate = new CubicCursorPath(start, p1, p2, end);
    const arcPreference = Math.abs(arc - desiredArc);
    const controlLength = Math.hypot(p1[0] - start[0], p1[1] - start[1])
      + Math.hypot(p2[0] - p1[0], p2[1] - p1[1])
      + Math.hypot(end[0] - p2[0], end[1] - p2[1]);
    const overflow = viewportOverflow(candidate, start, end, viewport);
    const score = overflow * 1_000_000 + arcPreference * 0.8 + controlLength * 0.2;
    if (score < bestScore) {
      bestScore = score;
      bestOverflow = overflow;
      bestPath = candidate;
    }
  }
  return bestOverflow > 0.0001 ? directCursorPath(start, end) : bestPath!;
}

export class CursorEngine {
  pos: [number, number] = [SENTINEL, SENTINEL];
  heading = CODEX_CURSOR_MOTION.clickAngle;
  pressed = false;

  private path: CubicCursorPath | null = null;
  private progress: SpringValue | null = null;
  private target: Point | null = null;
  private moveDistance = 0;
  private opacity = 0;
  private fadingIn = false;
  private clickT: number | null = null;
  private clickPoint: [number, number] | null = null;
  private clickOnArrive = false;
  private palette: Palette = makaBrandPalette();
  private viewport: Viewport | null = null;

  private readonly axis = makeSpring(
    CODEX_CURSOR_MOTION.clickAngle,
    CODEX_CURSOR_MOTION.scootAxisResponse,
    CODEX_CURSOR_MOTION.scootAxisDampingFraction,
  );
  private readonly baseRotation = makeSpring(
    0,
    CODEX_CURSOR_MOTION.scootBaseRotationResponse,
    CODEX_CURSOR_MOTION.scootBaseRotationDampingFraction,
  );
  private readonly stretchX = makeSpring(
    1,
    CODEX_CURSOR_MOTION.scootStretchResponse,
    CODEX_CURSOR_MOTION.scootStretchDampingFraction,
  );
  private readonly stretchY = makeSpring(
    1,
    CODEX_CURSOR_MOTION.scootStretchResponse,
    CODEX_CURSOR_MOTION.scootStretchDampingFraction,
  );
  private readonly rotationOffset = makeSpring(
    0,
    CODEX_CURSOR_MOTION.scootRotationResponse,
    CODEX_CURSOR_MOTION.scootRotationDampingFraction,
  );

  setSession(_sessionId: string): void {
    this.palette = makaBrandPalette();
  }

  setPalette(palette: Palette): void {
    this.palette = palette;
  }

  setViewport(width: number, height: number): void {
    this.viewport = Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
      ? { width, height }
      : null;
  }

  moveTo(x: number, y: number, _endHeading?: number, clickOnArrive = false): void {
    const destination: Point = [x, y];
    if (clickOnArrive) this.clickPoint = [x, y];

    // Codex fades the first appearance in at the requested hotspot. Starting
    // off-screen and gliding across the desktop is not part of the native path.
    if (!this.isVisible()) {
      this.pos = [x, y];
      this.heading = CODEX_CURSOR_MOTION.clickAngle;
      this.target = null;
      this.clickOnArrive = false;
      this.opacity = 0;
      this.fadingIn = true;
      if (clickOnArrive) this.clickT = 0;
      return;
    }

    const start: Point = [this.pos[0], this.pos[1]];
    const distance = Math.hypot(x - start[0], y - start[1]);
    if (distance < 0.01) {
      this.pos = [x, y];
      if (clickOnArrive) this.clickT = 0;
      return;
    }

    const departureAngle = Number.isFinite(this.heading)
      ? this.heading
      : Math.atan2(y - start[1], x - start[0]);
    this.path = planCursorPath(start, destination, departureAngle, this.viewport);
    this.target = destination;
    this.moveDistance = distance;
    const response = clamp(
      distance / 1000 * CODEX_CURSOR_MOTION.springResponseScaler,
      CODEX_CURSOR_MOTION.springResponseMin,
      CODEX_CURSOR_MOTION.springResponseMax,
    );
    this.progress = {
      value: 0,
      velocity: 0,
      target: 1,
      response,
      damping: CODEX_CURSOR_MOTION.springDampingFraction,
    };
    this.clickOnArrive = clickOnArrive;
  }

  /** Reconcile presentation with the coordinate confirmed by native execution. */
  completeAt(x: number, y: number, pulse = false, _endHeading?: number): void {
    this.pos = [x, y];
    this.heading = CODEX_CURSOR_MOTION.clickAngle;
    this.path = null;
    this.progress = null;
    this.target = null;
    this.moveDistance = 0;
    this.opacity = 1;
    this.fadingIn = false;
    this.clickOnArrive = false;
    this.pressed = false;
    this.clickT = null;
    this.clickPoint = null;
    this.resetVisualSprings();
    if (pulse) this.triggerClick(x, y);
  }

  triggerClick(x?: number, y?: number): void {
    if (typeof x === 'number' && typeof y === 'number') {
      if (!this.isVisible()) this.pos = [x, y];
      this.clickPoint = [x, y];
    }
    this.clickT = 0;
  }

  cancel(): void {
    this.path = null;
    this.progress = null;
    this.target = null;
    this.moveDistance = 0;
    this.opacity = 1;
    this.fadingIn = false;
    this.clickT = null;
    this.clickPoint = null;
    this.clickOnArrive = false;
    this.pressed = false;
    this.resetVisualSprings();
  }

  isMoving(): boolean {
    return this.path !== null
      || this.fadingIn
      || this.clickT !== null
      || !springSettled(this.baseRotation)
      || !springSettled(this.stretchX)
      || !springSettled(this.stretchY)
      || !springSettled(this.rotationOffset);
  }

  isVisible(): boolean {
    return this.pos[0] >= -100;
  }

  motionProgress(): number {
    return this.progress ? clamp(this.progress.value, 0, 1) : 1;
  }

  motionDistanceRemaining(): number {
    if (!this.path || !this.target) return 0;
    return Math.hypot(this.target[0] - this.pos[0], this.target[1] - this.pos[1]);
  }

  hasMotionPath(): boolean {
    return this.path !== null;
  }

  tick(dtIn: number): void {
    const dt = clamp(dtIn, 0, 0.05);
    if (this.fadingIn) {
      this.opacity = Math.min(1, this.opacity + dt / 0.16);
      if (this.opacity >= 1) this.fadingIn = false;
    }
    if (this.path && this.progress && this.target) {
      const previous: Point = [this.pos[0], this.pos[1]];
      stepSpring(this.progress, dt);
      const progress = clamp(this.progress.value, 0, 1);
      const sampled = this.path.sample(progress);
      const tangent = this.path.tangent(progress);
      let tangentAngle = Math.atan2(tangent[1], tangent[0]);
      if (progress > CODEX_CURSOR_MOTION.terminalTangentBlendStart) {
        const blend = (progress - CODEX_CURSOR_MOTION.terminalTangentBlendStart)
          / (1 - CODEX_CURSOR_MOTION.terminalTangentBlendStart);
        tangentAngle += wrapAngle(CODEX_CURSOR_MOTION.clickAngle - tangentAngle) * clamp(blend, 0, 1);
      }

      this.pos = [sampled[0], sampled[1]];
      this.heading = tangentAngle;
      const speed = dt > 0 ? Math.hypot(sampled[0] - previous[0], sampled[1] - previous[1]) / dt : 0;
      const scootEnabled = this.moveDistance >= CODEX_CURSOR_MOTION.scootDistanceThreshold;
      const intensity = scootEnabled ? clamp(speed / 900, 0, 1) : 0;

      setAngleTarget(this.axis, tangentAngle);
      setAngleTarget(
        this.baseRotation,
        clamp(
          wrapAngle(tangentAngle - CODEX_CURSOR_MOTION.clickAngle),
          -CODEX_CURSOR_MOTION.scootRotationMax,
          CODEX_CURSOR_MOTION.scootRotationMax,
        ) * intensity,
      );
      this.stretchX.target = 1 + CODEX_CURSOR_MOTION.scootStretchXAmount * intensity;
      this.stretchY.target = 1 - CODEX_CURSOR_MOTION.scootSquashYAmount * intensity;
      this.rotationOffset.target = clamp(
        this.progress.velocity * 0.035,
        -CODEX_CURSOR_MOTION.scootRotationMax,
        CODEX_CURSOR_MOTION.scootRotationMax,
      ) * intensity;

      const progressSettled = springSettled(this.progress, 0.0005, 0.005);
      if (progressSettled) {
        this.pos = [this.target[0], this.target[1]];
        this.heading = CODEX_CURSOR_MOTION.clickAngle;
        this.path = null;
        this.progress = null;
        this.target = null;
        this.baseRotation.target = 0;
        this.stretchX.target = 1;
        this.stretchY.target = 1;
        this.rotationOffset.target = 0;
        if (this.clickOnArrive) {
          this.clickT = 0;
          this.clickOnArrive = false;
        }
      }
    } else {
      this.baseRotation.target = 0;
      this.stretchX.target = 1;
      this.stretchY.target = 1;
      this.rotationOffset.target = 0;
    }

    stepSpring(this.axis, dt);
    stepSpring(this.baseRotation, dt);
    stepSpring(this.stretchX, dt);
    stepSpring(this.stretchY, dt);
    stepSpring(this.rotationOffset, dt);

    if (this.clickT !== null) {
      const next = this.clickT + dt * 4;
      this.clickT = next >= 1 ? null : next;
      if (next >= 1) this.clickPoint = null;
    }
  }

  private resetVisualSprings(): void {
    settleSpring(this.axis, CODEX_CURSOR_MOTION.clickAngle);
    settleSpring(this.baseRotation, 0);
    settleSpring(this.stretchX, 1);
    settleSpring(this.stretchY, 1);
    settleSpring(this.rotationOffset, 0);
  }

  paint(ctx: CanvasRenderingContext2D, originX: number, originY: number): void {
    if (!this.isVisible()) return;
    const px = this.pos[0] - originX;
    const py = this.pos[1] - originY;
    const pressProgress = this.clickT === null ? 0 : Math.sin(PI * this.clickT);
    const pressedAmount = this.pressed ? 1 : pressProgress;
    const scale = 1 - 0.1 * pressedAmount;

    ctx.save();
    ctx.globalAlpha = this.opacity;
    ctx.translate(px, py);
    ctx.rotate(this.axis.value);
    ctx.scale(this.stretchX.value, this.stretchY.value);
    ctx.rotate(-this.axis.value);
    ctx.rotate(this.baseRotation.value + this.rotationOffset.value);
    ctx.scale(scale, scale);
    this.paintAgentCursor(ctx, pressedAmount);
    ctx.restore();
  }

  private paintAgentCursor(ctx: CanvasRenderingContext2D, pressedAmount: number): void {
    const glyph = CODEX_CURSOR_GLYPH;
    const size = glyph.size;
    const offset = -size / 2;
    const point = ([x, y]: Point): Point => [offset + x * size, offset + y * size];
    const start = point(glyph.start);
    const curve1End = point(glyph.curve1[0]);
    const curve1Control1 = point(glyph.curve1[1]);
    const curve1Control2 = point(glyph.curve1[2]);
    const line1 = point(glyph.line1);
    const curve2End = point(glyph.curve2[0]);
    const curve2Control1 = point(glyph.curve2[1]);
    const curve2Control2 = point(glyph.curve2[2]);
    const line2 = point(glyph.line2);
    const line3 = point(glyph.line3);
    const curve3End = point(glyph.curve3[0]);
    const curve3Control1 = point(glyph.curve3[1]);
    const curve3Control2 = point(glyph.curve3[2]);

    ctx.beginPath();
    ctx.moveTo(start[0], start[1]);
    ctx.bezierCurveTo(
      curve1Control1[0], curve1Control1[1],
      curve1Control2[0], curve1Control2[1],
      curve1End[0], curve1End[1],
    );
    ctx.lineTo(line1[0], line1[1]);
    ctx.bezierCurveTo(
      curve2Control1[0], curve2Control1[1],
      curve2Control2[0], curve2Control2[1],
      curve2End[0], curve2End[1],
    );
    ctx.lineTo(line2[0], line2[1]);
    ctx.lineTo(line3[0], line3[1]);
    ctx.bezierCurveTo(
      curve3Control1[0], curve3Control1[1],
      curve3Control2[0], curve3Control2[1],
      curve3End[0], curve3End[1],
    );
    ctx.lineTo(start[0], start[1]);
    ctx.closePath();

    const palette = this.palette;
    const gradient = ctx.createLinearGradient(offset, offset, -offset, -offset);
    gradient.addColorStop(0, rgba(palette.cursorStart, 0.34 + pressedAmount * 0.08));
    gradient.addColorStop(0.55, rgba(palette.cursorMid, 0.3 + pressedAmount * 0.08));
    gradient.addColorStop(1, rgba(palette.cursorEnd, 0.26 + pressedAmount * 0.08));
    ctx.shadowColor = rgba(palette.cursorEnd, 0.38 + pressedAmount * 0.12);
    ctx.shadowBlur = glyph.shadowBlur + pressedAmount * 3;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 1;
    ctx.fillStyle = gradient;
    ctx.fill();
    ctx.strokeStyle = rgba(palette.cursorStart, 0.94 + pressedAmount * 0.06);
    ctx.lineWidth = 1.55;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();
  }
}
