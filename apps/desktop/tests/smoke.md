# Desktop smoke runbook

Use the narrowest deterministic check that covers the change, then add live-window or screenshot evidence when the risk requires it. Scenario inventories and check identifiers live in the scripts and fixtures, not in this document.

## Automated desktop checks

Run the desktop test suite for main-process, IPC, fixture, or contract changes:

```bash
npm --workspace @maka/desktop test
```

For a journey across renderer and main, extend the existing Playwright E2E suite and run:

```bash
npm --workspace @maka/desktop run e2e
```

Keep these runs on the fake backend and use deterministic fixtures.

## Real Electron window smoke

Screenshots and DOM checks do not prove native resize, drag regions, modal focus, or a healthy live renderer. Changes to the shell, sidebar, modal backdrop, window drag regions, or top-level renderer lifecycle must run:

```bash
npm --workspace @maka/desktop run smoke:real-window
```

The script builds the required workspaces, launches Electron with isolated user data, records programmatic checks, and prompts for native OS checks. Confirm that:

- the window launches without a crash or ErrorBoundary;
- each edge resizes and dragging all four corners resizes diagonally;
- allowed titlebar regions drag the window while controls do not;
- the Search modal opens and closes by button, backdrop, and Escape;
- Tab and Shift+Tab stay inside the modal and return focus afterward;
- modal-open window edges remain resizable;
- switching modules after closing the modal leaves the renderer healthy.

Reports are written under `apps/desktop/tests/real-window-smoke/`. A failed or unverified native check must remain visible in the report. A UI-shell PR is not ready to merge until the required report is attached or summarized for review.

For environments that cannot perform native hit testing, run the programmatic layer explicitly and record the limitation:

```bash
npm --workspace @maka/desktop run smoke:programmatic-window
```

## Screenshot validation

The capture script owns `ALL_SCENARIOS` and `VARIANTS`. Capture one relevant scenario during iteration or the full matrix for broad visual changes:

```bash
npm --workspace @maka/desktop run screenshots:single artifact-pane
npm --workspace @maka/desktop run screenshots
```

Compare the stable subset or full baseline:

```bash
npm --workspace @maka/desktop run screenshots:diff:stable
npm --workspace @maka/desktop run screenshots:diff
```

Promote baselines only after intentional changes have been reviewed:

```bash
npm --workspace @maka/desktop run screenshots:baseline:stable
npm --workspace @maka/desktop run screenshots:baseline
```

The dimension/inventory diff is a capture-integrity gate, not a pixel-level visual oracle. Review changed images for layout, color, typography, spacing, state, and reduced-motion behavior.

To inspect deterministic fixtures interactively without touching a real workspace:

```bash
MAKA_VISUAL_SMOKE_FIXTURE=all npm --workspace @maka/desktop run dev
```

Use a scenario name from `ALL_SCENARIOS` for a narrower launch.

## Release floor

Before a release, run the full automated suite, the full screenshot matrix and review, and real-window smoke on supported desktop platforms. Record any platform that could not be verified rather than treating absence of evidence as a pass.
