// Agent-cursor render engine — faithful port of trycua/cua's
// cursor-overlay/src/render_state.rs `tick_swift_constants` + `apply_command_base`
// (MoveTo) + `paint_cursor` / `draw_default_arrow`, plus motion.rs defaults.
//
// This is the HEART of the "Codex-style" cursor feel: a MoveTo plans a Dubins
// glide path, a smootherstep speed profile drives along it (300→900→200 pts/s),
// then a spring-damper settles at the target.
// The real system cursor is NEVER touched — this only paints a fake cursor into a
// click-through overlay (see the empirical 0px-move finding).
//
// All units are logical points. The caller scales the canvas by devicePixelRatio
// once, then paints in logical px.
import { planPath, PlannedPath } from './dubins.js';
import { makaBrandPalette, type Palette, type Rgb, rgba } from './palette.js';

const PI = Math.PI;

// motion.rs Default (macOS reference constants used by tick_swift_constants).
const TURN_RADIUS = 80;
const PEAK_SPEED = 900;
const MIN_START_SPEED = 300;
const MIN_END_SPEED = 200;
const SPRING_K = 400;
const SPRING_C = 38;
const SPRING_OVERSHOOT = 0.15;
const ARROW_TIP_LENGTH = 14;
const SENTINEL = -200; // off-screen start; paint hidden while pos.x < -100

/** Resting arrow heading: 45° so the tip points up-left like a normal cursor. */
const REST_HEADING = PI / 4;

interface Spring { ox: number; oy: number; vx: number; vy: number; }

export class CursorEngine {
  pos: [number, number] = [SENTINEL, SENTINEL];
  heading = REST_HEADING;
  private path: PlannedPath | null = null;
  private dist = 0;
  private spring: Spring | null = null;
  private springTgt: [number, number, number] | null = null;
  private clickT: number | null = null;
  private clickPoint: [number, number] | null = null;
  private clickOnArrive = false;
  pressed = false;
  private palette: Palette = makaBrandPalette();

  setSession(_sessionId: string): void {
    this.palette = makaBrandPalette();
  }
  setPalette(p: Palette): void {
    this.palette = p;
  }

  /** Queue a glide to (x,y). The cursor arrow always rests at REST_HEADING
   *  (tip up-left, standard macOS cursor). `clickOnArrive` fires the click
   *  pulse the moment the cursor lands. */
  moveTo(x: number, y: number, endHeading: number = REST_HEADING, clickOnArrive = false): void {
    // Snap out of spring before planning a new path — otherwise the engine
    // starts from an oscillating position, causing a visible jitter.
    if (this.spring && this.springTgt) {
      this.pos = [this.springTgt[0], this.springTgt[1]];
      this.heading = this.springTgt[2];
      this.spring = null;
      this.springTgt = null;
    }

    // Shift the target so the arrow TIP (not center) lands at
    // (x,y) when the arrow rests at endHeading (tip up-left).
    const tx = x + Math.cos(endHeading) * ARROW_TIP_LENGTH;
    const ty = y + Math.sin(endHeading) * ARROW_TIP_LENGTH;
    if (clickOnArrive) this.clickPoint = [x, y];

    if (this.pos[0] < -50) {
      // First appearance: start off-screen, facing TOWARD the target so the
      // Dubins path glides straight in instead of looping backward.
      this.pos = [tx - 240, ty - 170];
      const toTarget = Math.atan2(ty - this.pos[1], tx - this.pos[0]);
      this.heading = toTarget - PI;
    } else if (!this.path) {
      // At rest: override departure heading to face the target. Without this
      // the cursor departs at REST_HEADING (up-left) regardless of target
      // direction, creating a U-turn for any target that isn't up-left.
      const toTarget = Math.atan2(ty - this.pos[1], tx - this.pos[0]);
      this.heading = toTarget - PI;
    }

    const [x0, y0] = this.pos;
    const th0 = this.heading + PI;
    // Arrive at the standard cursor heading (tip up-left). The scaled turn
    // radius keeps the final arc small for short distances.
    const th1 = endHeading + PI;
    // Scale turn radius with distance: R=80 is fine for long moves but creates
    // tight loops for short ones (50px move, R=80 → arc 250px).
    const dist = Math.hypot(tx - x0, ty - y0);
    const radius = Math.max(8, Math.min(TURN_RADIUS, dist / 2.5));
    this.path = planPath(x0, y0, th0, tx, ty, th1, endHeading, radius);
    this.dist = 0;
    this.spring = null;
    this.springTgt = null;
    this.clickOnArrive = clickOnArrive;
  }

  /** Fire the expanding click-pulse ring (and optionally hold pressed). */
  triggerClick(x?: number, y?: number): void {
    if (typeof x === 'number' && typeof y === 'number' && this.pos[0] < -50) {
      this.pos = [x, y];
    }
    if (typeof x === 'number' && typeof y === 'number') {
      this.clickPoint = [x, y];
    }
    this.clickT = 0;
  }

  /** True while a glide, spring settle, or click pulse is in progress. */
  isMoving(): boolean {
    return this.path !== null || this.spring !== null || this.clickT !== null;
  }
  isVisible(): boolean {
    return this.pos[0] >= -100;
  }

  /** Advance the animation by dt seconds. */
  tick(dt: number): void {
    if (this.path) {
      const pathLen = Math.max(this.path.length, 1);
      const u = Math.min(this.dist / pathLen, 1);
      const profile = (30 * u * u * (1 - u) * (1 - u)) / 1.875; // smootherstep, peak 1.0 @ u=0.5
      const floor = u < 0.5 ? MIN_START_SPEED : MIN_END_SPEED;
      const speed = floor + (PEAK_SPEED - floor) * profile;
      this.dist += speed * dt;
      if (this.dist >= pathLen) {
        const end = this.path.sample(pathLen);
        const endHeading = this.path.endVisualHeading;
        const vh = end.heading;
        this.spring = { ox: 0, oy: 0, vx: speed * SPRING_OVERSHOOT * Math.cos(vh), vy: speed * SPRING_OVERSHOOT * Math.sin(vh) };
        this.springTgt = [end.x, end.y, endHeading];
        this.pos = [end.x, end.y];
        this.heading = endHeading;
        this.path = null;
        this.dist = 0;
        if (this.clickOnArrive) {
          this.clickT = 0;
          this.clickOnArrive = false;
        }
      } else {
        const s = this.path.sample(this.dist);
        this.pos = [s.x, s.y];
        this.heading = s.heading + PI; // tip tracks the trajectory
      }
    } else if (this.spring && this.springTgt) {
      const [tx, ty, th] = this.springTgt;
      const s = this.spring;
      const sdt = dt / 4;
      for (let i = 0; i < 4; i++) {
        s.vx += (-SPRING_K * s.ox - SPRING_C * s.vx) * sdt;
        s.vy += (-SPRING_K * s.oy - SPRING_C * s.vy) * sdt;
        s.ox += s.vx * sdt;
        s.oy += s.vy * sdt;
      }
      this.pos = [tx + s.ox, ty + s.oy];
      this.heading = th;
      if (Math.hypot(s.ox, s.oy) < 0.3 && Math.hypot(s.vx, s.vy) < 2.0) {
        this.pos = [tx, ty];
        this.spring = null;
        this.springTgt = null;
      }
    }
    if (this.clickT !== null) {
      const next = this.clickT + dt * 4; // full pulse over 0.25s
      if (next >= 1) {
        this.clickT = null;
        this.clickPoint = null;
      } else {
        this.clickT = next;
      }
    }
  }

  /** Paint the cursor into a 2D context. (px,py) = pos − origin, in logical px. */
  paint(ctx: CanvasRenderingContext2D, originX: number, originY: number): void {
    if (!this.isVisible()) return;
    const px = this.pos[0] - originX;
    const py = this.pos[1] - originY;
    const p = this.palette;

    // --- Bloom (radial gradient behind the cursor) ---
    const bloomR = this.pressed ? 34 : 22;
    const grad = ctx.createRadialGradient(px, py, 0, px, py, bloomR);
    grad.addColorStop(0, rgba(p.bloomInner, 115 / 255));
    grad.addColorStop(0.5, rgba(p.bloomOuter, 26 / 255));
    grad.addColorStop(1, rgba(p.bloomOuter, 0));
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(px, py, bloomR, 0, 2 * PI);
    ctx.fill();

    // --- Pressed state (dot + ring) ---
    if (this.pressed) {
      ctx.fillStyle = rgba(p.cursorMid, 110 / 255);
      ctx.beginPath();
      ctx.arc(px, py, 6.5, 0, 2 * PI);
      ctx.fill();
      ctx.strokeStyle = rgba(p.cursorMid, 210 / 255);
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(px, py, 13, 0, 2 * PI);
      ctx.stroke();
    }

    // --- Click pulse ring ---
    if (this.clickT !== null) {
      const t = this.clickT;
      const ringR = (bloomR + 20 * t) * (1 - t * 0.5);
      const ringX = (this.clickPoint?.[0] ?? this.pos[0]) - originX;
      const ringY = (this.clickPoint?.[1] ?? this.pos[1]) - originY;
      ctx.strokeStyle = rgba(p.cursorMid, (1 - t) * 180 / 255);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(ringX, ringY, ringR, 0, 2 * PI);
      ctx.stroke();
    }

    // --- Arrow glyph (procedural, gradient tip→tail, white outline) ---
    this.paintArrow(ctx, px, py);
  }

  private paintArrow(ctx: CanvasRenderingContext2D, px: number, py: number): void {
    const verts: ReadonlyArray<readonly [number, number]> = [[14, 0], [-8, -9], [-3, 0], [-8, 9]];
    const angle = this.heading + PI; // tip points along motion (draw_default_arrow)
    const ca = Math.cos(angle), sa = Math.sin(angle);
    const pts = verts.map(([vx, vy]) => [px + ca * vx - sa * vy, py + sa * vx + ca * vy] as const);
    const p = this.palette;
    const tip = pts[0];
    const tail: readonly [number, number] = [(pts[1][0] + pts[3][0]) / 2, (pts[1][1] + pts[3][1]) / 2];

    ctx.beginPath();
    ctx.moveTo(tip[0], tip[1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();

    const g = ctx.createLinearGradient(tip[0], tip[1], tail[0], tail[1]);
    const c = (rgb: Rgb): string => rgba(rgb, 1);
    g.addColorStop(0.0, c(p.cursorStart));
    g.addColorStop(0.53, c(p.cursorMid));
    g.addColorStop(1.0, c(p.cursorEnd));
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,1)';
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }
}
