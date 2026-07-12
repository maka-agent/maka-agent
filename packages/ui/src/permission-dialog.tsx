import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { PermissionRequestEvent, PermissionResponse } from '@maka/core';
import { derivePermissionRequestHealth, formatPermissionRequestWait, readWriteStdinInputPreview } from '@maka/core';
import { AlertOctagon, AlertTriangle, FileEdit, GitMerge, Globe, HelpCircle, ShieldAlert, Terminal, Wifi } from './icons.js';
import { Alert, AlertDescription } from './primitives/alert.js';
import { Collapsible, CollapsibleTrigger, CollapsiblePanel } from './primitives/collapsible.js';
import { Button as UiButton, Checkbox, AlertDialogContent, AlertDialogRoot } from './ui.js';
import { Badge } from './primitives/badge.js';
import { redactSecrets } from './redact.js';
import { formatRedactedJson } from './tool-format.js';

// Per-reason presentation hints. Drives icon + headline + risk tone in the
// dialog so the user can scan the modal in 1-2 seconds before reading the
// args block.
type ReasonKind = PermissionRequestEvent['reason'];

interface ReasonPreset {
  label: string;
  Icon: typeof AlertTriangle;
  tone: 'info' | 'caution' | 'destructive';
}

const REASON_PRESETS: Record<ReasonKind, ReasonPreset> = {
  shell_dangerous: { label: '高风险 shell 命令 · 请仔细确认', Icon: Terminal, tone: 'caution' },
  file_write: { label: '写入或创建文件', Icon: FileEdit, tone: 'info' },
  fs_destructive: { label: '不可恢复的文件系统操作', Icon: AlertOctagon, tone: 'destructive' },
  git_destructive: { label: '不可恢复的 Git 操作', Icon: GitMerge, tone: 'destructive' },
  network: { label: '对外网络请求', Icon: Wifi, tone: 'info' },
  privileged: { label: '特权操作 (sudo / su)', Icon: ShieldAlert, tone: 'destructive' },
  browser: { label: '读取和操作你登录的浏览器会话 · 请确认', Icon: Globe, tone: 'caution' },
  custom: { label: '自定义请求', Icon: HelpCircle, tone: 'info' },
};

export function PermissionDialog(props: {
  request: PermissionRequestEvent;
  // Accept Promise-returning impls so the dialog can await the IPC
  // and reset its own pending state when it resolves OR rejects.
  // The renderer's `respondToPermission` is async but was typed as
  // void by the legacy signature, which made `submit()` strand
  // `responsePending=true` if the IPC failed silently.
  onRespond(response: PermissionResponse): void | Promise<void>;
}) {
  const [rememberForTurn, setRememberForTurn] = useState(false);
  const [responsePending, setResponsePending] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const responsePendingRef = useRef(false);
  const permissionMountedRef = useRef(true);
  const activePermissionRequestIdRef = useRef(props.request.requestId);

  useEffect(() => {
    permissionMountedRef.current = true;
    return () => {
      permissionMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    activePermissionRequestIdRef.current = props.request.requestId;
    setRememberForTurn(false);
    setResponsePending(false);
    responsePendingRef.current = false;
    setNow(Date.now());
  }, [props.request.requestId]);

  useEffect(() => {
    const tick = () => setNow(Date.now());
    const interval = window.setInterval(tick, 30_000);
    return () => window.clearInterval(interval);
  }, [props.request.requestId]);

  async function submit(decision: PermissionResponse['decision']) {
    if (responsePendingRef.current) return;
    const requestId = props.request.requestId;
    responsePendingRef.current = true;
    setResponsePending(true);
    try {
      // PR-PERMISSION-UI-CLEANUP-0: await so the pending state
      // resets when the IPC settles. Previously a Promise-returning
      // onRespond would let the try/catch miss async rejections,
      // and on success the parent normally unmounts us — but if the
      // parent's own try/catch swallows the IPC error (PR-STOP-
      // ERROR-SURFACE-0 does exactly this), we'd stay mounted with
      // `responsePending=true` and the buttons would lock up.
      await props.onRespond({
        requestId,
        decision,
        rememberForTurn: decision === 'allow' ? rememberForTurn : false,
      });
    } finally {
      if (activePermissionRequestIdRef.current === requestId) {
        responsePendingRef.current = false;
        if (permissionMountedRef.current) setResponsePending(false);
      }
    }
  }

  const preset = REASON_PRESETS[props.request.reason] ?? REASON_PRESETS.custom;
  const summary = renderPermissionSummary(props.request);
  const isDestructive = preset.tone === 'destructive';
  const health = derivePermissionRequestHealth({ requestedAt: props.request.ts, now });
  const waitLabel = formatPermissionRequestWait(health.ageMs);

  return (
    <AlertDialogRoot defaultOpen onOpenChange={(open, details) => { if (!open) details.cancel(); }}>
      <AlertDialogContent
        className="maka-modal permissionDialog w-[min(92vw,720px)] p-0"
        aria-labelledby="permissionTitle"
        data-tone={preset.tone}
        showClose={false}
      >
        <div className="maka-modal-header maka-permission-header">
          <span className="maka-permission-icon" aria-hidden="true">
            <preset.Icon size={20} />
          </span>
          <div>
            <h2 className="maka-modal-title" id="permissionTitle">需要确认权限</h2>
            <p className="maka-modal-subtitle">
              <Badge variant={isDestructive ? 'destructive' : 'secondary'} className="maka-permission-tool font-mono">{props.request.toolName}</Badge>
              <span aria-hidden="true"> · </span>
              <span className="maka-reason-text" data-reason={props.request.reason}>{preset.label}</span>
              <span aria-hidden="true"> · </span>
              <span className="maka-permission-age" data-status={health.status}>
                已等待 {waitLabel}
              </span>
            </p>
          </div>
        </div>
        <div className="maka-modal-body maka-permission-body">
          {summary && <div className="maka-permission-summary">{summary}</div>}
          {props.request.hint && (
            <div className="maka-permission-hint" role="note">{props.request.hint}</div>
          )}
          <Collapsible className="maka-permission-raw">
            <CollapsibleTrigger>查看完整参数</CollapsibleTrigger>
            <CollapsiblePanel>
              <pre className="maka-code">{formatRedactedJson(props.request.args)}</pre>
            </CollapsiblePanel>
          </Collapsible>
          <label className="permissionRemember">
            <Checkbox
              checked={rememberForTurn}
              disabled={responsePending}
              onCheckedChange={(checked) => setRememberForTurn(checked === true)}
            />
            本轮对话内记住选择（同类型工具不再询问，关闭/切换对话后失效）
          </label>
          {props.request.reason === 'browser' && rememberForTurn && (
            <p className="maka-permission-hint" role="note">
              勾选后，本轮接下来的浏览、读取页面、导航、点击、输入都不再逐次询问。你会全程看到它操作的页面，随时可以停止；本轮结束后授权失效。
            </p>
          )}
          {isDestructive && (
            <Alert variant="error" className="maka-permission-danger-note">
              <AlertDescription>
                这类操作不可恢复，确认前请再读一遍上面的参数。
              </AlertDescription>
            </Alert>
          )}
          {health.status !== 'fresh' && (
            <Alert
              variant="warning"
              className="maka-permission-stale-note"
              data-status={health.status}
            >
              <AlertDescription>
                这个请求已经等待较久。允许前请重新确认工具名和参数；如果上下文已经变了，直接拒绝后重新发送。
              </AlertDescription>
            </Alert>
          )}
        </div>
        <div className="maka-modal-footer permissionActions">
          {/* Designer audit P2-16: for destructive requests the confirm used
              to be the dialog's ONLY solid colored button — muscle memory
              clicks the brightest control, which is exactly wrong for an
              irreversible action. Danger side drops to a red OUTLINE (still
              unmistakably destructive, no longer the visual magnet) and the
              safe side (拒绝) rises from ghost to secondary so both options
              read as equally pressable. Non-destructive requests keep the
              plain primary confirm. */}
          <UiButton
            className="maka-button"
            variant={isDestructive ? 'secondary' : 'ghost'}
            type="button"
            disabled={responsePending}
            onClick={() => submit('deny')}
          >
            拒绝
          </UiButton>
          <UiButton
            className={isDestructive
              ? 'maka-button border border-[oklch(from_var(--destructive)_l_c_h_/_0.55)] bg-[oklch(from_var(--destructive)_l_c_h_/_0.08)] text-[color:var(--destructive)] hover:bg-[oklch(from_var(--destructive)_l_c_h_/_0.14)] active:bg-[oklch(from_var(--destructive)_l_c_h_/_0.18)]'
              : 'maka-button'}
            variant={isDestructive ? 'outline' : 'default'}
            type="button"
            disabled={responsePending}
            onClick={() => submit('allow')}
          >
            {responsePending ? '正在提交…' : isDestructive ? '我已确认，允许' : '允许'}
          </UiButton>
        </div>
      </AlertDialogContent>
    </AlertDialogRoot>
  );
}

/**
 * One-line summary for a browser_* action. Names the concrete action (open /
 * read / click / type) so the prompt reads as a real browser step, not an opaque
 * tool call — reinforcing that a browser grant spans reads AND acts. The typed
 * text and full args stay in the raw Collapsible block below.
 */
function renderBrowserSummary(toolName: string, args: Record<string, unknown>): ReactNode {
  const ref = typeof args.ref === 'string' ? args.ref : '';
  const url = typeof args.url === 'string' ? args.url : '';
  const selector = typeof args.selector === 'string' ? args.selector : '';
  const line =
    toolName === 'browser_navigate'
      ? `即将在浏览器中打开 ${url || '一个网址'}`
      : toolName === 'browser_click'
        ? `即将在当前页面点击元素 ${ref}`.trim()
        : toolName === 'browser_type'
          ? `即将在当前页面输入文本${ref ? ` 到元素 ${ref}` : ''}`
          : toolName === 'browser_snapshot'
            ? '即将读取当前页面的可交互元素列表'
            : toolName === 'browser_extract'
              ? `即将读取当前页面内容${selector ? `（${selector}）` : ''}`
              : toolName === 'browser_wait'
                ? '即将等待当前页面满足某个条件'
                : '即将操作当前浏览器页面';
  return <p className="maka-permission-line">{line}</p>;
}

/**
 * Per-tool human-readable summary of what the request will do, used at the
 * top of the permission dialog body. Falls back to undefined if we can't
 * recognize the tool — the raw args Collapsible block is always available.
 */
function renderPermissionSummary(request: PermissionRequestEvent): ReactNode | undefined {
  const args = (request.args ?? {}) as Record<string, unknown>;
  switch (request.toolName) {
    case 'browser_navigate':
    case 'browser_snapshot':
    case 'browser_click':
    case 'browser_type':
    case 'browser_wait':
    case 'browser_extract':
      return renderBrowserSummary(request.toolName, args);
    case 'Bash': {
      const command = typeof args.command === 'string' ? args.command : undefined;
      if (!command) return undefined;
      const timeout = typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined;
      return (
        <>
          <p className="maka-permission-line">即将运行 shell 命令：</p>
          <pre className="maka-code maka-permission-command">{redactSecrets(command)}</pre>
          {timeout !== undefined && (
            <p className="maka-permission-meta">超时 <strong>{timeout} ms</strong></p>
          )}
        </>
      );
    }
    case 'WriteStdin': {
      const input = readWriteStdinInputPreview(args);
      const size = args.size && typeof args.size === 'object' && !Array.isArray(args.size)
        ? args.size as Record<string, unknown>
        : undefined;
      const cols = typeof size?.cols === 'number' ? size.cols : undefined;
      const rows = typeof size?.rows === 'number' ? size.rows : undefined;
      if (!input && (cols === undefined || rows === undefined)) return undefined;
      return (
        <>
          <p className="maka-permission-line">即将与后台终端交互：</p>
          {input && (
            <>
              <pre className="maka-code maka-permission-preview">
                {input.text}{input.truncated ? '…' : ''}
              </pre>
              {input.truncated && (
                <p className="maka-permission-meta">完整输入共 <strong>{input.bytes}</strong> 字节</p>
              )}
            </>
          )}
          {cols !== undefined && rows !== undefined && (
            <p className="maka-permission-meta">目标尺寸 <strong>{cols}x{rows}</strong></p>
          )}
        </>
      );
    }
    case 'Write': {
      const path = typeof args.path === 'string' ? args.path : undefined;
      const content = typeof args.content === 'string' ? args.content : '';
      if (!path) return undefined;
      const bytes = new TextEncoder().encode(content).length;
      const lines = content.split('\n').length;
      const preview = permissionTextPreview(content, 600);
      return (
        <>
          <p className="maka-permission-line">即将写入文件：</p>
          <p className="maka-permission-path"><code>{redactSecrets(path)}</code></p>
          <p className="maka-permission-meta">
            <strong>{bytes}</strong> 字节 · <strong>{lines}</strong> 行
          </p>
          <pre className="maka-code maka-permission-preview">{preview}</pre>
        </>
      );
    }
    case 'Edit': {
      const path = typeof args.path === 'string' ? args.path : undefined;
      const oldString = typeof args.old_string === 'string' ? args.old_string : '';
      const newString = typeof args.new_string === 'string' ? args.new_string : '';
      if (!path) return undefined;
      return (
        <>
          <p className="maka-permission-line">即将修改文件：</p>
          <p className="maka-permission-path"><code>{redactSecrets(path)}</code></p>
          <div className="maka-permission-diff">
            <div>
              <span className="maka-permission-diff-tag" data-side="old">删除</span>
              <pre className="maka-code">{permissionTextPreview(oldString, 400)}</pre>
            </div>
            <div>
              <span className="maka-permission-diff-tag" data-side="new">写入</span>
              <pre className="maka-code">{permissionTextPreview(newString, 400)}</pre>
            </div>
          </div>
        </>
      );
    }
    case 'OfficeDocumentEdit': {
      const path = typeof args.path === 'string' ? args.path : undefined;
      const operation = typeof args.operation === 'string' ? args.operation : undefined;
      if (!path || !operation) return undefined;
      const target = typeof args.target === 'string' ? args.target : undefined;
      const elementType = typeof args.elementType === 'string' ? args.elementType : undefined;
      const index = typeof args.index === 'number' ? args.index : undefined;
      const propsArg = args.props && typeof args.props === 'object' && !Array.isArray(args.props)
        ? args.props as Record<string, unknown>
        : {};
      const propEntries = Object.entries(propsArg).slice(0, 6);
      const hiddenProps = Math.max(0, Object.keys(propsArg).length - propEntries.length);
      return (
        <>
          <p className="maka-permission-line">即将编辑 Office 文档：</p>
          <p className="maka-permission-path"><code>{redactSecrets(path)}</code></p>
          <p className="maka-permission-meta">
            操作 <strong>{redactSecrets(operation)}</strong>
            {target && <> · 目标 <code>{redactSecrets(target)}</code></>}
            {elementType && <> · 元素 <code>{redactSecrets(elementType)}</code></>}
            {index !== undefined && <> · 位置 <strong>{index}</strong></>}
          </p>
          {propEntries.length > 0 && (
            <pre className="maka-code maka-permission-preview">
              {propEntries.map(([key, value]) => `${redactSecrets(key)}=${permissionValuePreview(value)}`).join('\n')}
              {hiddenProps > 0 && `\n… 另有 ${hiddenProps} 个属性`}
            </pre>
          )}
        </>
      );
    }
    default:
      return undefined;
  }
}

function permissionTextPreview(value: string, maxChars: number): string {
  const safe = redactSecrets(value);
  return safe.length > maxChars ? `${safe.slice(0, maxChars)}…` : safe;
}

function permissionValuePreview(value: unknown): string {
  if (typeof value === 'string') {
    const safe = redactSecrets(value);
    return safe.length > 160 ? `${safe.slice(0, 160)}…` : safe;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return '不支持的属性值';
}
