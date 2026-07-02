"use client";

import { cn } from "../utils.js";
import { cva, type VariantProps } from "class-variance-authority";
import type React from "react";

/**
 * Chat conversation-flow primitives (issue #332, PR1).
 *
 * `Message` is the per-turn row container; `Bubble` is the message body
 * surface. They retire the bespoke `.message.{role}` / `.maka-bubble-user`
 * shell CSS, moving the row/bubble *shell* onto the Tailwind substrate while
 * leaving Markdown prose (`.maka-bubble-assistant *`, maka-tokens.css) and the
 * turn machinery (summary / lineage / footer / markers — PR2) untouched.
 *
 * The row keeps the authored `.maka-message-row` base (centered reading column).
 * That base lives in maka-tokens.css's `@layer components`, so the role utilities below
 * (utilities layer) win over its `margin: 0 auto` for the left-anchored
 * assistant/system rows. The neutral `--chat-user-bg` token path is preserved
 * verbatim — the user bubble is never switched to `primary`/`accent`.
 */

const messageVariants = cva("maka-message-row", {
  variants: {
    variant: {
      // `.message.user`: shrink-wrap column, body hugs the right edge. No
      // margin override — the row stays centered (its `margin: 0 auto`).
      user: "flex flex-col items-end gap-1.5",
      // `.message.assistant` / `.message.system`: left-anchor inside the
      // measure column (override the row's centering).
      assistant: "ml-0 mr-auto",
      system: "ml-0 mr-auto",
    },
  },
});

export interface MessageProps
  extends React.ComponentPropsWithoutRef<"article"> {
  // The chat role. Named `variant` (not `role`) so it never shadows the native
  // HTML/ARIA `role` attribute, which still flows through `...props`. Emitted
  // to the DOM as `data-role` — the hook the turn lineage/footer and system
  // `pre` rules anchor on.
  variant: "user" | "assistant" | "system";
}

export function Message({
  className,
  variant,
  ...props
}: MessageProps): React.ReactElement {
  return (
    // `{...props}` is spread first so the structural `data-*` hooks the
    // re-anchored selectors depend on always land last and can't be clobbered
    // by a consumer passing `data-slot` / `data-role`.
    <article
      {...props}
      data-slot="message"
      data-role={variant}
      className={cn(messageVariants({ variant }), className)}
    />
  );
}

const bubbleVariants = cva("", {
  variants: {
    variant: {
      // `.maka-bubble-user`: tinted, width-capped, right-anchored block.
      // Padding stays literal (`px-[14px] py-[10px]`); radius now uses the
      // `--radius-surface` token (8px) per #406 gap 4 radius governance.
      // Keeps the neutral `--chat-user-bg` token path (never primary/accent).
      user: "max-w-[min(100%,640px)] whitespace-pre-wrap break-words rounded-[var(--radius-surface)] bg-[var(--chat-user-bg)] px-[14px] py-[10px] leading-[1.6] text-[color:var(--chat-user-foreground,var(--foreground))]",
      // Assistant / system: open prose, no bubble. Typography stays authored
      // under `.maka-bubble-assistant` (Markdown prose, OUT of scope), so this
      // variant re-emits that class as the styling hook.
      assistant: "maka-bubble-assistant",
    },
  },
});

export interface BubbleProps extends React.ComponentPropsWithoutRef<"div"> {
  variant: VariantProps<typeof bubbleVariants>["variant"];
}

export function Bubble({
  className,
  variant,
  ...props
}: BubbleProps): React.ReactElement {
  return (
    <div
      {...props}
      data-slot="bubble"
      data-variant={variant}
      className={cn(bubbleVariants({ variant }), className)}
    />
  );
}

/**
 * `Marker` — the per-turn status / lineage / footer chrome (issue #332, PR2).
 *
 * Retires the bespoke `.maka-turn-summary*`, `.maka-turn-aborted-marker`,
 * `.maka-turn-failed-*`, `.maka-turn-lineage-*`, and `.maka-turn-footer*` shell
 * CSS (spread across `maka-tokens.css`, `styles/settings/models.css`, and the
 * re-anchored measure-column block in `styles/tool-output.css`), moving each
 * onto this one Tailwind substrate.
 *
 * Every value is a LITERAL arbitrary utility (`gap-[6px]`, `rounded-[var(--radius-pill)]`,
 * `bg-[oklch(from_var(--foreground)_l_c_h_/_0.06)]`, `data-[kind=model]:…`);
 * radius values now reference `--radius-*` tokens per #406 gap 4. Each
 * leaf variant compiles 1:1 to the declarations it replaces, so the cva source
 * string IS the computed-style proof — the cascade contract asserts the exact
 * strings, no browser needed.
 *
 * The measure-column geometry the old `tool-output.css` re-anchor applied to
 * the summary / lineage rows / footer (`max-width:var(--maka-chat-measure)`,
 * `margin-right:auto`) is folded directly into those container variants here,
 * so the layout is location-independent instead of coupled to a
 * `[data-role="assistant"]` descendant selector.
 *
 * `markerVariants` is exported from THIS module (shadcn `buttonVariants` style)
 * so the lineage badge + footer action — which render as `UiButton` and can't
 * be wrapped — apply the shell via `className`; `Button` runs it through
 * `cn`/tailwind-merge last, so it wins over the button's own variant utilities.
 * It is intentionally kept OFF the `@maka/ui` package barrel (see `index.ts`):
 * the only consumers import it by relative path, so the variant table stays an
 * internal, freely-removable styling detail rather than public API.
 *
 * NOTE: `.maka-turn-thinking` (the committed-turn reasoning `<details>`) is
 * deliberately NOT migrated here. Its chrome lives in `summary::before` /
 * `::-webkit-details-marker` pseudo-elements that don't reduce to leaf
 * utilities (so the source-string == computed-style proof wouldn't hold), and
 * `maka-tokens.css` already documents an intended
 * Base UI Accordion path for it. It stays hand-written for that later effort.
 */
const markerVariants = cva("", {
  variants: {
    variant: {
      // `.maka-turn-summary` + the `tool-output.css` measure-column re-anchor:
      // one quiet caption line (model · tools · duration · tokens).
      summary:
        "flex w-full max-w-[var(--maka-chat-measure,680px)] flex-wrap items-center justify-start gap-[6px] mb-[2px] ml-0 mr-auto text-[color:var(--foreground-50)] [font-variant-numeric:tabular-nums]",
      // `.maka-turn-summary-chip` (+ `::before` middot, nested `code`, and the
      // `[data-kind]` / `[data-state]` / `[data-switched]` conditionals). The
      // call site keeps passing `data-kind` / `data-state` / `data-switched`,
      // which the literalized `data-[…]:` variants read.
      "summary-chip":
        "inline-flex items-center gap-[4px] text-[color:var(--foreground-50)] text-[12px] font-medium leading-[1.4]"
        + " [&:not(:first-child)]:before:content-['·'] [&:not(:first-child)]:before:mr-[4px] [&:not(:first-child)]:before:text-[color:var(--foreground-40)] [&:not(:first-child)]:before:font-normal"
        + " [&_code]:bg-transparent [&_code]:text-[color:inherit] [&_code]:[font-family:var(--font-mono)] [&_code]:text-[12px]"
        + " data-[kind=model]:[&_code]:text-[color:var(--foreground-60)] data-[kind=model]:[&_code]:font-semibold"
        + " data-[kind=tools]:text-[color:var(--foreground-50)]"
        + " data-[kind=duration]:[font-variant-numeric:tabular-nums]"
        + " data-[kind=tokens]:[font-variant-numeric:tabular-nums] data-[kind=tokens]:[font-family:var(--font-mono)] data-[kind=tokens]:text-[12px]"
        + " data-[state=in-progress]:text-[color:var(--accent)] data-[state=in-progress]:font-semibold"
        + " data-[kind=model]:data-[switched=true]:[&_code]:text-[color:var(--foreground-60)]",
      // `.maka-turn-summary-chip-switched` — the muted "切换" pill.
      "summary-switched":
        "ml-[4px] px-[6px] py-[1px] rounded-[var(--radius-pill)] bg-[oklch(from_var(--foreground)_l_c_h_/_0.06)] text-[color:var(--foreground-60)] text-[11px] font-semibold",
      // `.maka-turn-aborted-marker` (+ its italic `em`) — dormant, muted.
      aborted:
        "inline-flex w-fit items-center gap-[4px] mx-0 mt-[2px] mb-[4px] px-[6px] py-[2px] rounded-[var(--radius-control)] bg-[var(--foreground-5)] text-[color:var(--foreground-60)] text-[12px] italic [&_em]:italic",
      // `.maka-turn-failed-banner` — fault state, destructive tone.
      "failed-banner":
        "inline-flex w-fit flex-wrap items-center gap-[6px] mx-0 mt-[2px] mb-[6px] px-[8px] py-[4px] rounded-[var(--radius-control)] border border-[oklch(from_var(--destructive)_l_c_h_/_0.28)] bg-[oklch(from_var(--destructive)_l_c_h_/_0.10)] text-[color:var(--destructive)] text-[12px]",
      // `.maka-turn-failed-icon`
      "failed-icon": "inline-flex items-center",
      // `.maka-turn-failed-recovery` (+ `::before` middot separator).
      "failed-recovery":
        "text-[color:var(--text-muted)] before:content-['·'] before:mr-[6px] before:text-[color:var(--border-strong)]",
      // `.maka-turn-lineage-row` + the measure-column re-anchor (forward row).
      "lineage-row":
        "flex w-full max-w-[var(--maka-chat-measure,680px)] flex-wrap items-center justify-start gap-[3px] mt-[2px] mb-[4px] ml-0 mr-auto opacity-[0.82]",
      // `.maka-turn-lineage-row.maka-turn-lineage-row-reverse` — same, but the
      // `-reverse` class bumps margin-top 2px → 4px.
      "lineage-row-reverse":
        "flex w-full max-w-[var(--maka-chat-measure,680px)] flex-wrap items-center justify-start gap-[3px] mt-[4px] mb-[4px] ml-0 mr-auto opacity-[0.82]",
      // `.maka-turn-lineage-badge` (UiButton) — tiny pill, `[data-direction]`
      // recolors it forward (info) / reverse (brand-deep).
      "lineage-badge":
        // `h-8` + `leading-[12px]` explicit for the same reason as
        // `footer-action` (UiButton `size="nav"`): preserves the 30px height and
        // the 4/3 line-height (9px font × 4/3 = 12px) that `size="sm"`'s `h-8` /
        // `text-xs` used to supply implicitly on `main`, so geometry lives in
        // the marker shell.
        "inline-flex items-center h-8 gap-[3px] px-[5px] py-[1px] rounded-[var(--radius-pill)] [border:0] bg-[oklch(from_var(--foreground)_l_c_h_/_0.05)] text-[color:var(--foreground-50)] text-[9px] leading-[12px] [transition:background_150ms_var(--ease-out-strong),color_150ms_var(--ease-out-strong)]"
        + " hover:bg-[oklch(from_var(--foreground)_l_c_h_/_0.08)] hover:text-[color:var(--foreground)]"
        + " focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px]"
        + " data-[direction=forward]:bg-[oklch(from_var(--info)_l_c_h_/_0.06)] data-[direction=forward]:text-[oklch(from_var(--info-text)_calc(l_-_0.06)_c_h)]"
        + " data-[direction=reverse]:bg-[oklch(from_var(--brand-deep)_l_c_h_/_0.06)] data-[direction=reverse]:text-[oklch(from_var(--brand-deep)_calc(l_-_0.04)_c_h)]",
      // `.maka-turn-footer` (+ measure-column re-anchor) — quiet toolbar that
      // lifts to full opacity on hover / focus-within.
      footer:
        "flex w-full max-w-[var(--maka-chat-measure,680px)] flex-wrap items-center justify-start gap-[2px] mt-[2px] ml-0 mr-auto p-0 opacity-[0.72] hover:opacity-100 focus-within:opacity-100",
      // `.maka-turn-footer-action` (UiButton) — borderless ghost action. Also
      // reused by the user-message copy (`MessageCopyButton footerStyle`), so
      // it carries only the button look, never the footer's measure column.
      "footer-action":
        // `h-8` (→30px) + `leading-[16px]` are explicit because the call sites
        // pass `UiButton size="nav"` (the bare size whose docstring says the
        // consumer's className owns height/padding/font). On `main` both came
        // implicitly from `size="sm"` — its `h-8`, and `text-xs`'s 4/3
        // line-height ratio over the 12px font (12 × 4/3 = 16px exactly).
        // Folding them in keeps the exact pixels while the marker shell owns its
        // geometry (verified equal to `main` by computed style, headless electron).
        "inline-flex items-center gap-[6px] min-h-[28px] h-8 px-[8px] py-[4px] rounded-[var(--radius-surface)] [border:0] bg-transparent text-[color:var(--foreground-50)] text-[12px] leading-[16px] [transition:background_120ms_ease,color_120ms_ease,opacity_120ms_ease]"
        + " [&:hover:not(:disabled)]:bg-[oklch(from_var(--foreground)_l_c_h_/_0.05)] [&:hover:not(:disabled)]:text-[color:var(--foreground)]"
        + " focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px]"
        + " disabled:opacity-[0.45] disabled:cursor-not-allowed aria-disabled:opacity-[0.45] aria-disabled:cursor-not-allowed"
        + " data-[pending=true]:opacity-[0.78] data-[pending=true]:cursor-progress"
        // Copy-in-progress sets BOTH `disabled` and `data-pending`. The plain
        // `data-[pending=true]:opacity-[0.78]` and `disabled:opacity-[0.45]`
        // utilities have equal specificity (0,2,0), so the pending value would
        // only win on Tailwind's source order. These combined-modifier guards
        // raise pending to (0,3,0) so it beats the disabled dim by specificity,
        // not order — keeping the in-progress 0.78 stable regardless of emit
        // sequence. (Both `disabled`/`aria-disabled` are always set together.)
        + " disabled:data-[pending=true]:opacity-[0.78] aria-disabled:data-[pending=true]:opacity-[0.78]"
        + " data-[copy-feedback=copied]:text-[color:var(--accent)] data-[copy-feedback=failed]:text-[color:var(--destructive)]",
    },
  },
});

export type MarkerVariant = NonNullable<
  VariantProps<typeof markerVariants>["variant"]
>;

export { markerVariants };

export interface MarkerProps extends React.ComponentPropsWithoutRef<"div"> {
  variant: MarkerVariant;
  // The summary chips and the failed-banner sub-spans were authored as inline
  // `<span>`s; the containers/markers as `<div>`s. Keep the original tag so the
  // migration is structurally identical (zero behavioral change).
  as?: "div" | "span";
}

export function Marker({
  className,
  variant,
  as: Tag = "div",
  ...props
}: MarkerProps): React.ReactElement {
  return (
    // `{...props}` first so the `data-slot` / `data-variant` hooks land last and
    // can't be clobbered by a consumer (mirrors Message / Bubble). The styling
    // `data-kind` / `data-state` / `data-direction` etc. flow through `...props`
    // and are read by the literalized `data-[…]:` variants above.
    <Tag
      {...props}
      data-slot="marker"
      data-variant={variant}
      className={cn(markerVariants({ variant }), className)}
    />
  );
}

/**
 * Tool live-output stream shell (issue #332, PR3).
 *
 * Retires the bespoke `.maka-tool-output-stream-*` shell CSS (the panel,
 * header, counts row, scrolling body, and chunk/tag spans in
 * `styles/tool-stream.css`), moving each onto this Tailwind substrate. Every
 * value is a LITERAL arbitrary utility that compiles 1:1 to the declaration it
 * replaces, so the cva source string IS the computed-style proof (the cascade
 * contract asserts the exact strings).
 *
 * The single consumer (`ToolOutputStream`) keeps its semantic tags
 * (`<header>` / `<pre>` / `<span>`) and applies these by `className` rather than
 * through a wrapper component — there is one call site, the tags differ, and the
 * literalize vehicle (this table) is what the test net asserts. `streamVariants`
 * is kept OFF the package barrel for the same reason as `markerVariants`: the
 * only consumer imports it by relative path, so the part set stays an internal,
 * freely-removable styling detail.
 *
 * The live pulse dot is NOT a part here — it moves onto the governed
 * `LiveIndicator` primitive below (animation can't be a leaf-literal, so it gets
 * a primitive + a single canonical keyframe instead of a per-feature one).
 */
const streamVariants = cva("", {
  variants: {
    part: {
      // `.maka-tool-output-stream` (+ the `[data-live="true"]` accent border /
      // inset ring while the tool is running). The call site keeps passing
      // `data-live`, which the literalized `data-[live=true]:` utilities read.
      container:
        "flex flex-col gap-[6px] my-[6px] mx-0 overflow-hidden rounded-[var(--radius-surface)] border border-[var(--border)] bg-[var(--background)]"
        + " data-[live=true]:border-[oklch(from_var(--accent)_l_c_h_/_0.40)] data-[live=true]:[box-shadow:inset_0_0_0_1px_oklch(from_var(--accent)_l_c_h_/_0.06)]",
      // `.maka-tool-output-stream-header`
      header:
        "flex items-center justify-between gap-[12px] px-[10px] py-[6px] border-b border-[var(--border)] bg-[var(--foreground-3)] text-[0.72rem] uppercase tracking-[0.06em] text-[color:var(--foreground-50)]",
      // `.maka-tool-output-stream-label`
      label: "inline-flex items-center gap-[6px]",
      // `.maka-tool-output-stream-counts`
      counts: "inline-flex items-center gap-[10px]",
      // `.maka-tool-output-stream-counts span` (tabular-nums on every count) plus
      // the `[data-stream=stderr]` / `[data-redacted]` / `[data-truncated]`
      // recolors. The `已截断` pill (`data-truncated`) gets the warning chrome the
      // old `span[data-truncated="true"]` rule supplied; the inert
      // `.maka-tool-output-stream-truncated-tag` class (no rule of its own) is
      // dropped.
      count:
        "[font-variant-numeric:tabular-nums]"
        + " data-[stream=stderr]:text-[color:var(--destructive-text)]"
        + " data-[redacted=true]:text-[color:var(--warning-text,var(--info-text))]"
        + " data-[truncated=true]:rounded-[var(--radius-control)] data-[truncated=true]:border data-[truncated=true]:border-[oklch(from_var(--warning)_l_c_h_/_0.30)] data-[truncated=true]:bg-[oklch(from_var(--warning)_l_c_h_/_0.06)] data-[truncated=true]:px-[4px] data-[truncated=true]:text-[color:var(--warning-text,var(--info-text))] data-[truncated=true]:cursor-help",
      // `.maka-tool-output-stream-body` — the scrolling mono output `<pre>`.
      // `word-break:break-word` stays an arbitrary literal (Tailwind's
      // `break-words` is `overflow-wrap`, a different property).
      body:
        "m-0 max-h-[220px] overflow-y-auto whitespace-pre-wrap [word-break:break-word] px-[10px] py-[8px] [font-family:var(--font-mono)] text-[0.78rem] leading-[1.5] bg-[var(--background)] text-[color:var(--foreground-80)] [scroll-behavior:auto]",
      // `.maka-tool-output-stream-chunk` (`display:contents`; recolors stderr,
      // dims redacted). The call site keeps `data-stream` / `data-redacted`.
      chunk:
        "contents data-[stream=stderr]:text-[color:var(--destructive-text)] data-[redacted=true]:opacity-[0.65]",
      // `.maka-tool-output-stream-redacted-tag` — the inline `[已脱敏]` tag.
      "redacted-tag":
        "inline ml-[2px] rounded-[var(--radius-control)] px-[4px] tracking-[0.04em] text-[0.7rem] text-[color:var(--warning-text,var(--info-text))] bg-[oklch(from_var(--warning,var(--info))_l_c_h_/_0.10)]",
    },
  },
});

export { streamVariants };

/**
 * `LiveIndicator` — the pulsing "live" dot (issue #332, PR3).
 *
 * The governed home for the chat live-output dot, replacing the bespoke
 * `.maka-tool-output-stream-dot` + its per-feature `@keyframes`. The breath
 * itself is the one declaration that can't be a leaf-literal (a `@keyframes` is
 * a named global rule, not an element property, and `getComputedStyle` reads a
 * phase-dependent value — so it escapes the computed-style proof). It is pinned
 * instead by the canonical `@keyframes maka-pulse` in `maka-tokens.css` (the
 * shared motion home) plus the literal values here, verified by a keyframe
 * contract + before/after screenshots rather than the diff harness.
 *
 * It is kept INTERNAL (off the package barrel, applied by relative import like
 * `streamVariants`): the tool stream is its only consumer today. The duplicate
 * reasoning / composer / onboarding live dots can adopt it in a follow-up motion
 * pass — retiring their own `*-pulse` keyframes onto `maka-pulse` — and that is
 * when it would be promoted to a public export, not speculatively before a second
 * consumer exists. Reduced-motion suppression rides on the `motion-reduce:`
 * utilities (real-OS `prefers-reduced-motion: reduce`), mirroring the retired
 * dot's `@media` rule; the visual-smoke fixture freeze is handled by `base.css`.
 */
export function LiveIndicator({
  className,
  ...props
}: React.ComponentPropsWithoutRef<"span">): React.ReactElement {
  return (
    <span
      aria-hidden="true"
      {...props}
      data-slot="live-indicator"
      className={cn(
        "inline-block w-[6px] h-[6px] rounded-[50%] bg-[var(--accent)] [animation:maka-pulse_1.4s_ease-in-out_infinite] motion-reduce:[animation:none] motion-reduce:opacity-[0.8]",
        className,
      )}
    />
  );
}

/**
 * Tool-activity card shell (issue #332, PR3b).
 *
 * Retires the bespoke `ToolActivity` chrome — the inline section + count, the
 * `<details>` card (`.maka-tool` / `.toolItem`), the `<summary>` header row
 * (`.maka-tool-header` / `-name` / `-meta` / `-duration` / `-status-label` /
 * `-status-dot`), the body / intent, and the args `<pre>` override
 * (`.toolArgs`) — moving each onto this Tailwind substrate. The selectors lived
 * across `maka-tokens.css`'s `@layer components` and `styles/tool-output.css`.
 *
 * Every value is a LITERAL arbitrary utility that compiles 1:1 to the
 * declaration it replaces, so the cva source string IS the computed-style proof
 * (the cascade contract asserts the exact strings, no browser needed). Literals
 * over the semantic scale for the same reason as `markerVariants` / `streamVariants`:
 * the retired CSS hardcoded these pixels, so the literal is the faithful,
 * self-evidently-equal translation and is immune to later scale/token re-tuning
 * (the visual refresh, not this governance pass, owns adopting the scale).
 *
 * Two pieces escape the computed-style proof and are NOT in this table — they
 * stay a small named residue keyed on `[data-slot="tool"]` in maka-tokens.css,
 * pinned by the PR3b cascade contract (source strings + keyframe frames) rather
 * than the diff harness:
 *   1. the running status dot's `[animation:maka-tool-pulse …]` breath (the
 *      shorthand rides in the `dot` part here like `LiveIndicator`; only the
 *      `@keyframes maka-tool-pulse` stays in CSS — a keyframe is a global rule,
 *      not an element property, and `getComputedStyle` reads a phase-dependent
 *      value). The running dot's box-shadow RING is a leaf rest-state literal, so
 *      it stays here and IS diff-proven.
 *   2. the native `<summary>` marker reset (`::-webkit-details-marker` /
 *      `::marker`) — pseudo-elements with no leaf-utility form. Kept as residue.
 * (The reduced-motion / visual-smoke suppression both ride GLOBAL `*` rules in
 * maka-tokens.css / base.css, so — unlike `LiveIndicator`, a reusable primitive
 * that carries its own `motion-reduce:` guards — the dot and card need no
 * per-element motion utilities; the same global rules cover them as before.)
 *
 * The single consumer (`ToolActivity`) keeps its semantic tags and applies these
 * by `className`. `toolVariants` is kept OFF the package barrel for the same
 * reason as `markerVariants` / `streamVariants`: the only consumer imports it by
 * relative path, so the part set stays an internal, freely-removable styling
 * detail. The `<details>` card stays native HTML here — the eventual Base UI
 * Disclosure path (the intended convergence target for this card AND the
 * `.maka-turn-thinking` block) is a later structural pass, not this lift.
 *
 * NOTE: the args `<pre>` keeps the shared `.maka-code` inline-code base (used by
 * Markdown / artifact previews too — out of scope); the `args` part below is only
 * the `.toolArgs` override. The `ToolErrorBanner` (`Alert` + `.maka-tool-error*`)
 * is a separate concern on a different substrate and migrates in its own pass.
 */
// `waiting_permission` carries a literal underscore, which Tailwind reads as a
// SPACE in an arbitrary value (`[data-status="waiting permission"]` — never
// matches). The escape is `\_`, but a plain string literal makes the SCANNED
// source (`\\_`) disagree with cva's RUNTIME output (`\_`), so the emitted
// selector misses the class. `String.raw` keeps both at a single `\_`.
const WP_CARD_BORDER = String.raw`data-[status=waiting\_permission]:[border-color:oklch(from_var(--info)_l_c_h_/_0.4)]`;
const WP_DOT_BG = String.raw`data-[status=waiting\_permission]:bg-[var(--info)]`;

const toolVariants = cva("", {
  variants: {
    part: {
      // `.toolInline` — the inline section measure column.
      container: "w-[min(680px,100%)] mx-auto mt-[2px] mb-0 px-[16px] py-0",
      // `.toolInline > header` — the quiet "工具调用" caption row.
      "container-header":
        "flex items-center justify-between mb-[3px] text-[color:var(--foreground-50)] text-[10px]",
      // `.maka-tool-count` — the call-count pill.
      count:
        "inline-flex items-center justify-center min-w-[22px] h-[18px] px-[6px] py-0 rounded-[var(--radius-pill)] bg-[var(--foreground-5)] text-[color:var(--foreground-60)] text-[11px] [font-variant-numeric:tabular-nums]",
      // `.maka-tool` (effective: the later `padding: 0` rule wins over `8px 12px`)
      // + `.toolItem` + the `[open]>summary` divider + the `[data-status]` border /
      // background / opacity swaps. `[border: …]` / `[border-color: …]` are arbitrary
      // so the status overrides touch only the color, never width/style. The
      // `<summary>` marker reset stays a residue keyed on `[data-slot="tool"]`
      // (see docstring).
      item:
        "[border:1px_solid_var(--border)] rounded-[var(--radius-surface)] bg-[var(--foreground-2)] p-0 mt-[8px] [font-family:var(--font-mono)] text-[12.5px] text-[color:var(--foreground-80)] overflow-hidden [box-shadow:var(--shadow-minimal-flat)]"
        + " [&[open]>summary]:[border-bottom:1px_solid_var(--border)]"
        // `waiting_permission` border tint — see `WP_CARD_BORDER` above (String.raw).
        + " " + WP_CARD_BORDER
        + " data-[status=running]:[border-color:oklch(from_var(--accent)_l_c_h_/_0.4)]"
        + " data-[status=completed]:[border-color:var(--border)]"
        + " data-[status=errored]:[border-color:oklch(from_var(--destructive)_l_c_h_/_0.4)] data-[status=errored]:bg-[oklch(from_var(--destructive)_l_c_h_/_0.04)]"
        + " data-[status=interrupted]:[border-color:var(--border)] data-[status=interrupted]:bg-[var(--foreground-3)] data-[status=interrupted]:opacity-[0.7]",
      // `.maka-tool > summary` (list-style + padding) + `.maka-tool-header` (the
      // 8px · name · meta grid). Folded together since the summary IS the header.
      header:
        "list-none grid grid-cols-[8px_minmax(0,1fr)_auto] items-center gap-[10px] px-[12px] py-[8px] text-[color:var(--foreground-70)]",
      // `.maka-tool-status-dot` (+ the `[data-status]` color swaps; running adds
      // the box-shadow ring + `maka-tool-pulse` breath — keyframe stays in CSS).
      dot:
        "w-[8px] h-[8px] rounded-[var(--radius-pill)] bg-[var(--foreground-30)] [flex:0_0_auto]"
        // `waiting_permission` dot tint — see `WP_DOT_BG` above (String.raw).
        + " " + WP_DOT_BG
        + " data-[status=running]:bg-[var(--accent)] data-[status=running]:[box-shadow:0_0_0_3px_oklch(from_var(--accent)_l_c_h_/_0.15)] data-[status=running]:[animation:maka-tool-pulse_1.5s_ease-in-out_infinite]"
        + " data-[status=completed]:bg-[var(--success)]"
        + " data-[status=errored]:bg-[var(--destructive)]"
        + " data-[status=interrupted]:bg-[var(--foreground-30)]",
      // `.maka-tool-name` — the mono tool name, ellipsized.
      name:
        "min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[color:var(--foreground)] font-medium [font-family:var(--font-mono)]",
      // `.maka-tool-meta` — duration + status-label cluster.
      meta:
        "inline-flex items-center gap-[8px] text-[color:var(--foreground-50)] text-[11px]",
      // `.maka-tool-duration`
      duration: "[font-variant-numeric:tabular-nums]",
      // `.maka-tool-status-label`
      "status-label": "text-[color:var(--foreground-60)]",
      // `.maka-tool-body`
      body: "px-[12px] pt-[10px] pb-[12px]",
      // `.maka-tool-intent`
      intent:
        "mx-0 mt-0 mb-[8px] text-[color:var(--foreground-60)] [font-family:var(--font-default)] text-[12px] leading-[1.4]",
      // `.toolArgs` — the override layered over the shared `.maka-code` base
      // (`.maka-code` stays in CSS; the call site keeps the class).
      args: "m-0 max-h-[110px] overflow-auto",
    },
  },
});

export { toolVariants };

/**
 * Tool-result preview surfaces (issue #332, PR4).
 *
 * Retires the bespoke `OverlayPreview` family shell CSS — the shared
 * height-bounded `.maka-overlay-preview` base + `.maka-overlay-close`, the
 * structured cards (`.maka-tool-diff*`, `.maka-tool-terminal*`,
 * `.maka-office-document-*`, `.maka-explore-agent-*` / `.maka-subagent-preview`,
 * `.maka-web-search-*`), and the separate `.maka-load-tool-*` result card —
 * moving each onto this one Tailwind substrate. The selectors lived across
 * `styles/tool-output.css` and `styles/tool-stream.css` (`@layer components`).
 *
 * Every value is a LITERAL arbitrary utility that compiles 1:1 to the
 * declaration it replaces, so the cva source string IS the computed-style proof
 * (the visual-smoke screenshot fixture renders the `file_diff` + `terminal` cards
 * to keep those shells pixel-identical; the PR4 cascade contract pins the absence
 * of the retired selectors + the escape literals). Literals over the semantic
 * scale for the same reason as
 * `markerVariants` / `streamVariants` / `toolVariants`: the retired CSS hardcoded
 * these pixels, so the literal is the faithful, self-evidently-equal translation
 * and is immune to later scale/token re-tuning (the visual refresh, not this
 * governance pass, owns adopting the scale).
 *
 * Two structural notes:
 *   1. The chat structured cards carry BOTH the shared `overlay` base AND a kind
 *      part (the retired DOM had `class="maka-overlay-preview maka-tool-diff"`),
 *      applied as `cn(previewVariants({part:'overlay'}), previewVariants({part:'diff'}))`.
 *      The base's `white-space` / `font-family` are written as ARBITRARY props
 *      (`[white-space:pre-wrap]`, `[font-family:var(--font-mono)]`) so a kind part
 *      that overrides them (`[white-space:normal]`, `[font-family:var(--font-sans)]`)
 *      wins by tailwind-merge last-occurrence — reproducing the retired two-class
 *      source-order cascade without depending on stylesheet emit order.
 *   2. Leaf rules authored as descendant selectors on bare tags (e.g.
 *      `.maka-explore-agent-section li`, `.maka-web-search-preview > header strong`)
 *      are folded into their container part via `[&_tag]:` / `[&>tag]:` arbitrary
 *      variants, so the call sites swap ONLY the container className and the
 *      children stay bare — matching the original descendant cascade exactly.
 *
 * Unlike the other tables, `previewVariants` IS exported on the `@maka/ui` barrel
 * (`index.ts`): the file-diff `diff` / `diff-body` / `diff-line` parts have a
 * SECOND, cross-package consumer — `apps/desktop`'s `artifact-preview.tsx`, whose
 * non-chat diff pane shared the retired `.maka-tool-diff*` shell and co-migrates
 * here. That second consumer is exactly the condition the off-barrel convention
 * named for promotion, so the export is the rule, not an exception.
 *
 * Preview card shells use the shared shadow-ring recipe instead of hard visual
 * borders. Dividers inside the cards remain real borders because they separate
 * rows and headers.
 */
const previewVariants = cva("", {
  variants: {
    part: {
      // ── shared base ──────────────────────────────────────────────────────
      // `.maka-overlay-preview` — the height-bounded mono container every
      // overlay preview shares. `white-space` / `font-family` are arbitrary so
      // the structured-card kind parts override them by tailwind-merge (note 1).
      overlay:
        "mt-[5px] mx-0 mb-0 max-h-[180px] overflow-auto [font-family:var(--font-mono)] text-[10px] [white-space:pre-wrap] [word-break:break-word]",
      // `.maka-overlay-close` — the dismiss action (layered over `.maka-button`).
      close:
        "justify-self-end inline-flex items-center gap-[4px] min-h-[22px] px-[7px]",

      // ── file diff (shared with apps/desktop artifact-preview) ─────────────
      // `.maka-tool-diff` — the card shell. `[white-space:normal]` overrides the
      // overlay base's pre-wrap on the chat consumer.
      diff:
        "grid gap-0 p-0 rounded-[var(--radius-surface)] bg-[var(--background)] [white-space:normal] [box-shadow:var(--shadow-minimal-flat)]",
      // `.maka-tool-diff-paths` (+ its bare `code` children).
      "diff-paths":
        "flex flex-wrap gap-[6px] px-[8px] py-[5px] [border-bottom:1px_solid_var(--border)] bg-[var(--foreground-2)] [font-family:var(--font-mono)] text-[10px]"
        + " [&_code]:text-[color:var(--foreground-70)] [&_code]:bg-transparent",
      // `.maka-tool-diff-body` — the scrolling mono `<pre>`.
      "diff-body":
        "m-0 px-0 py-[5px] max-h-[320px] overflow-auto [font-family:var(--font-mono)] text-[11.5px] leading-[1.45] [white-space:pre] [word-break:normal]",
      // `.maka-tool-diff-line` (+ the `[data-line]` add/del/hunk/meta/ctx tints).
      "diff-line":
        "block px-[8px] py-0 [white-space:pre]"
        + " data-[line=add]:bg-[oklch(from_var(--success)_l_c_h_/_0.10)] data-[line=add]:text-[color:var(--success-text)]"
        + " data-[line=del]:bg-[oklch(from_var(--destructive)_l_c_h_/_0.10)] data-[line=del]:text-[color:var(--destructive)]"
        + " data-[line=hunk]:bg-[oklch(from_var(--accent)_l_c_h_/_0.08)] data-[line=hunk]:text-[color:var(--foreground-70)] data-[line=hunk]:font-semibold"
        + " data-[line=meta]:text-[color:var(--foreground-50)]"
        + " data-[line=ctx]:text-[color:var(--foreground-70)]",

      // ── terminal ──────────────────────────────────────────────────────────
      // `.maka-tool-terminal` — same card shell as diff.
      terminal:
        "grid gap-0 p-0 rounded-[var(--radius-surface)] bg-[var(--background)] [white-space:normal] [box-shadow:var(--shadow-minimal-flat)]",
      // `.maka-tool-terminal-head`
      "terminal-head":
        "flex flex-wrap items-center gap-[6px] px-[8px] py-[5px] [border-bottom:1px_solid_var(--border)] bg-[var(--foreground-2)] [font-family:var(--font-mono)] text-[10px]",
      // `.maka-tool-terminal-cwd`
      "terminal-cwd": "text-[color:var(--foreground-50)] bg-transparent",
      // `.maka-tool-terminal-cmd` — the ellipsized command line.
      "terminal-cmd":
        "[flex:1_1_auto] min-w-0 text-[color:var(--foreground)] bg-transparent font-semibold whitespace-nowrap overflow-hidden text-ellipsis",
      // `.maka-tool-terminal-exit` (+ the `[data-ok]` success/failure badge).
      "terminal-exit":
        "px-[6px] py-[1px] rounded-[var(--radius-pill)] text-[9px] font-bold tracking-[0.04em] bg-[var(--foreground-5)] text-[color:var(--foreground-60)]"
        + " data-[ok=true]:bg-[oklch(from_var(--success)_l_c_h_/_0.14)] data-[ok=true]:text-[color:var(--success)]"
        + " data-[ok=false]:bg-[oklch(from_var(--destructive)_l_c_h_/_0.14)] data-[ok=false]:text-[color:var(--destructive)]",
      // `.maka-tool-terminal-empty`
      "terminal-empty":
        "m-0 p-[8px] text-[color:var(--foreground-50)] [font-family:var(--font-mono)] text-[11px] italic",
      // `.maka-tool-terminal-stream` (+ the `[data-stream]` stdout/stderr tone).
      "terminal-stream":
        "m-0 px-[8px] py-[6px] max-h-[180px] overflow-auto [font-family:var(--font-mono)] text-[11.5px] [white-space:pre-wrap] [word-break:break-word]"
        + " data-[stream=stdout]:text-[color:var(--foreground)]"
        + " data-[stream=stderr]:[border-top:1px_solid_var(--border)] data-[stream=stderr]:bg-[oklch(from_var(--destructive)_l_c_h_/_0.04)] data-[stream=stderr]:text-[color:var(--destructive)]",
      // `.maka-tool-terminal-truncated-note` (+ its `> span` min-width reset).
      "terminal-truncated-note":
        "flex items-center justify-between gap-[8px] px-[8px] py-[6px] [border-top:1px_solid_var(--border)] bg-[oklch(from_var(--warning)_l_c_h_/_0.06)] text-[color:var(--foreground-70)] text-[11px] leading-[1.5] [&>span]:min-w-0",
      // `.maka-tool-terminal-copy` (UiButton) + the shared copy-state tints.
      "terminal-copy":
        "[flex:0_0_auto] data-[pending=true]:cursor-progress data-[copy-error=true]:text-[color:var(--destructive)] data-[copy-error=true]:[border-color:oklch(from_var(--destructive)_l_c_h_/_0.35)]",

      // ── office document ───────────────────────────────────────────────────
      // `.maka-office-document-preview` (+ the `[data-ok=false]` fault border).
      office:
        "grid gap-[8px] px-[12px] py-[10px] [border:1px_solid_var(--foreground-10)] rounded-[var(--radius-surface)] bg-[var(--foreground-3)] [white-space:normal] data-[ok=false]:[border-color:oklch(from_var(--destructive)_l_c_h_/_0.22)]",
      // `.maka-office-document-head` (+ its `strong` title and `small` caption).
      "office-head":
        "grid gap-[2px] pb-[6px] [border-bottom:1px_solid_var(--foreground-10)]"
        + " [&_strong]:min-w-0 [&_strong]:overflow-hidden [&_strong]:text-ellipsis [&_strong]:whitespace-nowrap [&_strong]:text-[13px] [&_strong]:text-[color:var(--foreground)]"
        + " [&_small]:text-[11px] [&_small]:text-[color:var(--foreground-50)] [&_small]:uppercase [&_small]:tracking-[0.04em]",
      // `.maka-office-document-args`
      "office-args":
        "min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[color:var(--foreground-60)] bg-transparent text-[11px]",
      // `.maka-office-document-message` (+ its `small` caption).
      "office-message":
        "grid gap-[3px] px-[10px] py-[8px] rounded-[var(--radius-control)] bg-[oklch(from_var(--destructive)_l_c_h_/_0.07)] text-[color:var(--destructive)] [font-family:var(--font-sans)] text-[12px]"
        + " [&_small]:text-[11px] [&_small]:text-[color:var(--foreground-50)] [&_small]:uppercase [&_small]:tracking-[0.04em]",
      // `.maka-office-document-empty`
      "office-empty":
        "m-0 text-[color:var(--foreground-50)] [font-family:var(--font-mono)] text-[12px] italic",
      // `.maka-office-document-stream` (+ the `[data-stream=stderr]` tone).
      "office-stream":
        "m-0 px-[10px] py-[8px] max-h-[200px] overflow-auto [border:1px_solid_var(--foreground-10)] rounded-[var(--radius-control)] bg-[var(--background)] [font-family:var(--font-mono)] text-[12.5px] [white-space:pre-wrap] [word-break:break-word]"
        + " data-[stream=stderr]:bg-[oklch(from_var(--destructive)_l_c_h_/_0.04)] data-[stream=stderr]:text-[color:var(--destructive)]",

      // ── explore agent / subagent (shared shell) ───────────────────────────
      // `.maka-explore-agent-preview, .maka-subagent-preview` (+ the fault
      // border, keyed on explore's `[data-ok=false]` or subagent's failed /
      // cancelled `[data-status]`).
      agent:
        "grid gap-[10px] px-[12px] py-[10px] [border:1px_solid_var(--foreground-10)] rounded-[var(--radius-surface)] bg-[var(--foreground-3)] [font-family:var(--font-sans)] [white-space:normal]"
        + " data-[ok=false]:[border-color:oklch(from_var(--destructive)_l_c_h_/_0.22)]"
        + " data-[status=failed]:[border-color:oklch(from_var(--destructive)_l_c_h_/_0.22)]"
        + " data-[status=cancelled]:[border-color:oklch(from_var(--destructive)_l_c_h_/_0.22)]",
      // `.maka-explore-agent-head` (+ its `strong` title and `small` caption,
      // the latter shared with the nested summary-line small).
      "agent-head":
        "grid gap-[2px] pb-[6px] [border-bottom:1px_solid_var(--foreground-10)]"
        + " [&_strong]:min-w-0 [&_strong]:overflow-hidden [&_strong]:text-ellipsis [&_strong]:whitespace-nowrap [&_strong]:text-[13px] [&_strong]:text-[color:var(--foreground)]"
        + " [&_small]:text-[11px] [&_small]:text-[color:var(--foreground-50)] [&_small]:uppercase [&_small]:tracking-[0.04em]",
      // `.maka-explore-agent-summary-line` (+ its `small` ellipsis, layered over
      // the head's caption styling above).
      "agent-summary-line":
        "flex items-center justify-between gap-[8px] min-w-0 [&_small]:min-w-0 [&_small]:overflow-hidden [&_small]:text-ellipsis [&_small]:whitespace-nowrap",
      // `.maka-explore-agent-actions`
      "agent-actions": "flex items-center justify-end gap-[6px] mt-[4px]",
      // `.maka-explore-agent-message`
      "agent-message":
        "px-[10px] py-[8px] rounded-[var(--radius-control)] bg-[oklch(from_var(--destructive)_l_c_h_/_0.07)] text-[color:var(--destructive)] text-[12px]",
      // `.maka-explore-agent-meta` (+ its `div` cells, `dt` labels, `dd` values).
      "agent-meta":
        "grid grid-cols-[repeat(2,minmax(0,1fr))] gap-[8px] m-0"
        + " [&>div]:min-w-0 [&>div]:grid [&>div]:gap-[2px]"
        + " [&_dt]:text-[11px] [&_dt]:text-[color:var(--foreground-50)] [&_dt]:uppercase [&_dt]:tracking-[0.04em]"
        + " [&_dd]:min-w-0 [&_dd]:m-0 [&_dd]:overflow-hidden [&_dd]:text-ellipsis [&_dd]:whitespace-nowrap [&_dd]:text-[color:var(--foreground-70)] [&_dd]:text-[12px]",
      // `.maka-explore-agent-section` (+ its direct `> strong`, list `ul`/`li`
      // rows, leading `li` reset, `code` / `small` / `p` / `span` leaves).
      "agent-section":
        "grid gap-[6px]"
        + " [&>strong]:text-[12px] [&>strong]:text-[color:var(--foreground)]"
        + " [&_small]:text-[11px] [&_small]:text-[color:var(--foreground-50)] [&_small]:uppercase [&_small]:tracking-[0.04em]"
        + " [&_ul]:list-none [&_ul]:m-0 [&_ul]:p-0 [&_ul]:grid [&_ul]:gap-[6px]"
        + " [&_li]:min-w-0 [&_li]:grid [&_li]:gap-[3px] [&_li]:py-[6px] [&_li]:[border-top:1px_solid_var(--foreground-5)]"
        + " [&_li:first-child]:border-t-0 [&_li:first-child]:pt-0"
        + " [&_code]:min-w-0 [&_code]:overflow-hidden [&_code]:text-ellipsis [&_code]:whitespace-nowrap [&_code]:text-[color:var(--foreground)] [&_code]:bg-transparent [&_code]:[font-family:var(--font-mono)] [&_code]:text-[12px]"
        + " [&_p]:m-0 [&_p]:text-[color:var(--foreground-70)] [&_p]:text-[12px] [&_p]:leading-[1.45] [&_p]:[white-space:pre-wrap] [&_p]:[word-break:break-word]"
        + " [&_span]:m-0 [&_span]:text-[color:var(--foreground-70)] [&_span]:text-[12px] [&_span]:leading-[1.45] [&_span]:[white-space:pre-wrap] [&_span]:[word-break:break-word]",
      // `.maka-explore-agent-section-head` (+ its `> strong`).
      "agent-section-head":
        "flex items-center justify-between gap-[8px] min-w-0 [&>strong]:min-w-0 [&>strong]:text-[12px] [&>strong]:text-[color:var(--foreground)]",
      // `.maka-explore-agent-copy` (UiButton) + the copied / shared copy-state tints.
      "agent-copy":
        "[flex:0_0_auto] gap-[4px] min-h-[24px] px-[8px] py-[3px] text-[11px]"
        + " data-[copied=true]:text-[color:var(--accent)] data-[copied=true]:[border-color:oklch(from_var(--accent)_l_c_h_/_0.35)]"
        + " data-[pending=true]:cursor-progress"
        + " data-[copy-error=true]:text-[color:var(--destructive)] data-[copy-error=true]:[border-color:oklch(from_var(--destructive)_l_c_h_/_0.35)]",

      // ── web search ────────────────────────────────────────────────────────
      // `.maka-web-search-preview` (+ its bare `> header` / list leaves; the
      // container inherits the overlay base's mono font, never resetting it).
      "web-search":
        "grid gap-[8px] px-[12px] py-[10px] [border:1px_solid_var(--foreground-10)] rounded-[var(--radius-surface)] bg-[var(--foreground-3)]"
        + " [&>header]:flex [&>header]:flex-col [&>header]:gap-[2px] [&>header]:pb-[6px] [&>header]:[border-bottom:1px_solid_var(--foreground-10)]"
        + " [&>header_strong]:text-[13px] [&>header_strong]:text-[color:var(--foreground)] [&>header_strong]:font-semibold"
        + " [&>header_small]:text-[11px] [&>header_small]:text-[color:var(--foreground-50)] [&>header_small]:uppercase [&>header_small]:tracking-[0.04em]"
        + " [&_ul]:list-none [&_ul]:m-0 [&_ul]:p-0 [&_ul]:grid [&_ul]:gap-[8px]"
        + " [&_li]:grid [&_li]:gap-[3px] [&_li]:py-[8px] [&_li]:[border-top:1px_solid_var(--foreground-5)]"
        + " [&_li:first-child]:border-t-0 [&_li:first-child]:pt-0"
        + " [&_a]:font-semibold [&_a]:text-[color:var(--foreground)] [&_a]:no-underline [&_a:hover]:underline"
        + " [&_li_small]:text-[11px] [&_li_small]:text-[color:var(--foreground-50)] [&_li_small]:uppercase [&_li_small]:tracking-[0.04em]"
        + " [&_li_p]:m-0 [&_li_p]:text-[12px] [&_li_p]:text-[color:var(--foreground-70)] [&_li_p]:leading-[1.45] [&_li_p]:[white-space:pre-wrap] [&_li_p]:[word-break:break-word]",
      // `.maka-web-search-error` — the destructive container tint, layered over
      // the `web-search` part via `cn`. It MUST restate the FULL `[border: …]`
      // shorthand + `bg-[ …]` util — NOT a bare `[border-color: …]`/`[background: …]`
      // longhand. tailwind-merge only collapses utilities of the SAME property
      // form, so matching the base part's forms lets the error (last in `cn`)
      // collapse the base and win deterministically. A bare longhand survives
      // un-collapsed and then loses to the base shorthand by Tailwind's emission
      // order (the neutral border/bg is emitted later), silently dropping the
      // destructive tint. `color-mix` kept verbatim as an arbitrary value.
      "web-search-error":
        "[border:1px_solid_color-mix(in_oklab,var(--destructive-text)_32%,var(--foreground-10))] bg-[color-mix(in_oklab,var(--destructive-text)_8%,var(--foreground-3))]",
      // `.maka-web-search-error-message`
      "web-search-error-message":
        "m-0 text-[12px] leading-[1.45] [white-space:pre-wrap] [word-break:break-word] text-[color:var(--destructive-text)]",
      // `.maka-web-search-error-repair`
      "web-search-error-repair":
        "m-0 text-[12px] leading-[1.45] [white-space:pre-wrap] [word-break:break-word] text-[color:var(--foreground-70)]",

      // ── load-tool result card (separate base; not an overlay) ─────────────
      // `.maka-load-tool-preview` (+ its `p` margin reset).
      "load-tool":
        "mt-[5px] mx-0 mb-0 px-[8px] py-[5px] grid gap-[2px] rounded-[var(--radius-control)] bg-[var(--background)] text-[10px] [box-shadow:var(--shadow-minimal-flat)] [&_p]:m-0",
      // `.maka-load-tool-title`
      "load-tool-title": "font-semibold",
      // `.maka-load-tool-count`
      "load-tool-count": "text-[color:var(--foreground-2)]",
      // `.maka-load-tool-tools`
      "load-tool-tools": "[font-family:var(--font-mono)] [word-break:break-word]",
      // `.maka-load-tool-footer`
      "load-tool-footer": "text-[color:var(--foreground-2)] text-[11px]",
    },
  },
});

export { previewVariants };
