import { PROVIDER_DEFAULTS, type ProviderType } from '@maka/core';
import { detectUiLocale, type UiLocale } from '@maka/ui';
import { ProviderBrandMark } from './provider-brand-marks';
import { PROVIDER_DISPLAY_COPY, type ProviderCopy } from './provider-display-copy';

// Kept as a thin wrapper so the many `ProviderLogo` call sites stay put.
function ProviderLogoMark({ type }: { type: ProviderType }) {
  return <ProviderBrandMark type={type} />;
}

export function ProviderLogo(props: { type: ProviderType; compact?: boolean }) {
  return (
    <span className="providerLogo" data-provider={props.type} data-compact={props.compact ? 'true' : undefined} aria-hidden="true">
      <ProviderLogoMark type={props.type} />
    </span>
  );
}

export function providerDisplay(
  type: ProviderType,
  locale: UiLocale = detectUiLocale(),
): ProviderCopy {
  // The copy map covers every registered ProviderType at compile time
  // (`satisfies` in provider-display-copy.ts), but a connection persisted on
  // a branch that registers a provider this build doesn't know reaches here
  // with an unknown type at runtime — hence the widened view and the registry
  // fallback below. Mirrors `isFakeBackend`.
  const copyByType = PROVIDER_DISPLAY_COPY as Partial<Record<ProviderType, Record<UiLocale, ProviderCopy>>>;
  const copy = copyByType[type]?.[locale];
  if (copy) return copy;
  const definition = PROVIDER_DEFAULTS[type];
  return {
    name: definition?.label ?? type,
    description: definition?.description ?? (locale === 'en' ? 'This provider is not registered in the current build.' : '该 provider 在当前版本未注册。'),
    ...(definition?.catalogBadge ? { badge: definition.catalogBadge } : {}),
  };
}
