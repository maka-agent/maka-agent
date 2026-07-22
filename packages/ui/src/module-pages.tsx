import { lazy, Suspense } from 'react';
import type { PlanReminder } from '@maka/core';
import { deriveCapabilityAuditReport } from '@maka/core';
import { CalendarDays } from './icons.js';
import { EmptyState } from './empty-state.js';
import { useUiLocale } from './locale-context.js';
import { getSharedUiCopy } from './shared-ui-copy.js';
import type {
  BundledSkillCatalogEntry,
  DailyReviewBridge,
  DailyReviewMarkdownActionInput,
  ManagedSkillSourceEntry,
  ManagedSkillUpdatePreview,
  PlanReminderDraftInput,
  PlanReminderUpdatePatch,
  SkillEntry,
} from './module-panel-types.js';

const SkillsModuleMain = lazy(() => import('./skills-panel.js').then((module) => ({ default: module.SkillsModuleMain })));
const DailyReviewPanel = lazy(() => import('./daily-review-panel.js').then((module) => ({ default: module.DailyReviewPanel })));
const PlanReminderPanel = lazy(() => import('./plan-reminder-panel.js').then((module) => ({ default: module.PlanReminderPanel })));

function ModulePageFallback(props: { label: string; message: string }) {
  return (
    <main className="maka-main detailPane maka-module-main agents-chat-panel" aria-label={props.label}>
      <div className="maka-lazy-fallback" data-surface="module" role="status" aria-busy="true">
        {props.message}
      </div>
    </main>
  );
}

function ModulePanelFallback(props: { message: string }) {
  return (
    <div className="maka-lazy-fallback" data-surface="module" role="status" aria-busy="true">
      {props.message}
    </div>
  );
}

export function SkillsPage(props: {
  skills?: SkillEntry[];
  planReminders?: PlanReminder[];
  onRefreshSkills?(): void | Promise<void>;
  onCreateSkillTemplate?(): void | Promise<void>;
  onOpenSkill?(skillId: string): void | Promise<void>;
  onUseSkill?(skillId: string, skillName: string): void;
  onOpenSkillsFolder?(): void | Promise<void>;
  managedSkillSources?: ManagedSkillSourceEntry[];
  onRefreshManagedSkillSources?(): void | Promise<void>;
  onImportManagedSkillSource?(): void | Promise<void>;
  onInstallManagedSkill?(sourceId: string): void | Promise<void>;
  bundledSkillCatalog?: BundledSkillCatalogEntry[];
  onRefreshBundledSkillCatalog?(): void | Promise<void>;
  onInstallBundledSkill?(id: string): void | Promise<void>;
  onPreviewManagedSkillUpdate?(skillId: string): Promise<ManagedSkillUpdatePreview | null>;
  onUpdateManagedSkill?(skillId: string, options?: { force?: boolean; expectedCurrentSha256?: string; expectedSourceSha256?: string }): boolean | Promise<boolean>;
  onSetSkillEnabled?(skillId: string, enabled: boolean): void | Promise<void>;
  onSetSkillPinned?(skillRef: string, pinned: boolean): void | Promise<void>;
  onDeleteSkill?(skillId: string): void | Promise<void>;
}) {
  const copy = getSharedUiCopy(useUiLocale()).modules;
  const auditReport = deriveCapabilityAuditReport({
    skills: props.skills ?? [],
    planReminders: props.planReminders ?? [],
  });
  return (
    <Suspense fallback={<ModulePageFallback label={copy.skills} message={copy.loadingSkills} />}>
      <SkillsModuleMain {...props} auditReport={auditReport} />
    </Suspense>
  );
}

export function AutomationsPage(props: {
  skills?: SkillEntry[];
  reminders?: PlanReminder[];
  keepSystemAwake?: boolean;
  onKeepSystemAwakeChange?: (next: boolean) => Promise<void>;
  onRefresh?: () => void | Promise<void>;
  onCreate?(input: PlanReminderDraftInput): boolean | Promise<boolean> | void | Promise<void>;
  onUpdate?(id: string, patch: PlanReminderUpdatePatch): boolean | Promise<boolean> | void | Promise<void>;
  onToggle?: (id: string, enabled: boolean) => void | Promise<void>;
  onTriggerNow?: (id: string) => void | Promise<void>;
  onSnooze?: (id: string) => void | Promise<void>;
  onClearRunHistory?: (id: string) => void | Promise<void>;
  onDelete?: (id: string) => void | Promise<void>;
}) {
  const copy = getSharedUiCopy(useUiLocale()).modules;
  const auditReport = deriveCapabilityAuditReport({
    skills: props.skills ?? [],
    planReminders: props.reminders ?? [],
  });
  return (
    <Suspense fallback={<ModulePageFallback label={copy.automations} message={copy.loadingAutomations} />}>
      <main className="maka-main detailPane maka-module-main agents-chat-panel" aria-label={copy.automations}>
        <PlanReminderPanel {...props} reminders={props.reminders ?? []} auditReport={auditReport} />
      </main>
    </Suspense>
  );
}

export function DailyReviewPage(props: {
  bridge?: DailyReviewBridge;
  onSelectSession?: (sessionId: string) => void;
  onCopyMarkdown?: (input: DailyReviewMarkdownActionInput) => Promise<void> | void;
  onAppendMarkdown?: (input: DailyReviewMarkdownActionInput) => Promise<void> | void;
  onSaveMarkdown?: (input: DailyReviewMarkdownActionInput) => Promise<void> | void;
}) {
  const copy = getSharedUiCopy(useUiLocale()).modules;
  return (
    <main className="maka-main detailPane maka-module-main agents-chat-panel" data-module="daily-review" aria-label={copy.dailyReview}>
      {props.bridge ? (
        // The PageHeader (title + subtitle + the 生成 actions) now lives INSIDE
        // the panel so the generation buttons can ride the header's actions slot
        // with the panel's run state. The bridge-less fallback keeps its own
        // static header below.
        <Suspense fallback={<ModulePanelFallback message={copy.loadingDailyReview} />}>
          <DailyReviewPanel {...props} bridge={props.bridge} />
        </Suspense>
      ) : (
        <>
          <header className="maka-module-main-header">
            <div>
              <h2>{copy.dailyReview}</h2>
              <p>{copy.dailyReviewDescription}</p>
            </div>
          </header>
          <EmptyState Icon={CalendarDays} title={copy.dailyReviewDisconnectedTitle} body={copy.dailyReviewDisconnectedBody} />
        </>
      )}
    </main>
  );
}
