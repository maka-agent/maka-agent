import type {
  DailyReviewArchive,
  DailyReviewArchiveSummary,
  DailyReviewConfig,
  DailyReviewMode,
  DailyReviewSummary,
  DailyReviewTopEntry,
  PlanReminderDeliveryTarget,
  PlanReminderRecurrence,
} from '@maka/core';
import type { SettingsSelectOption } from './primitives/settings-select.js';

export interface SkillEntry {
  id: string;
  name: string;
  description: string;
  path: string;
  /**
   * Tools the skill *declares* it would like to use. This is a request, not
   * a grant — PermissionEngine still applies. We surface the list so users
   * can see what a skill is asking for before they install / enable it.
   */
  declaredTools?: string[];
  sourceType?: 'workspace' | 'bundled' | 'managed' | 'unknown';
  userModified?: boolean;
  validationStatus?: 'ok' | 'missing_lock' | 'modified' | 'metadata_error';
  managedUpdateStatus?: 'not_managed' | 'source_missing' | 'up_to_date' | 'update_available' | 'local_modified' | 'metadata_error';
  enabled: boolean;
  runtimeStatus: 'enabled' | 'disabled' | 'state_error';
}

export type SkillGovernanceStatus = 'not_managed' | 'source_missing' | 'up_to_date' | 'update_available' | 'local_modified' | 'metadata_error';
export type SkillValidationStatus = 'ok' | 'missing_lock' | 'modified' | 'metadata_error';
export type SkillValidationCode =
  | 'missing_lock'
  | 'modified'
  | 'invalid_json'
  | 'id_mismatch'
  | 'unsupported_schema'
  | 'invalid_hash'
  | 'write_failed'
  | 'lock_symlink';

export interface SkillGovernanceDetails {
  id: string;
  name: string;
  description: string;
  path: string;
  declaredTools: string[];
  sourceType: 'workspace' | 'bundled' | 'managed' | 'unknown';
  userModified: boolean;
  validationStatus: SkillValidationStatus;
  enabled: boolean;
  runtimeStatus: 'enabled' | 'disabled' | 'state_error';
  validationCodes: SkillValidationCode[];
  validationMessages: string[];
  managedSourceId?: string;
  managedUpdateStatus?: SkillGovernanceStatus;
  hasManagedBaseline: boolean;
  sourceAvailable?: boolean;
  sourceChanged?: boolean;
}

export interface ManagedSkillUpdatePreview {
  skill: SkillGovernanceDetails;
  currentContent: string;
  sourceContent: string;
  baselineContent?: string;
  expectedCurrentSha256: string;
  expectedSourceSha256: string;
  summary: {
    currentLineCount: number;
    sourceLineCount: number;
    changedLineCount: number;
  };
}

export interface ManagedSkillSourceEntry {
  id: string;
  name: string;
  description: string;
  sourceType: 'local';
}

export type PlanReminderDraftInput = {
  title: string;
  note?: string;
  runAt: number;
  recurrence?: PlanReminderRecurrence;
  cronExpression?: string;
  delivery?: PlanReminderDeliveryTarget;
};

export type PlanReminderUpdatePatch = {
  title?: string;
  note?: string;
  runAt?: number;
  recurrence?: PlanReminderRecurrence;
  cronExpression?: string;
  delivery?: PlanReminderDeliveryTarget;
  enabled?: boolean;
};

/**
 * PR-DAILY-REVIEW-MVP-0: bridge handed in by `main.tsx`. Keeps
 * `@maka/ui` out of `window.maka` — the renderer wires
 * `(offsetDays) => window.maka.dailyReview.day(offsetDays)` and the
 * UI layer is reusable in fixtures / visual smoke / future surfaces
 * (e.g. a desktop notification renderer).
 */
export interface DailyReviewBridge {
  fetchDay(offsetDays: number, daySpan?: number): Promise<DailyReviewSummary>;
  /**
   * PR-DAILY-REVIEW-FULL-0 — optional pipeline methods. Renderer checks
   * for presence before exposing the matching UI. When undefined, the
   * panel still works as the MVP telemetry view.
   */
  runOnce?(opts: { mode: DailyReviewMode; modelKey?: string }): Promise<{ archiveId: string }>;
  modelOptions?: ReadonlyArray<SettingsSelectOption<string>>;
  listArchives?(): Promise<DailyReviewArchiveSummary[]>;
  getArchive?(archiveId: string): Promise<DailyReviewArchive>;
  deleteArchive?(archiveId: string): Promise<void>;
  fetchConfig?(): Promise<DailyReviewConfig>;
  updateConfig?(patch: Partial<DailyReviewConfig>): Promise<DailyReviewConfig>;
}

/**
 * Local-only daily summary view. Renders today by default; the
 * left/right arrows step through `offsetDays`. No LLM call — the
 * bullet list of sessions / top tools / top models is the whole
 * value-prop. Future PR can layer a generated narrative on top.
 *
 * borrow: external "today" digest concept (read-only summary).
 * diverge: no cron, no auto-push, no memory promotion (privacy default).
 */
export type DailyReviewMarkdownActionInput = {
  markdown: string;
  label: string;
  summary: DailyReviewSummary;
};
