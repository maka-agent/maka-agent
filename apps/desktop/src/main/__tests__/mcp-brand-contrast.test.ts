import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DARK_PLATE_MIN_LUMINANCE,
  hexRelativeLuminance,
  shouldUseCurrentColorOnDark,
} from '../../renderer/mcp-brand-contrast.js';

test('hexRelativeLuminance returns the WCAG endpoints for black and white', () => {
  assert.equal(hexRelativeLuminance('#000000'), 0);
  assert.equal(hexRelativeLuminance('#ffffff'), 1);
  // Tolerates a hex with or without the leading '#'.
  assert.equal(hexRelativeLuminance('000000'), 0);
});

test('hexRelativeLuminance matches the WCAG relative-luminance definition', () => {
  // Pure primaries, computed from the 0.2126/0.7152/0.0722 coefficients.
  assert.ok(Math.abs(hexRelativeLuminance('#ff0000') - 0.2126) < 1e-4);
  assert.ok(Math.abs(hexRelativeLuminance('#00ff00') - 0.7152) < 1e-4);
  assert.ok(Math.abs(hexRelativeLuminance('#0000ff') - 0.0722) < 1e-4);
});

test('the dark-plate threshold flips exactly the near-black MCP brand marks', () => {
  // Marks that must flip to currentColor on the dark plate.
  for (const hex of ['#000000' /* Vercel/Notion */, '#4A154B' /* Slack aubergine */]) {
    assert.equal(shouldUseCurrentColorOnDark(hex), true, `${hex} should fall back to currentColor`);
    assert.ok(hexRelativeLuminance(hex) < DARK_PLATE_MIN_LUMINANCE);
  }
  // Marks bright enough to keep their brand hex on the dark plate.
  for (const hex of ['#00C300' /* LINE */, '#4285F4' /* Google */, '#F24E1E' /* Figma */, '#3FCF8E' /* Supabase */]) {
    assert.equal(shouldUseCurrentColorOnDark(hex), false, `${hex} should keep its brand hex`);
    assert.ok(hexRelativeLuminance(hex) >= DARK_PLATE_MIN_LUMINANCE);
  }
});

test('the documented threshold keeps a wide margin from the darkest kept mark', () => {
  // The darkest KEPT marks (Google/Figma ≈ 0.244) stay well clear of the
  // threshold, and the brightest FLIPPED mark (Slack ≈ 0.025) stays under it.
  assert.ok(hexRelativeLuminance('#4285F4') - DARK_PLATE_MIN_LUMINANCE > 0.15);
  assert.ok(DARK_PLATE_MIN_LUMINANCE - hexRelativeLuminance('#4A154B') > 0.02);
});
