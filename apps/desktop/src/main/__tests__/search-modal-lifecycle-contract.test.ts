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
const STYLES_PATH = join(process.cwd(), 'src', 'renderer', 'styles.css');

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

  it('search result navigation consumes target.turnId instead of only switching sessions', async () => {
    const components = await readFile(COMPONENTS_PATH, 'utf8');
    const main = await readFile(MAIN_TSX_PATH, 'utf8');

    assert.match(
      components,
      /props\.onNavigateToSession\(result\.target\.sessionId,\s*result\.target\.turnId\)/,
      'SearchModal must pass the matched turnId through to the renderer shell',
    );
    assert.doesNotMatch(
      main,
      /onNavigateToSession=\{\(sessionId,\s*_turnId\)/,
      'renderer must not intentionally ignore SearchResult.target.turnId',
    );
    assert.match(
      main,
      /setSearchScrollTarget\(\{\s*sessionId,\s*turnId,\s*nonce:/,
      'renderer must store a turn scroll target when search provides one',
    );
    assert.match(
      main,
      /scrollTargetTurn=\{[\s\S]*searchScrollTarget\.turnId[\s\S]*searchScrollTarget\.nonce[\s\S]*\}/,
      'renderer must pass the pending search turn target into ChatView',
    );
    assert.match(
      components,
      /scrollTargetTurn\?:\s*\{\s*turnId:\s*string;\s*nonce:\s*number\s*\}/,
      'ChatView must expose a typed scroll target prop',
    );
    assert.match(
      components,
      /scrollIntoView\(\{\s*behavior:\s*props\.scrollBehavior\s*\?\?\s*'smooth',\s*block:\s*'center'/,
      'ChatView must scroll the matched turn into view',
    );
    assert.match(
      components,
      /data-search-highlight=\{props\.searchHighlighted\s*\?\s*'true'\s*:\s*undefined\}/,
      'ChatView must visually mark the matched search turn',
    );
  });

  it('search results support keyboard selection from the input', async () => {
    const components = await readFile(COMPONENTS_PATH, 'utf8');
    const styles = await readFile(STYLES_PATH, 'utf8');
    const searchModal = components.slice(components.indexOf('export function SearchModal'), components.indexOf('/**\n * Render an ordered list of session groups'));

    assert.match(searchModal, /activeResultIndex/, 'SearchModal must track the active result index');
    assert.match(searchModal, /aria-activedescendant=\{activeResultId\}/, 'Search input must expose the active result to assistive tech');
    assert.match(searchModal, /event\.key === 'ArrowDown'[\s\S]*moveActiveResult\(1\)/, 'ArrowDown must move to the next result');
    assert.match(searchModal, /event\.key === 'ArrowUp'[\s\S]*moveActiveResult\(-1\)/, 'ArrowUp must move to the previous result');
    assert.match(searchModal, /event\.key === 'Enter'[\s\S]*selectResult\(results\[activeResultIndex\]!\)/, 'Enter must open the active result');
    assert.match(searchModal, /data-active=\{activeResultIndex === index \? 'true' : undefined\}/, 'Active result must get a visible state hook');
    assert.match(styles, /\.maka-search-modal-result\[data-active="true"\]:not\(\[disabled\]\)/, 'Active search result must have dedicated styling');
  });

  it('search snippets highlight query matches without unsafe HTML rendering', async () => {
    const components = await readFile(COMPONENTS_PATH, 'utf8');
    const styles = await readFile(STYLES_PATH, 'utf8');
    const searchModal = components.slice(components.indexOf('export function SearchModal'), components.indexOf('/**\n * Render an ordered list of session groups'));

    assert.match(searchModal, /renderSearchSnippet\(result\.snippet,\s*trimmed\)/, 'Search snippets must render with the current query highlight helper');
    assert.match(components, /function renderSearchSnippet\(snippet: string,\s*query: string\): ReactNode/, 'Snippet highlight helper must stay local and typed');
    assert.match(components, /<mark key=\{\`\$\{matchIndex\}-\$\{end\}\`\} className="maka-search-modal-snippet-hit">/, 'Highlighted matches must use React-rendered <mark>, not HTML strings');
    assert.doesNotMatch(searchModal, /dangerouslySetInnerHTML/, 'SearchModal must not use dangerouslySetInnerHTML for snippets');
    assert.match(styles, /\.maka-search-modal-snippet-hit/, 'Highlighted search snippets must have dedicated styling');
  });

  it('search result list announces result count and truncation state', async () => {
    const components = await readFile(COMPONENTS_PATH, 'utf8');
    const styles = await readFile(STYLES_PATH, 'utf8');
    const searchModal = components.slice(components.indexOf('export function SearchModal'), components.indexOf('/**\n * Render an ordered list of session groups'));

    assert.match(searchModal, /const resultsTruncated = showResults && results\.some\(\(result\) => result\.truncated === true\)/, 'SearchModal must derive truncation state from SearchResult.truncated');
    assert.match(searchModal, /className="maka-search-modal-result-summary" aria-live="polite"/, 'Search result summary must be announced politely');
    assert.match(searchModal, /找到 \{results\.length\} 条匹配/, 'Search results must show a count');
    assert.match(searchModal, /结果较多，已显示前 \{results\.length\} 条/, 'Truncated result sets must say only the first results are shown');
    assert.match(styles, /\.maka-search-modal-result-summary/, 'Search result summary needs dedicated styling');
  });

  it('search result rows render source summaries from SearchResult.summary', async () => {
    const components = await readFile(COMPONENTS_PATH, 'utf8');
    const styles = await readFile(STYLES_PATH, 'utf8');
    const searchModal = components.slice(components.indexOf('export function SearchModal'), components.indexOf('/**\n * Render an ordered list of session groups'));

    assert.match(searchModal, /result\.summary && <div className="maka-search-modal-result-meta">\{result\.summary\}<\/div>/, 'Search result rows must render source summary metadata');
    assert.match(styles, /\.maka-search-modal-result-meta/, 'Search result source summary needs dedicated styling');
  });
});
