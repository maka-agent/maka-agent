import { useState } from 'react';
import type { PlanReminder, UiLocale } from '@maka/core';
import type { BundledSkillCatalogEntry, ManagedSkillSourceEntry, SkillEntry } from '@maka/ui';
import { createAppShellPlanActions, type AppShellPlanActions } from './app-shell-plan-actions';
import { createAppShellSkillActions, type AppShellSkillActions } from './app-shell-skill-actions';

type ToastApi = {
  success(title: string, description?: string): void;
  error(title: string, description?: string): void;
  confirm(options: {
    title: string;
    description: string;
    confirmLabel: string;
    cancelLabel: string;
    destructive?: boolean;
  }): Promise<boolean>;
};

/**
 * Owns the two sidebar-module data clusters — installed/managed/bundled
 * skills and plan reminders — together with their refresh + mutation
 * helpers (createAppShellSkillActions / createAppShellPlanActions). The
 * surface-active predicates are injected so the mutation helpers only
 * surface error toasts while their module is the foreground view, exactly
 * as before. Pure move: every returned action keeps its prior identity
 * semantics (recreated each render alongside the shell) and the plan
 * getter reads the latest reminders on each call.
 */
export function useAppShellModuleData(options: {
  uiLocale: UiLocale;
  isSkillsSurfaceActive: () => boolean;
  isAutomationsSurfaceActive: () => boolean;
  toastApi: ToastApi;
}): AppShellPlanActions & AppShellSkillActions & {
  skills: SkillEntry[];
  managedSkillSources: ManagedSkillSourceEntry[];
  bundledSkillCatalog: BundledSkillCatalogEntry[];
  planReminders: PlanReminder[];
} {
  const { uiLocale, isSkillsSurfaceActive, isAutomationsSurfaceActive, toastApi } = options;
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [managedSkillSources, setManagedSkillSources] = useState<ManagedSkillSourceEntry[]>([]);
  const [bundledSkillCatalog, setBundledSkillCatalog] = useState<BundledSkillCatalogEntry[]>([]);
  const [planReminders, setPlanReminders] = useState<PlanReminder[]>([]);

  const planActions = createAppShellPlanActions({
    getPlanReminders: () => planReminders,
    isAutomationsSurfaceActive,
    setPlanReminders,
    toastApi,
  });

  const skillActions = createAppShellSkillActions({
    uiLocale,
    isSkillsSurfaceActive,
    setSkills,
    setManagedSkillSources,
    setBundledSkillCatalog,
    toastApi,
  });

  return {
    skills,
    managedSkillSources,
    bundledSkillCatalog,
    planReminders,
    ...planActions,
    ...skillActions,
  };
}
