/**
 * CSS contract tests for ArtifactPane narrow layout (PR108j).
 *
 * The visual smoke path still owns screenshot verification. These tests are
 * a cheap automated floor for the @kenji gate: at narrow widths the pane must
 * stop being a squeezed right rail and become a bottom sheet that leaves the
 * composer/send path usable.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const STYLES_PATH = join(process.cwd(), 'src', 'renderer', 'styles.css');

describe('ArtifactPane narrow layout CSS contract', () => {
  it('uses a bottom-sheet layout at narrow widths instead of squeezing the chat column', async () => {
    const css = await readFile(STYLES_PATH, 'utf8');
    assert.match(
      css,
      /@media\s*\(max-width:\s*990px\)\s*\{[\s\S]*?\.maka-detail-with-artifacts\s*\{[\s\S]*?display:\s*grid[\s\S]*?grid-template-rows:\s*minmax\(0,\s*1fr\)\s*auto/,
      'expected ArtifactPane narrow mode to switch detail layout to a two-row grid',
    );
    assert.match(
      css,
      /@media\s*\(max-width:\s*990px\)\s*\{[\s\S]*?\.maka-artifact-pane\s*\{[\s\S]*?width:\s*100%[\s\S]*?max-height:\s*min\(42dvh,\s*360px\)[\s\S]*?border-top:\s*1px solid var\(--border\)/,
      'expected ArtifactPane narrow mode to become a bounded full-width bottom sheet',
    );
  });

  it('collapsed narrow pane stays a short strip so the composer remains reachable', async () => {
    const css = await readFile(STYLES_PATH, 'utf8');
    assert.match(
      css,
      /@media\s*\(max-width:\s*990px\)\s*\{[\s\S]*?\.maka-artifact-pane\[data-collapsed="true"\]\s*\{[\s\S]*?min-height:\s*34px[\s\S]*?max-height:\s*34px/,
      'expected collapsed ArtifactPane bottom sheet to stay at header-strip height',
    );
  });
});
