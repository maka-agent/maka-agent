// Agent-cursor colour palettes — faithful 1:1 port of trycua/cua's
// cursor-overlay/src/palette.rs (itself a port of AgentCursorPalette.cs).
// Colours are [R,G,B] 0-255. The overlay picks a palette from the session id so
// distinct agent runs are visually distinct but a given id is stable.
export type Rgb = readonly [number, number, number];

export interface Palette {
  name: string;
  /** Tip colour (lightest, gradient position 0.0). */
  cursorStart: Rgb;
  /** Mid-gradient colour (position 0.53). */
  cursorMid: Rgb;
  /** Tail colour (position 1.0). */
  cursorEnd: Rgb;
  /** Outer bloom layer. */
  bloomOuter: Rgb;
  /** Inner bloom layer (brighter core). */
  bloomInner: Rgb;
}

type PaletteData = readonly [string, Rgb, Rgb, Rgb, Rgb, Rgb];

// (name, cursorStart, cursorMid, cursorEnd, bloomOuter, bloomInner)
const PALETTE_DATA: readonly PaletteData[] = [
  ['default_blue', [219, 238, 255], [94, 192, 232], [84, 205, 160], [188, 232, 252], [238, 248, 255]],
  ['soft_purple', [238, 226, 255], [178, 132, 255], [118, 194, 255], [214, 188, 255], [246, 238, 255]],
  ['rose_gold', [255, 231, 238], [247, 132, 170], [255, 181, 108], [255, 190, 211], [255, 243, 232]],
  ['mint_lime', [226, 255, 240], [96, 218, 174], [178, 229, 72], [178, 245, 217], [241, 255, 231]],
  ['amber', [255, 244, 214], [244, 178, 66], [255, 126, 92], [255, 219, 140], [255, 248, 225]],
  ['aqua', [221, 252, 255], [76, 204, 224], [63, 222, 166], [172, 241, 249], [236, 255, 251]],
  ['orchid', [252, 228, 255], [221, 113, 236], [255, 139, 196], [237, 181, 246], [255, 239, 252]],
  ['crimson', [255, 226, 226], [232, 82, 98], [150, 94, 255], [255, 168, 178], [255, 240, 241]],
  ['chartreuse', [247, 255, 218], [184, 220, 54], [72, 190, 119], [224, 247, 128], [249, 255, 232]],
  ['cobalt', [226, 235, 255], [80, 126, 236], [91, 219, 222], [170, 195, 255], [239, 246, 255]],
];

function fromData(d: PaletteData): Palette {
  return { name: d[0], cursorStart: d[1], cursorMid: d[2], cursorEnd: d[3], bloomOuter: d[4], bloomInner: d[5] };
}

export function defaultPalette(): Palette {
  return fromData(PALETTE_DATA[0]);
}

/**
 * Maka's brand cursor palette, derived from the app's primary token
 * `--action` = oklch(0.62 0.19 264) (a blue/indigo). Gradient tip→tail around it
 * plus a soft brand bloom, so the agent cursor reads as "Maka" rather than a
 * random per-session hue. (FOLLOW-UP: thread the live --primary from the renderer
 * so it tracks theme changes instead of this baked snapshot.)
 */
export function makaBrandPalette(): Palette {
  return {
    name: 'maka_brand',
    cursorStart: [144, 182, 255], // lightest at the tip
    cursorMid: [73, 126, 247], // the primary
    cursorEnd: [71, 97, 228], // deeper at the tail
    bloomOuter: [157, 189, 255],
    bloomInner: [212, 229, 255],
  };
}

/**
 * Select a palette for an instance id using the same stable-hash logic as the
 * Rust `Palette::for_instance` (a port of C# `AgentCursorPalette.ForInstance`).
 * Same id → same colour, always.
 */
export function paletteForInstance(instanceId: string): Palette {
  if (instanceId === '' || instanceId === 'default') return defaultPalette();
  const exact = PALETTE_DATA.find((d) => d[0] === instanceId);
  if (exact) return fromData(exact);
  const alternates = PALETTE_DATA.slice(1); // all except default_blue
  return fromData(alternates[stableIndex(instanceId, alternates.length)]);
}

function stableIndex(id: string, count: number): number {
  const sepIdx = Math.max(id.lastIndexOf('-'), id.lastIndexOf('_'), id.lastIndexOf('.'));
  const suffix = sepIdx >= 0 ? id.slice(sepIdx + 1) : id;
  const n = Number.parseInt(suffix, 10);
  if (Number.isInteger(n) && String(n) === suffix.trim() && n > 0) return (n - 1) % count;
  if (suffix.length === 1) {
    const c = suffix.toLowerCase().charCodeAt(0);
    if (c >= 97 && c <= 122) return (c - 97) % count;
  }
  // FNV-1a over the full id.
  let hash = 2_166_136_261 >>> 0;
  for (const ch of id) {
    hash ^= ch.codePointAt(0)!;
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  return hash % count;
}

const lerp = (a: number, b: number, t: number): number => Math.round(a + (b - a) * t);

/** Lerp cursorStart → cursorMid → cursorEnd at t ∈ [0,1] (mid at 0.53). */
export function gradientAt(p: Palette, t: number): Rgb {
  const c = Math.min(1, Math.max(0, t));
  if (c <= 0.53) {
    const u = c / 0.53;
    return [lerp(p.cursorStart[0], p.cursorMid[0], u), lerp(p.cursorStart[1], p.cursorMid[1], u), lerp(p.cursorStart[2], p.cursorMid[2], u)];
  }
  const u = (c - 0.53) / 0.47;
  return [lerp(p.cursorMid[0], p.cursorEnd[0], u), lerp(p.cursorMid[1], p.cursorEnd[1], u), lerp(p.cursorMid[2], p.cursorEnd[2], u)];
}

export const rgba = (c: Rgb, a: number): string => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
