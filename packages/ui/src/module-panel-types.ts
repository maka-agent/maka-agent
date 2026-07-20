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
  entryKey: string;
  id: string;
  name: string;
  description: string;
  displayPath: string;
  discoveryOrigin: 'project_maka' | 'project_agents' | 'workspace' | 'user_maka' | 'user_agents';
  effective: boolean;
  shadowedBy?: string;
  metadataStatus: 'valid' | 'warning' | 'invalid';
  operationalStatus: 'invalid' | 'shadowed' | 'state_error' | 'disabled' | 'host_incompatible' | 'eligible';
  issues: Array<{
    code: string;
    severity: 'warning' | 'error';
    message: string;
    field?: string;
  }>;
  requiredTools: string[];
  requiredCapabilities: string[];
  missingDeclaredTools: string[];
  missingRequiredTools: string[];
  missingRequiredCapabilities: string[];
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
  canUse: boolean;
  canOpen: boolean;
  canToggle: boolean;
  canDelete: boolean;
  canUpdate: boolean;
  repairTarget: 'skill_file' | 'state_file' | null;
}

export interface SkillInventorySnapshot {
  hostBasis: 'session' | 'desktop_default';
  entries: SkillEntry[];
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

/**
 * Stable category buckets shared by the built-in catalog and managed Skill
 * source metadata. Unknown categories normalize to 效率工具 upstream.
 */
export type ManagedSkillCategory =
  | '内容创作'
  | '数据与AI'
  | '设计与UI'
  | 'DevOps与部署'
  | '文档与写作'
  | '效率工具'
  | '研究与分析';

/**
 * One entry in the built-in (内置) skill catalog shipped with the app. Mirrors
 * listBundledSkillCatalog in apps/desktop's skills module. Nothing here is
 * auto-activated: the catalog action creates a Maka-workspace copy first.
 */
export interface BundledSkillCatalogEntry {
  id: string;
  name: string;
  description: string;
  category: ManagedSkillCategory;
  declaredTools: string[];
  requiredTools: string[];
  requiredCapabilities: string[];
  targetPath: string;
  activationState: 'available' | 'active' | 'attention';
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
 * `@maka/ui` independent of desktop preload globals — the renderer wires a
 * host-injected daily-review reader, and the UI layer stays reusable in fixtures,
 * visual smoke tests, and future surfaces
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
