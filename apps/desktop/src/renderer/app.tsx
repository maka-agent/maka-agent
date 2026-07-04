import { StrictMode } from 'react';
import { ToastProvider } from '@maka/ui';
import { AppShell } from './app-shell';
import { ErrorBoundary } from './error-boundary';
import type { OnboardingSnapshot } from '../global';

export function App({
  initialOnboardingSnapshot = null,
}: {
  /** Pre-mount snapshot prefetched by main.tsx — see prefetchOnboardingSnapshot. */
  initialOnboardingSnapshot?: OnboardingSnapshot | null;
}) {
  return (
    <StrictMode>
      <ErrorBoundary>
        <ToastProvider>
          <AppShell initialOnboardingSnapshot={initialOnboardingSnapshot} />
        </ToastProvider>
      </ErrorBoundary>
    </StrictMode>
  );
}
