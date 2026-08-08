import type { DesktopPricingSettingsPort } from '../../shared/runtime-host-pricing';

/** Stable renderer-side adapter for the Host-backed Pricing settings seam. */
export const desktopPricingSettingsPort: DesktopPricingSettingsPort = {
  loadPricingSnapshot: () => window.maka.settings.pricing.loadSnapshot(),
  applyPricingMutation: (input) => window.maka.settings.pricing.applyMutation(input),
};
