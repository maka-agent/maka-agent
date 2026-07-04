/**
 * PR-ANTI-LAYOUT-SHIFT-TEXT-SWAP-0 (issue #520 PR3):
 * lock `min-width` on state-swap surfaces so a button/label whose text
 * changes between states (复制 ↔ 已复制, 保存 ↔ 保存中…, token counts
 * 9 → 10 → 100) can't shrink and push its right-hand siblings.
 *
 * Invariant (per-element pin, not a coarse file count): every known
 * state-swap button keeps a `min-w-[Nrem]` in the className of the very
 * `<Button>`/`<UiButton>` that owns the swapping onClick handler, and the
 * chat summary-chip / stream-count variants keep their `min-w-[Nrem]`
 * declarations. Dropping a lock from a real surface fails here; moving a
 * lock onto an unrelated element (different handler / different variant
 * string) also fails.
 *
 * Adding a new state-swap surface: give the swapping element
 * `min-w-[Nrem]` sized to its widest state, and add an entry to
 * TEXT_SWAP_BUTTONS (file + a unique onClick substring + the min-w) or
 * CHAT_VARIANT_LOCKS (the literal declaration substring).
 */
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { REPO_ROOT } from './css-test-helpers.js';

// State-swap buttons: file + a unique onClick substring that identifies the
// exact button + the min-w-[Nrem] the button's className must keep.
const TEXT_SWAP_BUTTONS: Array<{ file: string; onClick: string; minW: string; note: string }> = [
  // memory-settings-page.tsx — settingsActionRow + the inline 复制上下文 button
  { file: 'apps/desktop/src/renderer/settings/memory-settings-page.tsx', onClick: 'onClick={() => void save()}', minW: '3.5rem', note: '保存 ↔ 保存中… ↔ 已保存' },
  { file: 'apps/desktop/src/renderer/settings/memory-settings-page.tsx', onClick: 'onClick={() => void openFile()}', minW: '7.5rem', note: '打开中… ↔ 打开 MEMORY.md' },
  { file: 'apps/desktop/src/renderer/settings/memory-settings-page.tsx', onClick: 'onClick={() => void openFolder()}', minW: '6rem', note: '打开中… ↔ 打开所在目录' },
  { file: 'apps/desktop/src/renderer/settings/memory-settings-page.tsx', onClick: 'onClick={() => void openLatestBackup()}', minW: '5rem', note: '打开中… ↔ 打开上一版' },
  { file: 'apps/desktop/src/renderer/settings/memory-settings-page.tsx', onClick: 'onClick={() => void copyLatestBackupReference()}', minW: '7rem', note: '复制中… ↔ 复制上一版引用' },
  { file: 'apps/desktop/src/renderer/settings/memory-settings-page.tsx', onClick: 'onClick={() => void reset()}', minW: '5rem', note: '重置中… ↔ 重置并备份' },
  { file: 'apps/desktop/src/renderer/settings/memory-settings-page.tsx', onClick: 'onClick={() => void restoreLatestBackup()}', minW: '5rem', note: '恢复中… ↔ 恢复上一版' },
  { file: 'apps/desktop/src/renderer/settings/memory-settings-page.tsx', onClick: 'onClick={() => void copyLocalMemoryPromptPreview()}', minW: '5rem', note: 'settingsInlineTextButton: 复制中… ↔ 复制上下文' },
  { file: 'apps/desktop/src/renderer/settings/memory-settings-page.tsx', onClick: 'onClick={() => void copyPath()}', minW: '4rem', note: '复制中… ↔ 复制路径' },
  // open-gateway-settings-page.tsx — settingsActionRow copy buttons
  { file: 'apps/desktop/src/renderer/settings/open-gateway-settings-page.tsx', onClick: 'onClick={() => void copyBaseUrl()}', minW: '4rem', note: '复制中… ↔ 复制地址' },
  { file: 'apps/desktop/src/renderer/settings/open-gateway-settings-page.tsx', onClick: 'onClick={() => void copyOverviewCurl()}', minW: '8rem', note: '复制总览 curl' },
  { file: 'apps/desktop/src/renderer/settings/open-gateway-settings-page.tsx', onClick: 'onClick={() => void copyOpenApiCurl()}', minW: '9rem', note: '复制接口说明 curl' },
  { file: 'apps/desktop/src/renderer/settings/open-gateway-settings-page.tsx', onClick: 'onClick={() => void copySessionStateCurl()}', minW: '9.5rem', note: '复制单会话状态 curl' },
  { file: 'apps/desktop/src/renderer/settings/open-gateway-settings-page.tsx', onClick: 'onClick={() => void copyEventStreamCurl()}', minW: '8.5rem', note: '复制事件流 curl' },
  { file: 'apps/desktop/src/renderer/settings/open-gateway-settings-page.tsx', onClick: 'onClick={() => void copyRecentEventsCurl()}', minW: '9rem', note: '复制最近事件 curl' },
  { file: 'apps/desktop/src/renderer/settings/open-gateway-settings-page.tsx', onClick: 'onClick={() => void copyRecentRequestsCurl()}', minW: '9rem', note: '复制最近请求 curl' },
  // daily-review-panel.tsx — quick-run + 复制/保存 actions
  { file: 'packages/ui/src/daily-review-panel.tsx', onClick: "triggerManualRun('daily')", minW: '6rem', note: '生成中… ↔ 生成每日回顾' },
  { file: 'packages/ui/src/daily-review-panel.tsx', onClick: "triggerManualRun('deep')", minW: '6rem', note: '生成中… ↔ 生成深度分析' },
  { file: 'packages/ui/src/daily-review-panel.tsx', onClick: "runDailyReviewAction('copy'", minW: '4rem', note: '复制中… ↔ 复制' },
  { file: 'packages/ui/src/daily-review-panel.tsx', onClick: "runDailyReviewAction('save'", minW: '4rem', note: '保存中… ↔ 保存' },
  { file: 'packages/ui/src/daily-review-panel.tsx', onClick: "runDailyReviewAction('append'", minW: '5rem', note: '追加中… ↔ 粘到输入框' },
  // error-boundary.tsx — maka-error-copy-action
  { file: 'apps/desktop/src/renderer/error-boundary.tsx', onClick: 'onClick={this.handleCopyReport}', minW: '5.5rem', note: '复制诊断信息 ↔ 复制中… ↔ 已复制 ↔ 复制失败' },
];

// Chat summary-chip / stream-count variant locks: the min-w-[Nrem]
// declaration lives in the variant definition (chat.tsx), not at the call
// site, so we pin the literal declaration substrings.
const CHAT_VARIANT_LOCKS: Array<{ file: string; substr: string; note: string }> = [
  { file: 'packages/ui/src/primitives/chat.tsx', substr: 'data-[kind=tools]:min-w-[5rem]', note: 'summary-chip tools count (N 个工具)' },
  { file: 'packages/ui/src/primitives/chat.tsx', substr: 'data-[kind=duration]:min-w-[4rem]', note: 'summary-chip duration (进行中 ↔ 时长)' },
  { file: 'packages/ui/src/primitives/chat.tsx', substr: 'min-w-[5rem] [font-variant-numeric:tabular-nums]', note: 'streamVariants count (stdout/stderr/已脱敏 N)' },
];

const BUTTON_OPEN_RE = /<(?:Ui)?Button\b/g;

describe('PR-ANTI-LAYOUT-SHIFT-TEXT-SWAP-0 contract', () => {
  it('every state-swap button keeps min-w-[Nrem] in its own className', async () => {
    // Group by file so we read each file once.
    const byFile = new Map<string, typeof TEXT_SWAP_BUTTONS>();
    for (const b of TEXT_SWAP_BUTTONS) {
      const arr = byFile.get(b.file) ?? [];
      arr.push(b);
      byFile.set(b.file, arr);
    }
    for (const [file, buttons] of byFile) {
      const src = await readFile(resolve(REPO_ROOT, file), 'utf8');
      for (const { onClick, minW, note } of buttons) {
        const handlerIdx = src.indexOf(onClick);
        assert.ok(handlerIdx >= 0, `${file}: onClick anchor "${onClick}" not found (${note})`);
        // Find the nearest <Button / <UiButton opening tag at or before the
        // handler — that is the element the handler belongs to.
        let tagStart = -1;
        BUTTON_OPEN_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = BUTTON_OPEN_RE.exec(src)) !== null) {
          if (m.index > handlerIdx) break;
          tagStart = m.index;
        }
        assert.ok(tagStart >= 0, `${file}: no <Button>/<UiButton> opens before "${onClick}" (${note})`);
        // Slice from the tag open to the handler; the className must sit in
        // that span (className always precedes onClick in these tags).
        const tagSpan = src.slice(tagStart, handlerIdx);
        const clsMatch = tagSpan.match(/className="([^"]*)"/);
        assert.ok(clsMatch, `${file}: button for "${onClick}" has no className (${note})`);
        assert.ok(
          clsMatch[1].includes(`min-w-[${minW}]`),
          `${file}: button for "${onClick}" className="${clsMatch[1]}" is missing min-w-[${minW}] (${note})`,
        );
      }
    }
  });

  it('chat summary-chip / stream-count variants keep their min-w declarations', async () => {
    const byFile = new Map<string, typeof CHAT_VARIANT_LOCKS>();
    for (const l of CHAT_VARIANT_LOCKS) {
      const arr = byFile.get(l.file) ?? [];
      arr.push(l);
      byFile.set(l.file, arr);
    }
    for (const [file, locks] of byFile) {
      const src = await readFile(resolve(REPO_ROOT, file), 'utf8');
      for (const { substr, note } of locks) {
        assert.ok(
          src.includes(substr),
          `${file}: missing variant declaration "${substr}" (${note})`,
        );
      }
    }
  });
});