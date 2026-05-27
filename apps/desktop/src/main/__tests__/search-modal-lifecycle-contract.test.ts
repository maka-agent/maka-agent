/**
 * Static-analysis contract test for the SearchModal lifecycle
 * (PR-SIDEBAR-IA-0 Phase 3 P0 fixup).
 *
 * Background:
 *   WAWQAQ hit a React #310 ("Rendered fewer hooks than expected")
 *   in a real-window run of the Phase 3 build (msg `d53852ac`).
 *   xuan + kenji gated the merge until the lifecycle pattern is
 *   locked (xuan `558f1356`, kenji `3ddc91fe`).
 *
 *   The original SearchModal sat hooks BEFORE an `if (!open) return
 *   null`. While React technically allows hooks-then-early-return,
 *   it's a fragile pattern: adding a new hook below the return
 *   silently violates rules-of-hooks. The fixup matches
 *   `KeyboardHelpModal`'s conditional-mount pattern instead:
 *
 *     parent: `{open && <SearchModal onClose={...} />}`
 *     child:  function SearchModal({ onClose }) { ...hooks...; return JSX }
 *
 * This file is a grep-style gate. It does NOT mount React (the
 * desktop test setup has no DOM); the runtime exercise of the
 * mount/unmount cycle is covered by:
 *   - The `sidebar-search-modal-open` visual-smoke scenario, which
 *     forces the modal open at startup and captures a screenshot
 *     (verifies it can MOUNT cleanly).
 *   - The `sidebar-long-sessions` scenario, which captures the
 *     default state (verifies the renderer mounts cleanly WITHOUT
 *     the modal — the parent's `&&` guard skips the SearchModal
 *     subtree).
 *
 * If a future change reintroduces the `open` prop or the early
 * return inside SearchModal, this gate flips red.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { join, resolve } from 'node:path';

// The desktop test runs with cwd=apps/desktop; the UI package lives
// two levels up. Resolve once.
const COMPONENTS_PATH = resolve(process.cwd(), '..', '..', 'packages', 'ui', 'src', 'components.tsx');
const MAIN_TSX_PATH = join(process.cwd(), 'src', 'renderer', 'main.tsx');

describe('SearchModal lifecycle contract (PR-SIDEBAR-IA-0 Phase 3 P0 fixup)', () => {
  it('SearchModal signature takes only onClose — NO `open` prop (conditional-mount contract)', async () => {
    // The fragile `<SearchModal open={x} ...>` API is gone. The
    // parent owns lifecycle via `{open && <SearchModal .../>}`,
    // so SearchModal never has to do an early-return-before-JSX.
    const src = await readFile(COMPONENTS_PATH, 'utf8');
    // Find the `export function SearchModal(...)` declaration.
    const match = src.match(/export function SearchModal\s*\(\s*props\s*:\s*\{([^}]+)\}\s*\)/);
    assert.ok(match, 'SearchModal export must exist');
    const propBlock = match[1]!;
    assert.doesNotMatch(
      propBlock,
      /\bopen\s*:/,
      'SearchModal must NOT take an `open` prop (parent owns lifecycle via conditional mount)',
    );
    assert.match(
      propBlock,
      /onClose\s*\(\s*\)\s*:\s*void/,
      'SearchModal must take `onClose(): void` (the only prop)',
    );
  });

  it('SearchModal body has NO `if (!props.open) return null` early return', async () => {
    // The hooks-before-early-return pattern is removed. Match the
    // SearchModal function body and confirm no `if (...) return
    // null` shows up before the final `return (`. We grep the
    // narrow block between the signature and the next `^}` line.
    const src = await readFile(COMPONENTS_PATH, 'utf8');
    const startIdx = src.indexOf('export function SearchModal');
    assert.notEqual(startIdx, -1);
    // Find the start of the function body — the first `{` after
    // the signature.
    const bodyStart = src.indexOf('{', startIdx);
    assert.notEqual(bodyStart, -1);
    // Find the closing `}` of the function. SearchModal is
    // top-level (no nesting), so the next `^}` at column 0 ends it.
    const after = src.slice(bodyStart);
    const closingIdx = after.search(/\n\}\n/);
    assert.notEqual(closingIdx, -1);
    const body = after.slice(0, closingIdx);
    assert.doesNotMatch(
      body,
      /if\s*\(\s*!props\.open\s*\)\s*return\s*null/,
      'SearchModal body must NOT contain `if (!props.open) return null` — conditional mount lives at the parent',
    );
  });

  it('renderer mounts SearchModal conditionally via `{searchModalOpen && ...}`', async () => {
    // The fixup pattern at the call site: parent's `&&` short-
    // circuits before SearchModal is ever rendered, so its hooks
    // run only when open=true, with a fresh fiber each time.
    const src = await readFile(MAIN_TSX_PATH, 'utf8');
    // PR-UX-POLISH-1 commit 5 (relax-only): allow optional `(` between
    // `&&` and `<SearchModal` so multi-line JSX with multiple props
    // (`onClose`, `deps`, `onNavigateToSession`) still satisfies the
    // contract. The semantic gate — conditional mount on
    // `searchModalOpen` — is unchanged. Also relax the prop-anchor:
    // any prop name starting with `on` (`onClose`, `onNavigateToSession`)
    // is acceptable so future prop reorders don't trip the regex.
    assert.match(
      src,
      /\{searchModalOpen\s*&&\s*\(?\s*<SearchModal\s+on[A-Z]/,
      'renderer must mount SearchModal via `{searchModalOpen && <SearchModal ... />}` with at least one `on*` prop',
    );
    assert.doesNotMatch(
      src,
      /<SearchModal\s+open=/,
      'renderer must NOT pass `open=` to SearchModal — conditional mount instead',
    );
  });

  it('KeyboardHelpModal still uses conditional mount (alignment with SearchModal pattern)', async () => {
    // Sanity gate: SearchModal's new shape matches
    // KeyboardHelpModal's existing shape. If KeyboardHelpModal
    // ever flips to always-mounted with an internal early return,
    // we want to know — that would re-introduce the same class of
    // hook-order foot-guns.
    const src = await readFile(MAIN_TSX_PATH, 'utf8');
    assert.match(
      src,
      /\{helpOpen\s*&&\s*<KeyboardHelpModal\s+onClose=/,
      'renderer must mount KeyboardHelpModal conditionally (same pattern as SearchModal)',
    );
  });
});
