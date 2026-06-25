/**
 * Centralized icon re-export — the single seam between Maka's call
 * sites and the underlying icon library.
 *
 * PR-ICON-SET-MAPPING-LAYER-0 step 1 (WAWQAQ msg `265c1636` / `37fcbd95`):
 * built the central re-export so every call site stops touching the
 * library directly.
 *
 * PR-ICON-SET-MAPPING-LAYER-0 step 2 (WAWQAQ msgs `88ae79a5` / `53735cec`):
 * swapped the underlying library from Lucide React to Phosphor Icons
 * via Iconify (`@iconify/react` + `@iconify-json/ph`). WAWQAQ picked
 * Phosphor for visual style ("calm desktop") + Iconify as the access
 * layer for future flexibility — switching from Phosphor to Hugeicons
 * / Tabler / Iconoir later is now a single per-line change in the
 * mapping table below (`ph:gear` → `hugeicons:settings-02`).
 *
 * Why per-name React component wrappers (instead of `<Icon icon="…" />`
 * at call sites):
 *   - call sites keep the Lucide-shaped JSX: `<Settings size={16} />`
 *     — zero diff in the 1500+ icon usages across the renderer
 *   - IDE jump-to-def still works (jumps to this file)
 *   - swapping a single icon is one line here, no call-site touches
 *
 * Icons are registered offline via `addCollection(phData)` at module
 * load — no CDN fetch at runtime (Electron desktop, possibly offline).
 *
 * `LucideIcon` / `LucideProps` types are kept under their original
 * Lucide* names so the migration from Lucide React component types to
 * an Iconify-backed wrapper is invisible to call sites that destructure
 * them. New code should still use those names for now; renaming them
 * is deferred to a future PR.
 */

import { Icon, addCollection } from '@iconify/react';
import { icons as phData } from '@iconify-json/ph';
import {
  MAKA_BOT_ICON_BODIES,
  MAKA_BOT_ICON_PREFIX,
} from './bot-brand-icons.js';
import type { ComponentType } from 'react';

// Register the Phosphor icon collection once at module load so every
// `<Icon icon="ph:…">` renders synchronously without a CDN fetch.
addCollection(phData);

// Register the local bot brand SVG collection so
// `<IconifyIcon icon="maka-bot:telegram">` etc. resolve synchronously,
// without hitting `api.iconify.design` at runtime. See
// `bot-brand-icons.ts` for the source provenance and why only 4 of the
// 6 bot brands are local today (kenji audit msg `e4cfbfb0` round-2 #2).
addCollection({
  prefix: MAKA_BOT_ICON_PREFIX,
  width: 24,
  height: 24,
  icons: Object.fromEntries(
    Object.entries(MAKA_BOT_ICON_BODIES).map(([name, body]) => [name, { body }]),
  ),
});

/**
 * Re-export of `@iconify/react`'s `<Icon>` for cases where a caller
 * needs to render an arbitrary Iconify id (e.g. `simple-icons:wechat`
 * for the bot-settings brand logos) without taking a direct dependency
 * on `@iconify/react` from the consuming workspace.
 *
 * Icons NOT pre-registered above (everything outside `ph:*`) are
 * lazy-fetched from the Iconify CDN on first render and then cached by
 * the Iconify runtime. Use this sparingly — pin a real brand icon
 * collection (`@iconify-json/simple-icons` etc.) if a surface ends up
 * needing many or needs offline rendering.
 */
export { Icon as IconifyIcon } from '@iconify/react';

/** Phosphor weight options.
 *   `'thin'`    — `ph:gear-thin` (very light strokes)
 *   `'light'`   — `ph:gear-light` (matches old Lucide stroke ~1.5)
 *   `'regular'` — `ph:gear` (default, matches old Lucide stroke ~1.8-2)
 *   `'bold'`    — `ph:gear-bold` (heavier emphasis)
 *   `'fill'`    — `ph:gear-fill` (solid silhouette)
 *   `'duotone'` — `ph:gear-duotone` (two-tone accent style)
 *
 * Default is `'regular'`. Call sites can override per icon when they
 * want a specific weight (e.g. `<Settings weight="light" />`). */
export type PhosphorWeight = 'thin' | 'light' | 'regular' | 'bold' | 'fill' | 'duotone';

/* Lucide-React-compatible props.
   - `size`: number or string. Wires to width+height (1:1).
   - `weight`: Phosphor stroke weight. Maps to the icon name suffix
     (`-thin` / `-light` / `-bold` / `-fill` / `-duotone`) or to the
     bare `ph:gear` for `'regular'`. Default `'regular'`.
   - `strokeWidth`: legacy Lucide prop. Coerced to `weight` only when
     `weight` is not explicitly set — this preserves visual continuity
     for call sites that still pass `strokeWidth={1.5}` etc.
       strokeWidth ≤ 1.0 → weight 'thin'
       strokeWidth ≤ 1.6 → weight 'light' (≈ old Lucide 1.5)
       strokeWidth ≤ 2.0 → weight 'regular'
       strokeWidth > 2.0 → weight 'bold'
   - `color`, `className`, `aria-*`, SVG attrs: pass-through.
   - `ref`: not forwarded — Iconify's <Icon> doesn't accept it. */
export type LucideProps = {
  size?: number | string;
  strokeWidth?: number | string;
  weight?: PhosphorWeight;
  color?: string;
  className?: string;
  'aria-label'?: string;
  'aria-hidden'?: boolean | 'true' | 'false';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
};

export type LucideIcon = ComponentType<LucideProps>;

function strokeWidthToWeight(stroke: number | string | undefined): PhosphorWeight | undefined {
  if (stroke === undefined) return undefined;
  const n = typeof stroke === 'number' ? stroke : parseFloat(stroke);
  if (!Number.isFinite(n)) return undefined;
  if (n <= 1.0) return 'thin';
  if (n <= 1.6) return 'light';
  if (n <= 2.0) return 'regular';
  return 'bold';
}

function makeIcon(phosphorName: string): LucideIcon {
  function MakaIcon(props: LucideProps) {
    const { size, strokeWidth, weight, ...rest } = props;
    const dim = size ?? '1em';
    const resolvedWeight = weight ?? strokeWidthToWeight(strokeWidth) ?? 'regular';
    const iconName = resolvedWeight === 'regular' ? phosphorName : `${phosphorName}-${resolvedWeight}`;
    return <Icon icon={iconName} width={dim} height={dim} {...rest} />;
  }
  // Surface a stable name for React DevTools and snapshot tests.
  MakaIcon.displayName = `MakaIcon(${phosphorName})`;
  return MakaIcon as LucideIcon;
}

/* Lucide name → Phosphor (`ph:`) name mapping.
   Curated against phosphoricons.com / icones.js.org/collection/ph.
   When swapping the underlying set later (e.g. `ph:gear` →
   `hugeicons:settings-02`), edit only the right-hand strings.
   The `*Icon` suffix variants reuse the same Phosphor names because
   Lucide exposes them as identical-asset aliases. */

// Self-review: `ph:accessibility` doesn't exist in @iconify-json/ph;
// `ph:wheelchair` is the closest equivalent. Verified via
// `Object.keys(phData.icons).includes('wheelchair')` and pinned by
// the new `every makeIcon ph:* arg resolves` contract test.
export const Accessibility = makeIcon('ph:wheelchair');
export const Activity = makeIcon('ph:activity');
export const AlertCircle = makeIcon('ph:warning-circle');
export const AlertOctagon = makeIcon('ph:warning-octagon');
export const AlertTriangle = makeIcon('ph:warning');
export const Archive = makeIcon('ph:archive');
// PR-FRONTEND-AUDIT-CLEANUP-0 F2 (WAWQAQ msg `dde696a1`): Phosphor's
// `archive-box` glyph is visually identical to `ph:archive`, so the
// session-row's archive ↔ restore toggle rendered the same icon in
// both states (only the hover title differed). `ph:box-arrow-up`
// reads as "box with an outbound arrow" — clearly the inverse of
// archive. Restore affordance is now visible at a glance.
export const ArchiveRestore = makeIcon('ph:box-arrow-up');
export const ArrowDown = makeIcon('ph:arrow-down');
export const ArrowLeft = makeIcon('ph:arrow-left');
export const ArrowRight = makeIcon('ph:arrow-right');
export const ArrowUp = makeIcon('ph:arrow-up');
export const Ban = makeIcon('ph:prohibit');
export const BarChart3 = makeIcon('ph:chart-bar');
export const Bell = makeIcon('ph:bell');
export const BookOpen = makeIcon('ph:book-open');
export const Bot = makeIcon('ph:robot');
export const Brain = makeIcon('ph:brain');
export const CalendarDays = makeIcon('ph:calendar-dots');
export const Check = makeIcon('ph:check');
export const CheckCircle2 = makeIcon('ph:check-circle');
export const ChevronDown = makeIcon('ph:caret-down');
export const ChevronLeft = makeIcon('ph:caret-left');
export const ChevronRight = makeIcon('ph:caret-right');
export const CircleCheckBig = makeIcon('ph:check-circle');
export const CircleGauge = makeIcon('ph:gauge');
export const Clipboard = makeIcon('ph:clipboard');
export const Clock = makeIcon('ph:clock');
export const Copy = makeIcon('ph:copy');
export const CornerDownLeft = makeIcon('ph:arrow-elbow-down-left');
export const Cpu = makeIcon('ph:cpu');
export const Database = makeIcon('ph:database');
export const Download = makeIcon('ph:download-simple');
export const Eye = makeIcon('ph:eye');
export const EyeOff = makeIcon('ph:eye-slash');
export const FileCode = makeIcon('ph:file-code');
// Self-review: `ph:file-pencil` doesn't exist; `ph:note-pencil` is
// the closest equivalent (file glyph with a pencil overlay).
export const FileEdit = makeIcon('ph:note-pencil');
export const FileImage = makeIcon('ph:file-image');
export const FileText = makeIcon('ph:file-text');
export const FileType = makeIcon('ph:file-doc');
export const Flag = makeIcon('ph:flag');
export const FolderOpen = makeIcon('ph:folder-open');
export const GitBranch = makeIcon('ph:git-branch');
export const GitMerge = makeIcon('ph:git-merge');
export const Globe = makeIcon('ph:globe');
export const Grid3X3 = makeIcon('ph:grid-four');
export const HelpCircle = makeIcon('ph:question');
export const Hourglass = makeIcon('ph:hourglass');
export const Info = makeIcon('ph:info');
export const KeyRound = makeIcon('ph:key');
export const Keyboard = makeIcon('ph:keyboard');
export const LineChart = makeIcon('ph:chart-line');
export const Loader2 = makeIcon('ph:spinner');
export const MessageCircleQuestion = makeIcon('ph:chat-circle-dots');
export const MessageSquare = makeIcon('ph:chat');
export const Mic = makeIcon('ph:microphone');
export const Monitor = makeIcon('ph:monitor');
export const Moon = makeIcon('ph:moon');
export const MoreHorizontal = makeIcon('ph:dots-three');
export const MousePointer2 = makeIcon('ph:cursor');
export const Network = makeIcon('ph:network');
export const Palette = makeIcon('ph:palette');
export const PanelLeftClose = makeIcon('ph:sidebar-simple');
export const PanelLeftOpen = makeIcon('ph:sidebar');
export const Paperclip = makeIcon('ph:paperclip');
export const Pencil = makeIcon('ph:pencil-simple');
export const Pin = makeIcon('ph:push-pin');
export const PinOff = makeIcon('ph:push-pin-slash');
export const Plug = makeIcon('ph:plug');
export const Plus = makeIcon('ph:plus');
export const RefreshCcw = makeIcon('ph:arrows-counter-clockwise');
export const Repeat = makeIcon('ph:repeat');
export const RotateCcw = makeIcon('ph:arrow-counter-clockwise');
export const RotateCw = makeIcon('ph:arrow-clockwise');
export const Save = makeIcon('ph:floppy-disk');
export const Search = makeIcon('ph:magnifying-glass');
export const Settings = makeIcon('ph:gear');
export const ShieldAlert = makeIcon('ph:shield-warning');
export const ShieldCheck = makeIcon('ph:shield-check');
export const Sparkles = makeIcon('ph:sparkle');
export const SquarePen = makeIcon('ph:pencil-simple-line');
export const Sun = makeIcon('ph:sun');
export const SunMoon = makeIcon('ph:sun-horizon');
export const Terminal = makeIcon('ph:terminal');
export const Trash2 = makeIcon('ph:trash');
export const User = makeIcon('ph:user');
export const Volume2 = makeIcon('ph:speaker-high');
export const Wifi = makeIcon('ph:wifi-high');
export const X = makeIcon('ph:x');

// `*Icon` suffix aliases used by shadcn-style primitives (each just
// re-points at the same Phosphor asset as its non-suffix sibling).
export const ChevronLeftIcon = ChevronLeft;
export const ChevronRightIcon = ChevronRight;
export const ChevronsUpDownIcon = makeIcon('ph:caret-up-down');
export const Loader2Icon = Loader2;
export const MoreHorizontalIcon = MoreHorizontal;
export const PanelLeftIcon = PanelLeftOpen;
export const SearchIcon = Search;
export const XIcon = X;
