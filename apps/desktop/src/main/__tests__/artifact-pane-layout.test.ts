/**
 * CSS contract tests for ArtifactPane narrow layout (PR108j).
 *
 * The visual smoke path still owns screenshot verification. These tests are
 * a cheap automated floor for the @kenji gate: at narrow widths the pane must
 * stop being a squeezed right rail and become a bottom sheet that leaves the
 * composer/send path usable.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readRendererContractCss } from './contract-css-helpers.js';

describe('session workbar narrow layout CSS contract', () => {
  it('uses a bottom-sheet layout at narrow widths instead of squeezing the chat column', async () => {
    const css = await readRendererContractCss();
    assert.match(
      css,
      /@media\s*\(max-width:\s*990px\)\s*\{[\s\S]*?\.maka-detail-with-artifacts\s*\{[\s\S]*?display:\s*grid[\s\S]*?grid-template-rows:\s*minmax\(0,\s*1fr\)\s*auto/,
      'expected ArtifactPane narrow mode to switch detail layout to a two-row grid',
    );
    assert.match(
      css,
      /@media\s*\(max-width:\s*990px\)\s*\{[\s\S]*?\.maka-session-workbar\s*\{[\s\S]*?width:\s*100%[\s\S]*?min-height:\s*min\(220px,\s*42dvh\)[\s\S]*?max-height:\s*min\(42dvh,\s*360px\)[\s\S]*?border-top:\s*var\(--border-width-hairline\) solid var\(--border\)/,
      'expected the session workbar to become a bounded full-width bottom workspace',
    );
  });

  it('removes the desktop resize handle at narrow widths', async () => {
    const css = await readRendererContractCss();
    assert.match(
      css,
      /@media\s*\(max-width:\s*990px\)\s*\{[\s\S]*?\.maka-workbar-resize-handle\s*\{\s*display:\s*none/,
      'expected the desktop workbar resize handle to disappear in bottom-workspace mode',
    );
  });

  it('keeps the resize cursor and text selection lock while dragging', async () => {
    const css = await readRendererContractCss();
    assert.match(css, /\.isResizingWorkbar\s*\{[\s\S]*?cursor:\s*col-resize[\s\S]*?user-select:\s*none/);
  });
});
