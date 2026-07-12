import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { ArrowUp, Check, ChevronDown, FileEdit, FolderOpen, GitBranch, History, Plus } from './icons.js';
import { ChatModelSwitcher, ModelChipStatic, NewChatModelPicker } from './chat-model-switcher.js';
import { type UiLocale, detectUiLocale } from './locale-helpers.js';
import { type ChatModelChoice, modelChoiceValue } from './chat-model-helpers.js';
import {
  type ComposerHistoryState,
  appendPromptContextDraft,
  navigateComposerHistory,
  readComposerDraft,
  reconcileHistorySync,
  rememberComposerDraft,
  rememberComposerHistoryEntry,
} from './composer-helpers.js';
import { readGlobalInputHistory, saveGlobalInputHistoryEntry } from './input-history.js';
import {
  createChatInputActionOwner,
  fileTransferContainsFiles,
  focusTextInputAtEnd,
  isChatInputComposing,
  type ChatInputActionOwner,
} from './chat-input-behavior.js';
import type { AttachmentRef, PermissionMode, ProviderType, SessionSummary } from '@maka/core';
import { Button as UiButton } from './ui.js';
import { Textarea as UiTextarea } from './primitives/textarea.js';
import { AttachmentFileCard } from './attachment-file-card.js';
import { Kbd } from './primitives/kbd.js';
import { PermissionModeSelect } from './permission-mode-menu.js';
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from './primitives/menu.js';

const COMPOSER_MAX_HEIGHT = 240;

/**
 * PR-UI-15 (@yuejing 2026-05-22): Composer copy is locale-aware.
 *
 * Audit §3.5 — placeholder + state copy were hardcoded zh and drifted
 * stylistically from OnboardingHero's quickChat input (which used a
 * long example sentence as the placeholder). Unified style: both
 * surfaces show the same short action-oriented placeholder, and
 * OnboardingHero gets a separate `<small>` example hint below the
 * textarea so first-run users still know what to type.
 */
const COMPOSER_COPY_BY_LOCALE: Record<UiLocale, {
  placeholder: string;
  textareaAriaLabel: string;
  awaitingPermission: string;
  sending: string;
  streamingHintPrefix: string;
  streamingHintProcessingPrefix: string;
  streamingHintContinuingPrefix: string;
  streamingHintInterrupt: string;
}> = {
  zh: {
    // Placeholder honesty: '/' quick-invoke and '@' context syntax do not
    // exist yet — the old copy advertised affordances the input can't honor.
    placeholder: '描述任务…',
    textareaAriaLabel: '消息输入框',
    awaitingPermission: '等待你确认权限…',
    sending: '正在发送…',
    // PR-UX-POLISH-1 (yuejing UX audit msg `9c779b56`): composer streaming
    // hint now reads `正在回答` so it doesn't conflict with the
    // ReasoningPanel's `正在思考` (which displays the model's actual
    // extended-thinking stream). Composer = output-streaming;
    // ReasoningPanel = reasoning-streaming; distinct signals, distinct copy.
    streamingHintPrefix: 'Maka 正在回答…',
    // #646: before the first token, nothing is being answered yet — match the
    // timeline's "正在处理…" model-wait indicator so the two aren't at odds.
    streamingHintProcessingPrefix: 'Maka 正在处理…',
    // #646: a mid-turn step-to-step lull after content has already streamed —
    // matches the timeline's calm "继续中…" hint, never re-showing "正在处理…".
    streamingHintContinuingPrefix: 'Maka 继续中…',
    streamingHintInterrupt: '或点停止中断',
  },
  en: {
    placeholder: 'Describe a task, / for commands, @ for context…',
    textareaAriaLabel: 'Message input',
    awaitingPermission: 'Waiting for your permission decision…',
    sending: 'Sending…',
    // PR-UX-POLISH-1: parallel en-locale fix — `is responding` instead of
    // `is thinking`, so it doesn't collide with the ReasoningPanel's
    // `Thinking…` label.
    streamingHintPrefix: 'Maka is responding…',
    // #646: pre-first-token wait — Maka is working, not yet answering.
    streamingHintProcessingPrefix: 'Maka is working…',
    // #646: mid-turn step-to-step lull after content — calmer than the head wait.
    streamingHintContinuingPrefix: 'Maka is continuing…',
    streamingHintInterrupt: 'or click Stop to interrupt',
  },
};

const COMPOSER_BUTTON_COPY_BY_LOCALE: Record<UiLocale, { sendLabel: string; stopLabel: string }> = {
  zh: { sendLabel: '发送', stopLabel: '停止' },
  en: { sendLabel: 'Send', stopLabel: 'Stop' },
};

export interface ComposerHandle {
  /** Replace the textarea value and resize, leaving focus on the input. */
  setText(text: string): void;
  /** Append a prompt/context fragment after the existing draft instead of replacing it. */
  appendText(text: string): void;
  /** Move focus to the textarea without changing its content. */
  focus(): void;
}

type ComposerImportActionId = 'pick' | 'attach';

export const Composer = forwardRef<
  ComposerHandle,
  {
    disabled?: boolean;
    hidden?: boolean;
    /**
     * When true, a turn is in flight — live output OR (with `processing`) the
     * pre-first-token wait. Toolbar swaps to a working hint ("Maka 正在回答…" or
     * "正在处理…") and the Stop button is the only visible action — Send is hidden
     * because the model is busy.
     */
    streaming?: boolean;
    /**
     * #646: the `streaming` window is the pre-first-token wait (the model is
     * being awaited with nothing streaming yet), not live output. Only changes
     * the hint copy — "Maka 正在处理…" instead of "正在回答…", matching the
     * timeline's model-wait indicator. Ignored unless `streaming` is true.
     */
    processing?: boolean;
    /**
     * #646: a mid-turn step-to-step lull after content has already streamed. Only
     * changes the hint copy — "Maka 继续中…", matching the timeline's calm hint —
     * so the Stop button stays up without re-showing "正在处理…". Ignored unless
     * `streaming` is true; mutually exclusive with `processing`.
     */
    continuing?: boolean;
    /** True while the current streaming session is processing a stop request. */
    stopPending?: boolean;
    /** Runtime-only key used to keep unsent drafts isolated per session. */
    draftKey?: string;
    onSend(text: string): boolean | void | Promise<boolean | void>;
    onStop(): void | Promise<void>;
    onPickAttachments?(): void | Promise<void>;
    onAttachFilePaths?(files: File[]): void | Promise<void>;
    pendingAttachments?: readonly { displayName: string; kind: AttachmentRef['kind']; mimeType?: string; size: number }[];
    onRemoveAttachment?(index: number): void;
    modelLabel?: string;
    activeSession?: SessionSummary;
    activeConnectionLabel?: string;
    activeModel?: string;
    activeModelLabel?: string;
    modelChoices?: ChatModelChoice[];
    /** Renders the provider brand mark on each group heading of the model menus;
     *  injected by the desktop app to keep the provider SVG library out of @maka/ui. */
    renderProviderMark?(type: ProviderType): ReactNode;
    modelChangePending?: boolean;
    onModelChange?(input: { llmConnectionSlug: string; model: string }): void | Promise<void>;
    /** Per-model thinking-level variants for the active model; empty/undefined hides the switcher. */
    activeThinkingLevels?: readonly import('@maka/core').ThinkingLevel[];
    activeThinkingLevel?: import('@maka/core').ThinkingLevel;
    onThinkingLevelChange?(level: import('@maka/core').ThinkingLevel | undefined): void | Promise<void>;
    newChatThinkingLevels?: readonly import('@maka/core').ThinkingLevel[];
    newChatThinkingLevel?: import('@maka/core').ThinkingLevel;
    onNewChatThinkingLevelChange?(level: import('@maka/core').ThinkingLevel | undefined): void | Promise<void>;
    /**
     * Home / empty-state composer only (no active session yet): the model
     * the next new chat will start with, and the picker callback. When set,
     * the otherwise-static model chip becomes a real dropdown so the user can
     * choose the new-chat model inline instead of only via Settings · 模型.
     */
    newChatModel?: { llmConnectionSlug: string; model: string };
    onPickNewChatModel?(input: { llmConnectionSlug: string; model: string }): void | Promise<void>;
    /**
     * Empty-state only: no models are configured yet, so the model chip is a
     * non-interactive label. When provided, the chip becomes a button into
     * Settings · 模型 instead of wearing a dropdown chevron it cannot honor.
     */
    onOpenModelSettings?(): void;
    workspacePicker?: {
      label?: string;
      branch?: string | null;
      pending?: boolean;
      recentWorkspaces?: string[];
      onOpen(): void;
      onSelect(path: string): void;
    };
    /**
     * Git branch picker for the workspace row, shown to the right of
     * the folder indicator when the workspace is a git repository.
     * Clicking the trigger opens a Menu listing local branches; selecting
     * one fires `onSelect` to switch branches (handled in the shell).
     */
    branchPicker?: {
      branch: string | null;
      pending?: boolean;
      branches: string[];
      onOpen(): void;
      onSelect(branch: string): void;
    };
    /**
     * PR-MOVE-PERMISSION-MODE (WAWQAQ 47fe0d0e + a667cf6c): the
     * permission mode picker lives inside the composer left-controls
     * instead of the chat header. Composer renders a dropdown labelled
     * by the current mode (询问权限 / 自动执行 / 跳过确认);
     * selecting an option fires `onPermissionModeChange`. When the
     * active session is in the legacy `explore` mode the picker
     * collapses to display 询问权限 — explore is internal-only now and
     * won't surface here.
     */
    permissionMode?: PermissionMode;
    permissionModePending?: boolean;
    permissionModeDisabledReason?: string;
    onPermissionModeChange?(mode: PermissionMode): void | Promise<void>;
  }
>(function Composer(props, ref) {
  const formRef = useRef<HTMLFormElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [dragActive, setDragActive] = useState(false);
  const [sendPending, setSendPending] = useState(false);
  const [pendingImportAction, setPendingImportAction] = useState<ComposerImportActionId | null>(null);
  const [hasDraftText, setHasDraftText] = useState(false);
  const draftStoreRef = useRef<Map<string, string>>(new Map());
  const activeDraftKeyRef = useRef<string | undefined>(props.draftKey);
  const composerMountedRef = useRef(true);
  const sendPendingRef = useRef(false);
  const compositionActiveRef = useRef(false);
  const importActionOwnerRef = useRef<ChatInputActionOwner<ComposerImportActionId> | null>(null);
  if (!importActionOwnerRef.current) {
    importActionOwnerRef.current = createChatInputActionOwner((action) => {
      if (composerMountedRef.current) setPendingImportAction(action);
    });
  }
  const promptHistoryRef = useRef<ComposerHistoryState>({ entries: readGlobalInputHistory() ?? [], index: -1, savedDraft: '' });
  // PR-UI-15: locale-aware copy for placeholder + toolbar states. We
  // detect once per render (cheap) rather than memoizing — the locale
  // is effectively constant for the lifetime of the renderer but the
  // few ns of detection cost beats wiring up a context provider just
  // for this bundle.
  const locale = detectUiLocale();
  const copy = COMPOSER_COPY_BY_LOCALE[locale];
  const buttonCopy = COMPOSER_BUTTON_COPY_BY_LOCALE[locale];

  useEffect(() => {
    composerMountedRef.current = true;
    return () => {
      composerMountedRef.current = false;
      sendPendingRef.current = false;
      importActionOwnerRef.current?.reset();
    };
  }, []);

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

  function saveCurrentDraft(value?: string) {
    const nextValue = value ?? textareaRef.current?.value ?? '';
    rememberComposerDraft(draftStoreRef.current, activeDraftKeyRef.current, nextValue);
    setHasDraftText(Boolean(nextValue.trim()));
  }

  function resetPromptHistoryNavigation() {
    promptHistoryRef.current = {
      entries: promptHistoryRef.current.entries,
      index: -1,
      savedDraft: '',
    };
  }

  useEffect(() => {
    const el = textareaRef.current;
    const previousKey = activeDraftKeyRef.current;
    const nextKey = props.draftKey;

    if (previousKey !== nextKey) {
      rememberComposerDraft(draftStoreRef.current, previousKey, el?.value ?? '');
      activeDraftKeyRef.current = nextKey;
      resetPromptHistoryNavigation();
      if (el) {
        const nextDraft = readComposerDraft(draftStoreRef.current, nextKey);
        el.value = nextDraft;
        setHasDraftText(Boolean(nextDraft.trim()));
        autoResize();
        const length = el.value.length;
        el.setSelectionRange(length, length);
      }
    }
  }, [props.draftKey]);

  useImperativeHandle(
    ref,
    () => ({
      setText(text: string) {
        const el = textareaRef.current;
        if (!el) return;
        resetPromptHistoryNavigation();
        el.value = text;
        saveCurrentDraft(text);
        autoResize();
        // Move caret to end so the user can keep typing.
        focusTextInputAtEnd(el);
      },
      appendText(text: string) {
        const el = textareaRef.current;
        if (!el) return;
        resetPromptHistoryNavigation();
        el.value = appendPromptContextDraft(el.value, text);
        saveCurrentDraft(el.value);
        autoResize();
        focusTextInputAtEnd(el);
      },
      focus() {
        textareaRef.current?.focus();
      },
    }),
    [],
  );

  async function sendCurrent() {
    if (props.disabled || sendPendingRef.current || importActionOwnerRef.current?.pending) return;
    const textarea = textareaRef.current;
    const form = formRef.current;
    const text = (textarea?.value ?? '').trim();
    if (!text) return;
    const submittedDraftKey = activeDraftKeyRef.current;
    sendPendingRef.current = true;
    setSendPending(true);
    let sent: boolean | void;
    try {
      sent = await props.onSend(text);
    } finally {
      sendPendingRef.current = false;
      if (composerMountedRef.current) setSendPending(false);
    }
    if (!composerMountedRef.current) return;
    if (sent === false) return;
    // Save to both local ref and global persistence so the history
    // survives page reloads and is shared across all input surfaces.
    saveGlobalInputHistoryEntry(text);
    promptHistoryRef.current = {
      entries: rememberComposerHistoryEntry(promptHistoryRef.current.entries, text),
      index: -1,
      savedDraft: '',
    };
    rememberComposerDraft(draftStoreRef.current, submittedDraftKey, '');
    saveCurrentDraft('');
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
    void sendCurrent();
  }

  async function runImportAction(actionId: ComposerImportActionId, action: (() => void | Promise<void>) | undefined) {
    if (!action || props.disabled || props.streaming) return;
    await importActionOwnerRef.current?.run(actionId, async () => {
      await action();
    });
  }

  function onTextareaKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Skip when an IME composition is active so CJK input isn't interrupted.
    if (isChatInputComposing(event, compositionActiveRef.current)) return;
    // Esc while a drag-active highlight is showing should clear it
    // immediately. The existing useEffect listens for blur/dragend/drop
    // but not keydown, so a user who hits Esc to cancel a stuck drag
    // gesture would otherwise see the highlight linger until they
    // blurred the window or completed a real drop somewhere.
    if (event.key === 'Escape' && dragActive) {
      setDragActive(false);
    }
    // Esc during streaming interrupts the model. We don't preventDefault
    // unconditionally so Esc still works to close modals when the composer
    // happens to be focused outside a streaming turn.
    if (event.key === 'Escape' && props.streaming) {
      event.preventDefault();
      if (props.stopPending) return;
      props.onStop();
      return;
    }
    // PR-GLOBAL-INPUT-HISTORY: up/down arrow navigates the global input
    // history. Bare arrow keys only start navigation when the textarea is
    // empty, or when the user is already mid-navigation (index >= 0); in a
    // multi-line draft the caret keeps moving so editing isn't hijacked.
    // Ctrl/Cmd + ArrowUp/ArrowDown is an explicit shortcut that always
    // navigates history regardless of the current draft.
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      const explicit = Boolean(event.ctrlKey || event.metaKey);
      const plainArrow = !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey;
      if (plainArrow || explicit) {
        const el = textareaRef.current;
        const isNavigatingHistory = promptHistoryRef.current.index >= 0;
        const canStartHistory = Boolean(el && !el.value.trim());
        if (el && (explicit || isNavigatingHistory || canStartHistory)) {
          // Re-read global history from localStorage on every navigation so
          // a clear from Settings (an overlay that keeps the Composer
          // mounted) is picked up immediately, and a transient storage
          // failure does not clobber the in-memory history.
          // reconcileHistorySync restores the saved draft if a clear happened
          // mid-navigation (so the user doesn't lose what they were typing).
          const synced = readGlobalInputHistory();
          const { state, restoreDraft } = reconcileHistorySync(promptHistoryRef.current, synced);
          promptHistoryRef.current = state;
          if (restoreDraft && el) {
            el.value = state.savedDraft;
            saveCurrentDraft(state.savedDraft);
            autoResize();
            const length = el.value.length;
            el.setSelectionRange(length, length);
          }
          // Nothing to navigate when history was cleared (synced empty).
          // When the storage read failed (synced === null), keep navigating
          // with the in-memory entries.
          if (synced !== null && synced.length === 0) return;
          const next = navigateComposerHistory(
            promptHistoryRef.current,
            event.key === 'ArrowUp' ? 'previous' : 'next',
            el.value,
          );
          if (next.changed) {
            event.preventDefault();
            promptHistoryRef.current = next.state;
            el.value = next.value;
            saveCurrentDraft(next.value);
            autoResize();
            const length = el.value.length;
            el.setSelectionRange(length, length);
            return;
          }
        }
      }
    }
    if (event.key !== 'Enter') return;
    if (event.shiftKey || event.altKey) return; // Shift+Enter / Alt+Enter inserts a newline.
    event.preventDefault();
    void sendCurrent();
  }

  function onTextareaInput() {
    resetPromptHistoryNavigation();
    autoResize();
    saveCurrentDraft();
  }

  function canAcceptDroppedFiles(): boolean {
    return Boolean(props.onAttachFilePaths && !props.disabled && !props.streaming && !importActionOwnerRef.current?.pending);
  }

  function hasDraggedFiles(event: DragEvent<HTMLFormElement>): boolean {
    return fileTransferContainsFiles(event.dataTransfer.types, event.dataTransfer.files.length);
  }

  function hasPastedFiles(event: ClipboardEvent<HTMLTextAreaElement>): boolean {
    return fileTransferContainsFiles(event.clipboardData.types, event.clipboardData.files.length);
  }

  function onComposerDragOver(event: DragEvent<HTMLFormElement>) {
    if (!canAcceptDroppedFiles() || !hasDraggedFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setDragActive(true);
  }

  function onComposerDragLeave(event: DragEvent<HTMLFormElement>) {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDragActive(false);
  }

  function onComposerDrop(event: DragEvent<HTMLFormElement>) {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    setDragActive(false);
    if (!canAcceptDroppedFiles()) return;
    const files = Array.from(event.dataTransfer.files);
    if (files.length === 0) return;
    void runImportAction('attach', () => props.onAttachFilePaths?.(files));
  }

  function onTextareaPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    // PR-FE-BUG-HUNT-10 hotfix: extend the IME composition guard from
    // the keydown path (line 5640) to the paste path. If the user is
    // mid-CJK composition and the clipboard happens to contain a file
    // (screenshot shortcut etc.), `event.preventDefault()` below would
    // interrupt the IME mid-character.
    //
    // Original PR #216 copied `event.nativeEvent.isComposing` from the
    // keydown handler verbatim, but `isComposing` only exists on
    // KeyboardEvent / InputEvent in the DOM spec — not ClipboardEvent.
    // (Browsers happen to expose it on the underlying event too, but
    // TypeScript types don't acknowledge that.) Use a narrow `in` check
    // + a typed cast so this compiles AND keeps working when the
    // browser does expose the flag.
    if (isChatInputComposing(event, compositionActiveRef.current)) return;
    if (!hasPastedFiles(event)) return;
    if (!canAcceptDroppedFiles()) return;
    const files = Array.from(event.clipboardData.files);
    if (files.length === 0) return;
    event.preventDefault();
    void runImportAction('attach', () => props.onAttachFilePaths?.(files));
  }

  useEffect(() => {
    if (!dragActive) return undefined;
    const clearDragActive = () => setDragActive(false);
    window.addEventListener('blur', clearDragActive);
    window.addEventListener('dragend', clearDragActive);
    window.addEventListener('drop', clearDragActive);
    return () => {
      window.removeEventListener('blur', clearDragActive);
      window.removeEventListener('dragend', clearDragActive);
      window.removeEventListener('drop', clearDragActive);
    };
  }, [dragActive]);

  if (props.hidden) return null;
  const importActionBusy = pendingImportAction !== null;
  const sendDisabled = props.disabled || sendPending || importActionBusy || !hasDraftText;
  const modelChipLabel = props.modelLabel?.trim() || '选择模型';
  const modelSwitcherDisabledReason = props.streaming
    ? '当前对话正在流式输出，等结束后再切换模型。'
    : props.activeSession?.status === 'running'
      ? '当前对话正在运行，等结束后再切换模型。'
      : props.activeSession?.status === 'waiting_for_user'
        ? '当前有工具调用正在等待确认，处理后再切换模型。'
        : undefined;

  return (
    <form
      ref={formRef}
      className="maka-composer composer"
      data-drag-active={dragActive ? 'true' : undefined}
      data-maka-file-drop-target={canAcceptDroppedFiles() ? 'true' : undefined}
      onDragOver={onComposerDragOver}
      onDragLeave={onComposerDragLeave}
      onDrop={onComposerDrop}
      onSubmit={submit}
    >
      <div
        className="maka-composer-inner composerInner agents-parchment-paper-surface"
        data-streaming={props.streaming ? 'true' : undefined}
      >
        {props.pendingAttachments && props.pendingAttachments.length > 0 ? (
          <div className="flex flex-wrap gap-1.5 px-3 pt-2">
            {props.pendingAttachments.map((attachment, index) => (
              <AttachmentFileCard
                key={`${attachment.displayName}-${index}`}
                name={attachment.displayName}
                kind={attachment.kind}
                size={attachment.size}
                onRemove={props.onRemoveAttachment ? () => props.onRemoveAttachment?.(index) : undefined}
              />
            ))}
          </div>
        ) : null}
        <UiTextarea
          ref={textareaRef}
          unstyled
          name="text"
          className="maka-composer-textarea resize-none"
          placeholder={copy.placeholder}
          aria-label={copy.textareaAriaLabel}
          disabled={props.disabled}
          onKeyDown={onTextareaKeyDown}
          onPaste={onTextareaPaste}
          onCompositionStart={() => { compositionActiveRef.current = true; }}
          onCompositionEnd={() => { compositionActiveRef.current = false; }}
          onInput={onTextareaInput}
          rows={1}
          autoComplete="off"
          spellCheck={false}
        />
        {dragActive && (
          <span className="maka-visually-hidden" role="status" aria-live="polite">
            松开以导入文件内容
          </span>
        )}
        <div className="maka-composer-toolbar composerActions" data-streaming={props.streaming ? 'true' : undefined}>
          <div className="maka-composer-left-controls">
            {!props.streaming && props.onPickAttachments ? (
              <UiButton
                variant="quiet"
                size="icon-sm"
                className="maka-composer-tool-button maka-composer-context-plus"
                type="button"
                disabled={props.disabled || importActionBusy}
                onClick={() => void runImportAction('pick', props.onPickAttachments)}
                aria-label={pendingImportAction === 'pick' ? '正在添加附件' : '添加附件'}
                aria-busy={pendingImportAction === 'pick' ? 'true' : undefined}
                data-pending={pendingImportAction === 'pick' ? 'true' : undefined}
                title="添加附件"
              >
                <Plus size={15} aria-hidden="true" />
              </UiButton>
            ) : null}
            {/* PR-MOVE-PERMISSION-MODE: the static "通用" role chip
                was replaced by the permission-mode dropdown — that
                spot is where the reference Settings expects users to
                pick "Ask permissions" / "Auto mode" / "Bypass
                permissions". Maka exposes the user-facing modes
                `ask` / `execute` / `bypass`; `explore` collapses to `ask` in the
                display because Deep Research sessions use it
                internally but it's not a useful runtime toggle for
                normal chat. */}
            {props.onPermissionModeChange ? (
              <PermissionModeSelect
                activeMode={props.permissionMode ?? 'ask'}
                onSelect={(mode) => {
                  void props.onPermissionModeChange?.(mode);
                }}
                align="start"
                disabled={props.disabled || props.permissionModePending === true || Boolean(props.permissionModeDisabledReason)}
                disabledReason={props.permissionModeDisabledReason}
              />
            ) : null}
          </div>
          <span className="maka-composer-status-slot">
            {props.disabled ? (
              // PR-COMPOSER-PERMISSION-PULSE-0 (WAWQAQ msg `ed67a267`,
              // skills round task #116): wrap the "等待权限确认" text
              // in a styled hint with a pulsing accent dot. Plain text
              // was easy to miss — the dot signals "system is waiting
              // on YOU" with the same visual weight as the streaming
              // 3-dot bounce on the other side of the disabled/active
              // boundary.
              <span className="maka-composer-permission-hint">
                <span className="maka-composer-permission-dot" aria-hidden="true" />
                {copy.awaitingPermission}
              </span>
            ) : sendPending ? (
              copy.sending
            ) : importActionBusy ? (
              '正在导入…'
            ) : props.streaming ? (
              <span className="maka-composer-streaming-hint">
                <span className="maka-composer-streaming-dot" aria-hidden="true" />
                {props.processing
                  ? copy.streamingHintProcessingPrefix
                  : props.continuing
                    ? copy.streamingHintContinuingPrefix
                    : copy.streamingHintPrefix} <Kbd className="maka-shortcut-kbd">Esc</Kbd> {copy.streamingHintInterrupt}
              </span>
            ) : (
              null
            )}
          </span>
          <div className="maka-composer-right-controls">
            {!props.streaming && (
              <>
                {props.activeSession ? (
                  <ChatModelSwitcher
                    activeSession={props.activeSession}
                    activeModel={props.activeModel}
                    activeConnectionLabel={props.activeConnectionLabel}
                    activeModelLabel={props.activeModelLabel}
                    choices={props.modelChoices ?? []}
                    pending={props.modelChangePending}
                    disabledReason={modelSwitcherDisabledReason}
                    renderProviderMark={props.renderProviderMark}
                    onChange={props.onModelChange}
                    thinkingLevels={props.activeThinkingLevels}
                    thinkingLevel={props.activeThinkingLevel}
                    onThinkingLevelChange={props.onThinkingLevelChange}
                  />
                ) : props.onPickNewChatModel && (props.modelChoices?.length ?? 0) > 0 ? (
                  <NewChatModelPicker
                    label={modelChipLabel}
                    choices={props.modelChoices ?? []}
                    currentValue={
                      props.newChatModel
                        ? modelChoiceValue(props.newChatModel.llmConnectionSlug, props.newChatModel.model)
                        : undefined
                    }
                    renderProviderMark={props.renderProviderMark}
                    onPick={props.onPickNewChatModel}
                    thinkingLevels={props.newChatThinkingLevels}
                    thinkingLevel={props.newChatThinkingLevel}
                    onThinkingLevelChange={props.onNewChatThinkingLevelChange}
                  />
                ) : (
                  <ModelChipStatic label={modelChipLabel} onOpenSettings={props.onOpenModelSettings} />
                )}
              </>
            )}
            {props.streaming ? (
              <UiButton
                className="maka-button"
                variant="default"
                size="sm"
                type="button"
                disabled={props.stopPending}
                onClick={() => {
                  if (props.stopPending) return;
                  void props.onStop();
                }}
                aria-busy={props.stopPending ? 'true' : undefined}
                data-pending={props.stopPending ? 'true' : undefined}
              >
                {props.stopPending ? '停止中…' : buttonCopy.stopLabel}
              </UiButton>
            ) : (
              <UiButton
                className="maka-composer-send-button"
                variant="default"
                size="icon-sm"
                type="submit"
                disabled={sendDisabled}
                aria-label={buttonCopy.sendLabel}
                aria-busy={sendPending ? 'true' : undefined}
                data-pending={sendPending ? 'true' : undefined}
                title={buttonCopy.sendLabel}
              >
                <ArrowUp size={16} aria-hidden="true" />
              </UiButton>
            )}
          </div>
        </div>
      </div>
      {props.workspacePicker && (() => {
        const wp = props.workspacePicker!;
        return (
        <div className="maka-composer-workspace-row">
          {/* PR-COMPOSER-WORKSPACE-PICKER-PRIMITIVE-0 (round 9/30):
              the workspace picker badge was a raw `<button>`.
              Routed through UiButton variant="quiet"; custom class
              still owns the picker's inline-flex shape (icon +
              label + chevron) and the bespoke 3px accent
              focus-visible ring. */}
          <Menu>
            <MenuTrigger
              render={({ onClick: menuToggleClick, ...triggerRest }) => (
                <UiButton
                  {...triggerRest}
                  onClick={(e) => {
                    menuToggleClick?.(e);
                  }}
                  type="button"
                  variant="quiet"
                  className="maka-composer-workspace-picker"
                  disabled={wp.pending === true}
                  aria-busy={wp.pending === true ? 'true' : undefined}
                  title={wp.branch ? `选择工作目录 · ${wp.branch}` : '选择工作目录'}
                  aria-label={wp.branch
                    ? `选择工作目录：${wp.label ?? '当前工作目录'}，当前分支 ${wp.branch}`
                    : `选择工作目录：${wp.label ?? '当前工作目录'}`}
                >
                  <FolderOpen size={13} aria-hidden="true" />
                  {wp.label
                    ? <span className="maka-composer-workspace-current">{wp.label}</span>
                    : <span>选择工作目录</span>}
                  <ChevronDown size={12} aria-hidden="true" />
                </UiButton>
              )}
            />
            <MenuPopup className="maka-composer-workspace-menu" align="start" side="top" sideOffset={6}>
              {wp.recentWorkspaces && wp.recentWorkspaces.length > 0
                ? (
                  <>
                    {wp.recentWorkspaces.map((wsp) => (
                      <MenuItem key={wsp} onClick={() => { wp.onSelect(wsp); }}>
                        <History size={13} aria-hidden="true" />
                        <span>{basenameFromPath(wsp)}</span>
                      </MenuItem>
                    ))}
                    <MenuSeparator />
                    <MenuItem onClick={() => { wp.onOpen(); }}>
                      <FolderOpen size={13} aria-hidden="true" />
                      <span>选择其他目录...</span>
                    </MenuItem>
                  </>
                )
                : (
                  <MenuItem onClick={() => { wp.onOpen(); }}>
                    <FolderOpen size={13} aria-hidden="true" />
                    <span>选择工作目录...</span>
                  </MenuItem>
                )}
            </MenuPopup>
          </Menu>
          {props.branchPicker && (() => {
            const bp = props.branchPicker!;
            const triggerDisabled = bp.pending === true;
            return (
              <Menu>
                <MenuTrigger
                  render={({ onClick: menuToggleClick, ...triggerRest }) => (
                    <UiButton
                      {...triggerRest}
                      onClick={(e) => {
                        bp.onOpen();
                        menuToggleClick?.(e);
                      }}
                      type="button"
                      variant="quiet"
                      className="maka-composer-branch-picker"
                      disabled={triggerDisabled}
                      aria-busy={triggerDisabled ? 'true' : undefined}
                      title={bp.branch ? `分支：${bp.branch}` : '选择分支'}
                      aria-label={bp.branch
                        ? `切换分支：${bp.branch}`
                        : '选择分支'}
                    >
                      <GitBranch size={13} aria-hidden="true" />
                      <span className="maka-composer-branch-current">{bp.branch ?? '—'}</span>
                      <ChevronDown size={12} aria-hidden="true" />
                    </UiButton>
                  )}
                />
                <MenuPopup className="maka-composer-branch-menu" align="start" side="top" sideOffset={6}>
                  {bp.branches.length === 0 ? (
                    <div className="maka-composer-branch-empty">无本地分支</div>
                  ) : (
                    bp.branches.map((b) => (
                      <MenuItem
                        key={b}
                        data-active={b === bp.branch}
                        onClick={() => {
                          if (b === bp.branch) return;
                          void bp.onSelect(b);
                        }}
                      >
                        <GitBranch size={13} aria-hidden="true" />
                        <span>{b}</span>
                        {b === bp.branch && (
                          <Check size={12} aria-hidden="true" className="maka-composer-branch-check" />
                        )}
                      </MenuItem>
                    ))
                  )}
                </MenuPopup>
              </Menu>
            );
          })()}
        </div>
      );
    })()}
    </form>
  );
});

/** Extract the last path segment from a file system path (win32 / posix). */
function basenameFromPath(value: string): string {
  const trimmed = value.replace(/[\\/]+$/, '');
  const name = trimmed.split(/[\\/]/).filter(Boolean).pop();
  return name || trimmed || '当前项目';
}
