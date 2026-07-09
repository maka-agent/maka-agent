import { StrictMode, useLayoutEffect } from 'react';
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
  // PR-SHOW-AFTER-FIRST-COMMIT: the BrowserWindow is created hidden
  // (main-window.ts show: false) so the OS never flashes the index.html
  // `.maka-preload` skeleton before React paints. Signal main after the first
  // real commit — useLayoutEffect fires post-commit — unconditionally: even
  // when the onboarding snapshot is null and AppShell mounts its fail-soft
  // loading state, the window should still appear. A fallback timer in main
  // reveals it if this signal never arrives. `window.maka` is undefined
  // outside the Electron renderer (storybook), so guard the chain like
  // theme.ts.
  useLayoutEffect(() => {
    void window.maka?.appWindow?.notifyRendererReady?.();
  }, []);
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
