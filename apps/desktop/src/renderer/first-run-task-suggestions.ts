/**
 * Concrete first-run task prompts inspired by an external reference
 * desktop-agent's home suggestion rows.
 *
 * borrow
 * - Show short, task-shaped rows near the first composer.
 * - Clicking a row pre-fills a fuller prompt so users see what a
 *   good desktop-work request looks like before they send it.
 *
 * diverge
 * - Dismissal is explicit and reversible via the onboarding milestone
 *   store. Only the suggestion id is persisted; prompt text is never
 *   stored in settings.
 * - Prompts are conservative: they ask the agent to inspect and propose
 *   before mutating files.
 */

import type { OnboardingMilestoneId, QuickChatMode, UiLocale } from '@maka/core';
import { getOnboardingCopy } from './locales/onboarding-copy.js';

export type FirstRunTaskSuggestionId =
  | 'workspace-map'
  | 'deep-research'
  | 'file-organize'
  | 'web-research';

export interface FirstRunTaskSuggestion {
  id: FirstRunTaskSuggestionId;
  label: string;
  prompt: string;
  mode?: QuickChatMode;
}

const FIRST_RUN_TASK_SUGGESTION_IDS: readonly FirstRunTaskSuggestionId[] = [
  'workspace-map',
  'deep-research',
  'file-organize',
  'web-research',
];

export function getFirstRunTaskSuggestions(locale: UiLocale): readonly FirstRunTaskSuggestion[] {
  const copy = getOnboardingCopy(locale).suggestions;
  return FIRST_RUN_TASK_SUGGESTION_IDS.map((id) => ({ id, ...copy[id] }));
}

export const FIRST_RUN_TASK_SUGGESTION_MILESTONES: Record<
  FirstRunTaskSuggestionId,
  OnboardingMilestoneId
> = {
  'workspace-map': 'first_run_suggestion_workspace_map',
  'deep-research': 'first_run_suggestion_deep_research',
  'file-organize': 'first_run_suggestion_file_organize',
  'web-research': 'first_run_suggestion_web_research',
};
