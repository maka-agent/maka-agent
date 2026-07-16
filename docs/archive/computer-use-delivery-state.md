# Computer Use Delivery State

This follow-up preserves delivery uncertainty after a native or Electron action
has reached the executor.

## Problems

- AX and CDP text writes became `capture_failed` when readback did not confirm
  the value, even though the write had already been delivered.
- A successful semantic action became `capture_failed` or
  `sensitivity_blocked` when its required fresh screenshot failed.
- A failed screenshot observation was stored before normalization and could
  evict an earlier usable observation.
- The model-facing description still claimed Electron text was always refused.

## Fix

- Delivered but unverifiable writes and semantic actions return
  `outcome_unknown`.
- Fresh-capture errors after dispatch retain the action's delivered state.
- Observations enter the bounded FIFO only after screenshot normalization
  succeeds.
- The tool description documents the unique CDP click and text path.

These changes do not weaken pre-dispatch freshness, identity, occlusion, or
physical-input checks.
