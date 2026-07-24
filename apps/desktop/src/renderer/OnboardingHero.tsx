// apps/desktop/src/renderer/OnboardingHero.tsx
//
// First-run hero rendered above the chat surface when the workspace
// has no sessions yet (PR110c rewrite). Routes purely off the
// `OnboardingState` projection from `@maka/core/onboarding` — never
// re-derives provider readiness, never lists connections directly.
//
// @kenji + @xuan PR110c review gates:
//   - Each `OnboardingState.kind` has an explicit branch with a
//     diagnostic Chinese copy + Settings deep-link CTA. NO inline
//     editors (credential entry / model picker live in Settings).
//   - `blocked: all_connections_unhealthy` MUST have a labeled
//     fallback branch — no generic `default` swallowing it.
//   - `ready_with_history` MUST NOT render this hero (caller decides).
//   - Raw `state.kind` strings MUST NOT appear in rendered text;
//     copy is in Chinese with no enum identifier leakage.
//   - For `needs_connection_credentials` / `needs_default_model`,
//     `connectionSlug` is shown as a slug literal (no
//     `connectionName` promise) until sanitized display data is
//     wired in a later PR.

import { ArrowRight, ArrowUp, ChevronRight, RotateCcw, Sparkles, KeyRound, Settings as SettingsIcon, Cpu, AlertCircle, FolderOpen, Paperclip, X } from '@maka/ui/icons';
import { Fragment, useCallback, useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import { RECOMMENDED_PROVIDER_TYPES, type LlmConnection, type OnboardingState, type ProviderType, type QuickChatMode, type SettingsSection } from '@maka/core';
import {
  Button,
  ComposerMentionPopup,
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
  Textarea,
  appendPromptContextDraft,
  createChatInputActionOwner,
  fileTransferContainsFiles,
  focusTextInputAtEnd,
  getConversationCopy,
  isChatInputComposing,
  mentionOptionId,
  useComposerSkillDraft,
  useMentionPopup,
  useMountedRef,
  useUiLocale,
  type ChatInputActionOwner,
} from '@maka/ui';
import { ProviderLogo, providerDisplay } from './settings/provider-display';
import { getFirstRunTaskSuggestions } from './first-run-task-suggestions';
import { getOnboardingHeroCopy, getOnboardingSetupSteps, type OnboardingSetupStep } from './onboarding-hero-copy';
import { getOnboardingCopy } from './locales/onboarding-copy';

/**
 * PR-UI-15 (@yuejing 2026-05-22): unify OnboardingHero quickChat
 * placeholder style with the main Composer. v1 used a long example
 * sentence as placeholder which stylistically conflicted with the
 * Composer's short action-oriented placeholder. New design: same
 * short placeholder, example sentence moved to a `<small>` hint
 * below the textarea so first-run users still know what to type.
 */
export interface OnboardingHeroProps {
  state: OnboardingState;
  /** Open Settings with a specific section preselected. */
  onOpenSettings: (section?: SettingsSection) => void;
  /** Open Settings → 模型 with the create-connection dialog for this provider. */
  onAddProvider: (providerType: ProviderType) => void;
  /** Open the shared Settings provider catalog. */
  onBrowseProviders: () => void;
  /**
   * Quick Chat submit handler (PR110b `quickChat:start`). Only
   * called from the `ready_empty` branch. The caller is responsible
   * for handling the discriminated-union result (setActiveId on
   * success, toast on `send_failed`, etc.). Returns true only after
   * the target session is created; the hero keeps the draft on false
   * so a setup/send failure does not erate the user's first prompt.
   */
  onQuickChatSubmit: (
    prompt: string,
    mode?: QuickChatMode,
    skillIds?: readonly string[],
  ) => boolean | Promise<boolean>;
  /** Enabled, host-compatible Skills offered by the `/` popup. */
  mentionSkills?: ReadonlyArray<{ ref?: string; id: string; name: string; description?: string }>;
  /**
   * Flag set when a `quickChat:start` call is in flight, so the
   * composer can disable its submit button without owning the
   * pending state itself.
   */
  quickChatPending?: boolean;
  /**
   * PR-ONBOARDING-EARLY-COPY-0: current connection list so the
   * credentials / model heroes can resolve a `connectionSlug` to a
   * human-friendly name. Optional; falls back to slug if missing.
   */
  connections?: ReadonlyArray<LlmConnection>;
  /**
   * PR-ONBOARDING-EARLY-COPY-0: refresh handler so env-bootstrap
   * users who finished their setup outside the UI can re-query
   * the snapshot without restarting. Optional.
   */
  onRefreshConnections?: () => Promise<void> | void;
  /**
   * Skip the initial onboarding and enter the app. Writes
   * `initial_onboarding` milestone as `skipped`. Only invoked from
   * the `needs_*` / `blocked` branches; `ready_empty` does not show
   * a skip button because the user is already configured.
   */
  onSkip?: () => Promise<void> | void;
  onImportDroppedTextFiles?: (files: File[]) => Promise<string | undefined>;
}

export function OnboardingHero(props: OnboardingHeroProps) {
  const { state } = props;
  const [refreshConnectionsPending, setRefreshConnectionsPending] = useState(false);
  const onboardingMountedRef = useMountedRef();
  const refreshConnectionsPendingRef = useRef(false);

  useEffect(() => {
    return () => {
      refreshConnectionsPendingRef.current = false;
    };
  }, []);

  const runRefreshConnections = useCallback(async () => {
    if (!props.onRefreshConnections || refreshConnectionsPendingRef.current) return;
    refreshConnectionsPendingRef.current = true;
    setRefreshConnectionsPending(true);
    try {
      await props.onRefreshConnections();
    } finally {
      refreshConnectionsPendingRef.current = false;
      if (onboardingMountedRef.current) setRefreshConnectionsPending(false);
    }
  }, [props.onRefreshConnections]);

  switch (state.kind) {
    case 'needs_connection':
      return (
        <NeedsConnectionHero
          onAddProvider={props.onAddProvider}
          onBrowseProviders={props.onBrowseProviders}
          onRefreshConnections={props.onRefreshConnections ? runRefreshConnections : undefined}
          refreshConnectionsPending={refreshConnectionsPending}
          onSkip={props.onSkip}
        />
      );
    case 'needs_default_connection':
      return (
        <NeedsDefaultConnectionHero
          onOpenSettings={props.onOpenSettings}
          onRefreshConnections={props.onRefreshConnections ? runRefreshConnections : undefined}
          refreshConnectionsPending={refreshConnectionsPending}
          onSkip={props.onSkip}
        />
      );
    case 'needs_connection_credentials':
      return (
        <NeedsConnectionCredentialsHero
          connectionSlug={state.connectionSlug}
          connections={props.connections}
          onOpenSettings={props.onOpenSettings}
          onRefreshConnections={props.onRefreshConnections ? runRefreshConnections : undefined}
          refreshConnectionsPending={refreshConnectionsPending}
          onSkip={props.onSkip}
        />
      );
    case 'needs_default_model':
      return (
        <NeedsDefaultModelHero
          connectionSlug={state.connectionSlug}
          connections={props.connections}
          onOpenSettings={props.onOpenSettings}
          onRefreshConnections={props.onRefreshConnections ? runRefreshConnections : undefined}
          refreshConnectionsPending={refreshConnectionsPending}
          onSkip={props.onSkip}
        />
      );
    case 'ready_empty':
      return (
        <ReadyEmptyHero
          onQuickChatSubmit={props.onQuickChatSubmit}
          mentionSkills={props.mentionSkills}
          quickChatPending={props.quickChatPending === true}
          onImportDroppedTextFiles={props.onImportDroppedTextFiles}
        />
      );
    case 'blocked':
      // `blocked.reason` is `'all_connections_unhealthy'` in PR110a's
      // closed enum; if a future PR extends it, this assignment will
      // fail to compile (assertNever), forcing a labeled branch
      // rather than a silent fallthrough.
      return (
        <BlockedHero
          reason={state.reason}
          onOpenSettings={props.onOpenSettings}
          onRefreshConnections={props.onRefreshConnections ? runRefreshConnections : undefined}
          refreshConnectionsPending={refreshConnectionsPending}
          onSkip={props.onSkip}
        />
      );
    case 'ready_with_history':
      // The renderer caller decides which hero to render; this
      // component is only mounted when sessions.length === 0. Showing
      // ready_with_history at all means the caller bypassed the gate
      // — render nothing so the existing chat surface takes over.
      return null;
    default:
      return assertNever(state);
  }
}

/**
 * PR-ONBOARDING-EARLY-COPY-0: resolve a slug to its persisted
 * connection name. Falls back to the raw slug when the lookup misses
 * (e.g. snapshot raced ahead of the connection list refresh).
 */
function connectionLabel(
  slug: string,
  connections?: ReadonlyArray<LlmConnection>,
): { name: string; isFallback: boolean } {
  if (!connections) return { name: slug, isFallback: true };
  const match = connections.find((c) => c.slug === slug);
  if (!match || !match.name) return { name: slug, isFallback: true };
  return { name: match.name, isFallback: false };
}

function NeedsConnectionHero(props: {
  onAddProvider: (providerType: ProviderType) => void;
  onBrowseProviders: () => void;
  onRefreshConnections?: () => void;
  refreshConnectionsPending?: boolean;
  onSkip?: () => Promise<void> | void;
}) {
  const locale = useUiLocale();
  const copy = getOnboardingCopy(locale);
  const hero = getOnboardingHeroCopy({ kind: 'needs_connection' }, locale)!;
  const setupSteps = getOnboardingSetupSteps({ kind: 'needs_connection' }, locale);
  return (
    <section className="maka-onboarding maka-firstrun" aria-label={hero.eyebrow}>
      {/* Selection-led layout: a big title sets the hierarchy, the three
          setup steps compress to one quiet stepper line (context, not the
          subject), and the provider list is the clear primary action. */}
      <h1 className="maka-firstrun-title">{hero.title}</h1>
      <p className="maka-firstrun-sub">{copy.needsConnection.subtitle}</p>

      {setupSteps && <FirstRunStepper steps={setupSteps} />}

      <div className="maka-firstrun-pick">
        <span className="maka-firstrun-pick-label">{copy.needsConnection.pickLabel}</span>
        <span className="maka-firstrun-pick-hint">{copy.needsConnection.pickHint}</span>
      </div>

      {/* The list scrolls vertically (CSS max-height) so it scales as more
          providers are added without pushing the footer off-screen. */}
      <div className="maka-firstrun-list">
        <ul role="list">
          {RECOMMENDED_PROVIDER_TYPES.map((type) => {
            const display = providerDisplay(type, locale);
            return (
              <li key={type}>
                <Item
                  className="maka-firstrun-row px-3.5 py-2"
                  render={
                    <button
                      type="button"
                      onClick={() => props.onAddProvider(type)}
                    />
                  }
                >
                  <ItemMedia>
                    <ProviderLogo type={type} compact />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{display.name}</ItemTitle>
                    <ItemDescription>{display.description}</ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <ChevronRight size={16} aria-hidden="true" />
                  </ItemActions>
                </Item>
              </li>
            );
          })}
        </ul>
      </div>

      {/* Designer audit P2-15: the footer's primary 打开设置·模型 button
          duplicated what clicking any provider row above already does (the
          list header even says 点一个进入设置). One affordance per action —
          the footer keeps only genuinely distinct paths. */}
      <footer className="maka-onboarding-footer">
        <Button type="button" variant="secondary" onClick={props.onBrowseProviders}>
          {copy.needsConnection.browseProviders}
        </Button>
        {props.onRefreshConnections && (
          <Button
            type="button"
            variant="secondary"
            onClick={props.onRefreshConnections}
            disabled={props.refreshConnectionsPending === true}
            aria-busy={props.refreshConnectionsPending === true ? 'true' : undefined}
          >
            {props.refreshConnectionsPending === true ? copy.refresh.pending : copy.refresh.connection}
          </Button>
        )}
        {props.onSkip && <SkipButton onSkip={props.onSkip} />}
      </footer>
    </section>
  );
}

/**
 * Compact "where you are" stepper for the first-run hero: numbered nodes
 * joined by connectors, the active step lit with the brand accent and the
 * rest outlined. Stays one quiet line so the provider list keeps the lead.
 */
function FirstRunStepper({ steps }: { steps: readonly OnboardingSetupStep[] }) {
  const copy = getOnboardingCopy(useUiLocale());
  return (
    <ol className="maka-firstrun-stepper" aria-label={copy.setupProgressLabel}>
      {steps.map((step, index) => (
        <Fragment key={`${step.label}-${index}`}>
          {index > 0 && <li className="maka-firstrun-step-line" aria-hidden="true" />}
          <li className="maka-firstrun-step" data-state={step.state}>
            <span className="maka-firstrun-step-dot" aria-hidden="true">{index + 1}</span>
            <span className="maka-firstrun-step-label">{step.label}</span>
          </li>
        </Fragment>
      ))}
    </ol>
  );
}

function NeedsDefaultConnectionHero(props: {
  onOpenSettings: (section?: SettingsSection) => void;
  onRefreshConnections?: () => void;
  refreshConnectionsPending?: boolean;
  onSkip?: () => Promise<void> | void;
}) {
  const locale = useUiLocale();
  const copy = getOnboardingCopy(locale);
  const hero = getOnboardingHeroCopy({ kind: 'needs_default_connection' }, locale)!;
  return (
    <SetupHero
      icon={<SettingsIcon size={14} aria-hidden="true" />}
      eyebrow={hero.eyebrow}
      title={hero.title}
      body={hero.body}
      setupSteps={getOnboardingSetupSteps({ kind: 'needs_default_connection' }, locale)}
      primaryCta={{ label: hero.cta.label, onClick: () => props.onOpenSettings(hero.cta.settingsSection) }}
      secondaryCta={
        props.onRefreshConnections
          ? {
            label: props.refreshConnectionsPending === true ? copy.refresh.pending : copy.refresh.connection,
            onClick: props.onRefreshConnections,
            disabled: props.refreshConnectionsPending === true,
            busy: props.refreshConnectionsPending === true,
          }
          : undefined
      }
      onSkip={props.onSkip}
    />
  );
}

function NeedsConnectionCredentialsHero(props: {
  connectionSlug: string;
  connections?: ReadonlyArray<LlmConnection>;
  onOpenSettings: (section?: SettingsSection) => void;
  onRefreshConnections?: () => void;
  refreshConnectionsPending?: boolean;
  onSkip?: () => Promise<void> | void;
}) {
  const locale = useUiLocale();
  const copy = getOnboardingCopy(locale);
  const state = { kind: 'needs_connection_credentials', connectionSlug: props.connectionSlug } as const;
  const hero = getOnboardingHeroCopy(state, locale)!;
  const { name, isFallback } = connectionLabel(props.connectionSlug, props.connections);
  return (
    <SetupHero
      icon={<KeyRound size={14} aria-hidden="true" />}
      eyebrow={hero.eyebrow}
      title={hero.title}
      body={
        <>
          {hero.body} {copy.connectionLabel}:{' '}
          {isFallback ? (
            <code className="maka-onboarding-slug">{name}</code>
          ) : (
            <strong>{name}</strong>
          )}
        </>
      }
      setupSteps={getOnboardingSetupSteps(state, locale)}
      primaryCta={{ label: hero.cta.label, onClick: () => props.onOpenSettings(hero.cta.settingsSection) }}
      secondaryCta={
        props.onRefreshConnections
          ? {
            label: props.refreshConnectionsPending === true ? copy.refresh.pending : copy.refresh.credentials,
            onClick: props.onRefreshConnections,
            disabled: props.refreshConnectionsPending === true,
            busy: props.refreshConnectionsPending === true,
          }
          : undefined
      }
      onSkip={props.onSkip}
    />
  );
}

function NeedsDefaultModelHero(props: {
  connectionSlug: string;
  connections?: ReadonlyArray<LlmConnection>;
  onOpenSettings: (section?: SettingsSection) => void;
  onRefreshConnections?: () => void;
  refreshConnectionsPending?: boolean;
  onSkip?: () => Promise<void> | void;
}) {
  const locale = useUiLocale();
  const copy = getOnboardingCopy(locale);
  const state = { kind: 'needs_default_model', connectionSlug: props.connectionSlug } as const;
  const hero = getOnboardingHeroCopy(state, locale)!;
  const { name, isFallback } = connectionLabel(props.connectionSlug, props.connections);
  return (
    <SetupHero
      icon={<Cpu size={14} aria-hidden="true" />}
      eyebrow={hero.eyebrow}
      title={hero.title}
      body={
        <>
          {hero.body} {copy.connectionLabel}:{' '}
          {isFallback ? (
            <code className="maka-onboarding-slug">{name}</code>
          ) : (
            <strong>{name}</strong>
          )}
        </>
      }
      setupSteps={getOnboardingSetupSteps(state, locale)}
      primaryCta={{ label: hero.cta.label, onClick: () => props.onOpenSettings(hero.cta.settingsSection) }}
      secondaryCta={
        props.onRefreshConnections
          ? {
            label: props.refreshConnectionsPending === true ? copy.refresh.pending : copy.refresh.model,
            onClick: props.onRefreshConnections,
            disabled: props.refreshConnectionsPending === true,
            busy: props.refreshConnectionsPending === true,
          }
          : undefined
      }
      onSkip={props.onSkip}
    />
  );
}

function BlockedHero(props: {
  reason: 'all_connections_unhealthy';
  onOpenSettings: (section?: SettingsSection) => void;
  onRefreshConnections?: () => void;
  refreshConnectionsPending?: boolean;
  onSkip?: () => Promise<void> | void;
}) {
  // The reason is destructured to satisfy exhaustive type-checking;
  // when PR-future extends the enum, this branch must update too.
  void props.reason;
  const locale = useUiLocale();
  const copy = getOnboardingCopy(locale);
  const state = { kind: 'blocked', reason: props.reason } as const;
  const hero = getOnboardingHeroCopy(state, locale)!;
  return (
    <SetupHero
      icon={<AlertCircle size={14} aria-hidden="true" />}
      eyebrow={hero.eyebrow}
      title={hero.title}
      body={hero.body}
      setupSteps={getOnboardingSetupSteps(state, locale)}
      primaryCta={{ label: hero.cta.label, onClick: () => props.onOpenSettings(hero.cta.settingsSection) }}
      secondaryCta={
        props.onRefreshConnections
          ? {
            label: props.refreshConnectionsPending === true ? copy.refresh.pending : copy.refresh.blocked,
            onClick: props.onRefreshConnections,
            disabled: props.refreshConnectionsPending === true,
            busy: props.refreshConnectionsPending === true,
          }
          : undefined
      }
      onSkip={props.onSkip}
      // PR-UI-LAYOUT-25: 'destructive' (vs the previous 'warning') so
      // the user sees "all connections unhealthy" at full gravity —
      // distinct from "missing default model" or "needs reauth" which
      // are recoverable yellow states.
      tone="destructive"
    />
  );
}

function ReadyEmptyHero(props: {
  onQuickChatSubmit: (
    prompt: string,
    mode?: QuickChatMode,
    skillIds?: readonly string[],
  ) => boolean | Promise<boolean>;
  mentionSkills?: ReadonlyArray<{ ref?: string; id: string; name: string; description?: string }>;
  quickChatPending: boolean;
  onImportDroppedTextFiles?: (files: File[]) => Promise<string | undefined>;
}) {
  const [draft, setDraft] = useState('');
  const [draftMode, setDraftMode] = useState<QuickChatMode | undefined>();
  const [dragActive, setDragActive] = useState(false);
  const [submitPending, setSubmitPending] = useState(false);
  const [pendingImportAction, setPendingImportAction] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const readyHeroMountedRef = useMountedRef();
  const submitPendingRef = useRef(false);
  const compositionActiveRef = useRef(false);
  const skillDraft = useComposerSkillDraft('onboarding-quick-chat');
  const importActionOwnerRef = useRef<ChatInputActionOwner<string> | null>(null);
  if (!importActionOwnerRef.current) {
    importActionOwnerRef.current = createChatInputActionOwner((action) => {
      if (readyHeroMountedRef.current) setPendingImportAction(action);
    });
  }

  useEffect(() => {
    return () => {
      submitPendingRef.current = false;
      importActionOwnerRef.current?.reset();
    };
  }, []);

  const locale = useUiLocale();
  const onboardingCopy = getOnboardingCopy(locale);
  const composerCopy = getConversationCopy(locale).composer;
  const copy = onboardingCopy.ready;
  const suggestions = getFirstRunTaskSuggestions(locale);
  const quickChatBusy = props.quickChatPending || submitPending;
  const importStatusText = pendingImportAction === null
    ? null
    : pendingImportAction === 'folder'
      ? copy.importFolderPending
      : copy.importFilesPending;

  const saveQuickChatDraft = useCallback((value?: string) => {
    setDraft(value ?? inputRef.current?.value ?? '');
  }, []);
  const {
    mention,
    mentionItems,
    mentionActiveIndex,
    setMentionActiveIndex,
    mentionLoading,
    mentionListboxId,
    mentionPopupOpen,
    recomputeMention,
    closeMention,
    selectMention,
  } = useMentionPopup({
    textareaRef: inputRef,
    mentionSkills: props.mentionSkills,
    saveCurrentDraft: saveQuickChatDraft,
    autoResize: () => {},
    resetPromptHistoryNavigation: () => {},
    onSelectSkill: (skill) => skillDraft.add(skill),
  });

  const submit = useCallback(async () => {
    if (props.quickChatPending || submitPendingRef.current) return;
    submitPendingRef.current = true;
    setSubmitPending(true);
    // PR110b contract: empty prompt is OK — main creates the session
    // without sending. Caller (main.tsx) decides whether to focus the
    // composer afterward.
    try {
      const skillIds = skillDraft.skills.map((skill) => skill.ref ?? skill.id);
      const submitted = await props.onQuickChatSubmit(draft, draftMode, skillIds);
      if (!readyHeroMountedRef.current) return;
      if (!submitted) return;
      setDraft('');
      setDraftMode(undefined);
      skillDraft.clear(skillDraft.activeDraftKey());
    } finally {
      submitPendingRef.current = false;
      if (readyHeroMountedRef.current) setSubmitPending(false);
    }
  }, [draft, draftMode, props, skillDraft.skills]);

  const handleKey = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      // PR-FE-BUG-HUNT-0 (kenji bug-hunt 2026-06-24): mirror the main
      // Composer's IME composition guard. Without this, a Chinese /
      // Japanese / Korean user committing an IME composition with
      // Enter immediately fires `submit()` and sends the unfinished
      // draft. The same guard in packages/ui/src/composer.tsx already
      // covers the main chat input; the onboarding-hero clone
      // had drifted.
      if (isChatInputComposing(event, compositionActiveRef.current)) return;
      if (mentionPopupOpen) {
        const count = mentionItems.length;
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          if (count > 0) setMentionActiveIndex((index) => (index + 1) % count);
          return;
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          if (count > 0) setMentionActiveIndex((index) => (index - 1 + count) % count);
          return;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          if (count > 0) {
            event.preventDefault();
            selectMention(mentionActiveIndex);
            return;
          }
          if (event.key === 'Enter') event.preventDefault();
          closeMention();
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          closeMention();
          return;
        }
      }
      if (
        event.key === 'Backspace' &&
        event.currentTarget.selectionStart === 0 &&
        event.currentTarget.selectionEnd === 0 &&
        skillDraft.removeLast()
      ) {
        event.preventDefault();
        return;
      }
      // Enter (without modifier) → submit. Shift+Enter inserts newline.
      if (event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        submit();
      }
      // Esc while drag-active clears the stuck highlight. The useEffect
      // listens for blur/dragend/drop but not keydown, so a user who
      // hits Esc mid-drag would otherwise see the highlight linger.
      if (event.key === 'Escape' && dragActive) {
        setDragActive(false);
      }
    },
    [
      closeMention,
      dragActive,
      mentionActiveIndex,
      mentionItems.length,
      mentionPopupOpen,
      selectMention,
      setMentionActiveIndex,
      skillDraft,
      submit,
    ],
  );

  const prefillSuggestion = useCallback((prompt: string, mode?: QuickChatMode) => {
    if (quickChatBusy) return;
    const nextDraft = prompt;
    setDraft(nextDraft);
    setDraftMode(mode);
    window.requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      focusTextInputAtEnd(input);
    });
  }, [quickChatBusy]);

  const appendImportedPrompt = useCallback((prompt: string) => {
    if (!readyHeroMountedRef.current) return;
    let nextDraft = prompt;
    setDraft((current) => {
      nextDraft = appendPromptContextDraft(current, prompt);
      return nextDraft;
    });
    setDraftMode(undefined);
    window.requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      focusTextInputAtEnd(input);
    });
  }, []);

  const runImportAction = useCallback(async (
    actionKey: string,
    action: () => Promise<string | undefined>,
  ) => {
    if (quickChatBusy) return;
    const prompt = await importActionOwnerRef.current?.run(actionKey, async () => {
      const prompt = await action();
      return prompt;
    });
    if (prompt && readyHeroMountedRef.current) appendImportedPrompt(prompt);
  }, [appendImportedPrompt, quickChatBusy]);

  const importActionBusy = pendingImportAction !== null;

  const canAcceptDroppedTextFiles = useCallback(() => (
    Boolean(props.onImportDroppedTextFiles && !quickChatBusy && !importActionBusy)
  ), [importActionBusy, props.onImportDroppedTextFiles, quickChatBusy]);

  const hasDraggedFiles = useCallback((event: DragEvent<HTMLElement>) => (
    fileTransferContainsFiles(event.dataTransfer.types, event.dataTransfer.files.length)
  ), []);

  const hasPastedFiles = useCallback((event: ClipboardEvent<HTMLTextAreaElement>) => (
    fileTransferContainsFiles(event.clipboardData.types, event.clipboardData.files.length)
  ), []);

  const handleDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!canAcceptDroppedTextFiles() || !hasDraggedFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setDragActive(true);
  }, [canAcceptDroppedTextFiles, hasDraggedFiles]);

  const handleDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDragActive(false);
  }, []);

  const handleDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    setDragActive(false);
    if (!canAcceptDroppedTextFiles()) return;
    const files = Array.from(event.dataTransfer.files);
    if (files.length === 0) return;
    void runImportAction('drop', async () => props.onImportDroppedTextFiles?.(files));
  }, [canAcceptDroppedTextFiles, hasDraggedFiles, props.onImportDroppedTextFiles, runImportAction]);

  useEffect(() => {
    if (!dragActive) return;
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

  const handlePaste = useCallback((event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (isChatInputComposing(event, compositionActiveRef.current)) return;
    if (!hasPastedFiles(event)) return;
    if (!canAcceptDroppedTextFiles()) return;
    const files = Array.from(event.clipboardData.files);
    if (files.length === 0) return;
    event.preventDefault();
    void runImportAction('paste', async () => props.onImportDroppedTextFiles?.(files));
  }, [canAcceptDroppedTextFiles, hasPastedFiles, props.onImportDroppedTextFiles, runImportAction]);

  return (
    <section className="maka-onboarding maka-onboarding-ready" aria-label={copy.ariaLabel}>
      <header>
        <span className="maka-onboarding-eyebrow">
          <Sparkles size={12} aria-hidden="true" />
          <span>{copy.eyebrow}</span>
        </span>
        <h1>{copy.headline}</h1>
        <p>{copy.intro}</p>
      </header>

      <div
        className="maka-onboarding-quickchat"
        data-drag-active={dragActive ? 'true' : undefined}
        data-maka-file-drop-target={canAcceptDroppedTextFiles() ? 'true' : undefined}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {skillDraft.skills.length > 0 ? (
          <ul className="maka-composer-skill-chips" aria-label={composerCopy.selectedSkillsAriaLabel}>
            {skillDraft.skills.map((skill) => (
              <li className="maka-composer-skill-chip" key={skill.ref ?? skill.id}>
                <span>{skill.name}</span>
                <Button
                  type="button"
                  variant="quiet"
                  size="icon"
                  shape="pill"
                  className="maka-composer-skill-chip-remove"
                  aria-label={composerCopy.removeSkillAriaLabel(skill.name)}
                  onClick={() => {
                    skillDraft.remove(skill.ref ?? skill.id);
                    window.requestAnimationFrame(() => inputRef.current?.focus());
                  }}
                >
                  <X size={12} aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="maka-onboarding-quickchat-field">
          <Textarea
            ref={inputRef}
            unstyled
            className="maka-onboarding-quickchat-input"
            placeholder={copy.quickChatPlaceholder}
            rows={3}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              recomputeMention();
            }}
            onKeyDown={handleKey}
            onKeyUp={recomputeMention}
            onClick={recomputeMention}
            onPaste={handlePaste}
            onCompositionStart={() => { compositionActiveRef.current = true; }}
            onCompositionEnd={() => {
              compositionActiveRef.current = false;
              recomputeMention();
            }}
            disabled={quickChatBusy}
            aria-label={copy.quickChatAria}
            aria-controls={mentionPopupOpen ? mentionListboxId : undefined}
            aria-expanded={mentionPopupOpen ? true : undefined}
            aria-activedescendant={
              mentionPopupOpen && mentionItems.length > 0
                ? mentionOptionId(mentionListboxId, mentionActiveIndex)
                : undefined
            }
          />
          <small
            className="maka-onboarding-quickchat-example"
            data-pending={importStatusText ? 'true' : undefined}
            aria-hidden={importStatusText ? undefined : 'true'}
            aria-live={importStatusText ? 'polite' : undefined}
          >
            {importStatusText ?? copy.quickChatExample}
          </small>
        </div>
        {mention ? (
          <ComposerMentionPopup
            trigger={mention.trigger}
            items={mentionItems}
            activeIndex={mentionActiveIndex}
            loading={mentionLoading}
            listboxId={mentionListboxId}
            onSelect={selectMention}
            onHover={setMentionActiveIndex}
          />
        ) : null}
        {dragActive && (
          <span className="maka-visually-hidden" role="status" aria-live="polite">
            {copy.dropFiles}
          </span>
        )}
        {draftMode === 'deep_research' && (
          <span className="maka-onboarding-quickchat-mode">{copy.deepResearchMode}</span>
        )}
        <Button
          type="button"
          className="maka-onboarding-quickchat-submit"
          variant="default"
          size="icon"
          onClick={submit}
          disabled={quickChatBusy}
          aria-busy={quickChatBusy ? 'true' : undefined}
          aria-label={quickChatBusy ? copy.submitPendingLabel : copy.submitIdleLabel}
          title={quickChatBusy ? copy.submitPendingLabel : copy.submitIdleLabel}
        >
          <ArrowUp size={18} aria-hidden="true" />
        </Button>
      </div>

      {suggestions.length > 0 && (
        <div className="maka-first-run-task-suggestions" aria-label={copy.suggestionsLabel}>
          <div className="maka-first-run-task-suggestions-inner">
            <div className="maka-first-run-task-suggestions-header">
              <strong>{copy.suggestionsLabel}</strong>
            </div>
            <div className="maka-first-run-task-suggestion-list">
              {suggestions.map((suggestion) => (
                <div key={suggestion.id} className="maka-first-run-task-suggestion-chip">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => prefillSuggestion(suggestion.prompt, suggestion.mode)}
                    disabled={quickChatBusy}
                  >
                    {suggestion.label}
                  </Button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function SkipButton(props: { onSkip: () => Promise<void> | void; label?: string }) {
  const copy = getOnboardingCopy(useUiLocale());
  const [pending, setPending] = useState(false);
  const mountedRef = useMountedRef();
  const onClick = useCallback(async () => {
    if (pending) return;
    setPending(true);
    try {
      await props.onSkip();
    } finally {
      if (mountedRef.current) setPending(false);
    }
  }, [pending, props]);
  return (
    <Button
      type="button"
      variant="secondary"
      onClick={onClick}
      disabled={pending}
      aria-busy={pending ? 'true' : undefined}
    >
      {pending ? copy.skipping : (props.label ?? copy.skip)}
    </Button>
  );
}

interface SetupHeroProps {
  icon: React.ReactNode;
  eyebrow: string;
  title: string;
  body: React.ReactNode;
  setupSteps?: readonly OnboardingSetupStep[] | null;
  primaryCta: { label: string; onClick: () => void };
  /**
   * PR-ONBOARDING-EARLY-COPY-0: optional ghost-style secondary action
   * sitting next to the primary CTA. Used by the early-onboarding
   * branches to expose a "已经配好了？刷新检测" affordance so a user
   * with env-bootstrap connections is not stuck behind a stale
   * snapshot. Hidden when not provided so existing call sites are
   * unchanged.
   */
  secondaryCta?: { label: string; onClick: () => void; disabled?: boolean; busy?: boolean };
  /**
   * Optional skip affordance for the `needs_*` / `blocked` branches.
   * Renders as a ghost button after the secondary CTA. Lets the user
   * enter the app without configuring a provider.
   */
  onSkip?: () => Promise<void> | void;
  /**
   * PR-UI-LAYOUT-25 (@yuejing 2026-05-22): extended from `'warning'`
   * only to also accept `'destructive'` so a blocked-state hero
   * ("all_connections_unhealthy") reads with genuine gravity
   * instead of "yellow warning". CSS rules for
   * `.maka-onboarding-setup[data-tone="destructive"]` paint the
   * eyebrow + headline in destructive tone.
   */
  tone?: 'warning' | 'destructive';
}

function SetupHero(props: SetupHeroProps) {
  return (
    <section
      className="maka-onboarding maka-onboarding-setup"
      data-tone={props.tone}
      aria-label={props.eyebrow}
    >
      <header>
        <span className="maka-onboarding-eyebrow">
          {props.icon}
          <span>{props.eyebrow}</span>
        </span>
        <h1>{props.title}</h1>
        <p>{props.body}</p>
      </header>
      {props.setupSteps && <SetupProgress steps={props.setupSteps} />}
      <footer className="maka-onboarding-footer">
        <Button
          type="button"
          onClick={props.primaryCta.onClick}
        >
          {props.primaryCta.label}
        </Button>
        {props.secondaryCta && (
          <Button
            type="button"
            variant="secondary"
            onClick={props.secondaryCta.onClick}
            disabled={props.secondaryCta.disabled === true}
            aria-busy={props.secondaryCta.busy === true ? 'true' : undefined}
          >
            {props.secondaryCta.label}
          </Button>
        )}
        {props.onSkip && <SkipButton onSkip={props.onSkip} />}
      </footer>
    </section>
  );
}

function SetupProgress(props: { steps: readonly OnboardingSetupStep[] }) {
  const copy = getOnboardingCopy(useUiLocale());
  return (
    <ol className="maka-onboarding-setup-steps" aria-label={copy.setupProgressLabel}>
      {props.steps.map((step, index) => (
        <li key={`${step.label}-${index}`} data-state={step.state}>
          <span className="maka-onboarding-setup-step-marker" aria-hidden="true">
            {index + 1}
          </span>
          <span className="maka-onboarding-setup-step-copy">
            <strong>{step.label}</strong>
            <small>{step.detail}</small>
          </span>
          <span className="maka-onboarding-setup-step-state">
            {copy.setupStatus[step.state]}
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * Exhaustive switch helper. If `OnboardingState` ever grows a new
 * variant without a matching `case`, this call site fails to compile
 * — preventing a silent fallthrough that would render no hero or a
 * generic placeholder for the missing state.
 */
function assertNever(state: never): never {
  // The runtime fallback should never execute. We still log a
  // generalized error class (no raw `state.kind` leak) to surface the
  // gap in dev builds without breaking the chat surface.
  void state;
  throw new Error('OnboardingHero: unexhausted OnboardingState variant');
}
