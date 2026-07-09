import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readAllRendererCss, stripCssComments } from './css-test-helpers.js';

/**
 * Composer container single-source contract.
 *
 * The composer card (`.maka-composer-inner`) + its textarea + placeholder
 * were triplicated across maka-tokens.css (@layer components),
 * styles/tool-output.css, and reference-shell.css — three definitions of the
 * same selector fighting by specificity/layer, plus dead `::before/::after`
 * and a duplicated textarea font. They are consolidated into
 * styles/composer.css as one definition per selector. This contract pins
 * that single source so the scattered duplicates cannot silently come back,
 * and that the placeholder font is declared explicitly (not left to the
 * fragile `[font: inherit]` chain from the bare-field reset).
 */

/** All style rules in `css` as [prelude, body] pairs, comments stripped,
 *  at-rule preludes skipped, and any text left of a `;` (prior statements)
 *  discarded — same shape the form-font-reset contract uses. */
function styleRules(css: string): Array<[string, string]> {
  const stripped = stripCssComments(css);
  return [...stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => {
    const prelude = m[1].replace(/^[\s\S]*;/, '').trim();
    return [prelude, m[2]] as [string, string];
  });
}

/** Count rest-state rules whose subject is `subjectClass` (optionally with a
 *  trailing `.class` qualifier), excluding any selector that carries a state
 *  pseudo (`:focus-within`) or attribute (`[data-drag-active]`). The
 *  drag-active rule `.maka-composer[data-drag-active="true"]
 *  .maka-composer-inner` is an ancestor-scoped state rule, not a rest
 *  definition, so it is correctly excluded by the `[` guard. */
function restRulesFor(css: string, subjectClass: string): string[] {
  const re = new RegExp(
    String.raw`\.${subjectClass}(?:\.[\w-]+)?\s*$`,
  );
  return styleRules(css)
    .filter(([prelude]) => prelude && !prelude.startsWith('@'))
    .filter(([prelude]) => re.test(prelude))
    .filter(([prelude]) => !/[:[]/.test(prelude))
    .map(([prelude]) => prelude.replace(/\s+/g, ' '));
}

describe('composer container single-source contract', () => {
  it('`.maka-composer-inner` rest state is defined exactly once (in composer.css)', async () => {
    const css = await readAllRendererCss();
    const rest = restRulesFor(css, 'maka-composer-inner');
    assert.equal(
      rest.length,
      1,
      `composer card rest state must have one definition (styles/composer.css); got ${rest.length}: ${JSON.stringify(rest)}`,
    );
  });

  it('`.maka-composer-textarea` rest state is defined exactly once (in composer.css)', async () => {
    const css = await readAllRendererCss();
    // Count rest rules whose subject is the composer textarea across BOTH
    // selector forms — the class `.maka-composer-textarea` and the scoped
    // type `.composer textarea` / `.maka-composer textarea`. The old
    // duplicate used the type form, so counting only the class form would
    // miss a re-added type-form duplicate (same gap the placeholder test
    // closes for `::placeholder`).
    const rest = styleRules(css)
      .filter(([prelude]) => prelude && !prelude.startsWith('@'))
      .filter(([prelude]) => !/[:[]/.test(prelude))
      .filter(
        ([prelude]) =>
          /\.maka-composer-textarea\s*$/.test(prelude) ||
          /(?:\.composer|\.maka-composer)\s+textarea\s*$/.test(prelude),
      )
      .map(([prelude]) => prelude.replace(/\s+/g, ' '));
    assert.equal(
      rest.length,
      1,
      `composer textarea rest state must have one definition (styles/composer.css); got ${rest.length}: ${JSON.stringify(rest)}`,
    );
  });

  it('the composer placeholder has one rest definition and declares its font explicitly', async () => {
    const css = await readAllRendererCss();
    // A rest `::placeholder` rule (not the :focus variant) whose subject is
    // the composer textarea. Covers BOTH selector forms — the class
    // `.maka-composer-textarea::placeholder` and the scoped type
    // `.composer textarea::placeholder` — so the old triplicate duplicate
    // cannot sneak back in either form.
    const restPlaceholders = styleRules(css)
      .filter(([prelude]) => prelude && !prelude.startsWith('@'))
      .filter(([prelude]) => /::placeholder/.test(prelude) && !/:focus/.test(prelude))
      .filter(([prelude]) =>
        /maka-composer-textarea|\.composer\s+textarea|\.maka-composer\s+textarea/.test(
          prelude,
        ),
      )
      .map(([prelude, body]) => [prelude.replace(/\s+/g, ' '), body] as [string, string]);
    assert.equal(
      restPlaceholders.length,
      1,
      `composer placeholder rest state must have one definition; got ${restPlaceholders.length}: ${JSON.stringify(restPlaceholders.map(([p]) => p))}`,
    );
    const [, body] = restPlaceholders[0];
    assert.match(
      body,
      /font-family\s*:/,
      'composer placeholder must declare font-family explicitly (no inheritance reliance)',
    );
    assert.match(body, /font-size\s*:/, 'composer placeholder must declare font-size explicitly');
  });
});
