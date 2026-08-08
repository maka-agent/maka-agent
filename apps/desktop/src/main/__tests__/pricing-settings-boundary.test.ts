import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const PAGE = new URL('../../../src/renderer/settings/usage-settings-page.tsx', import.meta.url);
const OVERLAYS = new URL('../../../src/renderer/app-shell-overlays.tsx', import.meta.url);
const MODAL = new URL('../../../src/renderer/settings/settings-modal.tsx', import.meta.url);
const SURFACE = new URL('../../../src/renderer/settings/settings-surface.tsx', import.meta.url);

test('Pricing renderer stays behind the Host-backed port and away from the legacy bridge', async () => {
  const [source, overlays, modal, surface] = await Promise.all([
    readFile(PAGE, 'utf8'),
    readFile(OVERLAYS, 'utf8'),
    readFile(MODAL, 'utf8'),
    readFile(SURFACE, 'utf8'),
  ]);

  assert.match(source, /DesktopPricingSettingsPort/);
  assert.match(source, /EffectivePricingEntry/);
  assert.match(source, /saved_refresh_failed/);
  assert.match(source, /onReloadPricing/);
  assert.match(source, /isReady/);
  assert.doesNotMatch(source, /window\.maka\.settings\.pricing/);
  assert.doesNotMatch(source, /usage:pricing:(?:list|put|reset|changed)/);

  assert.match(overlays, /pricingPort=\{desktopPricingSettingsPort\}/);
  assert.match(modal, /pricingPort: DesktopPricingSettingsPort/);
  assert.match(modal, /pricingPort=\{props\.pricingPort\}/);
  assert.match(surface, /pricingPort: DesktopPricingSettingsPort/);
});
