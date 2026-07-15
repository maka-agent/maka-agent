// Agent-cursor render engine. The arrow and palette derive from trycua/cua's
// cursor overlay; Maka owns the direct-motion and backend-hotspot semantics.
//
// MoveTo uses a direct smootherstep glide (300→900→200 pts/s). Pointer actions
// snap to the backend coordinate; only explicit mouse_move requests animate.
// The real system cursor is NEVER touched — this only paints a fake cursor into a
// click-through overlay (see the empirical 0px-move finding).
//
// All units are logical points. The caller scales the canvas by devicePixelRatio
// once, then paints in logical px.
import { planDirectPath, PlannedPath } from './dubins.js';
import { makaBrandPalette, type Palette, type Rgb, rgba } from './palette.js';

const PI = Math.PI;

const PEAK_SPEED = 900;
const MIN_START_SPEED = 300;
const MIN_END_SPEED = 200;
const ARROW_TIP_LENGTH = 14;
const SENTINEL = -200; // off-screen start; paint hidden while pos.x < -100

/** Resting arrow heading: 45° so the tip points up-left like a normal cursor. */
const REST_HEADING = PI / 4;

export class CursorEngine {
  pos: [number, number] = [SENTINEL, SENTINEL];
  heading = REST_HEADING;
  private path: PlannedPath | null = null;
  private dist = 0;
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
    // Shift the target so the arrow TIP (not center) lands at
    // (x,y) when the arrow rests at endHeading (tip up-left).
    const tx = x + Math.cos(endHeading) * ARROW_TIP_LENGTH;
    const ty = y + Math.sin(endHeading) * ARROW_TIP_LENGTH;
    if (clickOnArrive) this.clickPoint = [x, y];

    if (this.pos[0] < -50) {
      // First appearance starts off-screen and glides directly into view.
      this.pos = [tx - 240, ty - 170];
    }

    const [x0, y0] = this.pos;
    this.path = planDirectPath(x0, y0, tx, ty, endHeading);
    this.dist = 0;
    this.clickOnArrive = clickOnArrive;
  }

  /** Snap the arrow tip to the coordinate where backend execution completed. */
  completeAt(x: number, y: number, pulse = false, endHeading: number = REST_HEADING): void {
    this.pos = [
      x + Math.cos(endHeading) * ARROW_TIP_LENGTH,
      y + Math.sin(endHeading) * ARROW_TIP_LENGTH,
    ];
    this.heading = endHeading;
    this.path = null;
    this.dist = 0;
    this.clickOnArrive = false;
    this.pressed = false;
    this.clickT = null;
    this.clickPoint = null;
    if (pulse) this.triggerClick(x, y);
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

  /** True while a direct glide or click pulse is in progress. */
  isMoving(): boolean {
    return this.path !== null || this.clickT !== null;
  }
  isVisible(): boolean {
    return this.pos[0] >= -100;
  }
  motionProgress(): number {
    if (!this.path) return 1;
    return Math.min(1, this.dist / Math.max(this.path.length, 1));
  }
  motionDistanceRemaining(): number {
    if (!this.path) return 0;
    return Math.max(0, this.path.length - this.dist);
  }
  hasMotionPath(): boolean {
    return this.path !== null;
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
    const hotspotX = px - Math.cos(this.heading) * ARROW_TIP_LENGTH;
    const hotspotY = py - Math.sin(this.heading) * ARROW_TIP_LENGTH;
    const p = this.palette;

    // --- Bloom (centered on the arrow hotspot / backend action point) ---
    const bloomR = this.pressed ? 34 : 22;
    const grad = ctx.createRadialGradient(hotspotX, hotspotY, 0, hotspotX, hotspotY, bloomR);
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
      ctx.arc(hotspotX, hotspotY, 6.5, 0, 2 * PI);
      ctx.fill();
      ctx.strokeStyle = rgba(p.cursorMid, 210 / 255);
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(hotspotX, hotspotY, 13, 0, 2 * PI);
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
