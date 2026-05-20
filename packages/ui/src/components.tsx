import { memo, useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type MouseEvent, type RefObject } from 'react';
import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  Check,
  Copy,
  Flag,
  MessageSquare,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Settings,
  Sparkles,
  SquarePen,
  Trash2,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import rehypeHighlight from 'rehype-highlight';
import type {
  PermissionRequestEvent,
  PermissionResponse,
  SessionSummary,
  StoredMessage,
  ToolResultContent,
} from '@maka/core';
import { materializeChat, materializeTools, type ToolActivityItem } from './materialize.js';

export type NavSelection =
  | { section: 'sessions'; filter: SessionFilter }
  | { section: 'skills' };

export type SessionFilter = 'chats' | 'flagged' | 'archived';

const FILTER_LABEL: Record<SessionFilter, string> = {
  chats: 'Chats',
  flagged: 'Flagged',
  archived: 'Archived',
};

/**
 * Hook for accessible modal dialogs.
 *
 * - Saves the element that had focus before the modal opened.
 * - Moves focus to the first focusable element inside the modal on mount
 *   (or the container itself if no focusable child exists).
 * - Traps Tab/Shift+Tab inside the modal.
 * - Optionally closes the modal on Escape.
 * - Restores focus to the previously-focused element on unmount.
 *
 * Implements rule "3. focus and dialogs (critical)" from the
 * fixing-accessibility skill.
 */
export function useModalA11y(
  containerRef: RefObject<HTMLElement | null>,
  onEscape?: () => void,
): void {
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;

    const initial = getFocusable(container);
    if (initial.length > 0) {
      initial[0]!.focus({ preventScroll: true });
    } else {
      if (!container.hasAttribute('tabindex')) container.setAttribute('tabindex', '-1');
      container.focus({ preventScroll: true });
    }

    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (!container) return;
      if (event.key === 'Escape' && onEscape) {
        event.stopPropagation();
        event.preventDefault();
        onEscape();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = getFocusable(container);
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !container.contains(active))) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!event.shiftKey && (active === last || !container.contains(active))) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    }

    container.addEventListener('keydown', onKeyDown);
    return () => {
      container.removeEventListener('keydown', onKeyDown);
      // Defer restoration so any in-flight focus changes (e.g. clicking a
      // button that unmounts the modal) settle before we yank focus back.
      queueMicrotask(() => {
        if (previouslyFocused && document.contains(previouslyFocused)) {
          previouslyFocused.focus?.({ preventScroll: true });
        }
      });
    };
  }, [containerRef, onEscape]);
}

const FOCUSABLE_SELECTOR =
  'a[href], area[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), iframe, [tabindex]:not([tabindex="-1"])';

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => !element.hasAttribute('inert') && isVisible(element),
  );
}

function isVisible(element: HTMLElement): boolean {
  if (element.hidden) return false;
  // offsetParent is null for display:none ancestors and fixed-positioned roots,
  // but our modal elements are always rendered visible — so this is a sufficient
  // approximation without forcing layout.
  return element.offsetParent !== null || element === document.activeElement;
}

function Count(props: { value: number }) {
  if (props.value <= 0) return null;
  return <small>{props.value}</small>;
}

export interface SessionRowActions {
  /** Flag (pin) state toggle. */
  onToggleFlag(sessionId: string, next: boolean): void;
  /** Move to / out of the archive bucket. */
  onArchive(sessionId: string): void;
  onUnarchive(sessionId: string): void;
  /** Rename via inline prompt. Receives the new (trimmed) name. */
  onRename(sessionId: string, name: string): void;
  /** Permanent removal — caller is responsible for the confirm gate. */
  onDelete(sessionId: string): void;
}

export function SessionListPanel(props: {
  selection: NavSelection;
  sessionCounts: Record<SessionFilter, number>;
  sessions: SessionSummary[];
  activeId?: string;
  onSelectSession(sessionId: string): void;
  onSelect(selection: NavSelection): void;
  onOpenSettings(): void;
  onNew(): void;
  rowActions?: SessionRowActions;
}) {
  const isSessionFilter = (filter: SessionFilter) => props.selection.section === 'sessions' && props.selection.filter === filter;
  const title = props.selection.section === 'sessions' ? FILTER_LABEL[props.selection.filter] : 'Skills';

  return (
    <aside className="maka-session-panel" aria-label="Chats">
      <header className="maka-session-panel-header">
        <div className="maka-window-drag-strip" aria-hidden="true" />
        <button className="maka-nav-primary" type="button" onClick={props.onNew}>
          <SquarePen className="maka-nav-primary-icon" strokeWidth={1.5} />
          <span>New Chat</span>
        </button>
      </header>

      <div className="maka-session-filter">
        <button
          className="maka-nav-row"
          data-active={isSessionFilter('chats')}
          type="button"
          onClick={() => props.onSelect({ section: 'sessions', filter: 'chats' })}
        >
          <MessageSquare className="maka-nav-icon" strokeWidth={1.5} />
          <span>Chats</span>
          <Count value={props.sessionCounts.chats} />
        </button>
        <button
          className="maka-nav-row"
          data-active={isSessionFilter('flagged')}
          type="button"
          onClick={() => props.onSelect({ section: 'sessions', filter: 'flagged' })}
        >
          <Flag className="maka-nav-icon" strokeWidth={1.5} />
          <span>Pinned</span>
          <Count value={props.sessionCounts.flagged} />
        </button>
        <button
          className="maka-nav-row"
          data-active={isSessionFilter('archived')}
          type="button"
          onClick={() => props.onSelect({ section: 'sessions', filter: 'archived' })}
        >
          <Archive className="maka-nav-icon" strokeWidth={1.5} />
          <span>Archived</span>
          <Count value={props.sessionCounts.archived} />
        </button>
      </div>

      <div className="maka-session-search" aria-hidden="true">
        <Search strokeWidth={1.5} />
        <span>Search chats</span>
      </div>

      <section className="maka-session-list" aria-label={title}>
        <div className="maka-session-list-title">{title}</div>
        {props.selection.section === 'skills' ? (
          <div className="maka-empty-state">
            <Sparkles className="maka-empty-state-icon" strokeWidth={1.5} />
            <div className="maka-empty-state-title">No skills yet</div>
            <div className="maka-empty-state-body">
              Maka loads skills from <code className="maka-empty-state-code">~/.maka/skills/</code>. Drop a folder with a <code className="maka-empty-state-code">SKILL.md</code> to register one.
            </div>
          </div>
        ) : props.sessions.length === 0 ? (
          <div className="maka-empty-state">
            <MessageSquare className="maka-empty-state-icon" strokeWidth={1.5} />
            <div className="maka-empty-state-title">No chats yet</div>
            <div className="maka-empty-state-body">Chats with Maka appear here. Start one to get going.</div>
            <button className="maka-button maka-empty-state-cta" type="button" onClick={props.onNew}>
              New Chat
            </button>
          </div>
        ) : (
          <div className="maka-list-stack">
            {props.sessions.map((session) => (
              <SessionRow
                key={session.id}
                session={session}
                active={session.id === props.activeId}
                onSelect={props.onSelectSession}
                actions={props.rowActions}
              />
            ))}
          </div>
        )}
      </section>

      <footer className="maka-session-panel-footer">
        <button
          className="maka-nav-row"
          data-active={props.selection.section === 'skills'}
          type="button"
          onClick={() => props.onSelect({ section: 'skills' })}
        >
          <Sparkles className="maka-nav-icon" strokeWidth={1.5} />
          <span>Skills</span>
        </button>
        <button
          className="maka-nav-row"
          type="button"
          onClick={props.onOpenSettings}
        >
          <Settings className="maka-nav-icon" strokeWidth={1.5} />
          <span>Settings</span>
        </button>
      </footer>
    </aside>
  );
}

const SCROLL_BOTTOM_THRESHOLD = 64; // px

function SessionRow(props: {
  session: SessionSummary;
  active: boolean;
  onSelect(sessionId: string): void;
  actions?: SessionRowActions;
}) {
  const { session, active, actions, onSelect } = props;

  const stopPropagation = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  };

  function handleRename(event: MouseEvent<HTMLButtonElement>) {
    stopPropagation(event);
    if (!actions) return;
    const next = window.prompt('Rename this chat', session.name);
    if (next === null) return;
    const trimmed = next.trim();
    if (!trimmed || trimmed === session.name) return;
    actions.onRename(session.id, trimmed);
  }

  function handleDelete(event: MouseEvent<HTMLButtonElement>) {
    stopPropagation(event);
    if (!actions) return;
    // Delegation: the App-level handler owns the confirmation flow via the
    // toast system (PR24), so SessionRow stays presentation-only.
    actions.onDelete(session.id);
  }

  return (
    <div className="maka-list-row" data-active={active}>
      <button
        className="maka-list-row-main"
        type="button"
        onClick={() => onSelect(session.id)}
      >
        <div>
          <div className="maka-list-row-name">{session.name}</div>
          <div className="maka-list-row-meta">{formatSessionMeta(session)}</div>
        </div>
        {session.hasUnread && <span className="maka-list-row-unread" />}
      </button>
      {actions && (
        <div className="maka-list-row-actions" aria-label="Session actions">
          <button
            type="button"
            className="maka-list-row-action"
            onClick={(event) => {
              stopPropagation(event);
              actions.onToggleFlag(session.id, !session.isFlagged);
            }}
            aria-label={session.isFlagged ? 'Unpin chat' : 'Pin chat'}
            data-active={session.isFlagged}
            title={session.isFlagged ? 'Unpin chat' : 'Pin chat'}
          >
            {session.isFlagged
              ? <PinOff size={14} strokeWidth={1.75} aria-hidden="true" />
              : <Pin size={14} strokeWidth={1.75} aria-hidden="true" />}
          </button>
          <button
            type="button"
            className="maka-list-row-action"
            onClick={handleRename}
            aria-label="Rename chat"
            title="Rename"
          >
            <Pencil size={14} strokeWidth={1.75} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="maka-list-row-action"
            onClick={(event) => {
              stopPropagation(event);
              session.isArchived
                ? actions.onUnarchive(session.id)
                : actions.onArchive(session.id);
            }}
            aria-label={session.isArchived ? 'Unarchive chat' : 'Archive chat'}
            title={session.isArchived ? 'Unarchive' : 'Archive'}
          >
            {session.isArchived
              ? <ArchiveRestore size={14} strokeWidth={1.75} aria-hidden="true" />
              : <Archive size={14} strokeWidth={1.75} aria-hidden="true" />}
          </button>
          <button
            type="button"
            className="maka-list-row-action maka-list-row-action-danger"
            onClick={handleDelete}
            aria-label="Delete chat"
            title="Delete"
          >
            <Trash2 size={14} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}

export function ChatView(props: {
  messages: StoredMessage[];
  streamingText: string;
  tools: ToolActivityItem[];
  activeSession?: SessionSummary;
  mode: NavSelection['section'];
  onNew(): void;
}) {
  const chat = materializeChat(props.messages);
  const storedTools = materializeTools(props.messages);
  const tools = mergeTools(storedTools, props.tools);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pinnedToBottom, setPinnedToBottom] = useState(true);

  // Auto-scroll on new content if the user is already at (or near) the
  // bottom. If they've scrolled up to read history we don't yank them back.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !pinnedToBottom) return;
    el.scrollTop = el.scrollHeight;
  }, [chat.length, props.streamingText, tools.length, pinnedToBottom]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setPinnedToBottom(distanceFromBottom <= SCROLL_BOTTOM_THRESHOLD);
  }

  function scrollToBottom() {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    setPinnedToBottom(true);
  }

  if (props.mode === 'skills') {
    return (
      <main className="maka-main detailPane">
        <div className="maka-center-state">No skill selected</div>
      </main>
    );
  }

  if (!props.activeSession) {
    return (
      <main className="maka-main detailPane">
        <header className="maka-chat-header">
          <ChatTab title="New Chat" backend="fake" />
          <button className="maka-chat-tab-plus" type="button" aria-label="New chat" onClick={props.onNew}>
            <Plus strokeWidth={1.5} />
          </button>
          <span className="maka-chat-header-spacer" />
          <span className="modePill">Ask mode</span>
        </header>
        <div className="maka-chat messages">
          <div className="emptyChat compact">
            <span className="eyebrow">Maka</span>
            <h1>What should we work on?</h1>
            <p>Describe the change, question, or investigation.</p>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="maka-main detailPane">
      <header className="maka-chat-header">
        <ChatTab title={props.activeSession.name} backend={props.activeSession.backend} />
        <button className="maka-chat-tab-plus" type="button" aria-label="New chat" onClick={props.onNew}>
          <Plus strokeWidth={1.5} />
        </button>
        <span className="maka-chat-header-spacer" />
        <span className="modePill">Ask mode</span>
      </header>
      <div className="maka-chat-shell">
        <div ref={scrollRef} className="maka-chat messages" onScroll={onScroll}>
          {chat.length === 0 && !props.streamingText && (
            <div className="emptyChat compact">
              <span className="eyebrow">Maka</span>
              <h1>What should we work on?</h1>
              <p>Describe the change, question, or investigation.</p>
            </div>
          )}
          {chat.map((item) => (
            <article key={item.id} className={`maka-message-row message ${item.role}`}>
              <span>{item.role}</span>
              <MessageBody role={item.role} text={item.text} />
            </article>
          ))}
          {props.streamingText && (
            <article className="maka-message-row message assistant streaming">
              <span>assistant</span>
              <div className="maka-bubble-assistant maka-bubble-streaming">
                <Markdown text={props.streamingText} />
              </div>
            </article>
          )}
          {tools.length > 0 && <ToolActivity items={tools} />}
        </div>
        {!pinnedToBottom && (
          <button
            type="button"
            className="maka-chat-jump-bottom"
            onClick={scrollToBottom}
            aria-label="Jump to latest message"
          >
            <ArrowDown size={16} strokeWidth={2} aria-hidden="true" />
          </button>
        )}
      </div>
    </main>
  );
}

/**
 * Renders an individual chat message body.
 *
 * - `user` messages stay verbatim (whitespace + line breaks preserved); the
 *   user's literal input shouldn't be reinterpreted as markdown.
 * - `assistant` / `system` (and anything else) flow through the markdown
 *   renderer so code fences, lists, tables, and links display natively.
 *
 * Assistant messages get a hover Copy button that yanks the raw markdown
 * source to the clipboard.
 *
 * Memoized because chat scroll re-renders the whole list on every streaming
 * delta; this keeps already-final bubbles from re-parsing markdown.
 */
const MessageBody = memo(function MessageBody(props: { role: string; text: string }) {
  if (props.role === 'user') {
    return <div className="maka-bubble-user">{props.text}</div>;
  }
  return (
    <div className="maka-bubble-assistant maka-bubble-with-actions">
      <Markdown text={props.text} />
      <MessageCopyButton text={props.text} />
    </div>
  );
});

function MessageCopyButton(props: { text: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(props.text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard unavailable — silently fail, button stays in default state */
    }
  }

  return (
    <button
      type="button"
      className="maka-message-copy"
      onClick={copy}
      aria-label={copied ? 'Copied' : 'Copy message'}
      data-copied={copied}
    >
      {copied ? <Check size={14} strokeWidth={2} aria-hidden="true" /> : <Copy size={14} strokeWidth={1.75} aria-hidden="true" />}
    </button>
  );
}

const MARKDOWN_REMARK_PLUGINS = [remarkGfm, remarkBreaks];
const MARKDOWN_REHYPE_PLUGINS = [
  // `detect: true` lets hljs guess the language when the fence didn't tag one;
  // `ignoreMissing: true` keeps bogus tags like ```mermaid from throwing.
  [rehypeHighlight, { detect: true, ignoreMissing: true }],
] as const;

function Markdown(props: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={MARKDOWN_REMARK_PLUGINS}
      rehypePlugins={MARKDOWN_REHYPE_PLUGINS as never}
      components={{
        // Force external links to open in a new window — Electron will route
        // through the OS default browser when the renderer is configured to.
        a: ({ children, href, ...rest }) => (
          <a {...rest} href={href} target="_blank" rel="noreferrer noopener">
            {children}
          </a>
        ),
        // Inline `code` keeps the bubble's foreground color; only block code
        // gets the framed treatment via `pre > code` in CSS.
        code: ({ children, className, ...rest }) => (
          <code {...rest} className={className}>
            {children}
          </code>
        ),
      }}
    >
      {props.text}
    </ReactMarkdown>
  );
}

function ChatTab(props: { title: string; backend: string }) {
  return (
    <div className="maka-chat-tab" title={props.title}>
      <MessageSquare className="maka-chat-tab-icon" strokeWidth={1.5} />
      <span>{props.title}</span>
      <span className="maka-chat-tab-backend">{props.backend}</span>
    </div>
  );
}

const COMPOSER_MAX_HEIGHT = 240;

export function Composer(props: { disabled?: boolean; hidden?: boolean; onSend(text: string): void; onStop(): void }) {
  const formRef = useRef<HTMLFormElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  if (props.hidden) return null;

  function autoResize() {
    const el = textareaRef.current;
    if (!el) return;
    // Standard "reset to auto, then set to scrollHeight" trick so the
    // textarea can both grow and shrink as the user edits. Cap at
    // COMPOSER_MAX_HEIGHT so it never pushes the chat surface off-screen;
    // overflow becomes an internal scroll past that.
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT)}px`;
  }

  function sendCurrent() {
    if (props.disabled) return;
    const textarea = textareaRef.current;
    const form = formRef.current;
    const text = (textarea?.value ?? '').trim();
    if (!text) return;
    props.onSend(text);
    form?.reset();
    // form.reset() empties the textarea but doesn't fire input — collapse
    // manually so the composer snaps back to its single-row footprint.
    if (textarea) {
      textarea.style.height = '';
      autoResize();
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    sendCurrent();
  }

  function onTextareaKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Skip when an IME composition is active so CJK input isn't interrupted.
    if (event.nativeEvent.isComposing || event.key === 'Process') return;
    if (event.key !== 'Enter') return;
    if (event.shiftKey || event.altKey) return; // Shift+Enter / Alt+Enter inserts a newline.
    event.preventDefault();
    sendCurrent();
  }

  return (
    <form ref={formRef} className="maka-composer composer" onSubmit={submit}>
      <div className="maka-composer-inner composerInner">
        <textarea
          ref={textareaRef}
          name="text"
          placeholder="Message Maka…"
          disabled={props.disabled}
          onKeyDown={onTextareaKeyDown}
          onInput={autoResize}
          rows={1}
          autoComplete="off"
          spellCheck={false}
        />
        <div className="maka-composer-toolbar composerActions">
          <span>{props.disabled ? 'Waiting for permission' : (<>Press <kbd>Enter</kbd> to send · <kbd>Shift</kbd>+<kbd>Enter</kbd> for newline</>)}</span>
          <div>
            <button className="maka-button" type="button" onClick={props.onStop}>Stop</button>
            <button className="maka-button" data-variant="primary" type="submit" disabled={props.disabled}>Send</button>
          </div>
        </div>
      </div>
    </form>
  );
}

const STATUS_LABEL: Record<ToolActivityItem['status'], string> = {
  pending: 'Queued',
  waiting_permission: 'Waiting for permission',
  running: 'Running',
  completed: 'Done',
  errored: 'Errored',
  interrupted: 'Interrupted',
};

function isOpenByDefault(status: ToolActivityItem['status']): boolean {
  // Show details inline while the call is in flight or blocking the user;
  // collapse once it has settled so completed history doesn't drown the chat.
  return status === 'pending' || status === 'waiting_permission' || status === 'running';
}

function formatDuration(ms: number | undefined): string | null {
  if (ms === undefined || ms < 0) return null;
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

export function ToolActivity(props: { items: ToolActivityItem[] }) {
  return (
    <section className="toolInline" aria-label="Tool activity">
      <header>
        <strong>Activity</strong>
        <span className="maka-tool-count" aria-label={`${props.items.length} calls`}>{props.items.length}</span>
      </header>
      {props.items.map((item) => {
        const duration = formatDuration(item.durationMs);
        return (
          <details
            key={item.toolUseId}
            className="maka-tool toolItem"
            data-status={item.status}
            open={isOpenByDefault(item.status)}
          >
            <summary className="maka-tool-header">
              <span className="maka-tool-status-dot" data-status={item.status} aria-hidden="true" />
              <span className="maka-tool-name">{item.displayName ?? item.toolName}</span>
              <span className="maka-tool-meta">
                {duration && <span className="maka-tool-duration">{duration}</span>}
                <span className="maka-tool-status-label">{STATUS_LABEL[item.status]}</span>
              </span>
            </summary>
            <div className="maka-tool-body">
              {item.intent && <p className="maka-tool-intent">{item.intent}</p>}
              {item.args !== undefined && (
                <pre className="maka-code toolArgs">{JSON.stringify(item.args, null, 2)}</pre>
              )}
              {item.result && <OverlayPreview content={item.result} />}
            </div>
          </details>
        );
      })}
    </section>
  );
}

export function OverlayHost(props: { content?: ToolResultContent; onClose(): void }) {
  if (!props.content) return null;
  return (
    <div className="maka-modal-backdrop overlay">
      <button className="maka-button" onClick={props.onClose}>Close</button>
      <OverlayPreview content={props.content} />
    </div>
  );
}

export function PermissionDialog(props: {
  request: PermissionRequestEvent;
  onRespond(response: PermissionResponse): void;
}) {
  const [rememberForTurn, setRememberForTurn] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);
  // No onEscape — a permission request requires an explicit allow/deny decision.
  useModalA11y(dialogRef);

  function submit(decision: PermissionResponse['decision']) {
    props.onRespond({
      requestId: props.request.requestId,
      decision,
      rememberForTurn: decision === 'allow' ? rememberForTurn : false,
    });
  }

  return (
    <div className="maka-modal-backdrop permissionBackdrop">
      <section ref={dialogRef} className="maka-modal permissionDialog" role="dialog" aria-modal="true" aria-labelledby="permissionTitle">
        <div className="maka-modal-header">
          <h2 className="maka-modal-title" id="permissionTitle">Permission required</h2>
          <p className="maka-modal-subtitle">
            {props.request.toolName} · <span className="maka-reason-text" data-reason={props.request.reason}>{props.request.reason}</span>
          </p>
        </div>
        <div className="maka-modal-body">
          <pre className="maka-code">{JSON.stringify(props.request.args, null, 2)}</pre>
          <label className="permissionRemember">
            <input
              type="checkbox"
              checked={rememberForTurn}
              onChange={(event) => setRememberForTurn(event.currentTarget.checked)}
            />
            Remember for this turn
          </label>
        </div>
        <div className="maka-modal-footer permissionActions">
          <button className="maka-button" data-variant="ghost" type="button" onClick={() => submit('deny')}>Deny</button>
          <button className="maka-button" data-variant="primary" type="button" onClick={() => submit('allow')}>Allow</button>
        </div>
      </section>
    </div>
  );
}

function OverlayPreview(props: { content: ToolResultContent }) {
  const body = renderOverlayBody(props.content);
  // Bound the height so a tool that prints kilobytes of output can't push the
  // composer off-screen. Internal scroll is fine for inline preview.
  return <pre className="maka-overlay-preview">{body}</pre>;
}

function renderOverlayBody(content: ToolResultContent): string {
  if (content.kind === 'text') return content.text;
  if (content.kind === 'json') return JSON.stringify(content.value, null, 2);
  if (content.kind === 'terminal') return content.stdout || content.stderr;
  if (content.kind === 'file_diff') return content.diff;
  return content.kind;
}

function mergeTools(stored: ToolActivityItem[], live: ToolActivityItem[]): ToolActivityItem[] {
  const byId = new Map(stored.map((item) => [item.toolUseId, item]));
  for (const item of live) byId.set(item.toolUseId, { ...byId.get(item.toolUseId), ...item });
  return [...byId.values()];
}

// One shared formatter per renderer instance — `Intl.RelativeTimeFormat` is
// cheap to allocate but pinning it avoids reading `navigator.language` on
// every list render.
const relativeTimeFormat: Intl.RelativeTimeFormat =
  typeof Intl !== 'undefined' && typeof Intl.RelativeTimeFormat === 'function'
    ? new Intl.RelativeTimeFormat(
        typeof navigator !== 'undefined' ? navigator.language : 'en',
        { numeric: 'auto', style: 'narrow' },
      )
    : ({ format: (n: number, unit: Intl.RelativeTimeFormatUnit) => `${n}${unit[0]}` } as unknown as Intl.RelativeTimeFormat);

const noMessagesYet =
  typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('zh')
    ? '暂无消息'
    : 'No messages yet';

function formatSessionMeta(session: SessionSummary): string {
  if (!session.lastMessageAt) return noMessagesYet;
  const diffMs = Date.now() - session.lastMessageAt;
  const diffMinutes = Math.max(1, Math.round(diffMs / 60_000));
  if (diffMinutes < 60) return relativeTimeFormat.format(-diffMinutes, 'minute');
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return relativeTimeFormat.format(-diffHours, 'hour');
  return relativeTimeFormat.format(-Math.round(diffHours / 24), 'day');
}
