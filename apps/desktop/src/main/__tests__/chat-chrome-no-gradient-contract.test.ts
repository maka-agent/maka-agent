/**
 * PR-CHAT-CHROME-FIX-1 (WAWQAQ msg `4a1b8c13`): pin the no-gradient
 * + visible-radius invariant. Background:
 *
 *   WAWQAQ has called out the 172deg "上面灰下面白" sidebar gradient
 *   three times in a row — msgs `1e693dee` / `5d3b10e5` / `4a1b8c13`
 *   — and each time we patched ONE of the rules that painted it
 *   while missing another. The cycle was:
 *
 *     round 0: killed gradient on `.maka-shell-2col`; missed
 *              `.appFrame` and the darwin `.maka-session-panel`
 *              override that still carried it.
 *     round 1: corrected the reference-atlas note to say "no
 *              gradient" but left the source still painting one.
 *     round 1 (this fix): killed `.appFrame` background gradient
 *              AND the `html[data-os="darwin"] .maka-session-panel`
 *              gradient. Plus removed the 1px right-border on the
 *              sidebar (the literal "边界线" WAWQAQ kept seeing) and
 *              bumped surface radius 6 → 12 with a soft drop-shadow
 *              so the floating card actually reads.
 *
 *   Without a contract test, the next refactor of the renderer
 *   chrome can re-introduce a 172deg gradient on the third place
 *   and we'd be on round 4 of the same complaint.
 *
 * Asserts:
 *   1. styles.css `.appFrame` / `.maka-shell-2col` use the flat
 *      neutral shell backplate and do NOT contain `172deg` or
 *      `linear-gradient`.
 *   2. styles.css `html[data-os="darwin"] .maka-session-panel`
 *      background does NOT contain `linear-gradient`.
 *   3. styles.css `html[data-os="darwin"] .maka-session-panel`
 *      does NOT have a `border-right` rule (would be the literal
 *      "边界线" the user complained about).
 *   4. styles.css `.maka-panel-detail.maka-floating-panel` has
 *      `border-radius: var(--radius-modal)` and a `box-shadow:` — without those
 *      the floating-card radius is geometrically present but
 *      optically invisible (WAWQAQ's "圆盘很不明显，尤其是下面的
 *      看都看不到").
 *   5. reference-shell.css uses `var(--radius-modal)` (12px) for the
 *      content area surface, in sync with the inline rule above.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { readRendererContractCss } from './contract-css-helpers.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');

describe('PR-CHAT-CHROME-FIX-1 no-gradient + visible-radius contract', () => {
  it('.appFrame and .maka-shell-2col paint a flat neutral shell, not a gradient', async () => {
    const css = await readRendererContractCss();

    for (const selector of ['.appFrame', '.maka-shell-2col']) {
      const ruleBody = extractRuleBody(css, selector);
      assert.ok(ruleBody, `${selector} rule must exist`);
      const body = ruleBody.replace(/\/\*[\s\S]*?\*\//g, '');

      assert.match(
        body,
        /background:\s*var\(--surface-canvas\)/,
        `${selector} must paint the flat neutral shell backplate, not white-on-white content`,
      );
      assert.ok(
        !/172deg/.test(body),
        `${selector} must not paint a 172deg gradient — WAWQAQ explicitly rejected it repeatedly`,
      );
      assert.ok(
        !/linear-gradient/.test(body),
        `${selector} background must be flat — no linear-gradient of any angle`,
      );
    }
  });

  it('html[data-os="darwin"] .maka-session-panel does not paint a gradient or a border-right', async () => {
    const css = await readRendererContractCss();

    const ruleMatch = css.match(
      /html\[data-os="darwin"\]\s+\.maka-session-panel\s*\{([\s\S]*?)\n\}/,
    );
    assert.ok(ruleMatch, 'darwin .maka-session-panel rule must exist');
    const body = ruleMatch[1].replace(/\/\*[\s\S]*?\*\//g, '');

    assert.ok(
      !/linear-gradient/.test(body),
      'darwin .maka-session-panel must not paint a gradient (WAWQAQ msg 1e693dee/5d3b10e5/4a1b8c13)',
    );
    assert.ok(
      !/border-right\s*:/.test(body),
      'darwin .maka-session-panel must not have a border-right — that was the literal "边界线" WAWQAQ kept seeing',
    );
  });

  it('content surface has a 12px radius and a real drop-shadow', async () => {
    const css = await readRendererContractCss();

    const ruleMatch = css.match(
      /\.maka-panel-detail\.maka-floating-panel\s*\{([\s\S]*?)\n\}/,
    );
    assert.ok(ruleMatch, '.maka-panel-detail.maka-floating-panel rule must exist');
    const body = ruleMatch[1].replace(/\/\*[\s\S]*?\*\//g, '');

    assert.match(
      body,
      /border-radius:\s*var\(--radius-modal\)/,
      'surface radius must be 12px (6px was optically invisible per WAWQAQ msg 4a1b8c13)',
    );
    assert.match(
      body,
      /box-shadow:[\s\S]*oklch/,
      'surface must carry a drop-shadow so the rounded corners actually read against the shell — without it the bottom corners are invisible',
    );
  });

  it('reference-shell.css surface radius uses the --radius-modal token', async () => {
    const css = await readFile(
      resolve(REPO_ROOT, 'apps/desktop/src/renderer/reference-shell.css'),
      'utf8',
    );

    assert.match(
      css,
      /border-radius:\s*var\(--radius-modal\)/,
      'reference-shell.css must use --radius-modal for the content area surface (12px per #406 gap 4)',
    );
    assert.match(
      css,
      /--agents-layout-bg:\s*var\(--surface-canvas\)/,
      'reference-shell.css must keep the layout shell as a flat neutral backplate, not white-on-white or gradient',
    );
  });
});

function extractRuleBody(css: string, selector: string): string | undefined {
  const lines = css.split('\n');
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? '';
    if (!matchesSelectorLine(line, selector)) continue;

    let cursor = lineIndex;
    let open = line.indexOf('{');
    while (open === -1 && cursor + 1 < lines.length) {
      cursor += 1;
      open = (lines[cursor] ?? '').indexOf('{');
    }
    if (open === -1) return undefined;

    const body: string[] = [];
    const startLine = lines[cursor] ?? '';
    const startTail = startLine.slice(open + 1);
    if (startTail.includes('}')) return startTail.slice(0, startTail.indexOf('}'));
    body.push(startTail);
    for (let i = cursor + 1; i < lines.length; i += 1) {
      const next = lines[i] ?? '';
      const close = next.indexOf('}');
      if (close !== -1) {
        body.push(next.slice(0, close));
        return body.join('\n');
      }
      body.push(next);
    }
  }
  return undefined;
}

function matchesSelectorLine(line: string, selector: string): boolean {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith(selector)) return false;
  const next = trimmed.charAt(selector.length);
  return next === ' ' || next === '\t' || next === ',' || next === '{' || next === '';
}
