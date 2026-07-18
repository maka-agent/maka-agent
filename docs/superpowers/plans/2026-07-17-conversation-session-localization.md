# Conversation, Session, and Tool Localization Implementation Plan

> **Execution note:** Implement this plan task-by-task with tests first. The current delivery is executed locally in one worktree; no parallel agents are required.

**Goal:** Deliver a coherent Chinese and English desktop conversation/session/tool journey for PR 3 of issue #1052 without adding another locale authority.

**Architecture:** `@maka/ui` owns compile-time-complete conversation and tool-activity catalogs selected from the existing `<LocaleProvider locale={resolvedLocale}>`. Pure presenters accept `UiLocale` explicitly, while desktop action factories receive the resolved locale from `AppShell` and select renderer-owned safe error copy. Tests render representative fake-backend states in both locales and gate migrated visible literals through the TypeScript AST.

**Tech Stack:** TypeScript 7, React 19, Node test runner, Electron desktop renderer, npm workspaces.

---

### Task 1: Lock the PR 3 catalog and source contract

**Files:**
- Create: `packages/ui/src/conversation-copy.ts`
- Create: `packages/ui/src/tool-activity/copy.ts`
- Create: `packages/ui/src/__tests__/conversation-copy.test.ts`
- Create: `apps/desktop/src/main/__tests__/pr3-localized-copy-contract.test.ts`
- Modify: `packages/ui/src/index.ts`

- [ ] **Step 1: Write failing catalog tests**

Add a test that imports the planned selectors and proves both catalogs have total Chinese and English entries with no fallback API:

```ts
import { getConversationCopy } from '../conversation-copy.js';
import { getToolActivityCopy } from '../tool-activity/copy.js';

assert.equal(getConversationCopy('zh').composer.sendLabel, '发送');
assert.equal(getConversationCopy('en').composer.sendLabel, 'Send');
assert.equal(getConversationCopy('zh').sessions.status.running, '进行中');
assert.equal(getConversationCopy('en').sessions.status.running, 'Running');
assert.equal(getToolActivityCopy('zh').status.running, '运行中');
assert.equal(getToolActivityCopy('en').status.running, 'Running');
```

Add a desktop contract test that parses the PR 3 source list with `typescript.createSourceFile()`, visits `JsxText`, string JSX attributes, and user-visible JSX expressions, and rejects Han-script literals outside `conversation-copy.ts` and `tool-activity/copy.ts`. The allowlist must contain only data/command comparisons that are not rendered copy.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm --workspace @maka/ui run build`

Expected: TypeScript fails because the two catalog modules and selectors do not exist.

- [ ] **Step 3: Add minimal typed catalog skeletons**

Define explicit interfaces and total catalogs:

```ts
export interface ConversationCopy {
  composer: { sendLabel: string; stopLabel: string };
  sessions: {
    status: Record<SessionStatus, string>;
    blockedReason: Record<SessionBlockedReason, string>;
  };
}

const CONVERSATION_COPY = {
  zh: { /* complete Chinese shape */ },
  en: { /* complete English shape */ },
} satisfies UiCatalog<ConversationCopy>;

export function getConversationCopy(locale: UiLocale): ConversationCopy {
  return CONVERSATION_COPY[locale];
}
```

Define the tool status/copy skeleton the same way and export the public conversation selector from `packages/ui/src/index.ts`.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npm --workspace @maka/ui test`

Expected: catalog tests pass; the source contract still reports the not-yet-migrated surfaces and is kept focused for the next tasks.

- [ ] **Step 5: Commit**

Commit message: `test(locale): lock PR3 conversation copy contract`

### Task 2: Localize empty chat, composer, and message chrome

**Files:**
- Modify: `packages/ui/src/conversation-copy.ts`
- Modify: `packages/ui/src/chat-empty-hero.tsx`
- Modify: `packages/ui/src/chat-view.tsx`
- Modify: `packages/ui/src/chat-turn.tsx`
- Modify: `packages/ui/src/composer.tsx`
- Modify: `packages/ui/src/composer-mention-popup.tsx`
- Modify: `packages/ui/src/composer-workspace-row.tsx`
- Modify: `packages/ui/src/chat-display-helpers.ts`
- Create: `packages/ui/src/__tests__/conversation-localization.test.tsx`
- Modify: affected existing `packages/ui/src/__tests__/*.test.tsx` fixtures

- [ ] **Step 1: Write failing bilingual render tests**

Render the real components under `LocaleProvider` and assert distinct output for both locales:

```tsx
function localized(locale: UiLocale, child: ReactNode) {
  return renderToStaticMarkup(
    <LocaleProvider preference={locale}>{child}</LocaleProvider>,
  );
}

assert.match(localized('zh', <EmptyChatHero />), /开始对话|今天想做点什么/);
assert.match(localized('en', <EmptyChatHero />), /Start a conversation|what shall we tackle/);
assert.doesNotMatch(localized('en', <EmptyChatHero />), /今天想做点什么/);
```

Cover deep research, composer placeholder/buttons/import/mention/workspace states, message role labels, copy phases, reasoning, processing/continuing, truncation, branch lineage, dynamic user/session/path values, and both timestamp locales.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm --workspace @maka/ui test`

Expected: English assertions fail on the first remaining hardcoded Chinese label.

- [ ] **Step 3: Expand the catalog and migrate React owners**

Move all Maka-owned visible copy into `getConversationCopy(locale)`. Each component calls `useUiLocale()` once at its ownership boundary. Thread `copy` or `locale` into nested render helpers rather than reading the DOM or adding optional locale defaults.

Keep the dynamic portion unchanged:

```tsx
const locale = useUiLocale();
const copy = getConversationCopy(locale);
return <span>{copy.messages.lineageFrom(parentSessionName)}</span>;
```

Define locale-aware deep-research display arrays in the UI catalog; do not change the core explore-agent prompt constants.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `npm --workspace @maka/ui test`

Expected: all UI tests pass and English render output contains no migrated Chinese visible copy.

- [ ] **Step 5: Commit**

Commit message: `feat(locale): translate conversation and composer`

### Task 3: Localize permissions, questions, and session presentation

**Files:**
- Modify: `packages/ui/src/conversation-copy.ts`
- Modify: `packages/ui/src/permission-dialog.tsx`
- Modify: `packages/ui/src/permission-mode-menu.tsx`
- Modify: `packages/ui/src/user-question-prompt.tsx`
- Modify: `packages/ui/src/session-sidebar-nav.tsx`
- Modify: `packages/ui/src/session-history-list.tsx`
- Modify: `packages/ui/src/session-status-presentation.ts`
- Modify: `packages/ui/src/relative-time.tsx`
- Modify: `packages/ui/src/__tests__/conversation-localization.test.tsx`
- Create: `packages/ui/src/__tests__/session-presentation-localization.test.ts`

- [ ] **Step 1: Write failing permission/session tests**

Test representative permission kinds, one-shot permission memory, browser/computer-use details, user-question navigation, session statuses/blocked reasons, history grouping, counts, and accessibility labels in both locales. Test pure presenters with explicit locale:

```ts
assert.equal(presentSessionStatus('running', 'zh').label, '进行中');
assert.equal(presentSessionStatus('running', 'en').label, 'Running');
assert.equal(describeBlockedReason('permission_required', 'en'), 'Waiting for permission');
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `npm --workspace @maka/ui test`

Expected: the explicit locale presenter calls fail to compile and English permission/session renders contain Chinese labels.

- [ ] **Step 3: Migrate permission and session surfaces**

Change pure helper signatures to require locale:

```ts
export function presentSessionStatus(
  status: SessionStatus,
  locale: UiLocale,
): SessionStatusPresentation {
  const copy = getConversationCopy(locale).sessions;
  return { label: copy.status[status], tone: STATUS_TONE[status], interactive: STATUS_INTERACTIVE[status] };
}
```

Move permission descriptions, wait labels, buttons, detail summaries, question controls, session menus/groups/statuses, and accessibility labels into the catalog. Preserve commands, paths, tool names, session names, and user-entered answers verbatim.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `npm --workspace @maka/ui test`

Expected: all UI permission/session tests pass in both locales.

- [ ] **Step 5: Commit**

Commit message: `feat(locale): translate permissions and sessions`

### Task 4: Localize tool activity and every fake-backend result preview

**Files:**
- Modify: `packages/ui/src/tool-activity/copy.ts`
- Modify: `packages/ui/src/tool-activity.tsx`
- Modify: `packages/ui/src/tool-activity/trow-summary.ts`
- Modify: `packages/ui/src/tool-activity/presentation.ts`
- Modify: `packages/ui/src/tool-activity/result-projection.ts`
- Modify: `packages/ui/src/tool-activity/tool-result-preview.tsx`
- Modify: `packages/ui/src/tool-activity/builtin-preview.ts`
- Modify: `packages/ui/src/tool-activity/agent-preview.tsx`
- Modify: `packages/ui/src/tool-activity/preview-utils.ts`
- Modify: `packages/ui/src/__tests__/tool-activity-presentation.test.ts`
- Modify: `packages/ui/src/__tests__/tool-trow-summary.test.ts`
- Modify: `packages/ui/src/__tests__/tool-trow-stability.test.tsx`
- Create: `packages/ui/src/__tests__/tool-preview-localization.test.tsx`

- [ ] **Step 1: Write failing tool presentation tests**

Add bilingual tests for pending/running/permission/completed/failed/interrupted statuses, live-group count grammar, automation previews, background terminal status/output, office document results, web search failure/results, explore-agent summaries, copy feedback, truncation/redaction, and raw-diagnostic controls.

Assert raw data preservation:

```tsx
const raw = '用户自定义 stdout / User supplied output';
assert.match(renderTool('en', { kind: 'text', text: raw }), new RegExp(escapeRegExp(raw)));
```

- [ ] **Step 2: Run focused UI tests and verify RED**

Run: `npm --workspace @maka/ui test`

Expected: English tool renders contain Chinese-owned status/preview labels.

- [ ] **Step 3: Migrate tool copy and locale-thread pure helpers**

Use `getToolActivityCopy(locale)` for all owned labels. Require locale in pure helpers such as grouped summary, status projection, cancellation/timeout classification, and permission-denied normalization. Pass locale from the nearest component using `useUiLocale()`.

Do not translate or rewrite `item.args`, `result.text`, stdout, stderr, file paths, query strings, model/tool names, agent objectives, or generated reports.

- [ ] **Step 4: Run UI tests and verify GREEN**

Run: `npm --workspace @maka/ui test`

Expected: all UI tests pass; tool previews are coherent in Chinese and English and preserve raw data.

- [ ] **Step 5: Commit**

Commit message: `feat(locale): translate tool activity previews`

### Task 5: Localize desktop chat/session action errors and wire explicit locale

**Files:**
- Create: `apps/desktop/src/renderer/locales/conversation-copy.ts`
- Modify: `apps/desktop/src/renderer/app-shell-chat-actions.ts`
- Modify: `apps/desktop/src/renderer/app-shell-session-settings-actions.ts`
- Modify: `apps/desktop/src/renderer/app-shell-session-row-actions.ts`
- Modify: `apps/desktop/src/renderer/session-health-notice.ts`
- Modify: `apps/desktop/src/renderer/session-status-presentation.ts`
- Modify: `apps/desktop/src/renderer/app-shell.tsx`
- Create: `apps/desktop/src/main/__tests__/conversation-action-localization.test.ts`
- Modify: related desktop action/session tests

- [ ] **Step 1: Write failing desktop action tests**

Test that the action factories require `uiLocale`, select Chinese/English safe titles and fallbacks, preserve rollback/pending behavior, and never expose the raw exception:

```ts
const actions = createAppShellChatActions({ ...deps, uiLocale: 'en' });
await actions.sendMessage('hello');
assert.deepEqual(toasts.at(-1), {
  title: 'Send failed',
  description: 'The message could not be sent. Try again shortly.',
});
```

Add explicit-locale tests for session health and status detail presenters.

- [ ] **Step 2: Run focused desktop tests and verify RED**

Run: `npm --workspace @maka/desktop test`

Expected: factories do not accept `uiLocale` and return Chinese-only feedback.

- [ ] **Step 3: Add renderer catalog and thread locale**

Create a typed `UiCatalog<DesktopConversationCopy>` and pass the resolved `uiLocale` already owned by `AppShell` into each factory. Replace `generalizedErrorMessageChinese()` on migrated paths with existing safe classification plus locale-owned text; do not render raw provider/runtime responses.

- [ ] **Step 4: Run desktop tests and verify GREEN**

Run: `npm --workspace @maka/desktop test`

Expected: focused action/session tests pass. Windows-only symlink/path fixture failures, if any, are recorded separately and are not treated as PR 3 regressions.

- [ ] **Step 5: Commit**

Commit message: `feat(locale): translate desktop conversation feedback`

### Task 6: Prove the complete fake-backend journey and delivery gates

**Files:**
- Modify: `apps/desktop/src/main/__tests__/pr3-localized-copy-contract.test.ts`
- Create: `apps/desktop/src/main/__tests__/fake-backend-locale-journey.test.ts`
- Modify: any migrated test fixture that requires `LocaleProvider`

- [ ] **Step 1: Write the final failing journey assertions**

Build representative states for empty, streaming, permission waiting, question waiting, tool running, tool failed, completed, archived, and blocked sessions. Render or invoke the real presentation owners once with `zh` and once with `en`. Assert no reload callback, no English-to-Chinese fallback, identical dynamic values, and locale-correct `Intl` output.

- [ ] **Step 2: Run the final focused tests and verify RED if coverage is missing**

Run: `npm --workspace @maka/ui test && npm --workspace @maka/desktop test`

Expected: any remaining source-contract literal or unthreaded presenter fails with its exact file and line.

- [ ] **Step 3: Close only the reported PR 3 gaps**

Move each reported Maka-owned literal into the appropriate catalog or pass the resolved locale to the named helper. Add only evidence-based allowlist entries for non-visible protocol/data strings.

- [ ] **Step 4: Run delivery verification**

Run:

```powershell
$env:npm_config_registry='https://registry.npmjs.org/'
npx --yes npm@11.16.0 ci --ignore-scripts --no-audit --no-fund
npm run build
npm run typecheck
npm run lint
npm --workspace @maka/ui test
npm --workspace @maka/desktop test
git diff --check
```

Expected: build, typecheck, lint, UI tests, PR 3 contracts, and all relevant desktop suites pass. Any pre-existing Windows-only fixture failures are reproduced on upstream `main` and documented with exact evidence.

- [ ] **Step 5: Review and commit**

Audit the diff against every PR 3 requirement, verify the worktree contains no PR 2-only files, and commit remaining test adjustments with:

`test(locale): cover bilingual conversation journey`
