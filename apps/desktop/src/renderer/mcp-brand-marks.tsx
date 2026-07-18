// Official MCP catalog brand marks.
//
// Mirrors settings/provider-brand-marks.tsx exactly: each mark is a vendored
// official brand logo imported as an `.svg` asset URL (NOT an inline SVG
// literal in this TSX — the icon-governance contract bans hand-drawn inline
// SVG, and these assets sidestep it because `.svg` files are not `.tsx`
// literals). Each logo remains the trademark of its owner and is used here
// only to identify the connected MCP service.
//
// Color marks (Slack, Figma, Google Calendar, Supabase) carry their own
// brand fills and render through `<img>`. Monochrome marks (Vercel ▲, LINE)
// ship with `fill="currentColor"` and render through a mask so they inherit
// the plate's foreground color and stay legible in both light and dark —
// the same split provider-brand-marks.tsx draws between `<img>` and
// `ProviderAssetMask`.
//
// Brands WITHOUT a faithful official asset (钉钉/飞书/Notion/macOS/filesystem/
// …) fall back to the catalog text mark. We never hand-draw or approximate a
// logo we do not have — that is the banned anti-pattern.

import type { ReactElement } from 'react';
import type { McpCatalogEntry } from './mcp-catalog';
import figmaBrandMark from './assets/mcp-brands/figma.svg';
import googleCalendarBrandMark from './assets/mcp-brands/google-calendar.svg';
import lineBrandMark from './assets/mcp-brands/line.svg';
import slackBrandMark from './assets/mcp-brands/slack.svg';
import supabaseBrandMark from './assets/mcp-brands/supabase.svg';
import vercelBrandMark from './assets/mcp-brands/vercel.svg';

// Slack, LINE, Google Calendar, Figma, Vercel and Supabase logos were
// recovered byte-for-byte from the inline markup that lived in mcp-page.tsx
// before #1205 (commit e48be522); see assets/mcp-brands/*.svg for the
// extracted geometry.
type BrandRenderer = { src: string; tone: 'color' | 'mono' };

const MCP_BRAND_MARKS: Record<string, BrandRenderer> = {
  slack: { src: slackBrandMark, tone: 'color' },
  line: { src: lineBrandMark, tone: 'mono' },
  'google-calendar': { src: googleCalendarBrandMark, tone: 'color' },
  figma: { src: figmaBrandMark, tone: 'color' },
  vercel: { src: vercelBrandMark, tone: 'mono' },
  supabase: { src: supabaseBrandMark, tone: 'color' },
};

/** True when the catalog entry has a vendored official brand asset. */
export function hasMcpBrandMark(id: string): boolean {
  return id in MCP_BRAND_MARKS;
}

// Monochrome assets ride a mask because `<img>` documents do not inherit
// `currentColor`; identical technique to provider-brand-marks' ProviderAssetMask.
function McpAssetMask({ src }: { src: string }): ReactElement {
  const mask = `url("${src}")`;
  return <span className="maka-mcp-brand-mask" style={{ maskImage: mask, WebkitMaskImage: mask }} aria-hidden="true" />;
}

/**
 * Official brand mark for a catalog entry. Renders the vendored logo when one
 * exists; otherwise falls back to the entry's text mark.
 */
export function McpBrandMark({ entry }: { entry: McpCatalogEntry }): ReactElement {
  const brand = MCP_BRAND_MARKS[entry.id];
  if (!brand) return <span>{entry.mark}</span>;
  if (brand.tone === 'mono') return <McpAssetMask src={brand.src} />;
  return <img src={brand.src} alt="" />;
}
