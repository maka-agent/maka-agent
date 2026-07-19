import type { DailyReviewConfig, DailyReviewMode, LlmConnection, UiLocale } from '@maka/core';
import {
  buildDailyReviewRunModelOptions,
  DAILY_REVIEW_CONFIG_MODEL_VALUE,
} from './daily-review-actions';
import { getShellRemainingCopy } from './locales/shell-remaining-copy.js';

export function createAppShellDailyReviewBridge(connections: readonly LlmConnection[], locale: UiLocale = 'zh') {
  const copy = getShellRemainingCopy(locale).dailyReview;
  return {
    modelOptions: buildDailyReviewRunModelOptions(connections, locale),
    async fetchDay(offsetDays: number, daySpan?: number) {
      const result = await window.maka.dailyReview.day(offsetDays, daySpan);
      if (!result.ok) throw new Error(result.error.message);
      return result.data;
    },
    runOnce(input: { mode: DailyReviewMode; modelKey?: string }) {
      const runOnce = window.maka.dailyReview.runOnce;
      if (!runOnce) throw new Error(copy.unavailable);
      const modelKey = input.modelKey === DAILY_REVIEW_CONFIG_MODEL_VALUE ? undefined : input.modelKey;
      return runOnce({ ...input, modelKey });
    },
    listArchives() {
      const listArchives = window.maka.dailyReview.listArchives;
      if (!listArchives) throw new Error(copy.historyUnavailable);
      return listArchives();
    },
    async getArchive(archiveId: string) {
      const getArchive = window.maka.dailyReview.getArchive;
      if (!getArchive) throw new Error(copy.historyUnavailable);
      const archive = await getArchive(archiveId);
      if (!archive) throw new Error(copy.archiveMissing);
      return archive;
    },
    deleteArchive(archiveId: string) {
      const deleteArchive = window.maka.dailyReview.deleteArchive;
      if (!deleteArchive) throw new Error(copy.historyUnavailable);
      return deleteArchive(archiveId);
    },
    fetchConfig() {
      const getConfig = window.maka.dailyReview.getConfig;
      if (!getConfig) throw new Error(copy.settingsUnavailable);
      return getConfig();
    },
    updateConfig(patch: Partial<DailyReviewConfig>) {
      const setConfig = window.maka.dailyReview.setConfig;
      if (!setConfig) throw new Error(copy.settingsUnavailable);
      return setConfig(patch);
    },
  };
}
