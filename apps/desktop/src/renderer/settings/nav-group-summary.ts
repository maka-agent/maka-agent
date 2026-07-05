/**
 * Settings nav-group enum + presentation order for the Settings modal
 * sidebar.
 *
 * The `deriveNavGroupSummary` helper that used to live here (the short
 * status line under each group label, PR-HEALTH-1) lost its last consumer
 * when the nav was regrouped (PR-SETTINGS-NAV-REGROUP-0) and was removed
 * as dead code — restore from git history if group summaries come back.
 */

/**
 * PR-SETTINGS-NAV-REGROUP-0 (WAWQAQ msg `a9ef0d5d`): 5 narrow groups
 * collapsed to 3. `基础` → `通用`, `AI` + `集成` → `AI 与集成`,
 * `数据` + `其他` → `系统`. Mirrors reference's tighter nav grouping
 * (通用 / 扩展与集成 / 高级设置) where one big group carries most
 * items instead of 5 tiny ones.
 */
export type SettingsNavGroup = '通用' | 'AI 与集成' | '系统';

/**
 * The render order used by the Settings modal sidebar. Lives here so the
 * nav-group enum and its presentation order stay in one place.
 */
export const NAV_GROUP_ORDER: SettingsNavGroup[] = ['通用', 'AI 与集成', '系统'];
