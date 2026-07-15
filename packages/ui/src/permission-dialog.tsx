import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useMountedRef } from './use-mounted-ref.js';
import type {
  AdditionalPermissionRequestEvent,
  AnyPermissionRequestEvent,
  PermissionRequestEvent,
  SandboxEscalationRequestEvent,
  PermissionResponse,
} from '@maka/core';
import {
  derivePermissionRequestHealth,
  formatPermissionRequestWait,
  formatWriteStdinPermissionInspection,
  projectWriteStdinPermissionSummary,
} from '@maka/core';
import { Collapsible, CollapsibleTrigger, CollapsiblePanel } from './primitives/collapsible.js';
import { Button as UiButton, Checkbox } from './ui.js';
import { redactSecrets } from './redact.js';
import { formatRedactedJson } from './tool-format.js';

// Per-reason presentation hints. The headline states the decision while tone
// handles the minimum visual distinction needed for higher-risk requests.
type ReasonKind = PermissionRequestEvent['reason']
  | AdditionalPermissionRequestEvent['reason']
  | SandboxEscalationRequestEvent['reason'];

interface ReasonPreset {
  prompt: string;
  tone: 'info' | 'caution' | 'destructive';
}

const REASON_PRESETS: Record<ReasonKind, ReasonPreset> = {
  shell_dangerous: { prompt: '允许执行高风险 shell 命令？', tone: 'caution' },
  file_write: { prompt: '允许写入或创建文件？', tone: 'info' },
  fs_destructive: { prompt: '允许执行不可恢复的文件操作？', tone: 'destructive' },
  git_destructive: { prompt: '允许执行不可恢复的 Git 操作？', tone: 'destructive' },
  network: { prompt: '允许发起网络请求？', tone: 'info' },
  privileged: { prompt: '允许执行特权操作？', tone: 'destructive' },
  browser: { prompt: '允许操作已登录的浏览器？', tone: 'caution' },
  computer_use: { prompt: '允许读取或操作本机应用？', tone: 'caution' },
  additional_permissions: { prompt: '允许本次额外权限？', tone: 'caution' },
  sandbox_escalation: { prompt: '允许本次在 sandbox 外执行？', tone: 'destructive' },
  custom: { prompt: '允许执行此操作？', tone: 'info' },
};

export function PermissionPrompt(props: {
  request: AnyPermissionRequestEvent;
  // Accept Promise-returning impls so the prompt can await the IPC
  // and reset its own pending state when it resolves OR rejects.
  // The renderer's `respondToPermission` is async but was typed as
  // void by the legacy signature, which made `submit()` strand
  // `responsePending=true` if the IPC failed silently.
  onRespond(response: PermissionResponse): void | Promise<void>;
  onStop(): void | Promise<void>;
  stopPending?: boolean;
}) {
  const [rememberForTurn, setRememberForTurn] = useState(false);
  const [expandedRequestId, setExpandedRequestId] = useState<string | null>(null);
  const [responsePending, setResponsePending] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const responsePendingRef = useRef(false);
  const denyButtonRef = useRef<HTMLButtonElement>(null);
  const permissionMountedRef = useMountedRef();
  const activePermissionRequestIdRef = useRef(props.request.requestId);

  useEffect(() => {
    activePermissionRequestIdRef.current = props.request.requestId;
    setRememberForTurn(false);
    setExpandedRequestId(null);
    setResponsePending(false);
    responsePendingRef.current = false;
    setNow(Date.now());
    const focusFrame = window.requestAnimationFrame(() => denyButtonRef.current?.focus());
    return () => window.cancelAnimationFrame(focusFrame);
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
        ...(props.request.rememberForTurnAllowed
          ? { rememberForTurn: decision === 'allow' ? rememberForTurn : false }
          : {}),
      });
    } finally {
      if (activePermissionRequestIdRef.current === requestId) {
        responsePendingRef.current = false;
        if (permissionMountedRef.current) setResponsePending(false);
      }
    }
  }

  const fullArgsOpen = expandedRequestId === props.request.requestId;
  const preset = REASON_PRESETS[props.request.reason] ?? REASON_PRESETS.custom;
  const summary = renderPermissionSummary(props.request);
  const details = renderPermissionDetails(props.request, fullArgsOpen);
  const additionalArgs = permissionAdditionalArgs(props.request);
  const showDisclosure = props.request.toolName === 'WriteStdin'
    || details !== undefined
    || additionalArgs !== undefined;
  const disclosureLabel = permissionDisclosureLabel(props.request, additionalArgs);
  const prompt = permissionPrompt(props.request, preset);
  const isDestructive = preset.tone === 'destructive';
  const context = props.request.hint ?? (isDestructive
    ? '此操作无法恢复，请确认上面的内容。'
    : undefined);
  const health = derivePermissionRequestHealth({ requestedAt: props.request.ts, now });
  const waitLabel = formatPermissionRequestWait(health.ageMs);
  const decisionsDisabled = props.stopPending || responsePending;

  return (
    <section
      role="region"
      className="maka-composer-interaction maka-permission-prompt composer"
      aria-labelledby="permissionTitle"
      data-tone={preset.tone}
    >
      <div className="maka-composer-interaction-inner maka-permission-prompt-inner agents-parchment-paper-surface">
        <header className="maka-permission-header">
          <div className="maka-permission-title-row">
            <h2 className="maka-permission-title" id="permissionTitle">{prompt}</h2>
            {health.status !== 'fresh' && (
              <span className="maka-permission-age" data-status={health.status}>
                已等待 {waitLabel}
              </span>
            )}
          </div>
        </header>
        <div className="maka-permission-body">
          {summary && <div className="maka-permission-summary">{summary}</div>}
          {context && (
            <p className="maka-permission-context" data-tone={preset.tone}>{context}</p>
          )}
          {props.request.reason === 'browser' && rememberForTurn && (
            <p className="maka-permission-context">
              勾选后，本轮接下来的浏览、读取页面、导航、点击、输入都不再逐次询问。你会全程看到它操作的页面，随时可以停止；本轮结束后授权失效。
            </p>
          )}
          {props.request.reason === 'computer_use' && rememberForTurn && (
            <p className="maka-permission-context" role="note">
              只会记住上方显示的目标、动作和授权类别。读取授权不会扩展为截图或输入授权；目标或动作类别变化时仍会再次询问。
            </p>
          )}
        </div>
        <Collapsible
          className="maka-permission-raw"
          open={fullArgsOpen}
          onOpenChange={(open) => setExpandedRequestId(open ? props.request.requestId : null)}
        >
          {showDisclosure && (
            <CollapsiblePanel>
              {details && <div className="maka-permission-details">{details}</div>}
              {additionalArgs && <pre className="maka-code">{formatRedactedJson(additionalArgs)}</pre>}
            </CollapsiblePanel>
          )}
          <footer className="permissionActions">
            <div className="maka-permission-utility-actions">
              {showDisclosure && <CollapsibleTrigger>{disclosureLabel}</CollapsibleTrigger>}
              {props.request.rememberForTurnAllowed && (
                <label className="permissionRemember">
                  <Checkbox
                    checked={rememberForTurn}
                    disabled={decisionsDisabled}
                    onCheckedChange={(checked) => setRememberForTurn(checked === true)}
                  />
                  本轮记住
                </label>
              )}
            </div>
            <div className="maka-permission-decision-actions" role="group" aria-label="权限操作">
              <UiButton
                variant="ghost"
                size="md"
                type="button"
                disabled={props.stopPending}
                onClick={() => void props.onStop()}
              >
                {props.stopPending ? '停止中…' : '停止'}
              </UiButton>
              <UiButton
                ref={denyButtonRef}
                variant="ghost"
                size="md"
                type="button"
                disabled={decisionsDisabled}
                onClick={() => submit('deny')}
              >
                拒绝操作
              </UiButton>
              <UiButton
                variant={isDestructive ? 'destructive' : 'default'}
                size="md"
                type="button"
                disabled={decisionsDisabled}
                onClick={() => submit('allow')}
              >
                {responsePending ? '正在提交…'
                  : isOneShotPermissionRequest(props.request) ? '允许这一次' : '允许操作'}
              </UiButton>
            </div>
          </footer>
        </Collapsible>
      </div>
    </section>
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
 * top of the permission prompt body. Falls back to undefined if we can't
 * recognize the tool — the raw args Collapsible block is always available.
 */
function renderPermissionSummary(request: AnyPermissionRequestEvent): ReactNode | undefined {
  if (isAdditionalPermissionRequest(request)) {
    const entries = request.additionalPermissions.fileSystem?.entries ?? [];
    return (
      <>
        <p className="maka-permission-line">{request.justification}</p>
        <p className="maka-permission-meta">工作目录 <code>{redactSecrets(request.cwd)}</code></p>
        {entries.map((entry) => (
          <p className="maka-permission-path" key={`${entry.access}:${entry.scope}:${entry.path}`}>
            <code>{redactSecrets(entry.path)}</code>
            {' · '}{entry.access === 'write' ? '读写' : '只读'}
            {' · '}{entry.scope === 'exact' ? '仅此路径' : '目录及子目录'}
          </p>
        ))}
        {request.risk.networkEnabled && (
          <p className="maka-permission-meta">本次调用将临时允许网络访问。</p>
        )}
        {request.risk.outsideWorkspace && (
          <p className="maka-permission-meta">包含工作区外路径。</p>
        )}
        {request.risk.protectedMetadata && (
          <p className="maka-permission-meta">包含受保护的 Git/Agent 元数据。</p>
        )}
      </>
    );
  }
  if (isSandboxEscalationRequest(request)) {
    return (
      <>
        <p className="maka-permission-line">{request.justification}</p>
        <p className="maka-permission-meta">工作目录 <code>{redactSecrets(request.cwd)}</code></p>
        <pre className="maka-code maka-permission-command">{redactSecrets(request.command)}</pre>
        <p className="maka-permission-context" data-tone="destructive">
          本次命令将不经过平台 sandbox，可访问工作区外文件、网络和受保护元数据。
        </p>
      </>
    );
  }
  const args = (request.args ?? {}) as Record<string, unknown>;
  switch (request.toolName) {
    case 'maka_computer': {
      const action = typeof args.action === 'string' ? args.action : 'unknown';
      const approvalClass = typeof args.approvalClass === 'string' ? args.approvalClass : 'unknown';
      const app = typeof args.app === 'string' ? args.app : undefined;
      const windowId = typeof args.windowId === 'number' ? args.windowId : undefined;
      return (
        <>
          <p className="maka-permission-line">
            Computer Use：<code>{action}</code>（{approvalClass}）
          </p>
          {(app || windowId !== undefined) && (
            <p className="maka-permission-meta">
              目标 {app ?? '当前应用'}{windowId !== undefined ? ` · window ${windowId}` : ''}
            </p>
          )}
        </>
      );
    }
    case 'browser_navigate':
    case 'browser_snapshot':
    case 'browser_click':
    case 'browser_type':
    case 'browser_wait':
    case 'browser_extract':
      return renderBrowserSummary(request.toolName, args);
    case 'Bash': {
      const command = typeof args.command === 'string' ? args.command : undefined;
      const cwd = typeof args.cwd === 'string' ? args.cwd : undefined;
      if (!command) return undefined;
      const commandSummary = cwd
        ? `在 ${redactSecrets(cwd)}\n${redactSecrets(command)}`
        : redactSecrets(command);
      return <pre className="maka-code maka-permission-command">{commandSummary}</pre>;
    }
    case 'WriteStdin': {
      const writeStdin = projectWriteStdinPermissionSummary(args);
      if (!writeStdin.ref && !writeStdin.input && !writeStdin.size) return undefined;
      return (
        <>
          <p className="maka-permission-line">即将与后台终端交互</p>
          {writeStdin.ref && (
            <p className="maka-permission-path">
              <code>{writeStdin.ref.text}{writeStdin.ref.truncated ? '…' : ''}</code>
            </p>
          )}
          {writeStdin.input && (
            <>
              <pre className="maka-code maka-permission-preview">
                {writeStdin.input.text}{writeStdin.input.truncated ? '…' : ''}
              </pre>
              {writeStdin.input.truncated && (
                <p className="maka-permission-meta">
                  完整输入共 <strong>{writeStdin.input.bytes}</strong> 字节
                </p>
              )}
            </>
          )}
          {writeStdin.size && (
            <p className="maka-permission-meta">
              目标尺寸 <strong>{writeStdin.size.cols}x{writeStdin.size.rows}</strong>
            </p>
          )}
        </>
      );
    }
    case 'Write': {
      const path = typeof args.path === 'string' ? args.path : undefined;
      const content = typeof args.content === 'string' ? args.content : '';
      if (!path) return undefined;
      const bytes = new TextEncoder().encode(content).length;
      const lines = countTextLines(content);
      return (
        <>
          <p className="maka-permission-path"><code>{redactSecrets(path)}</code></p>
          <p className="maka-permission-meta">
            <strong>{bytes}</strong> 字节 · <strong>{lines}</strong> 行
          </p>
        </>
      );
    }
    case 'Edit': {
      const path = typeof args.path === 'string' ? args.path : undefined;
      if (!path) return undefined;
      const oldString = typeof args.old_string === 'string' ? args.old_string : '';
      const newString = typeof args.new_string === 'string' ? args.new_string : '';
      const oldLines = countTextLines(oldString);
      const newLines = countTextLines(newString);
      return (
        <>
          <p className="maka-permission-path"><code>{redactSecrets(path)}</code></p>
          <p className="maka-permission-meta">
            删除 <strong>{oldLines}</strong> 行 · 写入 <strong>{newLines}</strong> 行
          </p>
        </>
      );
    }
    case 'OfficeDocumentEdit': {
      const path = typeof args.path === 'string' ? args.path : undefined;
      if (!path) return undefined;
      return <p className="maka-permission-path"><code>{redactSecrets(path)}</code></p>;
    }
    case 'WebFetch': {
      const url = typeof args.url === 'string' ? args.url : undefined;
      if (!url) return undefined;
      return <p className="maka-permission-path"><code>{redactSecrets(url)}</code></p>;
    }
    default:
      return request.toolName
        ? <p className="maka-permission-line">{request.toolName}</p>
        : undefined;
  }
}

function renderPermissionDetails(
  request: AnyPermissionRequestEvent,
  writeStdinExpanded: boolean,
): ReactNode | undefined {
  if (isAdditionalPermissionRequest(request)) return undefined;
  const args = (request.args ?? {}) as Record<string, unknown>;
  switch (request.toolName) {
    case 'WriteStdin': {
      if (!writeStdinExpanded) return undefined;
      const inspection = formatWriteStdinPermissionInspection(args);
      if (!inspection) return undefined;
      return (
        <pre className="maka-code maka-permission-preview">
          {inspection}
        </pre>
      );
    }
    case 'Write': {
      const content = typeof args.content === 'string' ? args.content : '';
      if (!content) return undefined;
      return <pre className="maka-code maka-permission-preview">{permissionTextPreview(content, 600)}</pre>;
    }
    case 'Edit': {
      const oldString = typeof args.old_string === 'string' ? args.old_string : '';
      const newString = typeof args.new_string === 'string' ? args.new_string : '';
      return (
        <div className="maka-permission-diff">
          <pre className="maka-permission-diff-lines" data-side="old">
            {prefixPermissionDiff(permissionTextPreview(oldString, 400), '-')}
          </pre>
          <pre className="maka-permission-diff-lines" data-side="new">
            {prefixPermissionDiff(permissionTextPreview(newString, 400), '+')}
          </pre>
        </div>
      );
    }
    case 'OfficeDocumentEdit': {
      const operation = typeof args.operation === 'string' ? args.operation : undefined;
      const target = typeof args.target === 'string' ? args.target : undefined;
      const elementType = typeof args.elementType === 'string' ? args.elementType : undefined;
      const index = typeof args.index === 'number' ? args.index : undefined;
      const propsArg = args.props && typeof args.props === 'object' && !Array.isArray(args.props)
        ? args.props as Record<string, unknown>
        : {};
      const propEntries = Object.entries(propsArg).slice(0, 6);
      const hiddenProps = Math.max(0, Object.keys(propsArg).length - propEntries.length);
      const lines = [
        operation && `操作=${redactSecrets(operation)}`,
        target && `目标=${redactSecrets(target)}`,
        elementType && `元素=${redactSecrets(elementType)}`,
        index !== undefined && `位置=${index}`,
        ...propEntries.map(([key, value]) => `${redactSecrets(key)}=${permissionValuePreview(value)}`),
      ].filter((line): line is string => Boolean(line));
      if (lines.length === 0) return undefined;
      return (
        <pre className="maka-code maka-permission-preview">
          {lines.join('\n')}
          {hiddenProps > 0 && `\n… 另有 ${hiddenProps} 个属性`}
        </pre>
      );
    }
    default:
      return undefined;
  }
}

function permissionAdditionalArgs(request: AnyPermissionRequestEvent): Record<string, unknown> | undefined {
  if (isAdditionalPermissionRequest(request)) return undefined;
  const args = (request.args ?? {}) as Record<string, unknown>;
  switch (request.toolName) {
    case 'Bash': {
      const { command: _command, cwd: _cwd, ...additional } = args;
      return Object.keys(additional).length > 0 ? additional : undefined;
    }
    case 'Write':
    case 'Edit':
    case 'OfficeDocumentEdit':
    case 'WriteStdin':
      return undefined;
    default:
      return Object.keys(args).length > 0 ? args : undefined;
  }
}

function permissionTextPreview(value: string, maxChars: number): string {
  const safe = redactSecrets(value);
  return safe.length > maxChars ? `${safe.slice(0, maxChars)}…` : safe;
}

function countTextLines(value: string): number {
  if (!value) return 0;
  const lines = value.split(/\r?\n/);
  return lines.at(-1) === '' ? lines.length - 1 : lines.length;
}

function prefixPermissionDiff(value: string, prefix: '-' | '+'): string {
  return value.split('\n').map((line) => `${prefix} ${line}`).join('\n');
}

function permissionPrompt(request: AnyPermissionRequestEvent, preset: ReasonPreset): string {
  if (isAdditionalPermissionRequest(request)) return '允许本次额外权限？';
  if (isSandboxEscalationRequest(request)) return '允许本次在 sandbox 外执行？';
  if (request.toolName === 'Edit') return '允许修改文件？';
  if (request.toolName === 'OfficeDocumentEdit') return '允许编辑 Office 文档？';
  return preset.prompt;
}

function permissionDisclosureLabel(
  request: AnyPermissionRequestEvent,
  additionalArgs: Record<string, unknown> | undefined,
): string {
  switch (request.toolName) {
    case 'Edit':
      return '查看变更';
    case 'Write':
      return '查看内容';
    case 'WriteStdin':
      return '查看输入';
    case 'OfficeDocumentEdit':
      return '查看变更';
    default:
      return additionalArgs ? '完整参数' : '查看详情';
  }
}

function isAdditionalPermissionRequest(
  request: AnyPermissionRequestEvent,
): request is AdditionalPermissionRequestEvent {
  return request.kind === 'additional_permissions';
}

function isSandboxEscalationRequest(
  request: AnyPermissionRequestEvent,
): request is SandboxEscalationRequestEvent {
  return request.kind === 'sandbox_escalation';
}

function isOneShotPermissionRequest(request: AnyPermissionRequestEvent): boolean {
  return isAdditionalPermissionRequest(request) || isSandboxEscalationRequest(request);
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
