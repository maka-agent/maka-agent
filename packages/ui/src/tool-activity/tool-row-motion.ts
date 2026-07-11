import { type ToolActivityItem } from '../materialize.js';

type ToolStatus = ToolActivityItem['status'];

/**
 * The run→done seam (#646 + #tool-jitter). A tool row is visible the instant it
 * starts; running statuses shimmer (the light band via `TextShimmer delayed`),
 * and the row settles by that band stopping — the same seam as the 深度思考
 * disclosure title, with no opacity fade so parallel tools finishing together
 * don't stack N fades.
 *
 * The ~200ms de-flicker before the sweep starts is CSS (`animation-delay` on
 * `TextShimmer delayed`), so a sub-second tool that settles inside the window
 * unmounts mid-delay and never visibly sweeps — no logic needed here.
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