/**
 * PR-ANTI-LAYOUT-SHIFT-TEXT-SWAP-0 (issue #520 PR3):
 * lock `min-width` on state-swap surfaces so a button/label whose text
 * changes between states (复制 ↔ 已复制, 保存 ↔ 保存中…, token counts
 * 9 → 10 → 100) can't shrink and push its right-hand siblings, causing
 * layout shift.
 *
 * Invariant: each known state-swap surface file keeps at least the count
 * of `min-w-[Nrem]` locks it was given. A regression that drops them
 * (removing the className, refactoring the button out, etc.) fails here
 * before it ships.
 *
 * Adding a new state-swap surface: give each swapping element
 * `min-w-[Nrem]` sized to its widest state, and add the file + expected
 * count here.
 *
 * Note: this is a coarse presence guard (count of min-w-[Nrem] per file),
 * not a per-element pin — the per-element pin lives in review + the audit
 * notes that produced this list. It stops the whole class of regressions
 * where a refactor silently drops the width locks.
 */
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { REPO_ROOT } from './css-test-helpers.js';

// file -> minimum number of `min-w-[Nrem]` locks that must remain.
// Counts are the locks added by the PR3 text-swap audit for state-swap
// buttons/chips in left-aligned multi-button rows (settingsActionRow,
// maka-error-actions, maka-daily-review-actions) and summary chips whose
// digit count can grow.
const TEXT_SWAP_SURFACES: Array<{ file: string; minCount: number; note: string }> = [
  { file: 'packages/ui/src/daily-review-panel.tsx', minCount: 4, note: '生成每日回顾/生成深度分析/复制/保存 state-swap buttons' },
  { file: 'apps/desktop/src/renderer/error-boundary.tsx', minCount: 1, note: '复制诊断信息 ↔ 复制中… ↔ 已复制 ↔ 复制失败' },
  { file: 'apps/desktop/src/renderer/settings/memory-settings-page.tsx', minCount: 8, note: 'settingsActionRow: 保存/打开MEMORY.md/打开所在目录/打开上一版/复制上一版引用/重置并备份/恢复上一版 + 复制上下文' },
  { file: 'apps/desktop/src/renderer/settings/open-gateway-settings-page.tsx', minCount: 6, note: 'settingsActionRow: 6 curl copy buttons (总览/接口说明/单会话状态/事件流/最近事件/最近请求)' },
  { file: 'packages/ui/src/primitives/chat.tsx', minCount: 3, note: 'summary-chip data-[kind=tools]/[duration] min-w + streamVariants count min-w' },
];

const MIN_W_REM_RE = /min-w-\[\d+(?:\.\d+)?rem\]/g;

describe('PR-ANTI-LAYOUT-SHIFT-TEXT-SWAP-0 contract', () => {
  it('every known state-swap surface keeps its min-w-[Nrem] width locks', async () => {
    for (const { file, minCount, note } of TEXT_SWAP_SURFACES) {
      const src = await readFile(resolve(REPO_ROOT, file), 'utf8');
      const count = (src.match(MIN_W_REM_RE) ?? []).length;
      assert.ok(
        count >= minCount,
        `${file} has ${count} min-w-[Nrem] lock(s), expected >= ${minCount} (${note}). A state-swap button lost its width lock and will push siblings on state change.`,
      );
    }
  });
});