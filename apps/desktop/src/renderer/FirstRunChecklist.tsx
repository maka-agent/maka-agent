/**
 * PR-FIRST-RUN-CHECKLIST-0 — small "what's next" checklist rendered
 * below the OnboardingHero when the user has finished provider
 * setup but has no sessions yet. Each item reads its live status
 * from real settings + reminders and links to the exact surface
 * that flips the bit; nothing is a marketing description.
 *
 * borrow
 * - Reference onboarding checklist concept: "explorable next steps"
 *   surfaced once the bare minimum is in place. We borrow the shape,
 *   NOT the OS-permission steps; this list is all software-side and
 *   reversible.
 *
 * diverge
 * - No new persisted state. The checklist naturally goes away once
 *   `sessions.length > 0` (OnboardingHero `ready_empty` exits).
 * - Each row has an explicit jump target — no marketing descriptions.
 * - Items the user has already completed render as muted "已完成"
 *   rows; they don't autofold so the user understands their state.
 *
 * risk
 * - Pure UI. No new IPC, no settings writes.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, BookOpen, CalendarDays, Check, Clock, FileText, Mic, RefreshCcw, Search, Sparkles, User } from '@maka/ui/icons';
import { generalizedErrorMessage, generalizedErrorMessageChinese, type AppSettings, type PlanReminder, type SettingsSection, type UiLocale } from '@maka/core';
import { Alert, AlertAction, AlertDescription, Button, useMountedRef, useToast, useUiLocale } from '@maka/ui';
import { Button as BaseButton } from '@base-ui/react/button';
import { getOnboardingCopy } from './locales/onboarding-copy';

interface ChecklistItem {
  id: string;
  Icon: typeof Sparkles;
  title: string;
  /** What the user gains if they do this. One short sentence. */
  reason: string;
  done: boolean;
  trackCompletion?: boolean;
  onClick(): void;
}

export interface FirstRunChecklistProps {
  onOpenSettingsSection(section: SettingsSection): void;
  onOpenSidebarModule(target: 'daily-review' | 'automations'): void;
  onStartPlanReminder?(): void;
}

export function FirstRunChecklist(props: FirstRunChecklistProps) {
  const locale = useUiLocale();
  const copy = getOnboardingCopy(locale).checklist;
  // Self-fetched so the host (main.tsx OnboardingHero wrapper) does
  // not have to thread AppSettings + planReminders down. Refreshed
  // whenever the panel remounts (which happens whenever sessions
  // drops back to 0).
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [settingsLoadFailed, setSettingsLoadFailed] = useState(false);
  const [planReminders, setPlanReminders] = useState<ReadonlyArray<PlanReminder> | null>(null);
  const [workspaceInstructionCount, setWorkspaceInstructionCount] = useState<number | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [statusRefreshPending, setStatusRefreshPending] = useState(false);
  const checklistMountedRef = useMountedRef();
  const failureToastShownRef = useRef(false);
  const statusRefreshPendingRef = useRef(false);
  const toast = useToast();

  useEffect(() => {
    return () => {
      statusRefreshPendingRef.current = false;
    };
  }, []);

  const isChecklistUnmounted = useCallback(() => !checklistMountedRef.current, []);

  const surfaceProbeFailure = useCallback((error: unknown) => {
    const message = firstRunChecklistErrorMessage(error, locale);
    setStatusError(message);
    if (!failureToastShownRef.current) {
      failureToastShownRef.current = true;
      toast.error(copy.refreshFailedTitle, message);
    }
  }, [copy.refreshFailedTitle, locale, toast]);

  const refreshChecklistStatus = useCallback(async (isCancelled: () => boolean = isChecklistUnmounted) => {
    if (statusRefreshPendingRef.current) return;
    statusRefreshPendingRef.current = true;
    setStatusRefreshPending(true);
    failureToastShownRef.current = false;
    let hadFailure = false;
    const handleProbeFailure = (error: unknown) => {
      hadFailure = true;
      surfaceProbeFailure(error);
    };
    try {
      await Promise.all([
        window.maka.settings.get().then((next) => {
          if (!isCancelled()) {
            setSettings(next);
            setSettingsLoadFailed(false);
          }
        }).catch((error) => {
          if (!isCancelled()) {
            setSettingsLoadFailed(true);
            handleProbeFailure(error);
          }
        }),
        window.maka.plans.list().then((list) => {
          if (!isCancelled()) setPlanReminders(list);
        }).catch((error) => {
          if (!isCancelled()) {
            setPlanReminders(null);
            handleProbeFailure(error);
          }
        }),
        window.maka.workspaceInstructions.getState().then((state) => {
          if (!isCancelled()) setWorkspaceInstructionCount(state.detectedCount);
        }).catch((error) => {
          if (!isCancelled()) {
            setWorkspaceInstructionCount(null);
            handleProbeFailure(error);
          }
        }),
      ]);
      if (!isCancelled() && !hadFailure) setStatusError(null);
    } finally {
      statusRefreshPendingRef.current = false;
      if (!isCancelled()) setStatusRefreshPending(false);
    }
  }, [isChecklistUnmounted, surfaceProbeFailure]);

  useEffect(() => {
    let cancelled = false;
    void refreshChecklistStatus(() => cancelled || !checklistMountedRef.current);
    return () => {
      cancelled = true;
    };
  }, [refreshChecklistStatus]);

  const items = useMemo<ReadonlyArray<ChecklistItem>>(() => {
    if (!settings) return [];
    const personalization = settings.personalization;
    const webSearch = settings.webSearch;
    const tavilyConfigured =
      webSearch.enabled && webSearch.providers.tavily.apiKey.length > 0;
    const planStatusKnown = planReminders !== null;
    const workspaceInstructionStatusKnown = workspaceInstructionCount !== null;
    const hasPlanReminder = planStatusKnown && planReminders.length > 0;
    const itemCopy = copy.items;
    return [
      {
        id: 'personalization',
        Icon: User,
        title: itemCopy.personalization.title,
        reason: itemCopy.personalization.reason,
        done: personalization.displayName.trim().length > 0,
        onClick: () => props.onOpenSettingsSection('appearance'),
      },
      {
        id: 'web-search',
        Icon: Search,
        title: itemCopy['web-search'].title,
        reason: itemCopy['web-search'].reason,
        done: tavilyConfigured,
        onClick: () => props.onOpenSettingsSection('search'),
      },
      {
        id: 'plan-reminder',
        Icon: Clock,
        title: itemCopy['plan-reminder'].title,
        reason: planStatusKnown
          ? itemCopy['plan-reminder'].reason
          : itemCopy['plan-reminder'].unknownReason!,
        done: hasPlanReminder,
        trackCompletion: planStatusKnown,
        // `onStartPlanReminder` returns void, so `?.() ?? fallback()` would
        // ALWAYS also fire the fallback — explicit branch instead.
        onClick: () => {
          if (props.onStartPlanReminder) props.onStartPlanReminder();
          else props.onOpenSidebarModule('automations');
        },
      },
      {
        id: 'daily-review',
        Icon: CalendarDays,
        title: itemCopy['daily-review'].title,
        reason: itemCopy['daily-review'].reason,
        // No persistence — visiting the panel doesn't strictly "complete"
        // anything. Render it as exploration, not a permanent unchecked todo.
        done: false,
        trackCompletion: false,
        onClick: () => props.onOpenSidebarModule('daily-review'),
      },
      {
        id: 'workspace-instructions',
        Icon: FileText,
        title: itemCopy['workspace-instructions'].title,
        reason: workspaceInstructionStatusKnown
          ? itemCopy['workspace-instructions'].reason
          : itemCopy['workspace-instructions'].unknownReason!,
        done: workspaceInstructionStatusKnown && workspaceInstructionCount > 0,
        trackCompletion: workspaceInstructionStatusKnown,
        onClick: () => props.onOpenSettingsSection('memory'),
      },
      {
        // xuan c06e13f transparent MEMORY.md MVP + my
        // PR-MEMORY-PROMPT-INJECT-0 wiring. "done" only flips when
        // BOTH switches are on (file enabled AND agent-read), since
        // a user who never enabled agent-read has not actually
        // wired memory into the agent loop yet.
        id: 'local-memory',
        Icon: BookOpen,
        title: itemCopy['local-memory'].title,
        reason: itemCopy['local-memory'].reason,
        done:
          settings.localMemory.enabled
          && settings.localMemory.agentReadEnabled,
        onClick: () => props.onOpenSettingsSection('memory'),
      },
      {
        // xuan d91422d PR-VOICE-CAPTURE-SMOKE-0: Settings → 语音模型
        // now runs a 2-second local-only mic self-check that proves
        // duration / bytes / sampleRate / channels meet the
        // `@maka/core/voice` contract. Done flag is intentionally
        // false — no persistence yet, so don't count it as an unfinished
        // checklist item.
        id: 'voice-smoke',
        Icon: Mic,
        title: itemCopy['voice-smoke'].title,
        reason: itemCopy['voice-smoke'].reason,
        done: false,
        trackCompletion: false,
        onClick: () => props.onOpenSettingsSection('voice'),
      },
    ];
  }, [copy.items, settings, planReminders, workspaceInstructionCount, props]);

  if (!settings && settingsLoadFailed) {
    return (
      <aside
        className="maka-first-run-checklist"
        role="alert"
        aria-label={copy.unavailableLabel}
        aria-busy={statusRefreshPending ? 'true' : undefined}
      >
        <Alert variant="warning" className="maka-first-run-checklist-error">
          <AlertDescription>
            {copy.unavailableBody} {statusError ?? copy.errorFallback}
          </AlertDescription>
          <AlertAction>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => void refreshChecklistStatus()}
              disabled={statusRefreshPending}
              aria-busy={statusRefreshPending ? 'true' : undefined}
            >
              <RefreshCcw size={12} aria-hidden="true" />
              <span>{statusRefreshPending ? copy.refreshing : copy.retry}</span>
            </Button>
          </AlertAction>
        </Alert>
      </aside>
    );
  }

  if (!settings || items.length === 0) return null;

  const completableItems = items.filter((item) => item.trackCompletion !== false);
  const remaining = completableItems.filter((item) => !item.done).length;

  return (
    <aside
      className="maka-first-run-checklist"
      aria-label={copy.remainingAria(remaining)}
    >
      <header className="maka-first-run-checklist-header">
        <Sparkles size={16} aria-hidden="true" />
        <strong>{copy.title}</strong>
        <span className="maka-first-run-checklist-count">{copy.remainingCount(remaining, completableItems.length)}</span>
      </header>
      {statusError && (
        <Alert variant="warning" className="maka-first-run-checklist-error">
          <AlertDescription>
            {copy.partialFailureBody} {statusError}
          </AlertDescription>
          <AlertAction>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => void refreshChecklistStatus()}
              disabled={statusRefreshPending}
              aria-busy={statusRefreshPending ? 'true' : undefined}
            >
              <RefreshCcw size={12} aria-hidden="true" />
              <span>{statusRefreshPending ? copy.refreshing : copy.retry}</span>
            </Button>
          </AlertAction>
        </Alert>
      )}
      <ul className="maka-first-run-checklist-list">
        {items.map((item) => (
          <li
            key={item.id}
            className="maka-first-run-checklist-row"
            data-done={item.done ? 'true' : undefined}
            data-kind={item.trackCompletion === false ? 'explore' : 'setup'}
          >
            <BaseButton type="button" onClick={item.onClick} disabled={false}>
              <span className="maka-first-run-checklist-status" aria-hidden="true">
                {item.done ? (
                  <Check size={14} />
                ) : (
                  <item.Icon size={14} />
                )}
              </span>
              <span className="maka-first-run-checklist-copy">
                <strong>{item.title}</strong>
                <small>{item.reason}</small>
              </span>
              <ArrowRight
                size={14}
                aria-hidden="true"
                className="maka-first-run-checklist-arrow"
              />
            </BaseButton>
          </li>
        ))}
      </ul>
    </aside>
  );
}

function firstRunChecklistErrorMessage(error: unknown, locale: UiLocale): string {
  const fallback = getOnboardingCopy(locale).checklist.errorFallback;
  return locale === 'zh' ? generalizedErrorMessageChinese(error, fallback) : generalizedErrorMessage(error, fallback);
}
