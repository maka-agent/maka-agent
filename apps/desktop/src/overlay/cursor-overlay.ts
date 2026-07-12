// Overlay renderer entry — hosts the ported CursorEngine on a full-window canvas.
// Receives MAIN-computed, window-local coordinates over a one-way bridge and
// animates the agent cursor. Display-only: it never sends anything back (S15).
// The rAF loop blocks on idle (stops when the engine is at rest; the last frame
// persists), so a resting cursor costs no CPU.
import { CursorEngine } from '../renderer/computer-use-overlay/engine/cursor-engine.js';

interface MovePayload { x: number; y: number; kind?: 'move' | 'click' | 'drag' | 'scroll'; pressed?: boolean }
interface ResetPayload { sessionColorId?: string }
declare global {
  interface Window {
    cursorOverlay?: {
      onMove(cb: (p: MovePayload) => void): void;
      onReset(cb: (p: ResetPayload) => void): void;
    };
  }
}

const canvas = document.getElementById('cursor') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
let dpr = window.devicePixelRatio || 1;

function resize(): void {
  dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(window.innerWidth * dpr);
  canvas.height = Math.floor(window.innerHeight * dpr);
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight}px`;
}
resize();
window.addEventListener('resize', resize);

const engine = new CursorEngine();
let running = false;
let last = 0;

function loop(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  engine.tick(dt);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  engine.paint(ctx, 0, 0); // MAIN sends window-local coords, so origin is (0,0)
  if (engine.isMoving()) {
    requestAnimationFrame(loop);
  } else {
    running = false; // block on idle — leave the last frame painted
  }
}
function kick(): void {
  if (!running) {
    running = true;
    last = performance.now();
    requestAnimationFrame(loop);
  }
}

window.cursorOverlay?.onReset((p) => {
  engine.setSession(p.sessionColorId ?? '');
  kick();
});
window.cursorOverlay?.onMove((p) => {
  const isClick = p.kind === 'click' || p.kind === 'drag';
  engine.moveTo(p.x, p.y, undefined, isClick); // glide there; pulse on arrival for clicks
  engine.pressed = p.pressed === true;
  kick();
});
