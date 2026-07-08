// Dubins path planner — faithful 1:1 port of trycua/cua's
// cursor-overlay/src/path_planner.rs (itself a port of the Swift AgentCursorRenderer).
// Plans a minimum-turning-radius arc–straight–arc path from (x0,y0,th0) to
// (x1,y1,th1) with turn radius R, then samples it at any arc-length. The curved,
// banked approach — not a straight line — is what gives the cursor its drift-in feel.
const PI = Math.PI;
const TAU = 2 * PI;

export interface PathState {
  x: number;
  y: number;
  heading: number;
}

type SegType = 'L' | 'R' | 'S';

interface DubinsSol {
  t: number;
  p: number;
  q: number;
  types: [SegType, SegType, SegType];
}

function mod2pi(x: number): number {
  const r = x - TAU * Math.floor(x / TAU);
  return r < 0 ? r + TAU : r;
}

export class PlannedPath {
  readonly length: number;
  readonly endVisualHeading: number;
  private readonly kind: 'dubins' | 'linear';
  private readonly x0: number;
  private readonly y0: number;
  private readonly th0: number;
  private readonly r: number;
  private readonly seg1: number;
  private readonly seg2: number;
  private readonly seg3: number;
  private readonly types: [SegType, SegType, SegType];
  private readonly x1: number;
  private readonly y1: number;
  private readonly th1: number;

  constructor(f: {
    length: number; endVisualHeading: number; kind: 'dubins' | 'linear';
    x0: number; y0: number; th0: number; r: number;
    seg1: number; seg2: number; seg3: number; types: [SegType, SegType, SegType];
    x1: number; y1: number; th1: number;
  }) {
    this.length = f.length; this.endVisualHeading = f.endVisualHeading; this.kind = f.kind;
    this.x0 = f.x0; this.y0 = f.y0; this.th0 = f.th0; this.r = f.r;
    this.seg1 = f.seg1; this.seg2 = f.seg2; this.seg3 = f.seg3; this.types = f.types;
    this.x1 = f.x1; this.y1 = f.y1; this.th1 = f.th1;
  }

  sample(distance: number): PathState {
    return this.kind === 'linear' ? this.sampleLinear(distance) : this.sampleDubins(distance);
  }

  private sampleLinear(s: number): PathState {
    const len = Math.max(this.length, 1);
    const u = Math.min(1, Math.max(0, s / len));
    let diff = this.th1 - this.th0;
    while (diff > PI) diff -= TAU;
    while (diff < -PI) diff += TAU;
    return { x: this.x0 + (this.x1 - this.x0) * u, y: this.y0 + (this.y1 - this.y0) * u, heading: this.th0 + diff * u };
  }

  private sampleDubins(sIn: number): PathState {
    if (sIn <= 0) return { x: this.x0, y: this.y0, heading: this.th0 };
    const r = this.r;
    const l1 = this.seg1 * r, l2 = this.seg2 * r, l3 = this.seg3 * r;
    const s = Math.min(sIn, l1 + l2 + l3);
    let x = this.x0, y = this.y0, th = this.th0;
    const advance = (len: number, seg: SegType): void => {
      if (seg === 'S') {
        x += Math.cos(th) * len;
        y += Math.sin(th) * len;
      } else {
        const dth = (len / r) * (seg === 'L' ? 1 : -1);
        const perp = seg === 'L' ? PI / 2 : -PI / 2;
        const cx = x + Math.cos(th + perp) * r;
        const cy = y + Math.sin(th + perp) * r;
        const ang = Math.atan2(y - cy, x - cx);
        x = cx + Math.cos(ang + dth) * r;
        y = cy + Math.sin(ang + dth) * r;
        th += dth;
      }
    };
    if (s <= l1) { advance(s, this.types[0]); return { x, y, heading: th }; }
    advance(l1, this.types[0]);
    if (s <= l1 + l2) { advance(s - l1, this.types[1]); return { x, y, heading: th }; }
    advance(l2, this.types[1]);
    advance(s - l1 - l2, this.types[2]);
    return { x, y, heading: th };
  }
}

function lsl(d: number, a: number, b: number): DubinsSol | null {
  const tmp0 = d + Math.sin(a) - Math.sin(b);
  const p2 = 2 + d * d - 2 * Math.cos(a - b) + 2 * d * (Math.sin(a) - Math.sin(b));
  if (p2 < 0) return null;
  const tmp1 = Math.atan2(Math.cos(b) - Math.cos(a), tmp0);
  return { t: mod2pi(-a + tmp1), p: Math.sqrt(p2), q: mod2pi(b - tmp1), types: ['L', 'S', 'L'] };
}
function rsr(d: number, a: number, b: number): DubinsSol | null {
  const tmp0 = d - Math.sin(a) + Math.sin(b);
  const p2 = 2 + d * d - 2 * Math.cos(a - b) + 2 * d * (Math.sin(b) - Math.sin(a));
  if (p2 < 0) return null;
  const tmp1 = Math.atan2(Math.cos(a) - Math.cos(b), tmp0);
  return { t: mod2pi(a - tmp1), p: Math.sqrt(p2), q: mod2pi(-b + tmp1), types: ['R', 'S', 'R'] };
}
function lsr(d: number, a: number, b: number): DubinsSol | null {
  const p2 = -2 + d * d + 2 * Math.cos(a - b) + 2 * d * (Math.sin(a) + Math.sin(b));
  if (p2 < 0) return null;
  const p = Math.sqrt(p2);
  const tmp1 = Math.atan2(-(Math.cos(a) + Math.cos(b)), d + Math.sin(a) + Math.sin(b)) - Math.atan2(-2, p);
  return { t: mod2pi(-a + tmp1), p, q: mod2pi(-mod2pi(b) + tmp1), types: ['L', 'S', 'R'] };
}
function rsl(d: number, a: number, b: number): DubinsSol | null {
  const p2 = d * d - 2 + 2 * Math.cos(a - b) - 2 * d * (Math.sin(a) + Math.sin(b));
  if (p2 < 0) return null;
  const p = Math.sqrt(p2);
  const tmp1 = Math.atan2(Math.cos(a) + Math.cos(b), d - Math.sin(a) - Math.sin(b)) - Math.atan2(2, p);
  return { t: mod2pi(a - tmp1), p, q: mod2pi(b - tmp1), types: ['R', 'S', 'L'] };
}
function rlr(d: number, a: number, b: number): DubinsSol | null {
  const tmp = (6 - d * d + 2 * Math.cos(a - b) + 2 * d * (Math.sin(a) - Math.sin(b))) / 8;
  if (Math.abs(tmp) > 1) return null;
  const p = mod2pi(TAU - Math.acos(tmp));
  const t = mod2pi(a - Math.atan2(Math.cos(a) - Math.cos(b), d - Math.sin(a) + Math.sin(b)) + p / 2);
  return { t, p, q: mod2pi(a - b - t + p), types: ['R', 'L', 'R'] };
}
function lrl(d: number, a: number, b: number): DubinsSol | null {
  const tmp = (6 - d * d + 2 * Math.cos(a - b) + 2 * d * (Math.sin(b) - Math.sin(a))) / 8;
  if (Math.abs(tmp) > 1) return null;
  const p = mod2pi(TAU - Math.acos(tmp));
  const t = mod2pi(-a + Math.atan2(-Math.cos(a) + Math.cos(b), d + Math.sin(a) - Math.sin(b)) + p / 2);
  return { t, p, q: mod2pi(mod2pi(b) - a - t + p), types: ['L', 'R', 'L'] };
}

const SOLVERS = [lsl, rsr, lsr, rsl, rlr, lrl] as const;

function planDubins(x0: number, y0: number, th0: number, x1: number, y1: number, th1: number, r: number, endVisualHeading: number): PlannedPath | null {
  const dx = x1 - x0, dy = y1 - y0;
  const dDist = Math.hypot(dx, dy);
  if (dDist < 0.5) return null;
  const d = dDist / r;
  const theta = mod2pi(Math.atan2(dy, dx));
  const a = mod2pi(th0 - theta);
  const b = mod2pi(th1 - theta);
  let bestLen = Infinity;
  let best: DubinsSol | null = null;
  for (const solver of SOLVERS) {
    const sol = solver(d, a, b);
    if (sol) {
      const len = sol.t + sol.p + sol.q;
      if (Number.isFinite(len) && len >= 0 && len < bestLen) { bestLen = len; best = sol; }
    }
  }
  if (!best) return null;
  return new PlannedPath({
    length: (best.t + best.p + best.q) * r, endVisualHeading, kind: 'dubins',
    x0, y0, th0, r, seg1: best.t, seg2: best.p, seg3: best.q, types: best.types, x1, y1, th1,
  });
}

/** Plan a Dubins cursor path; falls back to a straight line if Dubins fails. */
export function planPath(x0: number, y0: number, th0: number, x1: number, y1: number, th1: number, endVisualHeading: number, turnRadius: number): PlannedPath {
  const r = Math.max(turnRadius, 1);
  const dubins = planDubins(x0, y0, th0, x1, y1, th1, r, endVisualHeading);
  if (dubins) return dubins;
  const d = Math.max(Math.hypot(x1 - x0, y1 - y0), 1);
  return new PlannedPath({
    length: d, endVisualHeading, kind: 'linear',
    x0, y0, th0, r, seg1: 0, seg2: 0, seg3: 0, types: ['S', 'S', 'S'], x1, y1, th1,
  });
}
