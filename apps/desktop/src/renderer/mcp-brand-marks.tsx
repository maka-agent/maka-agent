// Official MCP catalog brand marks.
//
// Each mark is sourced from the `simple-icons` library — the de-facto brand
// icon set (official path geometry + official brand hex + CC0 licence). We use
// per-icon *named* ESM imports so the bundler tree-shakes the multi-thousand
// icon catalog down to only the marks we render (verified against the
// dist-renderer chunk size). Lucide deliberately ships no brand icons, so these
// marks come from simple-icons rather than the @maka/ui/icons lucide funnel.
//
// Rendering: each mark is a 24×24 `<svg>` MOUNTING SHELL wrapping the library's
// single `<path>`. The `<svg>` element is NOT hand-drawn art — it is an inert
// container for LIBRARY-sourced path data. That is the sanctioned reason
// mcp-brand-marks.tsx sits on the icon-governance INLINE_SVG_ALLOWLIST (see
// apps/desktop/src/main/__tests__/icon-governance-contract.test.ts); the
// rot-guard still holds because this file genuinely contains an inline `<svg>`.
//
// Colour: light theme fills each mark with its official brand hex (`si.hex`).
// Dark theme: marks whose brand hex is too dark to read on the neutral plate
// fall back to `currentColor` via shouldUseCurrentColorOnDark() — a pure,
// unit-tested luminance gate that lives in ./mcp-brand-contrast so it can be
// exercised without JSX. Tiles keep the #1205 neutral-plate recipe.
//
// simple-icons does not carry 钉钉 (DingTalk) or 飞书 (Lark/Feishu) in any
// released version, so those entries keep the catalog text mark. macOS ⌘,
// filesystem, memory and the other generic entries are non-brand and stay on
// their lucide/glyph text marks by design.

import type { CSSProperties, ReactElement } from 'react';
import type { SimpleIcon } from 'simple-icons';
import { siFigma, siGooglecalendar, siLine, siNotion, siSlack, siSupabase, siVercel } from 'simple-icons';
import { shouldUseCurrentColorOnDark } from './mcp-brand-contrast.js';
import type { McpCatalogEntry } from './mcp-catalog';

// Catalog id → simple-icons member. Only ids present here render a real library
// mark (and drive the neutral `data-logo` plate in mcp-page.tsx); every other
// entry falls back to its text mark.
const MCP_BRAND_ICONS: Record<string, SimpleIcon> = {
  slack: siSlack,
  line: siLine,
  'google-calendar': siGooglecalendar,
  figma: siFigma,
  vercel: siVercel,
  supabase: siSupabase,
  notion: siNotion,
};

/** True when the catalog entry has a simple-icons library brand mark. */
export function hasMcpBrandMark(id: string): boolean {
  return id in MCP_BRAND_ICONS;
}

/**
 * Official brand mark for a catalog entry. Renders the simple-icons library
 * mark when one exists; otherwise falls back to the entry's text mark.
 */
export function McpBrandMark({ entry }: { entry: McpCatalogEntry }): ReactElement {
  const icon = MCP_BRAND_ICONS[entry.id];
  if (!icon) return <span>{entry.mark}</span>;
  const hex = `#${icon.hex}`;
  // Light theme paints the brand hex; the `.dark` plate flips low-contrast
  // marks to currentColor (see mcp.css). Custom property carries the hex so
  // the theme switch is pure CSS, no re-render.
  const style = { '--mcp-brand-fill': hex } as CSSProperties;
  return (
    <svg
      className="maka-mcp-brand-mark"
      viewBox="0 0 24 24"
      aria-hidden="true"
      style={style}
      data-contrast={shouldUseCurrentColorOnDark(hex) ? 'low' : undefined}
    >
      <path d={icon.path} />
    </svg>
  );
}
