import { StrictMode } from 'react';
import { ToastProvider } from '@maka/ui';
import { AppShell } from './app-shell';
import { ErrorBoundary } from './error-boundary';

export function App() {
  return (
    <StrictMode>
      <ErrorBoundary>
        <ToastProvider>
          <AppShell />
        </ToastProvider>
      </ErrorBoundary>
    </StrictMode>
  );
}
