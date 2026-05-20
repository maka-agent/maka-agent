// apps/desktop/src/renderer/error-boundary.tsx
//
// Top-level React error boundary. If anything in the renderer throws during
// render or in a lifecycle method, the boundary catches it and shows a
// friendly fallback with stack details and a "Try again" button instead of a
// blank white window (the old behavior — a Vite/Electron renderer that
// crashed early just left the user staring at an empty viewport).

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RotateCw } from 'lucide-react';

type State = {
  error: Error | null;
};

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // In Electron's renderer this lands in DevTools console + main-process
    // stderr via the contextBridge logging path.
    console.error('Maka renderer error boundary caught:', error, info);
  }

  private handleReset = () => {
    this.setState({ error: null });
  };

  private handleReload = () => {
    window.location.reload();
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="maka-error-surface" role="alert" aria-live="assertive">
        <div className="maka-error-card">
          <span className="maka-error-icon" aria-hidden="true">
            <AlertTriangle size={28} strokeWidth={1.6} />
          </span>
          <div className="maka-error-copy">
            <h2>Maka 渲染层崩溃了</h2>
            <p>
              已捕获一次未处理的 React 异常。下面是错误摘要；点 <strong>重试</strong>
              清掉这次崩溃，<strong>重新加载</strong> 会刷新整个窗口。
            </p>
            <pre className="maka-error-stack" aria-label="Error details">
              {error.name}: {error.message}
              {error.stack ? `\n\n${error.stack}` : ''}
            </pre>
            <div className="maka-error-actions">
              <button type="button" className="maka-button" onClick={this.handleReset}>
                <RotateCw size={14} strokeWidth={1.75} aria-hidden="true" />
                <span>重试</span>
              </button>
              <button
                type="button"
                className="maka-button"
                data-variant="primary"
                onClick={this.handleReload}
              >
                重新加载
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }
}
