import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { REPO_ROOT, RENDERER_STYLES_DIR, TOKENS_FILE, readAllRendererCss, stripCssComments } from './css-test-helpers.js';

/**
 * Zero-visual governance contract for issue #332 PR4 — the tool-result preview
 * surfaces (the shared `.maka-overlay-preview` base + `.maka-overlay-close`, the
 * file-diff / terminal / office-document / explore-agent + subagent / web-search
 * cards, and the separate `.maka-load-tool-*` card) moved onto the `@maka/ui`
 * `previewVariants` literalize table.
 *
 * The file-diff and terminal shells are proven pixel-identical by the existing
 * visual-smoke screenshot fixture (it renders a `file_diff` and a `terminal` tool
 * result through the real chat pipeline); the remaining card surfaces are 1:1
 * literal translations of the retired declarations. So this test does NOT
 * re-assert those literals wholesale — that would only mirror the implementation.
 * It locks what a screenshot / computed-style diff cannot cover:
 *   1. the ABSENCE of the retired selectors (a diff of computed styles can't show
 *      a selector is gone), scoped so the still-bespoke neighbours survive — the
 *      `.maka-tool-error*` banner (PR3c), `.maka-code` base, `.maka-message-row`
 *      (PR1), the artifact pane's own `.maka-artifact-preview-diff` positioning,
 *      the `.composer` (next component), and the Settings live-query list;
 *   2. the card mount entrance `@keyframes maka-tool-card-enter` relocating to the
 *      canonical motion home (maka-tokens.css) — an animation can't be a leaf
 *      literal and `getComputedStyle` reads a phase-dependent value;
 *   3. the escape literals + the cross-package barrel export the diff harness (a
 *      chat-only fixture) never exercises.
 */
describe('chat preview-surface migration contract (#332 PR4)', () => {
  it('retires the bespoke OverlayPreview family + load-tool selectors', async () => {
    const css = stripCssComments(await readAllRendererCss());
    for (const selector of [
      '.maka-overlay-preview',
      '.maka-overlay-close',
      '.maka-tool-diff',
      '.maka-tool-terminal',
      '.maka-office-document',
      '.maka-explore-agent',
      '.maka-subagent-preview',
      '.maka-web-search',
      '.maka-load-tool',
    ]) {
      assert.ok(
        !css.includes(selector),
        `retired preview selector "${selector}" still present in renderer CSS`,
      );
    }
  });

  it('leaves adjacent out-of-scope surfaces untouched', async () => {
    const css = stripCssComments(await readAllRendererCss());
    for (const kept of [
      '.maka-code', // shared inline-code base (Markdown / args / previews)
      '.maka-message-row', // PR1 message row
      '.composer', // out of scope — the next component
      '.settingsWebSearch', // Settings live-query list, NOT the chat web-search card
    ]) {
      assert.ok(
        css.includes(kept),
        `PR4 must not retire the out-of-scope selector "${kept}"`,
      );
    }
  });

  it('moves @keyframes maka-tool-card-enter to the canonical motion home', async () => {
    const tokens = stripCssComments(await readFile(TOKENS_FILE, 'utf8'));
    assert.ok(
      tokens.includes('@keyframes maka-tool-card-enter'),
      '`@keyframes maka-tool-card-enter` must live in maka-tokens.css now (next to maka-pulse / maka-tool-pulse)',
    );
    const toolOutput = stripCssComments(
      await readFile(resolve(RENDERER_STYLES_DIR, 'tool-output.css'), 'utf8'),
    );
    assert.ok(
      !toolOutput.includes('@keyframes maka-tool-card-enter'),
      'the keyframe must no longer live in styles/tool-output.css',
    );
    // The frames the card entrance animates between (the diff harness can't read a
    // keyframe). Opacity 0 + scale .97 -> 1.
    const block = tokens.slice(
      tokens.indexOf('@keyframes maka-tool-card-enter'),
      tokens.indexOf('@keyframes maka-tool-card-enter') + 160,
    );
    assert.ok(
      block.includes('opacity: 0') && block.includes('scale(0.97)'),
      'maka-tool-card-enter must keep the retired from-frame (opacity 0 / scale .97)',
    );
    assert.ok(block.includes('scale(1)'), 'maka-tool-card-enter must keep the retired to-frame (scale 1)');
  });

  it('pins the preview escape literals + guards against scale drift in chat.tsx', async () => {
    const rawSrc = await readFile(
      resolve(REPO_ROOT, 'packages', 'ui', 'src', 'primitives', 'chat.tsx'),
      'utf8',
    );
    const chatSrc = rawSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const start = chatSrc.indexOf('const previewVariants');
    const block = chatSrc.slice(start, chatSrc.indexOf('export { previewVariants }', start));
    assert.ok(start !== -1 && block.length > 0, 'previewVariants table must exist in chat.tsx');

    // The card mount entrance is a keyframe animation the diff harness can't reach.
    assert.ok(
      block.includes('[animation:maka-tool-card-enter_350ms_var(--ease-out-strong)_both]'),
      'diff / terminal / load-tool cards must carry the entrance animation literal',
    );
    // The file-diff data-line colour matrix — the one preview surface whose tint
    // varies by attribute and which BOTH chat and artifact-preview render, so the
    // shared part is the co-migration's load-bearing literal.
    for (const tint of [
      'data-[line=add]:text-[color:var(--success-text)]',
      'data-[line=del]:text-[color:var(--destructive)]',
      'data-[line=hunk]:bg-[oklch(from_var(--accent)_l_c_h_/_0.08)]',
    ]) {
      assert.ok(block.includes(tint), `diff-line must keep the literal "${tint}"`);
    }
    // The overlay base + structured-card kind use ARBITRARY white-space so the kind
    // overrides the base by tailwind-merge last-occurrence — the `cn(overlay, kind)`
    // reproduction of the retired two-class source-order cascade. If a careless
    // "simplification" swapped the base back to the utility `whitespace-pre-wrap`,
    // the override would stop deduping and the card could inherit pre-wrap.
    assert.ok(
      block.includes('[white-space:pre-wrap]') && block.includes('[white-space:normal]'),
      'overlay base + card kind must both use arbitrary white-space so the kind wins by tailwind-merge',
    );

    // Anti-drift: the literalize vehicle stays arbitrary-value (immune to a later
    // scale/token re-tuning silently shifting pixels). Pin distinctive literals and
    // ban the semantic-scale forms they would be swapped for.
    for (const literal of ['rounded-[8px]', 'text-[11.5px]', 'max-h-[180px]']) {
      assert.ok(block.includes(literal), `previewVariants must keep the literal "${literal}"`);
    }
    for (const scale of ['rounded-lg', 'rounded-md', 'text-sm', 'text-xs']) {
      assert.ok(
        !block.includes(scale),
        `previewVariants must stay literal, not adopt the semantic-scale "${scale}"`,
      );
    }
  });

  it('exports previewVariants on the @maka/ui barrel for the artifact-preview consumer', async () => {
    const barrel = await readFile(resolve(REPO_ROOT, 'packages', 'ui', 'src', 'index.ts'), 'utf8');
    assert.match(
      barrel,
      /export \{[^}]*\bpreviewVariants\b[^}]*\} from '\.\/primitives\/chat\.js'/,
      'previewVariants must be re-exported on the package barrel — apps/desktop artifact-preview.tsx consumes the diff parts cross-package',
    );
    // The co-migration: the non-chat artifact diff pane renders the SHARED diff
    // parts and keeps only its own `.maka-artifact-preview-diff` positioning class.
    const artifact = await readFile(
      resolve(REPO_ROOT, 'apps', 'desktop', 'src', 'renderer', 'artifact-preview.tsx'),
      'utf8',
    );
    assert.match(
      artifact,
      /previewVariants\(\{ part: 'diff' \}\)/,
      'artifact diff must render the shared previewVariants diff part',
    );
    assert.match(
      artifact,
      /'maka-artifact-preview-diff'/,
      'artifact diff must keep its own positioning class (margin / font-size live in models.css)',
    );
    assert.doesNotMatch(
      artifact,
      /\bmaka-tool-diff\b/,
      'artifact diff must not keep the retired shared `.maka-tool-diff` class',
    );
  });
});
