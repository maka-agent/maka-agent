import { type ToolActivityItem } from '../materialize.js';

type ToolStatus = ToolActivityItem['status'];

/**
 * The run→done seam (#646). A tool row is visible the instant it starts, but its
 * two motions are gated so history stays quiet and sub-second tools never flicker:
 *
 * - `shimmer` — the working light-band sweeps the label while the tool is
 *   in flight. The ~200ms de-flicker delay is CSS (`animation-delay` on the
 *   sweep, see `TextShimmer delayed`), so a tool that settles inside the window
 *   unmounts mid-delay and never visibly sweeps — no logic needed here.
 * - `settling` — the one-shot "landing" fade only plays for a row that was seen
 *   running in THIS view and just settled, never for a replayed transcript's rows
 *   (mounted already terminal). The caller tracks `everRunning` with a ref.
 */

/**
 * Running-like statuses whose row shimmers. `waiting_permission` counts as
 * running: the row is still an open, in-flight affordance and its shimmer is the
 * "waiting on it/you" signal (the model-wait indicator, by contrast, hides while
 * a permission prompt is up — that gap is the prompt's job, not a dead window).
 */
export function isToolRowRunning(status: ToolStatus): boolean {
  return status === 'pending' || status === 'running' || status === 'waiting_permission';
}

/** Terminal statuses — the row has landed on a result (success, error, or interrupt). */
export function isToolRowSettled(status: ToolStatus): boolean {
  return status === 'completed' || status === 'errored' || status === 'interrupted';
}

export interface ToolRowMotion {
  /** Shimmer the working label (the delay that de-flickers sub-second tools is CSS). */
  shimmer: boolean;
  /** The row is on a terminal result. */
  settled: boolean;
  /**
   * Settled *after being seen running in this view* — plays the one-shot settle
   * fade. False for a replayed transcript's rows (mounted already terminal), so a
   * loaded session's tool history stays static instead of fading in on scroll.
   */
  settling: boolean;
}

export function deriveToolRowMotion(input: { status: ToolStatus; everRunning: boolean }): ToolRowMotion {
  const settled = isToolRowSettled(input.status);
  return {
    shimmer: isToolRowRunning(input.status),
    settled,
    settling: settled && input.everRunning,
  };
}
