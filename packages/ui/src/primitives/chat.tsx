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
 * The row keeps the authored `.maka-message-row` base (centered reading column
 * + entrance fade/animation + the `data-maka-visual-smoke` disable). That base
 * lives in maka-tokens.css's `@layer components`, so the role utilities below
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
      // Values are LITERAL (`rounded-[10px]`, `px-[14px] py-[10px]`), not the
      // design-system scale (`rounded-lg`, `px-3.5`): the retired CSS hardcoded
      // these pixels, so the literal is the faithful, self-evidently-equal
      // translation and immune to later scale/token re-tuning (the visual
      // refresh, not this governance pass, owns adopting the scale). Keeps the
      // neutral `--chat-user-bg` token path (never primary/accent).
      user: "max-w-[min(100%,640px)] whitespace-pre-wrap break-words rounded-[10px] bg-[var(--chat-user-bg)] px-[14px] py-[10px] leading-[1.6] text-[color:var(--chat-user-foreground,var(--foreground))]",
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
 * Every value is a LITERAL arbitrary utility (`gap-[6px]`, `rounded-[999px]`,
 * `bg-[oklch(from_var(--foreground)_l_c_h_/_0.06)]`, `data-[kind=model]:…`),
 * never the semantic scale — the literal is the faithful, self-evidently-equal
 * translation of the retired pixels/tokens and is immune to later re-tuning
 * (the visual refresh, not this governance pass, owns adopting the scale). Each
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
 * `markerVariants` is exported (shadcn `buttonVariants` style) so the lineage
 * badge + footer action — which render as `UiButton` and can't be wrapped —
 * apply the shell via `className`; `Button` runs it through `cn`/tailwind-merge
 * last, so it wins over the button's own variant utilities.
 *
 * NOTE: `.maka-turn-thinking` (the committed-turn reasoning `<details>`) is
 * deliberately NOT migrated here. Its chrome lives in `summary::before` /
 * `::-webkit-details-marker` pseudo-elements and an `@starting-style` body fade
 * that don't reduce to leaf utilities (so the source-string == computed-style
 * proof wouldn't hold), and `maka-tokens.css` already documents an intended
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
        "ml-[4px] px-[6px] py-[1px] rounded-[999px] bg-[oklch(from_var(--foreground)_l_c_h_/_0.06)] text-[color:var(--foreground-60)] text-[11px] font-semibold",
      // `.maka-turn-aborted-marker` (+ its italic `em`) — dormant, muted.
      aborted:
        "inline-flex w-fit items-center gap-[4px] mx-0 mt-[2px] mb-[4px] px-[6px] py-[2px] rounded-[6px] bg-[var(--foreground-5)] text-[color:var(--foreground-60)] text-[12px] italic [&_em]:italic",
      // `.maka-turn-failed-banner` — fault state, destructive tone.
      "failed-banner":
        "inline-flex w-fit flex-wrap items-center gap-[6px] mx-0 mt-[2px] mb-[6px] px-[8px] py-[4px] rounded-[6px] border border-[oklch(from_var(--destructive)_l_c_h_/_0.28)] bg-[oklch(from_var(--destructive)_l_c_h_/_0.10)] text-[color:var(--destructive)] text-[12px]",
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
        "inline-flex items-center gap-[3px] px-[5px] py-[1px] rounded-[999px] border-0 bg-[oklch(from_var(--foreground)_l_c_h_/_0.05)] text-[color:var(--foreground-48)] text-[9px] [transition:background_150ms_var(--ease-out-strong),color_150ms_var(--ease-out-strong)]"
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
        "inline-flex items-center gap-[6px] min-h-[28px] px-[8px] py-[4px] rounded-[8px] border-0 bg-transparent text-[color:var(--foreground-50)] text-[12px] [transition:background_120ms_ease,color_120ms_ease,opacity_120ms_ease]"
        + " [&:hover:not(:disabled)]:bg-[oklch(from_var(--foreground)_l_c_h_/_0.05)] [&:hover:not(:disabled)]:text-[color:var(--foreground)]"
        + " focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px]"
        + " disabled:opacity-[0.45] disabled:cursor-not-allowed aria-disabled:opacity-[0.45] aria-disabled:cursor-not-allowed"
        + " data-[pending=true]:opacity-[0.78] data-[pending=true]:cursor-progress"
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
