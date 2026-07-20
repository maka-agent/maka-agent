import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useMountedRef } from './use-mounted-ref.js';
import type {
  AdditionalPermissionRequestEvent,
  AnyPermissionRequestEvent,
  PermissionRequestEvent,
  PublicToolIntentReview,
  SandboxEscalationRequestEvent,
  PermissionResponse,
} from '@maka/core';
import {
  derivePermissionRequestHealth,
  formatPermissionRequestWait,
  projectWriteStdinInput,
} from '@maka/core';
import { Collapsible, CollapsibleTrigger, CollapsiblePanel } from './primitives/collapsible.js';
import { Button as UiButton, Checkbox } from './ui.js';
import { redactSecrets } from './redact.js';
import { useUiLocale } from './locale-context.js';
import { getConversationCopy, type ConversationCopy } from './conversation-copy.js';
import { assertNever } from './tool-review-presentation.js';

// Per-reason presentation hints. The headline states the decision while tone
// handles the minimum visual distinction needed for higher-risk requests.
type ReasonKind = PermissionRequestEvent['reason']
  | AdditionalPermissionRequestEvent['reason']
  | SandboxEscalationRequestEvent['reason'];

interface ReasonPreset {
  prompt: string;
  tone: 'info' | 'caution' | 'destructive';
}

const REASON_TONE: Record<ReasonKind, ReasonPreset['tone']> = {
  shell_dangerous: 'caution', file_write: 'info', fs_destructive: 'destructive', git_destructive: 'destructive', network: 'info', privileged: 'destructive', browser: 'caution', computer_use: 'caution', additional_permissions: 'caution', sandbox_escalation: 'destructive', custom: 'info',
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
  const locale = useUiLocale();
  const copy = getConversationCopy(locale).permissionPrompt;
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
        ...(isToolPermissionRequest(props.request) && props.request.rememberForTurnAllowed
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

  const detailsOpen = expandedRequestId === props.request.requestId;
  const reason = props.request.reason in REASON_TONE ? props.request.reason as ReasonKind : 'custom';
  const preset: ReasonPreset = { prompt: copy.reason[reason], tone: REASON_TONE[reason] };
  const summary = renderPermissionSummary(props.request, copy);
  const details = renderPermissionDetails(props.request);
  const showDisclosure = details !== undefined;
  const disclosureLabel = permissionDisclosureLabel(props.request, copy);
  const prompt = permissionPrompt(props.request, preset, copy);
  const isDestructive = preset.tone === 'destructive';
  const context = isDestructive
    ? copy.destructiveContext
    : undefined;
  const health = derivePermissionRequestHealth({ requestedAt: props.request.ts, now });
  const waitLabel = formatPermissionRequestWait(health.ageMs, locale);
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
                {copy.waited(waitLabel)}
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
              {copy.rememberBrowser}
            </p>
          )}
          {props.request.reason === 'computer_use' && rememberForTurn && (
            <p className="maka-permission-context" role="note">
              {copy.rememberScoped}
            </p>
          )}
        </div>
        <Collapsible
          className="maka-permission-raw"
          open={detailsOpen}
          onOpenChange={(open) => setExpandedRequestId(open ? props.request.requestId : null)}
        >
          {showDisclosure && (
            <CollapsiblePanel>
              {details && <div className="maka-permission-details">{details}</div>}
            </CollapsiblePanel>
          )}
          <footer className="permissionActions">
            <div className="maka-permission-utility-actions">
              {showDisclosure && <CollapsibleTrigger>{disclosureLabel}</CollapsibleTrigger>}
              {isToolPermissionRequest(props.request) && props.request.rememberForTurnAllowed && (
                <label className="permissionRemember">
                  <Checkbox
                    checked={rememberForTurn}
                    disabled={decisionsDisabled}
                    onCheckedChange={(checked) => setRememberForTurn(checked === true)}
                  />
                  {copy.rememberTurn}
                </label>
              )}
            </div>
            <div className="maka-permission-decision-actions" role="group" aria-label={copy.actionsAriaLabel}>
              <UiButton
                variant="ghost"
                size="md"
                type="button"
                disabled={props.stopPending}
                onClick={() => void props.onStop()}
              >
                {props.stopPending ? copy.stopping : copy.stop}
              </UiButton>
              <UiButton
                ref={denyButtonRef}
                variant="ghost"
                size="md"
                type="button"
                disabled={decisionsDisabled}
                onClick={() => submit('deny')}
              >
                {copy.deny}
              </UiButton>
              <UiButton
                variant={isDestructive ? 'destructive' : 'default'}
                size="md"
                type="button"
                disabled={decisionsDisabled}
                onClick={() => submit('allow')}
              >
                {responsePending ? copy.submitting
                  : isOneShotPermissionRequest(props.request) ? copy.allowOnce : copy.allow}
              </UiButton>
            </div>
          </footer>
        </Collapsible>
      </div>
    </section>
  );
}

function renderPermissionSummary(
  request: AnyPermissionRequestEvent,
  copy: ConversationCopy['permissionPrompt'],
): ReactNode | undefined {
  if (isAdditionalPermissionRequest(request)) {
    return (
      <>
        <p className="maka-permission-meta">
          {copy.workingDirectory} <code>{redactSecrets(request.review.cwd)}</code>
        </p>
        {request.review.paths.map((entry) => (
          <p className="maka-permission-path" key={`${entry.access}:${entry.scope}:${entry.path}`}>
            <code>{redactSecrets(entry.path)}</code>
            {' · '}{entry.access === 'write' ? copy.readWrite : copy.readOnly}
            {' · '}{entry.scope === 'exact' ? copy.exactPath : copy.directoryTree}
          </p>
        ))}
        {request.review.networkEnabled && (
          <p className="maka-permission-meta">{copy.temporaryNetwork}</p>
        )}
        {request.risk.outsideWorkspace && (
          <p className="maka-permission-meta">{copy.outsideWorkspace}</p>
        )}
        {request.risk.protectedMetadata && (
          <p className="maka-permission-meta">{copy.protectedMetadata}</p>
        )}
      </>
    );
  }
  if (isSandboxEscalationRequest(request)) {
    return (
      <>
        <p className="maka-permission-meta">
          {copy.workingDirectory} <code>{redactSecrets(request.review.cwd)}</code>
        </p>
        <pre className="maka-code maka-permission-command">
          {redactSecrets(request.review.command)}
        </pre>
        <p className="maka-permission-context" data-tone="destructive">
          {copy.outsideSandbox}
        </p>
      </>
    );
  }
  return renderToolReviewSummary(request.review, copy);
}

function renderToolReviewSummary(
  review: PublicToolIntentReview,
  copy: ConversationCopy['permissionPrompt'],
): ReactNode {
  switch (review.kind) {
    case 'command':
      return (
        <>
          <p className="maka-permission-meta">
            {copy.workingDirectory} <code>{redactSecrets(review.cwd)}</code>
          </p>
          <pre className="maka-code maka-permission-command">{redactSecrets(review.command)}</pre>
        </>
      );
    case 'path':
      return (
        <>
          <p className="maka-permission-path"><code>{redactSecrets(review.path)}</code></p>
          <p className="maka-permission-meta">
            {copy.workingDirectory} <code>{redactSecrets(review.cwd)}</code>
          </p>
        </>
      );
    case 'search':
      return (
        <>
          <p className="maka-permission-line">
            {review.operation === 'glob'
              ? copy.review.search.glob(redactSecrets(review.pattern))
              : copy.review.search.grep(redactSecrets(review.pattern))}
          </p>
          <p className="maka-permission-meta">
            {copy.review.search.scope(
              redactSecrets(review.root),
              review.operation === 'grep' && review.glob
                ? redactSecrets(review.glob)
                : undefined,
            )}
          </p>
        </>
      );
    case 'stdin': {
      const input = review.input ? projectWriteStdinInput(review.input.text) : undefined;
      return (
        <>
          <p className="maka-permission-line">{copy.terminalInteraction}</p>
          <p className="maka-permission-path"><code>{redactSecrets(review.ref)}</code></p>
          {review.input && input && (
            <>
              <pre className="maka-code maka-permission-preview">
                {redactSecrets(input.text)}{input.truncated ? '…' : ''}
              </pre>
              <p className="maka-permission-meta">
                {input.truncated
                  ? copy.fullInputBytes(review.input.bytes)
                  : copy.review.inputBytes(review.input.bytes)}
              </p>
            </>
          )}
          {review.size && (
            <p className="maka-permission-meta">
              {copy.targetSize(review.size.cols, review.size.rows)}
            </p>
          )}
        </>
      );
    }
    case 'web':
      return (
        <p className="maka-permission-path">
          <code>{redactSecrets(review.target)}</code>
        </p>
      );
    case 'browser':
      return renderBrowserReviewSummary(review, copy);
    case 'patch':
      return (
        <>
          <p className="maka-permission-path"><code>{redactSecrets(review.path)}</code></p>
          <p className="maka-permission-meta">
            {copy.review.patchOperation[review.operation]}
          </p>
        </>
      );
    case 'agent': {
      let summary: string;
      switch (review.operation) {
        case 'spawn':
          summary = copy.review.agent.spawn(
            redactSecrets(review.profile),
            review.isolation,
            review.writeBack,
          );
          break;
        case 'dispatch':
          summary = copy.review.agent.dispatch(redactSecrets(review.member));
          break;
        case 'swarm':
          summary = copy.review.agent.swarm(
            review.itemCount,
            review.resumeCount,
            review.concurrency,
            review.profiles.map(redactSecrets).join(', '),
            review.writeBack.join(', '),
            review.isolation.join(', '),
          );
          break;
        default:
          return assertNever(review, 'agent review operation');
      }
      return <p className="maka-permission-line">{summary}</p>;
    }
    case 'runtime_resource':
      return (
        <p className="maka-permission-line">
          {review.operation === 'stop'
            ? copy.review.resource.stop(redactSecrets(review.ref))
            : copy.review.resource.read(redactSecrets(review.ref))}
        </p>
      );
    case 'skill':
      return (
        <p className="maka-permission-line">
          {copy.review.skill(redactSecrets(review.name))}
        </p>
      );
    case 'question':
      return (
        <p className="maka-permission-line">
          {copy.review.questions(review.questionCount)}
        </p>
      );
    case 'computer_use':
      return (
        <>
          <p className="maka-permission-line">
            {copy.review.computerUse(review.action)}
          </p>
          {('app' in review || 'windowId' in review) && (
            <p className="maka-permission-meta">
              {copy.target} {'app' in review
                ? redactSecrets(review.app ?? copy.currentApp)
                : copy.currentApp}
              {'windowId' in review && review.windowId !== undefined
                ? ` · window ${review.windowId}`
                : ''}
            </p>
          )}
        </>
      );
  }
  return assertNever(review, 'permission tool review');
}

function renderBrowserReviewSummary(
  review: Extract<PublicToolIntentReview, { kind: 'browser' }>,
  copy: ConversationCopy['permissionPrompt'],
): ReactNode {
  switch (review.action) {
    case 'navigate':
      return (
        <p className="maka-permission-line">
          {copy.browser.navigate(redactSecrets(review.url))}
        </p>
      );
    case 'snapshot':
      return <p className="maka-permission-line">{copy.browser.snapshot}</p>;
    case 'click':
      return (
        <p className="maka-permission-line">
          {copy.browser.click(redactSecrets(review.ref))}
        </p>
      );
    case 'type':
      return (
        <>
          <p className="maka-permission-line">
            {copy.browser.type(redactSecrets(review.ref))}
            {review.submit ? ` ${copy.review.submitAfterTyping}` : ''}
          </p>
          <pre className="maka-code maka-permission-preview">
            {redactSecrets(review.text)}
          </pre>
        </>
      );
    case 'wait':
      return (
        <p className="maka-permission-line">
          {review.condition === 'duration'
            ? copy.review.browserWaitDuration(review.seconds)
            : copy.review.browserWaitFor(review.condition, redactSecrets(review.value))}
        </p>
      );
    case 'extract':
      return (
        <p className="maka-permission-line">
          {copy.browser.extract(review.selector ? redactSecrets(review.selector) : '')}
        </p>
      );
  }
  return assertNever(review, 'permission browser review action');
}

function renderPermissionDetails(
  request: AnyPermissionRequestEvent,
): ReactNode | undefined {
  if (!isToolPermissionRequest(request) || request.review.kind !== 'stdin') return undefined;
  const lines = [
    `ref: ${request.review.ref}`,
    request.review.input
      ? `input: ${request.review.input.text}\nbytes: ${request.review.input.bytes}`
      : undefined,
    request.review.size
      ? `size: ${request.review.size.cols}x${request.review.size.rows}`
      : undefined,
  ].filter((line): line is string => line !== undefined);
  return (
    <pre className="maka-code maka-permission-preview">
      {redactSecrets(lines.join('\n'))}
    </pre>
  );
}

function permissionPrompt(
  request: AnyPermissionRequestEvent,
  preset: ReasonPreset,
  copy: ConversationCopy['permissionPrompt'],
): string {
  if (isAdditionalPermissionRequest(request)) return copy.additionalPermission;
  if (isSandboxEscalationRequest(request)) return copy.sandboxEscalation;
  if (request.review.kind === 'path' && request.review.operation === 'edit') {
    return request.toolName === 'OfficeDocumentEdit' ? copy.editOffice : copy.editFile;
  }
  return preset.prompt;
}

function permissionDisclosureLabel(
  request: AnyPermissionRequestEvent,
  copy: ConversationCopy['permissionPrompt'],
): string {
  return isToolPermissionRequest(request) && request.review.kind === 'stdin'
    ? copy.disclosure.input
    : copy.disclosure.details;
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

function isToolPermissionRequest(
  request: AnyPermissionRequestEvent,
): request is PermissionRequestEvent {
  return request.kind === 'tool_permission';
}

function isOneShotPermissionRequest(request: AnyPermissionRequestEvent): boolean {
  return isAdditionalPermissionRequest(request) || isSandboxEscalationRequest(request);
}
