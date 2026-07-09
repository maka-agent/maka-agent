/**
 * Empty-chat hero surfaces (`EmptyChatHero`, `DeepResearchEmptyHero`)
 * + their locale-aware copy bundle + the time-of-day greeting helper.
 *
 * PR-UI-LIB-EXTRACT-8 (WAWQAQ msg `510fef52`, round 9/10): pulled
 * out of `components.tsx`. `detectDayPeriod` and `DayPeriod` were
 * already public (consumed by `apps/desktop/src/renderer/main.tsx`
 * and three contract tests — `empty-hero-day-period`,
 * `deep-research-visible-surface-contract`, and
 * `visible-copy-hygiene-contract`); the two hero components and
 * the locale copy bundle were panel-internal. byte-for-byte
 * equivalent; behavior unchanged; `index.ts` re-exports this
 * module so the `@maka/ui` public API surface stays identical.
 *
 * Why this seam: the empty-chat hero is the first thing every
 * user sees on a fresh session. Its day-period boundary
 * (5/11/14/18) is screenshot-baseline-pinned by a contract test
 * because visual-smoke fixtures freeze `Date.now()` but not the
 * `Date` constructor — getting this wrong silently drifts the
 * baseline. The DeepResearch variant is also where the read-only
 * deep-research workflow rules live. Both deserve their own
 * surface so the boundary rules sit next to the surface they
 * govern, not buried in a 7000-line file.
 */

import { Sparkles } from './icons.js';
import {
  DEEP_RESEARCH_EVIDENCE_CHECKLIST,
  DEEP_RESEARCH_PROGRESS_CHECKPOINTS,
  DEEP_RESEARCH_REPORT_SECTIONS,
  DEEP_RESEARCH_SCOPE_OPTIONS,
  DEEP_RESEARCH_STARTER_PROMPTS,
  DEEP_RESEARCH_WORKFLOW_STEPS,
} from '@maka/core';

import { detectUiLocale, type UiLocale } from './locale-helpers.js';
import { Button as UiButton } from './ui.js';

export type DayPeriod = 'morning' | 'noon' | 'afternoon' | 'evening';

/**
 * PR-UI-LAYOUT-4 / B1-a1 review fixup (@kenji msg 1d7ba56c):
 * Compute the day-period bucket from a millisecond epoch timestamp,
 * not from `new Date()`. Visual-smoke fixtures freeze `Date.now()`
 * to a deterministic value (see `applyVisualSmokeFixture` in
 * `apps/desktop/src/renderer/main.tsx`) but do NOT freeze the
 * `Date` constructor itself; reading `new Date()` directly would
 * pick up the host clock and let screenshot baselines drift at the
 * 11:00 / 14:00 / 18:00 boundaries.
 *
 * Default arg is `Date.now()`, which the visual-smoke renderer
 * replaces with `state.now`. Tests pass an explicit timestamp.
 * Exported so the day-period boundary contract is reachable from
 * `apps/desktop/src/main/__tests__/empty-hero-day-period.test.ts`.
 */
export function detectDayPeriod(nowMs: number = Date.now()): DayPeriod {
  const hour = new Date(nowMs).getHours();
  if (hour < 5) return 'evening';
  if (hour < 11) return 'morning';
  if (hour < 14) return 'noon';
  if (hour < 18) return 'afternoon';
  return 'evening';
}

const EMPTY_HERO_COPY_BY_LOCALE: Record<UiLocale, {
  ariaLabel: string;
  /** Time-of-day prefix: "早上好" / "Good morning" etc. */
  greeting: Record<DayPeriod, string>;
  /** Soft contextual phrase appended when no userLabel is set
   *  (e.g. "安静的夜晚适合深度思考"). */
  greetingTail: Record<DayPeriod, string>;
  /** Compose the headline when the user has a display name. */
  headlineWithLabel: (greeting: string, label: string) => string;
  /** Compose the headline when no name (greeting + tail). */
  headlineFallback: (greeting: string, tail: string) => string;
  primaryBubble: string;
  secondaryBubble: string;
  intro: string;
}> = {
  zh: {
    ariaLabel: '开始对话',
    greeting: {
      morning: '早上好',
      noon: '中午好',
      afternoon: '下午好',
      evening: '晚上好',
    },
    greetingTail: {
      morning: '清醒的早晨适合理清思路',
      noon: '专注的午间适合一鼓作气',
      afternoon: '舒缓的下午适合慢慢推进',
      evening: '安静的夜晚适合深度思考',
    },
    headlineWithLabel: (greeting, label) => `${greeting} ${label}，今天想做点什么？`,
    headlineFallback: (greeting, tail) => `${greeting}，${tail}。`,
    primaryBubble: '好，我来帮你理清楚。',
    secondaryBubble: '为这个任务起草计划',
    intro: '自主规划，陪你把事做完的智能个人助手。',
  },
  en: {
    ariaLabel: 'Start a conversation',
    greeting: {
      morning: 'Good morning',
      noon: 'Good afternoon',
      afternoon: 'Good afternoon',
      evening: 'Good evening',
    },
    greetingTail: {
      morning: 'A clear morning is good for untangling ideas',
      noon: 'A focused midday is good for a single big push',
      afternoon: 'A calm afternoon is good for steady progress',
      evening: 'A quiet evening is good for deep thinking',
    },
    headlineWithLabel: (greeting, label) => `${greeting} ${label} — what shall we tackle today?`,
    headlineFallback: (greeting, tail) => `${greeting} — ${tail}.`,
    primaryBubble: 'Sure. I can organize that.',
    secondaryBubble: 'Draft a plan for this task',
    intro: 'Describe what you want to change, ask, or look up. Type it in the composer below and Maka will start from there.',
  },
};

export function EmptyChatHero(props: { onPromptSuggestion?(prompt: string): void; userLabel?: string }) {
  // Greet the user by name when they've set one in Personalization Settings.
  // Falls back to a neutral title so first-run users don't see "Hi 你, …".
  //
  // PR-REFERENCE_APP-HERO-0: the normal empty chat page now follows the
  // reference implementation single-card pattern: calm copy above the one real composer
  // card, without a grid of starter chips competing for the first
  // viewport. `onPromptSuggestion` stays in the signature for callers
  // that still pass it, but the generic empty-chat surface no longer
  // renders suggestions; Deep Research keeps its specialized starters.
  const label = props.userLabel?.trim();
  const locale = detectUiLocale();
  const copy = EMPTY_HERO_COPY_BY_LOCALE[locale];
  // PR-UI-LAYOUT-4: time-of-day greeting prefix. `detectDayPeriod`
  // reads the user's local clock at render time; we don't memo
  // because the hero is short-lived and React will re-render when
  // the user navigates back into it.
  const period = detectDayPeriod();
  const greeting = copy.greeting[period];
  const greetingTail = copy.greetingTail[period];
  return (
    <section className="maka-hero maka-hero-empty-chat" aria-label={copy.ariaLabel}>
      <div className="maka-hero-visual" aria-hidden="true">
        <span className="maka-hero-bubble maka-hero-bubble-primary">{copy.primaryBubble}</span>
        <span className="maka-hero-avatar maka-hero-avatar-maka">
          <Sparkles size={18} />
        </span>
        <span className="maka-hero-avatar maka-hero-avatar-user">
          {label ? label.slice(0, 1).toUpperCase() : 'M'}
        </span>
        <span className="maka-hero-bubble maka-hero-bubble-secondary">{copy.secondaryBubble}</span>
      </div>
      <header>
        <h1>
          {label ? copy.headlineWithLabel(greeting, label) : copy.headlineFallback(greeting, greetingTail)}
        </h1>
        <p>{copy.intro}</p>
      </header>
    </section>
  );
}

export function DeepResearchEmptyHero(props: { onPromptSuggestion?(prompt: string): void }) {
  return (
    <section className="maka-hero maka-hero-empty-chat maka-hero-deep-research" aria-label="深度研究空会话">
      <header>
        <span className="maka-hero-eyebrow">
          <Sparkles size={12} aria-hidden="true" />
          <span>深度研究 · 只读探索</span>
        </span>
        <h1>先把项目读透，再决定怎么改。</h1>
        <p>
          这个会话固定在只读权限：优先阅读、搜索和分析代码；需要动手实现时，先输出文件、风险和验证命令。
        </p>
      </header>
      <ol className="maka-deep-research-workflow" aria-label="深度研究流程">
        {DEEP_RESEARCH_WORKFLOW_STEPS.map((step) => (
          <li key={step.title}>
            <span className="maka-deep-research-workflow-title">{step.title}</span>
            <span className="maka-deep-research-workflow-body">{step.body}</span>
          </li>
        ))}
      </ol>
      <section className="maka-deep-research-report" aria-label="深度研究输出结构">
        <h2>输出必须能直接落地</h2>
        <ul>
          {DEEP_RESEARCH_REPORT_SECTIONS.map((section) => (
            <li key={section.title}>
              <span className="maka-deep-research-report-title">{section.title}</span>
              <span className="maka-deep-research-report-body">{section.body}</span>
            </li>
          ))}
        </ul>
      </section>
      <section className="maka-deep-research-scope" aria-label="深度研究范围">
        <h2>默认按标准深度研究</h2>
        <ul>
          {DEEP_RESEARCH_SCOPE_OPTIONS.map((option) => (
            <li key={option.label}>
              <span className="maka-deep-research-scope-label">{option.label}</span>
              <span className="maka-deep-research-scope-body">{option.body}</span>
            </li>
          ))}
        </ul>
      </section>
      <section className="maka-deep-research-evidence" aria-label="深度研究证据清单">
        <h2>每次研究都要留证据</h2>
        <ul>
          {DEEP_RESEARCH_EVIDENCE_CHECKLIST.map((item) => (
            <li key={item.title}>
              <span className="maka-deep-research-evidence-title">{item.title}</span>
              <span className="maka-deep-research-evidence-body">{item.body}</span>
            </li>
          ))}
        </ul>
      </section>
      <section className="maka-deep-research-progress" aria-label="深度研究检查点">
        <h2>多步研究要按检查点推进</h2>
        <ul>
          {DEEP_RESEARCH_PROGRESS_CHECKPOINTS.map((item) => (
            <li key={item.title}>
              <span className="maka-deep-research-progress-title">{item.title}</span>
              <span className="maka-deep-research-progress-body">{item.body}</span>
            </li>
          ))}
        </ul>
      </section>
      {props.onPromptSuggestion && (
        <ul className="maka-prompt-suggestions" aria-label="深度研究起手式">
          {DEEP_RESEARCH_STARTER_PROMPTS.map((suggestion) => (
            <li key={suggestion.label}>
              <UiButton
                type="button"
                className="maka-prompt-chip h-auto"
                variant="quiet"
                onClick={() => props.onPromptSuggestion?.(suggestion.prompt)}
              >
                <span className="maka-prompt-chip-label">{suggestion.label}</span>
                <span className="maka-prompt-chip-hint">{suggestion.prompt.slice(0, 60)}…</span>
              </UiButton>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
