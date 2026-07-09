// apps/desktop/src/renderer/error-boundary.tsx
//
// Top-level React error boundary. If anything in the renderer throws during
// render or in a lifecycle method, the boundary catches it and shows a
// friendly fallback with stack details and a "Try again" button instead of a
// blank white window (the old behavior — a Vite/Electron renderer that
// crashed early just left the user staring at an empty viewport).

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, Check, Clipboard, RotateCw } from '@maka/ui/icons';
import { Button as UiButton, Card, redactSecrets } from '@maka/ui';

type State = {
  error: Error | null;
  errorInfo: ErrorInfo | null;
  copyState: 'idle' | 'pending' | 'copied' | 'failed';
};

export function formatRendererErrorReport(error: Error, info?: ErrorInfo | null): string {
  const lines = [
    'Maka renderer error report',
    `Captured at: ${new Date().toISOString()}`,
    '',
    `${error.name}: ${error.message}`,
  ];
  if (error.stack) {
    lines.push('', 'Stack:', error.stack);
  }
  if (info?.componentStack) {
    lines.push('', 'React component stack:', info.componentStack.trim());
  }
  if (typeof navigator !== 'undefined' && navigator.userAgent) {
    lines.push('', `User agent: ${navigator.userAgent}`);
  }
  if (typeof window !== 'undefined' && window.location?.href) {
    lines.push(`Location: ${window.location.href}`);
  }
  return redactSecrets(lines.join('\n'));
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null, errorInfo: null, copyState: 'idle' };
  private mounted = false;
  private copyRequestSeq = 0;

  static getDerivedStateFromError(error: Error): State {
    return { error, errorInfo: null, copyState: 'idle' };
  }

  componentDidMount(): void {
    this.mounted = true;
  }

  componentWillUnmount(): void {
    this.mounted = false;
    this.copyRequestSeq += 1;
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // In Electron's renderer this lands in DevTools console + main-process
    // stderr via the contextBridge logging path.
    console.error('Maka renderer error boundary caught:', error, info);
    this.copyRequestSeq += 1;
    this.setState({ errorInfo: info });
  }

  private handleReset = () => {
    this.copyRequestSeq += 1;
    this.setState({ error: null, errorInfo: null, copyState: 'idle' });
  };

  private handleReload = () => {
    this.copyRequestSeq += 1;
    window.location.reload();
  };

  private isCurrentCopyRequest(copyRequestId: number, error: Error): boolean {
    return this.mounted && this.copyRequestSeq === copyRequestId && this.state.error === error;
  }

  private handleCopyReport = async () => {
    const { error, errorInfo } = this.state;
    if (!error || this.state.copyState === 'pending') return;
    const copyRequestId = ++this.copyRequestSeq;
    this.setState({ copyState: 'pending' });
    try {
      await navigator.clipboard.writeText(formatRendererErrorReport(error, errorInfo));
      if (this.isCurrentCopyRequest(copyRequestId, error)) this.setState({ copyState: 'copied' });
    } catch {
      if (this.isCurrentCopyRequest(copyRequestId, error)) this.setState({ copyState: 'failed' });
    }
  };

  render(): ReactNode {
    const { error, errorInfo, copyState } = this.state;
    if (!error) return this.props.children;
    const safeStack = redactSecrets(`${error.name}: ${error.message}${error.stack ? `\n\n${error.stack}` : ''}`);
    const copyPending = copyState === 'pending';
    const copyLabel = copyPending ? '复制中…' : copyState === 'copied' ? '已复制' : copyState === 'failed' ? '复制失败' : '复制诊断信息';
    const CopyIcon = copyState === 'copied' ? Check : Clipboard;

    return (
      <div className="maka-error-surface" role="alert" aria-live="assertive">
        <Card className="maka-error-card">
          <span className="maka-error-icon" aria-hidden="true">
            <AlertTriangle size={28} />
          </span>
          <div className="maka-error-copy">
            <h2>Maka 渲染层崩溃了</h2>
            <p>
              已捕获一次未处理的 React 异常。下面是错误摘要；点 <strong>重试</strong>
              清掉这次崩溃，<strong>重新加载</strong> 会刷新整个窗口。需要交接时先复制诊断信息。
            </p>
            <pre className="maka-error-stack" aria-label="错误详情">
              {safeStack}
            </pre>
            {errorInfo?.componentStack && (
              <pre className="maka-error-stack" aria-label="组件栈">
                {redactSecrets(errorInfo.componentStack.trim())}
              </pre>
            )}
            <div className="maka-error-actions">
              <UiButton
                type="button"
                variant="outline"
                className="maka-error-copy-action min-w-[5.5rem]"
                data-copy-state={copyState}
                disabled={copyPending}
                aria-busy={copyPending ? 'true' : undefined}
                onClick={this.handleCopyReport}
              >
                <CopyIcon size={14} aria-hidden="true" />
                <span>{copyLabel}</span>
              </UiButton>
              <UiButton type="button" variant="secondary" onClick={this.handleReset}>
                <RotateCw size={14} aria-hidden="true" />
                <span>重试</span>
              </UiButton>
              <UiButton
                type="button"
                variant="default"
                onClick={this.handleReload}
              >
                重新加载
              </UiButton>
            </div>
            {copyState === 'failed' && (
              <p className="maka-error-copy-status">剪贴板不可用或被系统拒绝；可以手动选择上面的错误摘要。</p>
            )}
          </div>
        </Card>
      </div>
    );
  }
}
