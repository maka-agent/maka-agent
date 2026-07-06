import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readAllRendererCss, stripCssComments } from './css-test-helpers.js';

/**
 * Regression guard for #546 (form-control font reset).
 *
 * Tailwind preflight already ships `button, input, select, optgroup,
 * textarea { font: inherit }` inside `@layer base`. base.css used to carry an
 * UNLAYERED duplicate of that reset; because unlayered author CSS outranks
 * every `@layer` rule, the duplicate silently killed all font utilities
 * (text-*, font-*, leading-*, tracking-*) on every form control in the app —
 * e.g. the Button cva's `text-sm font-medium` never rendered anywhere.
 *
 * Invariant: renderer CSS must not declare font properties on bare
 * form-element type selectors outside a `@layer`. Font inheritance for form
 * controls is preflight's job; per-surface font styling belongs on classes.
 */

const FORM_TYPES = new Set(['button', 'input', 'textarea', 'select', 'optgroup']);
const FONT_PROP_RE = /(?:^|[;{\s])(font|font-size|font-weight|font-family|line-height|letter-spacing)\s*:/;

interface Violation {
  selector: string;
  declaration: string;
}

/**
 * Scans expanded renderer CSS for style rules whose selector list consists
 * solely of bare form-element type selectors (`button, textarea, input,
 * select`), outside any `@layer` block, that declare font properties.
 */
function findUnlayeredFormFontDeclarations(css: string): Violation[] {
  const violations: Violation[] = [];
  let i = 0;
  let ruleStart = 0;
  // Stack of open blocks; each entry records whether it is an @layer block.
  const blockStack: { isLayer: boolean }[] = [];

  while (i < css.length) {
    const ch = css[i];
    if (ch === '{') {
      const prelude = css.slice(ruleStart, i).trim();
      if (prelude.startsWith('@')) {
        blockStack.push({ isLayer: /^@layer\b/.test(prelude) });
        ruleStart = i + 1;
        i += 1;
        continue;
      }
      // Style rule: capture its body up to the matching close brace.
      let depth = 1;
      let j = i + 1;
      while (j < css.length && depth > 0) {
        if (css[j] === '{') depth += 1;
        else if (css[j] === '}') depth -= 1;
        j += 1;
      }
      const body = css.slice(i + 1, j - 1);
      const inLayer = blockStack.some((b) => b.isLayer);
      const parts = prelude.split(',').map((p) => p.trim().toLowerCase());
      const isBareFormSelector = parts.length > 0 && parts.every((p) => FORM_TYPES.has(p));
      if (!inLayer && isBareFormSelector) {
        const match = body.match(FONT_PROP_RE);
        if (match) {
          violations.push({
            selector: prelude.replace(/\s+/g, ' '),
            declaration: match[1],
          });
        }
      }
      ruleStart = j;
      i = j;
      continue;
    }
    if (ch === '}') {
      blockStack.pop();
      ruleStart = i + 1;
    } else if (ch === ';' && blockStack.length === 0) {
      // Top-level at-statement (e.g. @import) terminator.
      ruleStart = i + 1;
    }
    i += 1;
  }
  return violations;
}

describe('renderer form font reset contract', () => {
  it('declares no font properties on bare form-element type selectors outside @layer', async () => {
    const css = stripCssComments(await readAllRendererCss());
    const violations = findUnlayeredFormFontDeclarations(css);
    assert.deepEqual(
      violations,
      [],
      'Unlayered font declarations on bare button/input/textarea/select type selectors ' +
        'outrank Tailwind layers and disable every font utility on form controls. ' +
        'Preflight (@layer base) already provides `font: inherit`; style form-control ' +
        'fonts via classes instead. See #546.',
    );
  });

  it('self-check: detector catches the historical unlayered reset', () => {
    const historical = `button,\n  textarea,\n  input,\n  select {\n    font: inherit;\n  }`;
    const layered = `@layer base {\n${historical}\n}`;
    assert.equal(findUnlayeredFormFontDeclarations(historical).length, 1);
    assert.equal(findUnlayeredFormFontDeclarations(layered).length, 0);
  });
});
