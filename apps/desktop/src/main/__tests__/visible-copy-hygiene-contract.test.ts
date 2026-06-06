/**
 * Static-analysis contract test for visible-copy hygiene
 * (PR-SIDEBAR-IA-0 Phase 3 P0 fixup v2, kenji msg `08be08d8`).
 *
 * Background:
 *   WAWQAQ noticed `建文` showing up in his real chat surface
 *   (msg `1886c41b`). Tracing it back: the visual-smoke fixture
 *   seeded `personalization.displayName = '建文'` for screenshot
 *   determinism, but that placeholder name has no product
 *   meaning — a user opening a demo workspace (or anyone
 *   reviewing a baseline screenshot) sees a stranger's name as
 *   the "user" label.
 *
 *   Kenji also called out `WELCOME TO MAKA` (all-caps English
 *   eyebrow in `NeedsConnectionHero`) as inconsistent with the
 *   rest of the Chinese-first surface (msg `08be08d8` #4).
 *
 * This file is a grep-style gate that fails if either string
 * reappears in renderer/UI source. The runtime fix landed
 * separately (fixture displayName → '', eyebrow → '欢迎使用 Maka').
 *
 * Add new entries to `FORBIDDEN_VISIBLE_COPY` when a reviewer
 * calls out additional copy drift that should never reappear.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { join, resolve } from 'node:path';

// Cwd is `apps/desktop` when the test runs (per the existing
// sidebar-scroll-contract pattern).
const FILES_TO_SCAN = [
  resolve(process.cwd(), '..', '..', 'packages', 'ui', 'src', 'components.tsx'),
  join(process.cwd(), 'src', 'renderer', 'main.tsx'),
  join(process.cwd(), 'src', 'renderer', 'OnboardingHero.tsx'),
  join(process.cwd(), 'src', 'renderer', 'artifact-pane.tsx'),
  join(process.cwd(), 'src', 'renderer', 'artifact-preview.tsx'),
  join(process.cwd(), 'src', 'renderer', 'artifact-preview-registry-shell.tsx'),
  join(process.cwd(), 'src', 'renderer', 'onboarding-hero-copy.ts'),
  join(process.cwd(), 'src', 'renderer', 'chat-header-alert.ts'),
  join(process.cwd(), 'src', 'main', 'chat-readiness.ts'),
  join(process.cwd(), 'src', 'main', 'visual-smoke-fixture.ts'),
];

interface ForbiddenCopy {
  /**
   * Pattern (regex) that must NOT appear in any scanned file.
   * Use a regex when the forbidden shape requires distinguishing
   * code-vs-comment context or mixed-language detection (e.g.
   * "uppercase English prefix followed by a Chinese character" —
   * a literal substring match would also flag the legitimate
   * all-English en-locale string).
   */
  needle: RegExp;
  /** Short human-readable label for the assertion message. */
  label: string;
  /** Human-readable why-it's-forbidden for the assertion message. */
  reason: string;
}

// Range: `[一-龥]` is the CJK Unified Ideographs block —
// matches any common Chinese character. Combined with an English
// prefix this catches "mixed-language eyebrow" without flagging
// pure-English en-locale strings.
const CJK_CHAR = '[\\u4e00-\\u9fa5]';

const FORBIDDEN_VISIBLE_COPY: ForbiddenCopy[] = [
  {
    label: 'placeholder Chinese personal name as fixture displayName',
    needle: /personalization\.displayName\s*=\s*'[一-龥]/,
    reason:
      "fixture must not seed a Chinese personal name as displayName — placeholder human names confuse users and reviewers (kenji `08be08d8`, WAWQAQ `1886c41b`). Default to empty string so the renderer fallback (`'你'`) shows in screenshots.",
  },
  {
    label: 'event-stream recovery copy sounds unfinished',
    needle: /实时事件暂未更新|事件流暂未/,
    reason:
      "event-stream stale/recovery copy is a current recovery state, not unfinished roadmap work. Say the local session log is being used to refresh/recover instead of `暂未更新`.",
  },
  {
    label: 'all-caps English-only hero eyebrow',
    needle: /<span>[A-Z][A-Z\s]{4,}<\/span>/,
    reason:
      "JSX `<span>` containing 5+ all-caps English chars is inconsistent with the Chinese-first onboarding surface (kenji `08be08d8` #4). Use a Chinese eyebrow to match the surrounding rhythm.",
  },
  {
    label: 'mixed-language eyebrow (English prefix + Chinese tail)',
    needle: new RegExp(`eyebrow:\\s*'[A-Z]+[^']*${CJK_CHAR}`),
    reason:
      "mixed-language eyebrow (English uppercase prefix followed by Chinese) drifted from the rest of the Chinese-first surface (kenji `08be08d8` #4). Use a Chinese-only eyebrow on zh-locale entries; en-locale entries staying all-English is fine.",
  },
  {
    label: 'internal phase / PR name leaked into user-visible text',
    // Match `Phase <N>` after comments have been stripped (see
    // `stripComments` below). Phase identifiers are engineering-
    // plan vocabulary and must never surface to users.
    needle: /Phase\s+\d/,
    reason:
      "user-visible text must not expose internal phase identifiers like `Phase 4` (xuan `a4c98a2a`). Use product-semantic copy describing the outcome, not the engineering plan. Stripping source comments means this fires only when `Phase N` actually lands in JSX text or string literals.",
  },
  {
    label: 'engineering term `incognito` leaked into user-visible text',
    // PR-UX-POLISH-1 commit 5 (yuejing): tightened from `/incognito/i`
    // so the gate doesn't false-positive on contract enum names
    // (e.g. `'incognito_active'` from `@maka/core/search.SearchErrorReason`)
    // or local variable identifiers (e.g. `incognitoBlocked`,
    // `incognitoActive`). User-visible Chinese surface uses `隐私 / 隐身
    // 模式`. The negative lookahead `(?![_a-zA-Z])` blocks any
    // `incognito` that's part of a longer identifier or snake_case
    // enum value; it still catches `incognito` as a standalone word
    // in JSX text or copy strings.
    needle: /incognito(?![_a-zA-Z])/i,
    reason:
      "user-visible text must not expose the literal English `incognito` as a standalone word (xuan `a4c98a2a`). Describe the user-facing privacy state in Chinese product terms (e.g. `隐私` / `隐身`) instead. Contract enum names like `incognito_active` and camelCase identifiers like `incognitoBlocked` are OK because they're code, not user-visible text.",
  },
  {
    label: 'dev/demo backend terminology leaked into visible readiness copy',
    needle: /FakeBackend|Fake backend|backend\s*\/\s*连接|开发演示|演示版/,
    reason:
      "readiness and chat-header copy must describe stale local simulation sessions in user terms, not leak development backend names or demo-stage language.",
  },
  {
    label: 'renderer implementation terms leaked into visible preview copy',
    needle: /注册表中实现|(?:此类|已识别到|无法识别|超过 2 MB 的|无法读取)\s*artifact|Artifact\s*(?:预览|列表|操作)|(?:打开|读取|复制|另存|保存|选择左侧|展开|折叠|不存在|路径检查未通过|已删除)[^'\n`]*artifact/,
    reason:
      "artifact preview fallback copy must explain the product capability boundary in user terms, not expose renderer implementation details like a preview registry or internal `artifact` naming.",
  },
  {
    label: 'visual-smoke fixture seeded visible copy leaks implementation terms',
    needle: /Artifact Pane|artifact pane|artifact fixture|(?:生成|已生成)\s*(?:\d+\s*个|三个)\s*artifact|Claude backend|HTML artifact|Artifact Smoke Report|Pane Smoke Report|视觉 smoke|provider capability|ModelTable|source\/fetchedAt|test gate/,
    reason:
      "visual-smoke fixture chat messages and file contents appear in screenshots/baseline workspaces; they should use product-facing Chinese copy rather than internal fixture/backend/artifact labels.",
  },
  {
    label: 'English hidden-line markers in tool previews',
    needle: /more (?:stdout |stderr )?lines hidden/,
    reason:
      "tool result previews are user-visible runtime output surfaces; truncation markers should use Chinese product copy such as `已隐藏 N 行`, not English debug copy.",
  },
  {
    label: 'English chat fallback name in destructive confirmation',
    needle: /this chat/,
    reason:
      "delete confirmations are user-visible product copy. A missing session title should fall back to Chinese `当前会话`, not English `this chat` inside a Chinese dialog.",
  },
  {
    label: 'English terminal empty-output marker',
    needle: /\(no output\)/,
    reason:
      "terminal previews should show a Chinese empty-output marker (`（无输出）`) instead of raw English debug copy.",
  },
  {
    label: 'English terminal exit-code marker',
    needle: /exit code|>\s*exit\s*\{/,
    reason:
      "terminal previews should label process status as `退出码 N` in visible and aria copy, not English `exit code` / `exit N`.",
  },
  {
    label: 'missing real-model toast sounds unfinished',
    needle: /未配置真实模型/,
    reason:
      "send-path setup toast should frame the missing real model as an actionable waiting state (`等待配置真实模型`), not an unfinished/missing-product state.",
  },
  {
    label: 'missing default-model guard sounds unfinished',
    needle: /还没有配置默认模型/,
    reason:
      "send-path readiness errors should frame the missing default model as an actionable waiting state (`等待配置默认模型`), not unfinished setup copy.",
  },
  {
    label: 'shared empty-state titles sound unfinished',
    needle: /还没有(?:对话| Skill|计划提醒)/,
    reason:
      "shared empty-state titles should frame empty product surfaces as actionable waiting states (`等待开始对话` / `等待添加 Skill` / `等待创建计划提醒`), not unfinished setup copy.",
  },
  {
    label: 'workspace instruction missing-state toast sounds unfinished',
    needle: /当前项目还没有项目指引/,
    reason:
      "Command Palette project-instruction fallback should frame the missing file as an actionable waiting state (`等待创建项目指引`), not unfinished project setup copy.",
  },
  {
    label: 'Daily Review empty activity title sounds unfinished',
    needle: /今天还没有活动|\$\{dayLabel\}没有活动/,
    reason:
      "Daily Review empty-state titles should frame today's empty state as an actionable waiting state (`等待记录今天活动`) and past ranges as a concise fact (`无活动`), not unfinished activity copy.",
  },
];

/**
 * Strip TypeScript / JavaScript comments from `src` so the hygiene
 * gates only inspect ACTIVE source code (JSX text, string literals,
 * identifiers) — not the comments that explain why a string was
 * removed in the first place.
 *
 * Order matters: strip block comments (`/* ... *\/`) first so the
 * line-comment pass doesn't choke on `//` sequences inside them.
 * The same string is passed through three stripping passes:
 *   1. Block comments `/* ... *\/` (non-greedy, including newlines).
 *   2. JSX block comments `{/* ... *\/}` (also non-greedy + newline-safe).
 *   3. Line comments `// ...\n` (per-line tail).
 *
 * Naive — does NOT respect string literals or template literals
 * containing the comment delimiter sequences. The files this test
 * scans have no such legitimate sequences in code (only inside
 * source comments we're already stripping), so the bias is safe.
 */
function stripComments(src: string): string {
  let out = src;
  // 1. Block comments — `/* ... */` across lines.
  out = out.replace(/\/\*[\s\S]*?\*\//g, '');
  // 2. JSX block-comment expressions `{/* ... */}` left over from
  //    step 1 (after the `/* */` is stripped, the wrapper braces
  //    may remain as `{}`). Drop the empty braces too so they don't
  //    confuse later JSX-text heuristics.
  out = out.replace(/\{\s*\}/g, '');
  // 3. Line comments — `// ...` to end of line. Anchor on a
  //    leading non-`:` character so URL schemes like `http://`
  //    aren't accidentally stripped (this codebase has none in the
  //    scanned files, but keep the guard for safety).
  out = out.replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  return out;
}

describe('visible-copy hygiene contract (PR-SIDEBAR-IA-0 Phase 3 P0 fixup v2)', () => {
  for (const entry of FORBIDDEN_VISIBLE_COPY) {
    it(`forbidden copy "${entry.label}" does NOT appear in any visible source file`, async () => {
      const offenders: Array<{ path: string; match: string }> = [];
      for (const path of FILES_TO_SCAN) {
        const raw = await readFile(path, 'utf8');
        const src = stripComments(raw);
        const match = entry.needle.exec(src);
        if (match) {
          offenders.push({ path, match: match[0]! });
        }
      }
      assert.equal(
        offenders.length,
        0,
        `forbidden copy pattern "${entry.label}" found:\n${offenders
          .map((o) => `  ${o.path}\n    matched: ${o.match}`)
          .join('\n')}\n\nreason: ${entry.reason}`,
      );
    });
  }
});

describe('terminal truncation handoff contract', () => {
  it('shows a deep-research handoff when terminal output is capped', async () => {
    const componentsPath = resolve(process.cwd(), '..', '..', 'packages', 'ui', 'src', 'components.tsx');
    const src = await readFile(componentsPath, 'utf8');

    assert.match(
      src,
      /const hiddenLines = stdout\.capped \+ stderr\.capped;/,
      'TerminalPreview should combine capped stdout/stderr counts into one visible handoff condition.',
    );
    assert.match(
      src,
      /\{hiddenLines > 0 && \(/,
      'The handoff note should only render when at least one terminal output stream is capped.',
    );
    assert.match(
      src,
      /maka-tool-terminal-truncated-note/,
      'TerminalPreview should render the capped-output handoff with a stable class for styling and review.',
    );
    assert.match(
      src,
      /前 \{TOOL_LINE_CAP\} 行/,
      'The handoff note should reflect the actual terminal preview line cap instead of hard-coding a stale number.',
    );
    assert.match(
      src,
      /深度研究.*只读探索/,
      'Long terminal output should point users toward the read-only deep-research workflow instead of ending at a dead truncated preview.',
    );
    assert.match(
      src,
      /const handoffText = \[/,
      'TerminalPreview should build a copyable handoff prompt for capped terminal output.',
    );
    assert.match(
      src,
      /工作目录：\$\{safeCwd\}/,
      'The capped-output handoff should include the redacted working directory.',
    );
    assert.match(
      src,
      /命令：\$\{safeCmd\}/,
      'The capped-output handoff should include the redacted command.',
    );
    assert.match(
      src,
      /copyFeedback\.copy\('handoff', handoffText\)/,
      'The capped-output handoff copy path must use the shared guarded clipboard feedback path.',
    );
    assert.match(
      src,
      /function useClipboardCopyFeedback/,
      'Clipboard copy actions should share one pending/failure feedback boundary instead of silently firing raw writes.',
    );
    assert.match(
      src,
      /navigator\.clipboard\.writeText\(options\.redact === false \? text : redactSecrets\(text\)\)/,
      'The shared clipboard feedback helper must redact by default and require an explicit raw-copy opt-out.',
    );
    assert.match(
      src,
      /handoffCopyPhase === 'pending'/,
      'The capped-output handoff copy button should expose a pending state while the clipboard write is running.',
    );
    assert.match(
      src,
      /data-copy-error=\{handoffCopyPhase === 'failed'/,
      'The capped-output handoff copy button should expose clipboard failures in-place instead of silently failing.',
    );
    assert.match(
      src,
      /复制研读提示/,
      'The truncation handoff should expose a visible copy action for the deep-research prompt.',
    );
  });

  it('styles the terminal truncation handoff distinctly from raw terminal output', async () => {
    const stylesPath = join(process.cwd(), 'src', 'renderer', 'styles.css');
    const src = await readFile(stylesPath, 'utf8');

    assert.match(src, /\.maka-tool-terminal-truncated-note\s*\{/, 'Missing truncated terminal note style.');
    assert.match(
      src,
      /maka-tool-terminal-truncated-note[\s\S]*border-top:\s*1px solid var\(--border\);/,
      'The truncation handoff should be visually separated from terminal text.',
    );
    assert.match(
      src,
      /maka-tool-terminal-truncated-note[\s\S]*var\(--warning\)/,
      'The truncation handoff should use the warning token so it reads as a capped-output state.',
    );
    assert.match(
      src,
      /maka-tool-terminal-copy[\s\S]*flex:\s*0 0 auto;/,
      'The copy action should keep a stable size inside the truncation handoff row.',
    );
    assert.match(
      src,
      /maka-tool-terminal-copy\[data-copy-error="true"\]/,
      'The terminal handoff copy button should have a visible failed state.',
    );
    assert.match(
      src,
      /maka-explore-agent-copy\[data-pending="true"\]/,
      'Explore Agent copy buttons should have a visible pending state.',
    );
  });
});

describe('turn footer copy feedback contract', () => {
  it('keeps shared clipboard feedback from updating state after unmount', async () => {
    const componentsPath = resolve(process.cwd(), '..', '..', 'packages', 'ui', 'src', 'components.tsx');
    const src = await readFile(componentsPath, 'utf8');
    const hookBlock = src.match(/function useClipboardCopyFeedback[\s\S]*?function TurnFooterActions/)?.[0] ?? '';

    assert.match(hookBlock, /const copyMountedRef = useRef\(true\)/, 'Shared copy feedback must track mounted state.');
    assert.match(
      hookBlock,
      /useEffect\(\(\) => \(\) => \{\s*copyMountedRef\.current = false;\s*clearResetTimer\(\);\s*\}, \[\]\)/,
      'Shared copy feedback must cancel timers and mark itself unmounted during cleanup.',
    );
    assert.match(
      hookBlock,
      /function settle\(key: string, phase: Exclude<ClipboardCopyPhase, 'pending'>\) \{\s*if \(!copyMountedRef\.current\) return;/,
      'Clipboard Promise settlement must not call setState after the owner unmounts.',
    );
    assert.match(
      hookBlock,
      /window\.setTimeout\(\(\) => \{\s*if \(!copyMountedRef\.current\) return;/,
      'Delayed feedback reset must not run setState after unmount.',
    );
    assert.doesNotMatch(
      hookBlock,
      /useEffect\(\(\) => clearResetTimer, \[\]\)/,
      'Cleanup that only clears the current timer is insufficient because clipboard settlement can happen after unmount.',
    );
  });

  it('gates the inline footer copy action instead of silently firing raw clipboard writes', async () => {
    const componentsPath = resolve(process.cwd(), '..', '..', 'packages', 'ui', 'src', 'components.tsx');
    const src = await readFile(componentsPath, 'utf8');
    const footerBlock = src.match(/function TurnFooterActions[\s\S]*?const STATUS_FOOTER_ICON/)?.[0] ?? '';

    assert.match(footerBlock, /const \[copyPhase, setCopyPhase\]/, 'Turn footer copy should track visible copy state.');
    assert.match(footerBlock, /copyPendingRef/, 'Turn footer copy should gate duplicate clipboard writes.');
    assert.match(footerBlock, /copyResetTimerRef/, 'Turn footer copy feedback should reset without leaking timers.');
    assert.match(
      footerBlock,
      /await navigator\.clipboard\.writeText\(props\.assistantText\)/,
      'Turn footer copy must preserve the exact assistant message text, unlike redacted tool-output copies.',
    );
    assert.match(footerBlock, /setCopyPhase\('pending'\)/, 'Turn footer copy should expose pending state immediately.');
    assert.match(footerBlock, /settleCopy\('copied'\)/, 'Turn footer copy should expose success state.');
    assert.match(footerBlock, /settleCopy\('failed'\)/, 'Turn footer copy should expose clipboard failure state.');
    assert.match(footerBlock, /复制中…/, 'Turn footer copy should show a pending label.');
    assert.match(footerBlock, /已复制/, 'Turn footer copy should show success feedback.');
    assert.match(footerBlock, /复制失败/, 'Turn footer copy should show failure feedback.');
    assert.match(footerBlock, /data-copy-feedback/, 'Turn footer copy should expose stable state data for CSS and review.');
    assert.match(footerBlock, /aria-busy=\{isActionPending/, 'Turn footer copy should expose busy state to assistive tech.');
    assert.match(footerBlock, /disabled=\{!action\.enabled \|\| copyIsPending\}/, 'Turn footer copy should disable while pending.');
    assert.doesNotMatch(
      footerBlock,
      /silent — clipboard may be unavailable/,
      'Turn footer copy failures should not be silent anymore.',
    );
  });

  it('styles footer copy pending and failure states', async () => {
    const stylesPath = join(process.cwd(), 'src', 'renderer', 'styles.css');
    const src = await readFile(stylesPath, 'utf8');

    assert.match(
      src,
      /\.maka-turn-footer-action\[data-pending\]\s*\{[\s\S]*cursor:\s*progress;/,
      'Turn footer pending copy should visibly indicate in-progress work.',
    );
    assert.match(
      src,
      /\.maka-turn-footer-action\[data-copy-feedback="copied"\]/,
      'Turn footer copied state should have a stable CSS selector.',
    );
    assert.match(
      src,
      /\.maka-turn-footer-action\[data-copy-feedback="failed"\]/,
      'Turn footer failed copy state should have a stable CSS selector.',
    );
  });
});

describe('tool error copy feedback contract', () => {
  it('routes tool-error copy through the shared guarded feedback path', async () => {
    const componentsPath = resolve(process.cwd(), '..', '..', 'packages', 'ui', 'src', 'components.tsx');
    const src = await readFile(componentsPath, 'utf8');
    const block = src.match(/function ToolErrorBanner[\s\S]*?export function OverlayHost/)?.[0] ?? '';

    assert.match(block, /const copyFeedback = useClipboardCopyFeedback\(\)/, 'Tool-error copy should use the shared pending/failure copy feedback path.');
    assert.match(block, /copyFeedback\.phaseFor\('tool-error'\)/, 'Tool-error copy should expose a scoped copy phase.');
    assert.match(block, /await copyFeedback\.copy\('tool-error', errorText\)/, 'Tool-error copy should route clipboard writes through the guarded helper.');
    assert.match(block, /复制中…/, 'Tool-error copy should show a pending label.');
    assert.match(block, /已复制/, 'Tool-error copy should show success feedback.');
    assert.match(block, /复制失败/, 'Tool-error copy should show failure feedback.');
    assert.match(block, /data-copy-feedback=\{copyPhase \?\? undefined\}/, 'Tool-error copy should expose stable copy state for CSS and review.');
    assert.match(block, /aria-busy=\{copyPending \? 'true' : undefined\}/, 'Tool-error copy should expose busy state to assistive tech.');
    assert.match(block, /disabled=\{copyPending\}/, 'Tool-error copy should disable while pending.');
    assert.doesNotMatch(
      block,
      /navigator\.clipboard\.writeText\(errorText\)|clipboard unavailable/,
      'Tool-error copy failures should not be silent raw clipboard writes.',
    );
  });

  it('styles tool-error copy pending and failure states', async () => {
    const stylesPath = join(process.cwd(), 'src', 'renderer', 'styles.css');
    const src = await readFile(stylesPath, 'utf8');

    assert.match(
      src,
      /\.maka-tool-error-copy\[data-pending="true"\]\s*\{[\s\S]*cursor:\s*progress;/,
      'Tool-error pending copy should visibly indicate in-progress work.',
    );
    assert.match(
      src,
      /\.maka-tool-error-copy\[data-copy-feedback="copied"\]/,
      'Tool-error copied state should have a stable CSS selector.',
    );
    assert.match(
      src,
      /\.maka-tool-error-copy\[data-copy-feedback="failed"\]/,
      'Tool-error failed copy state should have a stable CSS selector.',
    );
  });
});

describe('chat markdown copy feedback contract', () => {
  it('gates assistant message copy without redacting the raw message markdown', async () => {
    const componentsPath = resolve(process.cwd(), '..', '..', 'packages', 'ui', 'src', 'components.tsx');
    const src = await readFile(componentsPath, 'utf8');
    const block = src.match(/function MessageCopyButton[\s\S]*?const MARKDOWN_REMARK_PLUGINS/)?.[0] ?? '';

    assert.match(block, /useClipboardCopyFeedback\(1400, \{ redact: false \}\)/, 'Message copy should preserve raw assistant markdown.');
    assert.match(block, /await copyFeedback\.copy\('message', props\.text\)/, 'Message copy should route through the guarded helper.');
    assert.match(block, /复制中/, 'Message copy should expose pending feedback.');
    assert.match(block, /复制失败/, 'Message copy should expose failure feedback.');
    assert.match(block, /aria-busy=\{copyPending \? 'true' : undefined\}/, 'Message copy should expose busy state.');
    assert.match(block, /disabled=\{copyPending\}/, 'Message copy should disable while pending.');
    assert.match(block, /data-copy-feedback=\{copyPhase \?\? undefined\}/, 'Message copy should expose stable copy state.');
    assert.doesNotMatch(
      block,
      /navigator\.clipboard\.writeText\(props\.text\)|silently fail/,
      'Message copy should not use a silent raw clipboard write.',
    );
  });

  it('gates code-block copy and keeps code-copy accessibility copy Chinese-first', async () => {
    const componentsPath = resolve(process.cwd(), '..', '..', 'packages', 'ui', 'src', 'components.tsx');
    const src = await readFile(componentsPath, 'utf8');
    const block = src.match(/function CodeBlock[\s\S]*?function isElementWithClassName/)?.[0] ?? '';

    assert.match(block, /useClipboardCopyFeedback\(1400, \{ redact: false \}\)/, 'Code copy should preserve raw code text.');
    assert.match(block, /await copyFeedback\.copy\('code', text\)/, 'Code copy should route through the guarded helper.');
    assert.match(block, /复制代码中/, 'Code copy should expose pending feedback.');
    assert.match(block, /已复制代码/, 'Code copy should expose success feedback.');
    assert.match(block, /复制代码失败/, 'Code copy should expose failure feedback.');
    assert.match(block, /aria-busy=\{copyPending \? 'true' : undefined\}/, 'Code copy should expose busy state.');
    assert.match(block, /disabled=\{copyPending\}/, 'Code copy should disable while pending.');
    assert.match(block, /data-copy-feedback=\{copyPhase \?\? undefined\}/, 'Code copy should expose stable copy state.');
    assert.doesNotMatch(
      block,
      /navigator\.clipboard\.writeText\(text\)|Copy code|Copied|clipboard unavailable/,
      'Code copy should not regress to English/silent copy feedback.',
    );
  });

  it('keeps message and code copy pending/failure states visible', async () => {
    const stylesPath = join(process.cwd(), 'src', 'renderer', 'maka-tokens.css');
    const src = await readFile(stylesPath, 'utf8');

    assert.match(src, /\.maka-message-copy\[data-pending="true"\]/, 'Message copy needs a visible pending selector.');
    assert.match(src, /\.maka-message-copy\[data-copy-feedback="failed"\]/, 'Message copy needs a visible failed selector.');
    assert.match(src, /\.maka-code-block-copy\[data-pending="true"\]/, 'Code copy needs a visible pending selector.');
    assert.match(src, /\.maka-code-block-copy\[data-copy-feedback="failed"\]/, 'Code copy needs a visible failed selector.');
  });
});
