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
import { generalizedErrorMessageChinese, type AppSettings, type PlanReminder, type SettingsSection } from '@maka/core';
import { Alert, AlertAction, AlertDescription, Button, useToast } from '@maka/ui';

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
  const checklistMountedRef = useRef(true);
  const failureToastShownRef = useRef(false);
  const statusRefreshPendingRef = useRef(false);
  const toast = useToast();

  useEffect(() => {
    checklistMountedRef.current = true;
    return () => {
      checklistMountedRef.current = false;
      statusRefreshPendingRef.current = false;
    };
  }, []);

  const isChecklistUnmounted = useCallback(() => !checklistMountedRef.current, []);

  const surfaceProbeFailure = useCallback((error: unknown) => {
    const message = firstRunChecklistErrorMessage(error);
    setStatusError(message);
    if (!failureToastShownRef.current) {
      failureToastShownRef.current = true;
      toast.error('刷新首次使用清单失败', message);
    }
  }, [toast]);

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
    return [
      {
        id: 'personalization',
        Icon: User,
        title: '告诉我们怎么称呼你',
        reason: '消息行就不会再把你显示成默认的「你」。',
        done: personalization.displayName.trim().length > 0,
        onClick: () => props.onOpenSettingsSection('appearance'),
      },
      {
        id: 'web-search',
        Icon: Search,
        title: '开通 Tavily 联网搜索',
        reason: '让你能直接在 Maka 里发一条搜索查询，看到真实结果。',
        done: tavilyConfigured,
        onClick: () => props.onOpenSettingsSection('search'),
      },
      {
        id: 'plan-reminder',
        Icon: Clock,
        title: '建一条本地计划提醒',
        reason: planStatusKnown
          ? '能本地保存一条到点提醒，全程留在本机，不需要外部服务。'
          : '计划提醒状态暂时没刷新成功，打开计划页可查看。',
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
        title: '看看每日回顾',
        reason: '聚合今天的对话、token 使用、Top 模型与工具。',
        // No persistence — visiting the panel doesn't strictly "complete"
        // anything. Render it as exploration, not a permanent unchecked todo.
        done: false,
        trackCompletion: false,
        onClick: () => props.onOpenSidebarModule('daily-review'),
      },
      {
        id: 'workspace-instructions',
        Icon: FileText,
        title: '创建项目指令文件',
        reason: workspaceInstructionStatusKnown
          ? '把这个工作区的约定写进 AGENTS.md / CLAUDE.md / GEMINI.md，之后可随时关闭。'
          : '项目指令状态暂时没刷新成功，打开记忆设置可查看。',
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
        title: '写一条本地记忆',
        reason: '透明的 MEMORY.md，agent 默认看不到；想让它记住偏好就在设置里再开一个开关。',
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
        title: '跑一次语音录音自检',
        reason: '请求麦克风权限、录 2 秒本地样本，确认采集链路通；不上传、不保存、不写记忆。',
        done: false,
        trackCompletion: false,
        onClick: () => props.onOpenSettingsSection('voice'),
      },
    ];
  }, [settings, planReminders, workspaceInstructionCount, props]);

  if (!settings && settingsLoadFailed) {
    return (
      <aside
        className="maka-first-run-checklist"
        role="alert"
        aria-label="接下来可以探索暂时不可用"
        aria-busy={statusRefreshPending ? 'true' : undefined}
      >
        <Alert variant="warning" className="maka-first-run-checklist-error">
          <AlertDescription>
            首次使用清单暂时没刷新成功。{statusError ?? '请稍后重试。'}
          </AlertDescription>
          <AlertAction>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="maka-first-run-checklist-error-action"
              onClick={() => void refreshChecklistStatus()}
              disabled={statusRefreshPending}
              aria-busy={statusRefreshPending ? 'true' : undefined}
            >
              <RefreshCcw size={12} aria-hidden="true" />
              <span>{statusRefreshPending ? '刷新中…' : '重试'}</span>
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
      aria-label={`接下来可以探索（待完成 ${remaining} 项）`}
    >
      <header className="maka-first-run-checklist-header">
        <Sparkles size={16} aria-hidden="true" />
        <strong>接下来可以探索</strong>
        <span className="maka-first-run-checklist-count">{remaining} / {completableItems.length} 待完成</span>
      </header>
      {statusError && (
        <Alert variant="warning" className="maka-first-run-checklist-error">
          <AlertDescription>
            部分状态暂时没刷新成功，已避免把未知状态计成未完成。{statusError}
          </AlertDescription>
          <AlertAction>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="maka-first-run-checklist-error-action"
              onClick={() => void refreshChecklistStatus()}
              disabled={statusRefreshPending}
              aria-busy={statusRefreshPending ? 'true' : undefined}
            >
              <RefreshCcw size={12} aria-hidden="true" />
              <span>{statusRefreshPending ? '刷新中…' : '重试'}</span>
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
            <Button type="button" variant="ghost" onClick={item.onClick} disabled={false}>
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
            </Button>
          </li>
        ))}
      </ul>
    </aside>
  );
}

function firstRunChecklistErrorMessage(error: unknown): string {
  return generalizedErrorMessageChinese(error, '状态服务暂时不可用，请稍后重试。');
}
