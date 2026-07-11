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
 *    instruction-file actions all slipped through). The scan closes that
 *    gap for INLINE string ternaries (`? 'A' : 'B'` in children). It does
 *    NOT cover COMPUTED-LABEL state-swap buttons (children is a variable
 *    holding a ternary result, e.g. `{copyLabel}` / `{statusActionLabel}`)
 *    — those have no inline ternary for the scan to find, so they MUST be
 *    hand-pinned in TEXT_SWAP_BUTTONS (see the COMPUTED-LABEL note above
 *    TEXT_SWAP_BUTTONS). So the claim is narrower than "no reviewer needed":
 *    inline-ternary omissions in these files are auto-caught; computed-label
 *    omissions are still on the whitelist author.
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
 *    its onClick handler. The scan also requires every discovered button to
 *    be value-pinned here (or in EXCEPTIONS) so a too-small `min-w-[1rem]`
 *    can't bypass the value lock; the whitelist pins the exact value so a
 *    refactor can't shrink a real lock to the wrong value.
 */
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { REPO_ROOT } from './css-test-helpers.js';

// State-swap buttons: file + a unique onClick substring that identifies the
// exact button + the min-w-[Nrem] the button's className must keep.
// COMPUTED-LABEL state-swap buttons (children is a variable holding a ternary
// result, NOT an inline `? 'A' : 'B'`): the scan CANNOT discover these (no
// inline ternary in children), so they MUST be hand-pinned in TEXT_SWAP_BUTTONS.
// Known cases — keep this list in sync with the whitelist entries that pin
// them:
// - error-boundary copyLabel (onClick={this.handleCopyReport}): children is
//   {copyLabel}; copyLabel = copyPending ? '复制中…' : copyState === 'copied'
//   ? '已复制' : copyState === 'failed' ? '复制失败' : '复制诊断信息'.
// - memory onStatusChange (onClick={() => void props.onStatusChange?.(...)}):
//   children is {statusActionLabel}; statusActionLabel = draftDirty
//   ? (archived ? '恢复到草稿' : '归档到草稿') : (archived ? '恢复' : '归档').
//   NB: the scan happens to flag this one too because its onClick contains a
//   `props.archived ? 'active' : 'archived'` ternary that BUTTON_BLOCK_RE
//   leaks into children via the `=>` boundary — a regex artifact, not a real
//   discovery; keep the whitelist pin regardless.
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
  // open-gateway-settings-page.tsx — 复制地址 + per-endpoint-row 复制 curl buttons (round 11)
  { file: 'apps/desktop/src/renderer/settings/open-gateway-settings-page.tsx', onClick: 'onClick={() => void copyBaseUrl()}', minW: '4rem', note: '复制中… ↔ 复制地址' },
  { file: 'apps/desktop/src/renderer/settings/open-gateway-settings-page.tsx', onClick: 'onClick={() => void copyOverviewCurl()}', minW: '5rem', note: '复制中… ↔ 复制 curl (总览)' },
  { file: 'apps/desktop/src/renderer/settings/open-gateway-settings-page.tsx', onClick: 'onClick={() => void copyOpenApiCurl()}', minW: '5rem', note: '复制中… ↔ 复制 curl (接口说明)' },
  { file: 'apps/desktop/src/renderer/settings/open-gateway-settings-page.tsx', onClick: 'onClick={() => void copySessionStateCurl()}', minW: '5rem', note: '复制中… ↔ 复制 curl (单会话状态)' },
  { file: 'apps/desktop/src/renderer/settings/open-gateway-settings-page.tsx', onClick: 'onClick={() => void copyEventStreamCurl()}', minW: '5rem', note: '复制中… ↔ 复制 curl (事件流)' },
  { file: 'apps/desktop/src/renderer/settings/open-gateway-settings-page.tsx', onClick: 'onClick={() => void copyRecentEventsCurl()}', minW: '5rem', note: '复制中… ↔ 复制 curl (最近事件)' },
  { file: 'apps/desktop/src/renderer/settings/open-gateway-settings-page.tsx', onClick: 'onClick={() => void copyRecentRequestsCurl()}', minW: '5rem', note: '复制中… ↔ 复制 curl (最近请求)' },
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

  it('scan does NOT discover computed-label state-swap (children is a variable, not inline ternary)', () => {
    // Computed-label buttons (children is {someVariable} holding a ternary
    // result) are NOT auto-discovered: STRING_TERNARY_RE looks for
    // ? 'A' : 'B' IN children, and {label} has none. These buttons MUST be
    // hand-pinned in TEXT_SWAP_BUTTONS — see the COMPUTED-LABEL note above.
    const computedLabelButton = [
      '<Button type="button" className="min-w-[1rem]" onClick={() => void fn()}">',
      '  {label}',
      '</Button>',
    ].join('\n');
    BUTTON_BLOCK_RE.lastIndex = 0;
    const blockMatch = BUTTON_BLOCK_RE.exec(computedLabelButton);
    assert.ok(blockMatch, 'BUTTON_BLOCK_RE should match the button block');
    const children = blockMatch[3];
    assert.equal(
      STRING_TERNARY_RE.test(children),
      false,
      'STRING_TERNARY_RE must NOT match a computed-label child ({label}); if it did, the scan would wrongly claim to cover computed-label buttons. They must stay hand-pinned in TEXT_SWAP_BUTTONS.',
    );
  });
});
