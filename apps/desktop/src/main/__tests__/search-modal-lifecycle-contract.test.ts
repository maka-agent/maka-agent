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
const COMMAND_PALETTE_CONTENT_PATH = join(process.cwd(), 'src', 'renderer', 'command-palette-content-search.ts');

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

  it('returns focus to the sidebar Search trigger when the modal closes', async () => {
    const components = await readFile(COMPONENTS_PATH, 'utf8');
    const main = await readFile(MAIN_TSX_PATH, 'utf8');
    const sidebarModules = components.match(/<nav className="maka-sidebar-modules"[\s\S]*?<\/nav>/)?.[0] ?? '';
    const closeSearchModal = main.match(/function closeSearchModal\(\) \{[\s\S]*?\n  \}/)?.[0] ?? '';

    assert.match(
      sidebarModules,
      /data-maka-search-trigger="true"[\s\S]*aria-haspopup="dialog"/,
      'Sidebar Search trigger must be queryable for focus restoration after modal close',
    );
    assert.match(
      closeSearchModal,
      /setSearchModalOpen\(false\);[\s\S]*requestAnimationFrame/,
      'Search close handler must defer focus restoration until after React unmounts the modal',
    );
    assert.match(
      closeSearchModal,
      /querySelector<HTMLButtonElement>\('\[data-maka-search-trigger="true"\]'\)[\s\S]*focus\(\{ preventScroll: true \}\)/,
      'Search close handler must restore keyboard focus to the Search trigger',
    );
    assert.match(
      main,
      /<SearchModal\s+onClose=\{closeSearchModal\}/,
      'SearchModal must use the focus-restoring close handler',
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
    const contentSearch = await readFile(COMMAND_PALETTE_CONTENT_PATH, 'utf8');

    assert.match(
      components,
      /props\.onNavigateToSession\(result\.target\.sessionId,\s*result\.target\.turnId\)/,
      'SearchModal must pass the matched turnId through to the renderer shell',
    );
    assert.match(
      contentSearch,
      /onSelectSession\(hit\.sessionId,\s*hit\.turnId\)/,
      'Command Palette content-search hits must pass the matched turnId through too',
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
    assert.match(searchModal, /role="listbox" aria-label="搜索结果"/, 'Search results must expose a listbox for aria-activedescendant');
    assert.match(searchModal, /role="option"[\s\S]*aria-selected=\{activeResultIndex === index\}/, 'Search result rows must expose selected option state');
    assert.match(searchModal, /keyboardKey\(event, \['ArrowDown', 'Down'\]\)[\s\S]*moveActiveResult\(1,\s*\{ focusResult: true \}\)/, 'ArrowDown/Down must move focus to the next result');
    assert.match(searchModal, /keyboardKey\(event, \['ArrowUp', 'Up'\]\)[\s\S]*moveActiveResult\(-1,\s*\{ focusResult: true \}\)/, 'ArrowUp/Up must move focus to the previous result');
    assert.match(searchModal, /function jumpActiveResult\(index: number,\s*options\?: \{ focusResult\?: boolean \}\)/, 'SearchModal must support direct active-result jumps');
    assert.match(searchModal, /keyboardKey\(event, \['Home'\]\)[\s\S]*jumpActiveResult\(0,\s*\{ focusResult: true \}\)/, 'Home must jump focus to the first result');
    assert.match(searchModal, /keyboardKey\(event, \['End'\]\)[\s\S]*jumpActiveResult\(results\.length - 1,\s*\{ focusResult: true \}\)/, 'End must jump focus to the last result');
    assert.match(searchModal, /function selectKeyboardResult\(\) \{[\s\S]*results\[activeResultIndex >= 0 \? activeResultIndex : 0\]/, 'Enter/Return must fall back to opening the first result when no row is active');
    assert.match(searchModal, /keyboardKey\(event, \['Enter', 'Return'\]\) && showResults[\s\S]*selectKeyboardResult\(\)/, 'Enter/Return must open a keyboard result from the input');
    assert.match(searchModal, /onKeyUp=\{\(event\) => \{[\s\S]*keyboardKey\(event, \['Enter', 'Return'\]\) && showResults[\s\S]*selectKeyboardResult\(\)/, 'Search input must also handle Enter/Return on keyup for Electron search-field activation quirks');
    assert.match(searchModal, /function handleResultKeyDown\(event: KeyboardEvent<HTMLButtonElement>, index: number, result: SearchResult\)/, 'Focused search result rows must have their own keyboard handler');
    assert.match(searchModal, /keyboardKey\(event, \['Enter', 'Return', 'Space', ' '\]\)[\s\S]*selectResult\(result\)/, 'Focused search result rows must activate on Enter, Return, or Space');
    assert.match(searchModal, /tabIndex=\{-1\}/, 'Search result rows should be arrow-key focused, not extra tab stops');
    assert.match(searchModal, /onKeyDown=\{\(event\) => handleResultKeyDown\(event, index, result\)\}/, 'Search result rows must wire the keyboard handler');
    assert.match(searchModal, /data-active=\{activeResultIndex === index \? 'true' : undefined\}/, 'Active result must get a visible state hook');
    assert.match(styles, /\.maka-search-modal-result\[data-active="true"\]:not\(\[disabled\]\)/, 'Active search result must have dedicated styling');
  });

  it('search input keeps focus after results load until the user navigates results', async () => {
    const components = await readFile(COMPONENTS_PATH, 'utf8');
    const searchModal = components.slice(components.indexOf('export function SearchModal'), components.indexOf('/**\n * Render an ordered list of session groups'));
    const hook = components.slice(components.indexOf('export function useModalA11y'), components.indexOf('const FOCUSABLE_SELECTOR'));

    assert.match(
      hook,
      /initialFocusRef\?: RefObject<HTMLElement \| null>/,
      'useModalA11y must allow a modal to nominate the correct initial focus target',
    );
    assert.match(
      searchModal,
      /useModalA11y\(dialogRef,\s*props\.onClose,\s*inputRef\)/,
      'SearchModal must give initial modal focus to the search input, not the close button',
    );
    assert.match(
      searchModal,
      /setResults\(response\);\s*setError\(null\);\s*setActiveResultIndex\(-1\);/m,
      'Search results must not automatically move active-descendant focus onto the first result while the user is still typing',
    );
    assert.match(
      searchModal,
      /const next = activeResultIndex < 0\s*\?\s*\(delta > 0 \? 0 : results\.length - 1\)/,
      'Arrow navigation should still select the first or last result from the input',
    );
  });

  it('search query has an explicit clear button because the native search cancel is hidden', async () => {
    const components = await readFile(COMPONENTS_PATH, 'utf8');
    const styles = await readFile(STYLES_PATH, 'utf8');
    const searchModal = components.slice(components.indexOf('export function SearchModal'), components.indexOf('/**\n * Render an ordered list of session groups'));

    assert.match(styles, /\.maka-search-modal-input::-webkit-search-cancel-button\s*\{\s*display:\s*none;/, 'Native search cancel is intentionally hidden for visual consistency');
    assert.match(searchModal, /query\.length > 0 && \(/, 'Clear button should appear only when the query has content');
    assert.match(searchModal, /className="maka-search-modal-clear"[\s\S]*aria-label="清空搜索"/, 'Search modal must provide an explicit clear search button');
    assert.match(searchModal, /onClick=\{clearSearchQuery\}/, 'Clear search button must use the shared clear helper');
    assert.match(searchModal, /function clearSearchQuery\(\) \{[\s\S]*setQuery\(''\);[\s\S]*clearSearchState\(\);[\s\S]*inputRef\.current\?\.focus\(\);[\s\S]*\}/, 'Clear search helper must clear the query, invalidate search state, and return focus to input');
    assert.match(styles, /\.maka-search-modal-clear/, 'Clear search button needs dedicated styling');
  });

  it('empty query invalidates any already-started search request from every clear path', async () => {
    const components = await readFile(COMPONENTS_PATH, 'utf8');
    const searchModal = components.slice(components.indexOf('export function SearchModal'), components.indexOf('/**\n * Render an ordered list of session groups'));

    assert.match(searchModal, /function clearSearchState\(\) \{\s*ticketRef\.current \+= 1;\s*setResults\(\[\]\);/m, 'Shared clear state helper must invalidate in-flight search before clearing results');
    assert.match(searchModal, /function updateSearchQuery\(nextQuery: string\) \{[\s\S]*if \(nextQuery\.trim\(\)\.length === 0\) \{[\s\S]*clearSearchState\(\);[\s\S]*\}/, 'Typing/deleting to an empty query must synchronously invalidate in-flight search');
    assert.match(searchModal, /onChange=\{\(event\) => updateSearchQuery\(event\.currentTarget\.value\)\}/, 'Search input changes must go through the synchronized update helper');
    assert.match(searchModal, /keyboardKey\(event, \['Escape'\]\) && query[\s\S]*clearSearchQuery\(\);/, 'Escape clear path must synchronously invalidate in-flight search');
    assert.match(
      searchModal,
      /if \(trimmed\.length === 0\) \{\s*ticketRef\.current \+= 1;\s*setResults\(\[\]\);/m,
      'Clearing the query must invalidate in-flight search responses before clearing results, otherwise stale responses can repopulate an empty query',
    );
    assert.match(searchModal, /if \(ticket !== ticketRef\.current\) return; \/\/ newer query in flight/, 'Search responses must still be guarded by the latest ticket');
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

  it('search modal copy reflects session title hits as part of the supported scope', async () => {
    const components = await readFile(COMPONENTS_PATH, 'utf8');
    const searchModal = components.slice(components.indexOf('export function SearchModal'), components.indexOf('/**\n * Render an ordered list of session groups'));

    assert.match(searchModal, /placeholder="搜索会话标题和内容…"/, 'Search input placeholder must include session titles');
    assert.match(searchModal, /aria-label="搜索会话标题和内容"/, 'Search input accessible label must include session titles');
    assert.match(searchModal, /结果只包含会话标题和内容文本，不进入网络。/, 'Search empty-state copy must describe the actual local title/content scope');
    assert.match(searchModal, /没有匹配的会话标题或内容。换个关键词试试。/, 'Search no-match copy must not imply title hits are unsupported');
  });

  it('search modal generic error copy is a retryable local-search state', async () => {
    const components = await readFile(COMPONENTS_PATH, 'utf8');
    const searchModal = components.slice(components.indexOf('export function SearchModal'), components.indexOf('/**\n * Render an ordered list of session groups'));

    assert.match(searchModal, /搜索服务需要刷新，请重试。/);
    assert.doesNotMatch(searchModal, /搜索暂时不可用，请稍后重试。/, 'Search modal fallback error should not read like a generic unavailable feature');
  });

  it('modal focus restoration does not steal focus during React StrictMode effect replay', async () => {
    const components = await readFile(COMPONENTS_PATH, 'utf8');
    const hook = components.slice(components.indexOf('export function useModalA11y'), components.indexOf('const FOCUSABLE_SELECTOR'));

    assert.match(
      hook,
      /queueMicrotask\(\(\) => \{\s*if \(document\.contains\(container\)\) return;\s*if \(previouslyFocused && document\.contains\(previouslyFocused\)\)/m,
      'StrictMode effect cleanup must not restore focus to the opener while the modal container is still mounted',
    );
  });

  it('session time buckets use product labels without unfinished-state wording', async () => {
    const components = await readFile(COMPONENTS_PATH, 'utf8');
    const groupingBlock = components.slice(components.indexOf('function groupSessionsByTime'), components.indexOf('function formatSessionMeta'));

    assert.match(groupingBlock, /label:\s*'待发送'/, 'Sessions with no messages should live in the concise pending-send bucket');
    assert.doesNotMatch(groupingBlock, /尚未发送/, 'Session group labels should not read like unfinished implementation copy');
  });
});
