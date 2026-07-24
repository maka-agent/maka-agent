/**
 * Re-export barrel for all skill sub-modules.
 *
 * The original `skills.ts` was split along discovery/metadata/context/state
 * seams in #1408. This file re-exports every symbol so existing callers that
 * import from `'./skills.js'` (internal modules, tests, desktop) continue
 * to work without changes. New code should import from the specific
 * sub-module instead.
 *
 * @see skills-discovery.js   – path resolution, directory scanning, dedup
 * @see skills-metadata.js    – front-matter parsing, validation
 * @see skills-context.js     – gating, prompt rendering, search, instruction loading
 * @see skills-state.js       – per-workspace enablement state read/write
 * @see skills-agent-tools.js – Skill / SkillSearch tool builders
 */

// ── From path-containment (contained I/O moved in #1408) ──────────────────
export {
  readContainedRegularFile,
  readContainedRegularTextFile,
  writeContainedRegularTextFile,
  isRecord,
} from './path-containment.js';

// ── From skills-metadata ──────────────────────────────────────────────────
export {
  validateSkillMetadata,
  parseSkillFrontMatter,
  cleanPromptText,
  truncateCodepoints,
  MAX_SKILL_BODY_CHARS,
  MAX_SKILL_TOOL_BODY_CHARS,
} from './skills-metadata.js';
export type {
  SkillManifest,
  SkillValidationSeverity,
  SkillValidationCode,
  SkillValidationIssue,
  SkillMetadataValidationResult,
} from './skills-metadata.js';

// ── From skills-state ──────────────────────────────────────────────────────
export {
  readSkillRuntimeState,
  writeSkillRuntimeState,
  writeSkillRuntimePreferences,
} from './skills-state.js';
export type {
  SkillRuntimeStatus,
  SkillRuntimePreference,
  SkillRuntimeStateReadResult,
} from './skills-state.js';

// ── From skills-discovery ──────────────────────────────────────────────────
export {
  resolveSkillDiscoveryPaths,
  scanSkills,
  scanSkillsWithDiagnostics,
  scanWorkspaceSkills,
  scanWorkspaceSkillsWithDiagnostics,
} from './skills-discovery.js';
export type {
  SkillScope,
  SkillDiscoverySource,
  SkillDiscoveryEntry,
  SkillSource,
  SkillSourceResolver,
  RuntimeSkillDefinition,
  ScannedSkill,
  SkillScanDiagnostic,
  SkillScanResult,
  SkillDiscoveryDiagnostic,
  RejectedSkillDefinition,
} from './skills-discovery.js';

// ── From skills-context ────────────────────────────────────────────────────
export {
  gateSkillsByHostCapabilities,
  resolveSkillsPromptCharBudget,
  selectSkillsForContext,
  selectSkillScanForContext,
  buildSkillsPromptFragment,
  buildSkillsPromptFragmentWithReport,
  loadSkillInstructions,
  loadSkillInstructionsFromScan,
  searchSkills,
  MAX_SKILLS_PROMPT_CHARS,
  MIN_SKILLS_PROMPT_TOKENS,
  MAX_SKILLS_PROMPT_TOKENS,
  SKILLS_PROMPT_CONTEXT_RATIO,
  SKILL_SEARCH_RESULT_LIMIT,
} from './skills-context.js';
export type {
  HostCapabilities,
  HostCapabilitiesResolver,
  SkillCatalogBudgetOptions,
  SkillHostCompatibility,
  GatedSkill,
  SkillContextDecisionReason,
  SkillContextDecision,
  SkillSelectionReport,
  SkillContextSelection,
  SkillsPromptFragmentResult,
  SkillSearchMatch,
  SkillSearchResult,
  LoadedSkillInstructions,
  LoadSkillInstructionsResult,
} from './skills-context.js';

// ── From skills-agent-tools ────────────────────────────────────────────────
export {
  buildSkillAgentTool,
  buildSkillSearchAgentTool,
  SkillShadowSelectionTracker,
  SKILL_TOOL_NAME,
  SKILL_SEARCH_TOOL_NAME,
} from './skills-agent-tools.js';
export type { SkillToolOptions } from './skills-agent-tools.js';
