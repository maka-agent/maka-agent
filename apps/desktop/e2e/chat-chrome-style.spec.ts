import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

/**
 * Rendered computed-style contract for the chat chrome / surface (#1312).
 *
 * Successor to the retired screenshot gate (#1308) and an abandoned
 * standalone synthetic-DOM Electron script — three review rounds showed that
 * any probe DOM (hand-built mirror or in-place clones) diverges from the real
 * shell in ways that hide regressions (missing painters, relational
 * selectors, sibling position), so this spec measures the REAL shell
 * elements in the live app. The surviving
 * `chat-chrome-no-gradient-contract.test.ts` is the fast source-string
 * pre-check; THIS spec is the authoritative rendered lock.
 *
 * ── Platform axis: booted, not flipped ──────────────────────────────────────
 * The darwin glass cascade vs the opaque base cascade branches on
 * `html[data-os]`. Each window here BOOTS with a forced platform through the
 * e2e-fixture override seam (`MAKA_E2E_FIXTURE_PLATFORM` → app:info →
 * data-os). app-shell-effects.ts sets `data-os` ONCE, asynchronously after
 * React mount, from `app:info` — the exact production sequence. The point is
 * that there is no mid-session value→value flip on a long-lived resolved
 * cascade (the abandoned approach forced a post-boot attribute change, which
 * Chromium resolves relative colors against stale values for). `prepareWindow`
 * asserts each window's `data-os` settled to its forced platform, so boot
 * honesty is covered directly rather than by an inter-window inequality guard.
 *
 * ── Theme axis: the real media-query path ───────────────────────────────────
 * Light/dark is driven through `page.emulateMedia({ colorScheme })` — the same
 * `prefers-color-scheme` path a real `theme: 'auto'` user's OS appearance
 * change takes (the fixture seeds theme 'auto'; its production listener in
 * theme.ts follows the media query and toggles `.dark`). That forces a full
 * style recalc, including the relative-color chains inside `--surface-canvas`
 * (`oklch(from var(--background) …)`). An in-page `.dark` class flip does NOT:
 * measured live, after a class flip `.appFrame` / `.maka-shell-2col`
 * backgroundColor stay at the stale light sRGB [247,247,247] while the media
 * path resolves them to the true dark [9,9,11], so a class-flip probe asserts
 * against a phantom shell. The test emulates light explicitly too (host
 * appearance must not leak in) and asserts the production listener landed —
 * `.dark` present for dark, absent for light — before each read; a broken
 * theme seed fails that assertion loud.
 *
 * ── The gutter painter model ────────────────────────────────────────────────
 * The visible 4px gutter around the floating content card lives in grid
 * column 3 of `.maka-shell-2col` (the card's own margin box). The sidebar
 * subtree (`.maka-panel-list` / `.maka-session-panel`) lives in column 1 and
 * CANNOT paint that pixel — so the effective gutter color is the composite
 * of exactly two painters: `.appFrame` (bottom) ← `.maka-shell-2col` (top).
 * Compositing (Porter-Duff "over") matters because which one shows is
 * platform-dependent: shell-2col paints opaque `--surface-canvas` in the
 * base cascade and the darwin glass theme overrides it to transparent,
 * exposing appFrame. The card is then composited OVER the effective gutter,
 * so `background: transparent` on the card honestly collapses to distance 0
 * instead of slipping past a raw-color compare. The resize handle's hitbox
 * overlaps the boundary strip and is separately asserted fully transparent.
 *
 * ── Asserted facts (per combo, measured in the EXPANDED sidebar state) ──────
 * The collapsed state carries its own higher-specificity border rules that
 * mask expanded-state seam regressions, so the spec first expands the
 * sidebar through the production control (React owns `data-sidebar-state`).
 *
 *   A. the effective gutter is FULLY PAINTED (composited alpha 255 — a
 *      transparent backplate pair shipped once, 2026-07-18 theme-glass
 *      notes, and an rgb-only distance would not see it), and its sRGB
 *      distance to the effective card is ≥ 6 (the card reads against the
 *      shell — the pixel script's fact 1).
 *   B. no background-image on appFrame / shell / panel-list / session-panel /
 *      handle / card — the thrice-rejected 172deg gradient lives in
 *      background-image, invisible to backgroundColor reads.
 *   C. no seam: panel-list & session-panel border-right, BOTH handle
 *      borders, and card border-left are zero-width or fully transparent
 *      (fact 2, the "边界线" seam).
 *   D. the handle (0px layout width, padding-inline hitbox over the gutter)
 *      has a fully transparent background, and its always-present 1px
 *      `::after` grip rests transparent — hover/focus paint it
 *      intentionally; a headless run has no hover, so the resting read IS
 *      the invariant.
 *   E. no box-shadow on panel-list / session-panel / handle — an adjacent
 *      element's shadow repaints the seam with every border clean.
 *   F. card corner radii each compute to exactly the string '12px' — a
 *      string compare, not parseFloat, so an elliptical `12px / 0px` (which
 *      serializes as '12px 0px') fails instead of truncating to 12. Also
 *      the vacuous-green self-check: an unstyled document reads '0px'.
 *   G. card margins each compute to exactly '4px' (design source:
 *      reference-shell.css `--agents-content-area-gap`) — the rounded
 *      corner sits over the differently-colored gutter, exposing shell
 *      pixels (fact 3); an exact compare rejects a 0.01px sliver that
 *      `> 0` would wave through.
 *   H. card box-shadow, mode-split by design (reference-shell.css):
 *      · dark  — at least one shadow layer must have a color with alpha > 0
 *                AND non-zero paint geometry (offset/blur/spread): `inset
 *                0 0 0 1px transparent` is a non-'none' string that paints
 *                nothing, and so is `inset 0 0 0 0 <visible color>`.
 *                Production is `inset 0 0 0 1px oklch(1 0 0 / .07)` —
 *                spread 1px, visible color.
 *      · light — must compute exactly 'none' ("Light mode keeps
 *                box-shadow: none — the lightness gap already reads").
 *   I. effective opacity: the card and panel-list ancestor chains (up to
 *      <html>) each multiply to exactly 1. The fact-A composite ignores CSS
 *      `opacity`, so `opacity: 0` anywhere on the chrome or an ancestor
 *      leaves every color/border read green while the shell is invisible
 *      (and Playwright actionability treats opacity:0 as visible). These two
 *      chains cover all six contract elements' ancestor paths.
 *   J. resting outline is invisible on panel-list / session-panel / handle /
 *      card — `outline: 1px solid red` paints a gutter line the border
 *      checks miss. (`.maka-resize-handle` sets `outline: none` by design;
 *      its focus ring lives on `::after`, so the resting read is consistent.)
 *   K. no filter on panel-list / session-panel / handle — `filter:
 *      drop-shadow(…)` evades the box-shadow 'none' checks (fact E's trio).
 *
 * ── Not observable here ─────────────────────────────────────────────────────
 * Painted pixels / anti-aliasing (computed style, not raster — the repo's
 * preferred trade per AGENTS.md) and hover/focus states (no live pointer).
 */

const SHELL_SELECTORS = {
  appFrame: '.appFrame',
  shell: '.maka-shell-2col',
  panelList: '.maka-panel-list.maka-floating-panel',
  sessionPanel: '.maka-session-panel',
  handle: '.maka-resize-handle',
  card: '.maka-panel-detail.maka-floating-panel.agents-content-area',
} as const;

type ShellKey = keyof typeof SHELL_SELECTORS;

type Rgba = [number, number, number, number];

interface ShadowLayer {
  colorAlpha: number;
  geometry: number[];
}

interface ElementFacts {
  bg: Rgba;
  bgImage: string;
  borderLeftWidth: number;
  borderLeftColorA: number;
  borderRightWidth: number;
  borderRightColorA: number;
  radii: string[];
  boxShadow: string;
  shadowLayers: ShadowLayer[];
  margins: string[];
  outlineStyle: string;
  outlineWidth: number;
  outlineColorA: number;
  filter: string;
}

type ComboFacts = { [K in ShellKey]: ElementFacts } & {
  handleAfterBgA: number;
  cardOpacityProduct: number;
  panelListOpacityProduct: number;
};

/** Read every contract fact directly from the REAL shell elements. */
async function readComboFacts(page: Page): Promise<ComboFacts> {
  return page.evaluate((selectors) => {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 1;
    const cx = cv.getContext('2d', { willReadFrequently: true });
    if (!cx) throw new Error('no 2d canvas context');
    const rgba = (color: string): number[] => {
      cx.clearRect(0, 0, 1, 1);
      cx.fillStyle = color;
      cx.fillRect(0, 0, 1, 1);
      return [...cx.getImageData(0, 0, 1, 1).data];
    };

    // Split a computed box-shadow list on top-level commas, then extract
    // each layer's color alpha and px geometry (offset-x/y, blur, spread).
    const parseShadowLayers = (shadow: string) => {
      if (shadow === 'none') return [];
      const layers: string[] = [];
      let depth = 0;
      let current = '';
      for (const ch of shadow) {
        if (ch === '(') depth += 1;
        if (ch === ')') depth -= 1;
        if (ch === ',' && depth === 0) {
          layers.push(current.trim());
          current = '';
        } else {
          current += ch;
        }
      }
      if (current.trim()) layers.push(current.trim());
      return layers.map((layer) => {
        const colorToken = layer.match(/(?:rgba?|hsla?|oklch|oklab|lab|lch|color)\([^)]*\)/)?.[0];
        const geometrySource = colorToken ? layer.replace(colorToken, '') : layer;
        return {
          colorAlpha: colorToken ? rgba(colorToken)[3] : 255,
          geometry: (geometrySource.match(/-?\d+(?:\.\d+)?(?=px)/g) ?? []).map(Number),
        };
      });
    };

    const read = (el: Element) => {
      const cs = getComputedStyle(el);
      return {
        bg: rgba(cs.backgroundColor),
        bgImage: cs.backgroundImage,
        borderLeftWidth: Number.parseFloat(cs.borderLeftWidth),
        borderLeftColorA: rgba(cs.borderLeftColor)[3],
        borderRightWidth: Number.parseFloat(cs.borderRightWidth),
        borderRightColorA: rgba(cs.borderRightColor)[3],
        radii: [
          cs.borderTopLeftRadius,
          cs.borderTopRightRadius,
          cs.borderBottomRightRadius,
          cs.borderBottomLeftRadius,
        ],
        boxShadow: cs.boxShadow,
        shadowLayers: parseShadowLayers(cs.boxShadow),
        margins: [cs.marginTop, cs.marginRight, cs.marginBottom, cs.marginLeft],
        outlineStyle: cs.outlineStyle,
        outlineWidth: Number.parseFloat(cs.outlineWidth),
        outlineColorA: rgba(cs.outlineColor)[3],
        filter: cs.filter,
      };
    };

    // Cumulative CSS opacity from an element up through every ancestor to
    // <html>: `opacity: 0` anywhere fades the whole subtree to invisible
    // while every color/border read stays green.
    const opacityChainProduct = (el: Element): number => {
      let product = 1;
      let node: Element | null = el;
      while (node) {
        product *= Number.parseFloat(getComputedStyle(node).opacity);
        node = node.parentElement;
      }
      return product;
    };

    const facts: Record<string, unknown> = {};
    for (const [key, selector] of Object.entries(selectors)) {
      const el = document.querySelector(selector);
      if (!el) throw new Error(`shell selector missing from the live window: ${selector}`);
      facts[key] = read(el);
    }
    const handle = document.querySelector(selectors.handle);
    if (!handle) throw new Error('resize handle disappeared mid-read');
    facts.handleAfterBgA = rgba(getComputedStyle(handle, '::after').backgroundColor)[3];
    const card = document.querySelector(selectors.card);
    const panelList = document.querySelector(selectors.panelList);
    if (!card || !panelList) throw new Error('shell opacity-chain anchor disappeared mid-read');
    facts.cardOpacityProduct = opacityChainProduct(card);
    facts.panelListOpacityProduct = opacityChainProduct(panelList);
    return facts;
  }, SHELL_SELECTORS) as Promise<ComboFacts>;
}

const MIN_GUTTER_TO_CARD_DISTANCE = 6;

/** Porter-Duff "over": composite top onto bottom, both [r,g,b,a(0-255)]. */
function over(top: Rgba, bottom: Rgba): Rgba {
  const at = top[3] / 255;
  const ab = bottom[3] / 255;
  const ao = at + ab * (1 - at);
  if (ao === 0) return [0, 0, 0, 0];
  const ch = (i: number) => (top[i] * at + bottom[i] * ab * (1 - at)) / ao;
  return [ch(0), ch(1), ch(2), ao * 255];
}

function dist(a: Rgba, b: Rgba): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function noSeam(width: number, colorAlpha: number): boolean {
  return width === 0 || colorAlpha === 0;
}

function assertCombo(tag: string, dark: boolean, m: ComboFacts): void {
  // A. fully painted effective gutter, visibly distinct from the card.
  const effectiveGutter = over(m.shell.bg, m.appFrame.bg);
  const effectiveCard = over(m.card.bg, effectiveGutter);
  expect(
    Math.round(effectiveGutter[3]),
    `${tag} the gutter must be fully painted — a transparent appFrame+shell pair leaves the native window backdrop showing (gutter=${JSON.stringify(effectiveGutter.map(Math.round))})`,
  ).toBe(255);
  const gutterToCard = dist(effectiveGutter, effectiveCard);
  expect(
    gutterToCard,
    `${tag} effective gutter must be visibly distinct from the effective card: distance=${gutterToCard.toFixed(2)} gutter=${JSON.stringify(effectiveGutter.map(Math.round))} card=${JSON.stringify(effectiveCard.map(Math.round))} rawCard=${JSON.stringify(m.card.bg)}`,
  ).toBeGreaterThanOrEqual(MIN_GUTTER_TO_CARD_DISTANCE);

  // B. no background-image (gradient) anywhere on the chrome surfaces.
  for (const key of Object.keys(SHELL_SELECTORS) as ShellKey[]) {
    expect(
      m[key].bgImage,
      `${tag} ${key} must not paint a background-image (the 172deg gradient class of regression)`,
    ).toBe('none');
  }

  // C. no effective seam at the sidebar/content boundary.
  const seamChecks: [string, number, number][] = [
    ['panel-list border-right', m.panelList.borderRightWidth, m.panelList.borderRightColorA],
    ['session-panel border-right', m.sessionPanel.borderRightWidth, m.sessionPanel.borderRightColorA],
    ['resize-handle border-left', m.handle.borderLeftWidth, m.handle.borderLeftColorA],
    ['resize-handle border-right', m.handle.borderRightWidth, m.handle.borderRightColorA],
    ['card border-left', m.card.borderLeftWidth, m.card.borderLeftColorA],
  ];
  for (const [name, width, alpha] of seamChecks) {
    expect(
      noSeam(width, alpha),
      `${tag} ${name} must be zero-width or transparent (width=${width}px colorAlpha=${alpha})`,
    ).toBe(true);
  }

  // D. transparent handle: element background and the resting ::after grip.
  expect(
    m.handle.bg[3],
    `${tag} resize-handle background must be fully transparent (bg=${JSON.stringify(m.handle.bg)}) — its hitbox overlaps the gutter strip`,
  ).toBe(0);
  expect(
    m.handleAfterBgA,
    `${tag} resize-handle ::after grip must rest fully transparent (alpha=${m.handleAfterBgA}) — a permanent color is a literal 1px seam`,
  ).toBe(0);

  // E. no shadow on the sidebar shell or the handle.
  for (const [name, el] of [
    ['panel-list', m.panelList],
    ['session-panel', m.sessionPanel],
    ['resize-handle', m.handle],
  ] as const) {
    expect(
      el.boxShadow,
      `${tag} ${name} must not carry a box-shadow (adjacent shadow repaints the seam)`,
    ).toBe('none');
  }

  // F. exact-string radius: catches elliptical '12px 0px' that parseFloat
  //    would truncate; doubles as the vacuous-green self-check (UA '0px').
  for (const radius of m.card.radii) {
    expect(
      radius,
      `${tag} every card corner radius must compute to exactly '12px' (radii=${JSON.stringify(m.card.radii)})`,
    ).toBe('12px');
  }

  // G. exact-string 4px inset on every side (--agents-content-area-gap).
  for (const margin of m.card.margins) {
    expect(
      margin,
      `${tag} every card margin must compute to exactly '4px' (margins=${JSON.stringify(m.card.margins)})`,
    ).toBe('4px');
  }

  // H. mode-split card shadow (see header).
  if (dark) {
    const visibleLayer = m.card.shadowLayers.find(
      (layer) => layer.colorAlpha > 0 && layer.geometry.some((v) => v !== 0),
    );
    expect(
      visibleLayer,
      `${tag} dark card must carry a VISIBLE box-shadow — a layer with color alpha > 0 and non-zero offset/blur/spread (box-shadow=${JSON.stringify(m.card.boxShadow)})`,
    ).toBeTruthy();
  } else {
    expect(
      m.card.boxShadow,
      `${tag} light card box-shadow must compute to exactly 'none' (design fact, reference-shell.css)`,
    ).toBe('none');
  }

  // I. no accumulated opacity fade on the two ancestor chains that cover all
  //    six contract elements — opacity:0 anywhere hides the shell invisibly.
  for (const [name, product] of [
    ['card', m.cardOpacityProduct],
    ['panel-list', m.panelListOpacityProduct],
  ] as const) {
    expect(
      product,
      `${tag} ${name} ancestor chain must have cumulative opacity exactly 1 (product=${product}) — opacity:0 anywhere hides the shell while every color/border read stays green`,
    ).toBe(1);
  }

  // J. resting outline invisible: catches a gutter line the border checks
  //    miss (the handle's focus ring lives on ::after; outline rests none).
  for (const [name, el] of [
    ['panel-list', m.panelList],
    ['session-panel', m.sessionPanel],
    ['resize-handle', m.handle],
    ['card', m.card],
  ] as const) {
    const invisible = el.outlineStyle === 'none' || el.outlineWidth === 0 || el.outlineColorA === 0;
    expect(
      invisible,
      `${tag} ${name} resting outline must be invisible (style=${el.outlineStyle} width=${el.outlineWidth}px colorAlpha=${el.outlineColorA})`,
    ).toBe(true);
  }

  // K. no filter: drop-shadow() paints a seam the box-shadow checks miss.
  for (const [name, el] of [
    ['panel-list', m.panelList],
    ['session-panel', m.sessionPanel],
    ['resize-handle', m.handle],
  ] as const) {
    expect(
      el.filter,
      `${tag} ${name} filter must compute to 'none' (drop-shadow() evades the box-shadow checks)`,
    ).toBe('none');
  }
}

/**
 * Boot precondition per window: `data-os` must have settled to the FORCED
 * platform (app-shell-effects sets it from app:info asynchronously after
 * mount), and the sidebar must be expanded (the long-transcript fixture
 * boots collapsed; expand through the production control).
 */
async function prepareWindow(page: Page, os: 'darwin' | 'win32'): Promise<void> {
  await expect(page.locator('html')).toHaveAttribute('data-os', os);
  const shell = page.locator(SHELL_SELECTORS.shell);
  if ((await shell.getAttribute('data-sidebar-state')) === 'collapsed') {
    await page.locator('button[aria-label="展开侧边栏"]').click();
  }
  await expect(shell).toHaveAttribute('data-sidebar-state', 'expanded');
}

test('chat chrome computed-style contract holds across platform and theme combos', async ({
  chatChromeDarwinWindow,
  chatChromeWin32Window,
}) => {
  const windows: { os: 'darwin' | 'win32'; page: Page }[] = [
    { os: 'darwin', page: chatChromeDarwinWindow },
    { os: 'win32', page: chatChromeWin32Window },
  ];

  for (const { os, page } of windows) {
    await prepareWindow(page, os);
    let lightFacts: ComboFacts | undefined;
    for (const dark of [false, true]) {
      // Drive light/dark through the REAL media-query path. The fixture seeds
      // theme 'auto', whose production listener (applyTheme in theme.ts)
      // follows prefers-color-scheme, so emulateMedia forces a full style
      // recalc — including the relative-color chains in --surface-canvas that
      // an in-page class flip leaves resolved against stale token values.
      // Emulate light explicitly too, so the host appearance never leaks in;
      // if the fixture ever stops seeding 'auto', the class assertion below
      // fails loud rather than reading a phantom cascade.
      await page.emulateMedia({ colorScheme: dark ? 'dark' : 'light' });
      const html = page.locator('html');
      if (dark) await expect(html).toHaveClass(/(?:^| )dark(?:$| )/);
      else await expect(html).not.toHaveClass(/(?:^| )dark(?:$| )/);
      // The `.dark` class landing does NOT mean the cascade is settled:
      // Chromium resolves the relative-color chains in `--surface-canvas`
      // (`oklch(from var(--background) …)`) lazily, so a getComputedStyle read
      // fired immediately after the class flips still returns the stale boot
      // appearance's value (measured: dark appFrame reads the light [247,247,247]
      // instead of [9,9,11]). Producing two animation frames flushes that
      // invalidation, after which the reads reflect the true resolved cascade.
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
      );
      const facts = await readComboFacts(page);
      assertCombo(`[${os}/${dark ? 'dark' : 'light'}]`, dark, facts);
      if (!dark) {
        lightFacts = facts;
      } else {
        // Settle non-vacuity guard: detects an insufficient settle (a phantom
        // stale read), NOT an inter-platform painter difference. The appFrame
        // backplate (--surface-canvas) is theme-tracking (light [247,247,247]
        // vs dark [9,9,11]) and is exactly the element whose relative-color
        // chain can go stale; at least one combo trivially matches the boot
        // appearance, so a phantom on the other side makes both reads EQUAL.
        if (!lightFacts) throw new Error('light combo facts missing before dark combo');
        expect(
          dist(lightFacts.appFrame.bg, facts.appFrame.bg),
          `[${os}] appFrame background must differ between light and dark reads — equal reads mean one combo returned a phantom stale cascade (settle insufficient): light=${JSON.stringify(lightFacts.appFrame.bg)} dark=${JSON.stringify(facts.appFrame.bg)}`,
        ).toBeGreaterThan(0);
      }
    }
  }
});
