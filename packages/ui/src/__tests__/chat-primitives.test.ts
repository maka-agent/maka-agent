import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bubble, LiveIndicator, Marker, markerVariants, Message, previewVariants, streamVariants, toolVariants } from '../primitives/chat.js';
import { buttonVariants, cn } from '../ui.js';

// The re-anchored renderer selectors key off the primitives' own `data-slot` /
// `data-role` / `data-variant`, so a consumer must never be able to clobber
// them. Both primitives are hook-free pure functions, so calling them directly
// and inspecting the returned element's props proves the structural hooks win
// over conflicting props — no DOM, no renderer needed.
test('Message keeps its own data-slot/data-role over conflicting props', () => {
  const el = Message({
    variant: 'assistant',
    'data-slot': 'spoofed',
    'data-role': 'user',
  } as never);
  const props = el.props as Record<string, unknown>;
  assert.equal(props['data-slot'], 'message');
  assert.equal(props['data-role'], 'assistant');
});

test('Bubble keeps its own data-slot/data-variant over conflicting props', () => {
  const el = Bubble({
    variant: 'user',
    'data-slot': 'spoofed',
    'data-variant': 'assistant',
  } as never);
  const props = el.props as Record<string, unknown>;
  assert.equal(props['data-slot'], 'bubble');
  assert.equal(props['data-variant'], 'user');
});

test('Marker keeps its own data-slot/data-variant but forwards the styling data-* hooks', () => {
  const el = Marker({
    variant: 'footer-action',
    as: 'span',
    'data-slot': 'spoofed',
    'data-variant': 'aborted',
    // The literalized `data-[kind=…]:` variants read this off the element, so it
    // must flow through unchanged.
    'data-kind': 'model',
  } as never);
  const props = el.props as Record<string, unknown>;
  assert.equal(el.type, 'span');
  assert.equal(props['data-slot'], 'marker');
  assert.equal(props['data-variant'], 'footer-action');
  assert.equal(props['data-kind'], 'model');
});

test('markerVariants resolves a leaf shell string the UiButton call sites can apply', () => {
  // The lineage badge + footer action render as UiButton and apply the shell via
  // className, so the cva must return a non-empty literal utility string.
  const footerAction = markerVariants({ variant: 'footer-action' });
  assert.match(footerAction, /min-h-\[28px\]/);
  assert.match(footerAction, /data-\[copy-feedback=copied\]:text-\[color:var\(--link\)\]/);
  const lineageBadge = markerVariants({ variant: 'lineage-badge' });
  assert.match(lineageBadge, /rounded-\[var\(--radius-pill\)\]/);
  assert.match(lineageBadge, /data-\[direction=forward\]:/);
});

// The footer action + lineage badge are the only NON-leaf marker call sites:
// they render as `UiButton variant="quiet" size="nav"` in EVERY state — the
// pending footer action no longer switches the Button to `secondary` (the
// marker shell overrides the variant either way, so the switch was visually
// inert and is dropped), which means `quiet` is now the only merge path to
// pin. The real on-element class string is
// `cn(buttonVariants({ quiet, nav }), markerVariants(...))`.
// `nav` is the bare size (emits nothing), so the marker shell — including its
// own `h-8` height — fully owns the geometry; the only conflicts left to drop
// are `buttonVariants`' BASE/quiet utilities (`gap-2`, `rounded-md`,
// `text-muted-foreground`), not a `size` token. Unlike the pure-container
// variants, "source string == computed style" doesn't hold for free here, so
// this pins the merge resolution deterministically (no browser, no screenshot
// rasterization noise) — the exact regression risk PR2 introduced for these two.
test('footer-action merge drops the UiButton base shell so the retired footer pixels win', () => {
  const merged = cn(
    buttonVariants({ variant: 'quiet', size: 'nav' }),
    markerVariants({ variant: 'footer-action' }),
  );
  // The retired `.maka-turn-footer-action` declarations survive (incl. the now
  // explicit `h-8` height that `size="sm"` used to supply implicitly). The
  // spacing-converge pass (#448) moved the shell from bare-px arbitraries
  // (`gap-[6px]` / `px-[8px]` / `py-[4px]`) onto the 4px-ruler scale
  // (`gap-1.5` / `px-2` / `py-1` — same computed pixels via --spacing: 4px)…
  for (const win of [
    'gap-1.5',
    'min-h-[28px]',
    'h-8',
    'leading-[16px]',
    'px-2',
    'py-1',
    'rounded-[var(--radius-surface)]',
    'text-[color:var(--muted-foreground)]',
    'text-xs', // #546 PR0: text-[12px] -> text-xs (typography onto token scale)
  ]) {
    assert.ok(merged.includes(win), `footer pixel "${win}" must survive the merge`);
  }
  // …and the conflicting `buttonVariants` base/quiet utilities are dropped, so
  // they can't override the footer shell (rounded-sm radius, gap-2 gap,
  // muted-foreground color).
  for (const dropped of ['rounded-sm', 'gap-2', 'text-muted-foreground']) {
    assert.ok(
      !merged.split(/\s+/).includes(dropped),
      `conflicting UiButton utility "${dropped}" must be merged out of the footer action`,
    );
  }
});

test('lineage-badge merge drops the UiButton base shell so the retired badge pixels win', () => {
  const merged = cn(
    buttonVariants({ variant: 'quiet', size: 'nav' }),
    markerVariants({ variant: 'lineage-badge' }),
  );
  // Spacing-converge (#448): `gap-[3px]` / `px-[5px]` snapped to the 4px
  // ruler as `gap-0.5` / `px-1`.
  for (const win of [
    'h-8',
    'leading-[12px]',
    'gap-0.5',
    'px-1',
    'py-[1px]',
    'rounded-[var(--radius-pill)]',
    'text-[color:var(--muted-foreground)]',
    'text-xs', // #546 PR0: text-[9px] -> text-xs (typography onto token scale)
  ]) {
    assert.ok(merged.includes(win), `lineage pixel "${win}" must survive the merge`);
  }
  for (const dropped of ['rounded-sm', 'gap-2', 'text-muted-foreground']) {
    assert.ok(
      !merged.split(/\s+/).includes(dropped),
      `conflicting UiButton utility "${dropped}" must be merged out of the lineage badge`,
    );
  }
});

// PR3 — the tool live-output stream shell. The full per-part shell is proven by
// the computed-style diff harness (38 rows, 0 delta), so this does NOT enumerate
// every part literal — that would only mirror the implementation. It keeps the
// two guards the diff doesn't make obvious: the shell must stay LITERAL (not the
// semantic `rounded-lg`/scale, which a refactor could silently swap in), and the
// body must use the `word-break` literal, never Tailwind's `break-words` (the
// different `overflow-wrap` property — an easy, invisible-until-rendered mistake).
test('streamVariants stays literal and avoids the overflow-wrap break-words trap', () => {
  const container = streamVariants({ part: 'container' });
  assert.ok(container.length > 0, 'container must resolve a non-empty leaf shell');
  assert.ok(
    !container.split(/\s+/).some((u) => ['rounded-lg', 'rounded-md', 'bg-primary'].includes(u)),
    'shell must stay literal, not the semantic scale / a recolor',
  );
  const body = streamVariants({ part: 'body' });
  assert.match(body, /\[word-break:break-word\]/);
  assert.ok(!body.split(/\s+/).includes('break-words'), 'body must not use overflow-wrap break-words');
});

// The live dot is the one declaration that escapes the computed-style proof (a
// `@keyframes` is a named global rule + `getComputedStyle` reads a phase-
// dependent value). `LiveIndicator` pins the animation reference + reduced-motion
// fallback as literals here; the keyframe body itself is pinned in the renderer
// CSS contract. Also proves the structural `data-slot` hook can't be clobbered.
test('LiveIndicator pins the canonical pulse + reduced-motion fallback over conflicting props', () => {
  const el = LiveIndicator({ 'data-slot': 'spoofed' } as never);
  const props = el.props as Record<string, unknown>;
  assert.equal(el.type, 'span');
  assert.equal(props['data-slot'], 'live-indicator');
  const className = props.className as string;
  assert.match(className, /\[animation:maka-pulse_1\.4s_ease-in-out_infinite\]/);
  assert.match(className, /motion-reduce:\[animation:none\]/);
  assert.match(className, /motion-reduce:opacity-\[0\.8\]/);
  // never the Tailwind `animate-pulse` (a different opacity-only keyframe).
  assert.ok(!className.split(/\s+/).includes('animate-pulse'), 'must use the governed maka-pulse, not animate-pulse');
});

// PR3b — the tool-activity card shell. The full per-part shell is proven by the
// computed-style diff harness (20 rows, 0 delta), so this does NOT enumerate the
// leaf literals. It keeps two guards the diff can't make at the source level:
// the shell stays LITERAL (no semantic scale a refactor could swap in), and —
// the subtle one — cva's RUNTIME output must preserve the `waiting_permission`
// `\_` escape as a SINGLE backslash. Tailwind turns a bare `_` in an arbitrary
// value into a space; the `String.raw` source keeps source==runtime at one `\_`,
// and any build/refactor that re-doubles or drops it silently breaks the
// `waiting_permission` border/dot tint (invisible until rendered — the diff
// harness caught exactly this).
// PR4 — the web-search error card layers `web-search-error` over `web-search`
// via `cn`. Unlike the pure-container previews (source string == computed style
// for free), this one only holds if both the base border/bg AND the error
// override use the SAME utility property form so tailwind-merge COLLAPSES them —
// then the error, last in `cn`, wins deterministically. A bare
// `[border-color: …]`/`[background: …]` longhand would survive un-collapsed and
// then lose to the base `[border: …]` shorthand by Tailwind's emission order,
// silently dropping the destructive tint (invisible until rendered — the exact
// regression this pins). No browser, no emission-order dependency: the merged
// string itself is the proof.
test('web-search-error tint collapses the neutral base border/bg so the destructive pixels win', () => {
  const merged = cn(
    previewVariants({ part: 'web-search' }),
    previewVariants({ part: 'web-search-error' }),
  );
  // the neutral base border + background must be merged OUT…
  assert.ok(
    !merged.includes('[border:1px_solid_var(--foreground-10)]'),
    'neutral base border must be collapsed by the error tint',
  );
  assert.ok(
    !merged.split(/\s+/).includes('bg-[var(--foreground-3)]'),
    'neutral base background must be collapsed by the error tint',
  );
  // …and only the destructive tints survive (kept as the collapse-safe
  // `[border: …]` shorthand + `bg-[ …]` util, never a bare longhand).
  assert.match(merged, /\[border:1px_solid_color-mix\(in_oklab,var\(--destructive-text\)_32%/);
  assert.match(merged, /bg-\[color-mix\(in_oklab,var\(--destructive-text\)_8%/);
  assert.ok(
    !merged.includes('[border-color:color-mix') && !merged.includes('[background:color-mix'),
    'the error tint must use the collapse-safe shorthand/util forms, never a bare longhand',
  );
});

test('toolVariants stays literal and emits the single-backslash waiting_permission escape', () => {
  const item = toolVariants({ part: 'item' });
  const dot = toolVariants({ part: 'dot' });
  for (const cls of [item, dot]) {
    assert.ok(
      // Typography (text-*) converged onto the scale by #546 PR0, so text-xs/sm
      // are allowed here; only radius scale + recolor drift stays banned.
      !cls.split(/\s+/).some((u) => ['rounded-lg', 'rounded-md', 'rounded-xl', 'bg-primary'].includes(u)),
      'tool shell must stay literal on radius, not the semantic scale / a recolor',
    );
  }
  // exactly one backslash before the underscore (source == runtime via String.raw)
  assert.ok(item.includes('data-[status=waiting\\_permission]:[border-color:'), 'item must keep the single-backslash waiting_permission border escape');
  assert.ok(dot.includes('data-[status=waiting\\_permission]:bg-[var(--info)]'), 'dot must keep the single-backslash waiting_permission bg escape');
  // never the bare underscore form (Tailwind would read it as a space)
  assert.ok(!item.includes('data-[status=waiting_permission]') && !dot.includes('data-[status=waiting_permission]'), 'the bare waiting_permission form must never reach the className');
  // the running dot keeps the governed ring keyframe, never Tailwind animate-pulse
  assert.match(dot, /\[animation:maka-tool-pulse_1\.5s_ease-in-out_infinite\]/);
  assert.ok(!dot.split(/\s+/).includes('animate-pulse'), 'running dot must use the governed maka-tool-pulse ring');
});
