/**
 * PR-ANTI-LAYOUT-SHIFT-TEXT-SWAP-0 (issue #520 PR3):
 * lock `min-width` on state-swap surfaces so a button/label whose text
 * changes between states (复制 ↔ 已复制, 保存 ↔ 保存中…, token counts
 * 9 → 10 → 100) can't shrink and push its right-hand siblings.
 *
 * Two layers, complementary:
 *
 * 1. Heuristic scan (DISCOVERY, scoped): every `<Button>`/`<UiButton>`
 *    whose children contain a string-ternary (`? 'A' : 'B'` with
 *    string/template branches — the state-swap signal) must keep
 *    `min-w-[Nrem]` in its className. The scan runs over the PR3 text-swap
 *    audit scope (the files #520 PR3 touched: memory/open-gateway settings
 *    action rows, daily-review actions, error-boundary). This is what
 *    stops a new state-swap button in those files from shipping without a
 *    lock: the test fails closed. A whitelist-only contract kept missing
 *    buttons nobody had audited by hand (reload, backup-candidate actions,
 *    instruction-file actions all slipped through); the scan makes "did we
 *    forget one in these files?" a question the test answers, not a
 *    question a reviewer has to keep answering.
 *
 *    The scan is deliberately scoped to the PR3 files, not the whole
 *    renderer. `? 'A' : 'B'` is only the state-swap SIGNAL — it can't tell
 *    whether the button actually sits in a multi-element row where width
 *    change pushes siblings (the real bug condition needs layout context,
 *    unlike min-w-0's mechanical ellipsis+nowrap signal). A repo-wide scan
 *    would flag ~77 buttons, most of them toggles/accordion headers/stand-
 *    alone retry buttons with no right-hand sibling to push. Those are a
 *    separate, broader text-swap convergence effort, not this contract.
 *    Adding a state-swap button to one of the SCAN_FILES below: give it
 *    min-w-[Nrem] or the scan fails.
 *
 * 2. Whitelist per-element pin (VALUE LOCK): each known state-swap button
 *    keeps a SPECIFIC `min-w-[Nrem]` sized to its widest state, located by
 *    its onClick handler. The scan only checks "has any min-w-[Nrem]";
 *    the whitelist stops a refactor from shrinking a real lock to the
 *    wrong value. Chat summary-chip / stream-count variant locks live in
 *    the variant definition, so they're pinned by their literal declaration
 *    substrings.
 */
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
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
  { file: 'apps/desktop/src/renderer/settings/memory-settings-page.tsx', onClick: 'onClick={() => void openWorkspaceInstructionFile(file.file)}', minW: '4rem', note: '打开中… ↔ 打开 (项目指令文件行)' },
  { file: 'apps/desktop/src/renderer/settings/memory-settings-page.tsx', onClick: 'onClick={() => void createWorkspaceInstructionFile(file.file)}', minW: '4rem', note: '创建中… ↔ 创建 (项目指令文件行)' },
  { file: 'apps/desktop/src/renderer/settings/memory-settings-page.tsx', onClick: 'onClick={() => void openBackupCandidate(backup)}', minW: '4rem', note: '打开中… ↔ 打开 (备份候选行)' },
  { file: 'apps/desktop/src/renderer/settings/memory-settings-page.tsx', onClick: 'onClick={() => void restoreBackupCandidate(backup)}', minW: '4rem', note: '恢复中… ↔ 恢复 (备份候选行)' },
  { file: 'apps/desktop/src/renderer/settings/memory-settings-page.tsx', onClick: 'onClick={() => void copyBackupReference(backup)}', minW: '4rem', note: '复制中… ↔ 复制引用 (备份候选行)' },
  { file: 'apps/desktop/src/renderer/settings/memory-settings-page.tsx', onClick: 'onClick={() => void reloadDraftFromDisk()}', minW: '4rem', note: '载入中… ↔ 重新载入 (settingsActionRow)' },
  { file: 'apps/desktop/src/renderer/settings/memory-settings-page.tsx', onClick: 'onClick={() => void props.onCopyReference?.(entry)}', minW: '4rem', note: '复制中… ↔ 复制引用 (记忆条目行)' },
  { file: 'apps/desktop/src/renderer/settings/memory-settings-page.tsx', onClick: 'onClick={() => void props.onStatusChange?.(entry', minW: '5rem', note: '归档到草稿/恢复到草稿 ↔ 归档/恢复 (draftDirty 5字最宽)' },
  // open-gateway-settings-page.tsx — settingsActionRow copy buttons
  { file: 'apps/desktop/src/renderer/settings/open-gateway-settings-page.tsx', onClick: 'onClick={() => void copyBaseUrl()}', minW: '4rem', note: '复制中… ↔ 复制地址' },
  { file: 'apps/desktop/src/renderer/settings/open-gateway-settings-page.tsx', onClick: 'onClick={() => void copyOverviewCurl()}', minW: '8rem', note: '复制总览 curl' },
  { file: 'apps/desktop/src/renderer/settings/open-gateway-settings-page.tsx', onClick: 'onClick={() => void copyOpenApiCurl()}', minW: '9rem', note: '复制接口说明 curl' },
  { file: 'apps/desktop/src/renderer/settings/open-gateway-settings-page.tsx', onClick: 'onClick={() => void copySessionStateCurl()}', minW: '9.5rem', note: '复制单会话状态 curl' },
  { file: 'apps/desktop/src/renderer/settings/open-gateway-settings-page.tsx', onClick: 'onClick={() => void copyEventStreamCurl()}', minW: '8.5rem', note: '复制事件流 curl' },
  { file: 'apps/desktop/src/renderer/settings/open-gateway-settings-page.tsx', onClick: 'onClick={() => void copyRecentEventsCurl()}', minW: '9rem', note: '复制最近事件 curl' },
  { file: 'apps/desktop/src/renderer/settings/open-gateway-settings-page.tsx', onClick: 'onClick={() => void copyRecentRequestsCurl()}', minW: '9rem', note: '复制最近请求 curl' },
  // daily-review-panel.tsx — quick-run + 复制/保存/粘到输入框 actions
  { file: 'packages/ui/src/daily-review-panel.tsx', onClick: "triggerManualRun('daily')", minW: '6rem', note: '生成中… ↔ 生成每日回顾' },
  { file: 'packages/ui/src/daily-review-panel.tsx', onClick: "triggerManualRun('deep')", minW: '6rem', note: '生成中… ↔ 生成深度分析' },
  { file: 'packages/ui/src/daily-review-panel.tsx', onClick: "runDailyReviewAction('copy'", minW: '4rem', note: '复制中… ↔ 复制' },
  { file: 'packages/ui/src/daily-review-panel.tsx', onClick: "runDailyReviewAction('save'", minW: '4rem', note: '保存中… ↔ 保存' },
  { file: 'packages/ui/src/daily-review-panel.tsx', onClick: "runDailyReviewAction('append'", minW: '5rem', note: '追加中… ↔ 粘到输入框' },
  // error-boundary.tsx — maka-error-copy-action (children is {copyLabel}, a
  // variable holding the ternary result, so the scan won't catch it; the
  // whitelist does.)
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

// --- Heuristic scan (DISCOVERY, scoped to PR3 files) ------------------------
// Files this contract governs: the surfaces #520 PR3 touched. A new
// state-swap button in any of these is caught by the scan and must get a
// min-w-[Nrem] (or the test fails). State-swap buttons in other files
// (other settings pages, onboarding, etc.) are a separate, broader
// text-swap convergence effort — not this contract's scope — so they
// aren't scanned here and won't false-positive.
const SCAN_FILES = [
  'apps/desktop/src/renderer/settings/memory-settings-page.tsx',
  'apps/desktop/src/renderer/settings/open-gateway-settings-page.tsx',
  'apps/desktop/src/renderer/error-boundary.tsx',
  'packages/ui/src/daily-review-panel.tsx',
];
// Match a full <Button>/<UiButton> element (opening attrs + children +
// closing tag). `[^>]*` is fine here because these tags never put a `>`
// inside an attribute; nested <Button> is handled by the non-greedy
// children matching the nearest close.
const BUTTON_BLOCK_RE = /<(Ui)?Button\b([^>]*)>([\s\S]*?)<\/\1Button>/g;
// A string-ternary child: `? 'A' : 'B'` / `? "A" : "B"` / `? `A` : `B``
// (template literals allowed). This is the state-swap signal: the button's
// text depends on runtime state, so its width can change between states.
const STRING_TERNARY_RE = /\?\s*['"`][^'"`]+['"`]\s*:\s*['"`][^'"`]+['"`]/;
const MIN_W_REM_RE = /min-w-\[\d+(?:\.\d+)?rem\]/;

describe('PR-ANTI-LAYOUT-SHIFT-TEXT-SWAP-0 contract', () => {
  it('every whitelisted state-swap button keeps its exact min-w-[Nrem]', async () => {
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
        let tagStart = -1;
        BUTTON_OPEN_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = BUTTON_OPEN_RE.exec(src)) !== null) {
          if (m.index > handlerIdx) break;
          tagStart = m.index;
        }
        assert.ok(tagStart >= 0, `${file}: no <Button>/<UiButton> opens before "${onClick}" (${note})`);
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

  it('no state-swap Button with a string-ternary child slips through without min-w-[Nrem] + whitelist value pin', () => {
    // Two failure modes, both must fail closed:
    //  (a) no min-w-[Nrem] at all — the width lock is missing;
    //  (b) has some min-w-[Nrem] but the button isn't in TEXT_SWAP_BUTTONS
    //      (or EXCEPTIONS) — the value lock can be bypassed by setting
    //      min-w-[1rem]. The scan finds the button; the whitelist pins the
    //      exact value. Both must hold.
    const WHITELIST_ANCHORS = TEXT_SWAP_BUTTONS.map((b) => b.onClick);
    const EXCEPTION_ANCHORS: string[] = [
      // (none — every state-swap button in the PR3 scope files is
      // whitelisted. Add an onClick substring here only if a scanned button
      // is intentionally not value-pinned, with a comment saying why.)
    ];
    const missingMinW: Array<{ file: string; line: number; snippet: string }> = [];
    const notPinned: Array<{ file: string; line: number; snippet: string }> = [];
    for (const file of SCAN_FILES) {
      const src = readFileSync(resolve(REPO_ROOT, file), 'utf8');
      BUTTON_BLOCK_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = BUTTON_BLOCK_RE.exec(src)) !== null) {
        const block = m[0];
        const attrs = m[2];
        const children = m[3];
        if (!STRING_TERNARY_RE.test(children)) continue;
        const clsMatch = attrs.match(/className="([^"]*)"/);
        const hasMinW = clsMatch != null && MIN_W_REM_RE.test(clsMatch[1]);
        const line = src.slice(0, m.index).split('\n').length;
        const snippet = children.trim().replace(/\s+/g, ' ').slice(0, 80);
        if (!hasMinW) {
          missingMinW.push({ file, line, snippet });
        }
        // Even with a min-w, the button must be value-pinned by the
        // whitelist (or an explicit exception) so a too-small min-w can't
        // bypass the value lock.
        const pinned =
          WHITELIST_ANCHORS.some((oc) => block.includes(oc)) ||
          EXCEPTION_ANCHORS.some((oc) => block.includes(oc));
        if (!pinned) {
          notPinned.push({ file, line, snippet });
        }
      }
    }
    const fmt = (arr: typeof missingMinW) =>
      arr.map((m) => `  ${m.file}:${m.line} — ${m.snippet}`).join('\n');
    assert.equal(
      missingMinW.length,
      0,
      `Found ${missingMinW.length} state-swap button(s) without min-w-[Nrem] in the PR3 scope files. Each <Button>/<UiButton> whose children contain a string ternary (? 'A' : 'B', the state-swap signal) must keep min-w-[Nrem] in its className:\n` +
        fmt(missingMinW),
    );
    assert.equal(
      notPinned.length,
      0,
      `Found ${notPinned.length} state-swap button(s) with a min-w but no TEXT_SWAP_BUTTONS value pin (and not in EXCEPTIONS). A too-small min-w-[1rem] would bypass the value lock. Add a TEXT_SWAP_BUTTONS entry (file + onClick anchor + min-w sized to the widest state):\n` +
        fmt(notPinned),
    );
  });
});