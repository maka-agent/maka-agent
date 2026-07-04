import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readProviderSettingsCombinedSource } from './provider-contract-source-helpers.js';
import { describe, it } from 'node:test';
import { readRendererContractCss } from './contract-css-helpers.js';
import { readRendererShellCombinedSource } from './renderer-shell-source-helpers.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');

// The model switcher / picker JSX lives in `chat-model-switcher.tsx`, the
// composer renders it from `composer.tsx`, and turn chips render in
// `chat-view.tsx`. These source-grep contracts assert behavior that spans the
// seam, so search their union.
async function readModelSwitcherUiSource(): Promise<string> {
  const [composer, chatView, switcher] = await Promise.all([
    readFile(resolve(REPO_ROOT, 'packages/ui/src/composer.tsx'), 'utf8'),
    readFile(resolve(REPO_ROOT, 'packages/ui/src/chat-view.tsx'), 'utf8'),
    readFile(resolve(REPO_ROOT, 'packages/ui/src/chat-model-switcher.tsx'), 'utf8'),
  ]);
  return `${composer}\n${chatView}\n${switcher}`;
}

describe('PR-SESSION-STICKY-MODEL-0 contract', () => {
  it('captures the ready model when creating a desktop session', async () => {
    const main = await readFile(resolve(REPO_ROOT, 'apps/desktop/src/main/main.ts'), 'utf8');

    assert.match(main, /const requestedSlug = input\?\.llmConnectionSlug \?\? \(await connectionStore\.getDefault\(\)\)/);
    assert.match(main, /const \{ connection, model \} = await getReadyConnection\(requestedSlug, input\?\.model\)/);
    assert.match(main, /runtime\.createSession\(\{[\s\S]*llmConnectionSlug: connection\.slug,[\s\S]*model,/);
  });

  it('validates sends against the session model, not the latest provider default', async () => {
    const readiness = await readFile(resolve(REPO_ROOT, 'apps/desktop/src/main/chat-readiness.ts'), 'utf8');
    const main = await readFile(resolve(REPO_ROOT, 'apps/desktop/src/main/main.ts'), 'utf8');

    assert.match(readiness, /assertSessionCanSend\([\s\S]*header: Pick<SessionHeader, 'backend' \| 'llmConnectionSlug' \| 'model'>/);
    assert.match(readiness, /requireReadyConnection\(header\.llmConnectionSlug, deps, header\.model\)/);
    assert.match(readiness, /normalizeRequestedModel\(connection, requestedModel\)/);
    assert.match(readiness, /CODEX_SUBSCRIPTION_UNSUPPORTED_CHATGPT_MODELS\.has\(requestedModel\)/);
    assert.match(main, /const \{ connection, apiKey, model \} = await getReadyConnection\(ctx\.header\.llmConnectionSlug, ctx\.header\.model\)/);
    assert.match(main, /header: \{ \.\.\.ctx\.header, model \}/);
    assert.match(main, /modelId: model/);
    assert.match(readiness, /Once a session has user messages, its connection\/model is sticky/);
    assert.match(readiness, /if \(header\.connectionLocked\) \{\s*throw error;\s*\}/);
  });

  it('preserves sticky model through branch sessions and session summaries', async () => {
    const runtime = await readFile(resolve(REPO_ROOT, 'packages/runtime/src/session-manager.ts'), 'utf8');
    const storage = await readFile(resolve(REPO_ROOT, 'packages/storage/src/session-store.ts'), 'utf8');
    const core = await readFile(resolve(REPO_ROOT, 'packages/core/src/session.ts'), 'utf8');

    assert.match(runtime, /branchFromTurn[\s\S]*model: header\.model/);
    assert.match(runtime, /model: h\.model/);
    assert.match(storage, /model: header\.model/);
    assert.match(core, /Sticky session default model id, captured when the session is created/);
  });

  it('surfaces the session model in the chat header and explains default-model scope', async () => {
    const renderer = await readRendererShellCombinedSource();
    const ui = await readModelSwitcherUiSource();
    const providers = await readProviderSettingsCombinedSource();

    assert.match(renderer, /normalizeActiveChatModel\(activeSession, activeConnection, chatModelChoices\)/);
    assert.match(ui, /本会话固定模型：\$\{props\.activeConnectionLabel\} · \$\{props\.activeModelLabel\}/);
    assert.match(ui, /设置里的默认模型只影响新建会话/);
    assert.match(providers, /默认模型只用于新建会话；已有会话会保留创建时的模型选择/);
  });

  it('lets the user explicitly switch the current session model from the chat header', async () => {
    const main = await readFile(resolve(REPO_ROOT, 'apps/desktop/src/main/main.ts'), 'utf8');
    const preload = await readFile(resolve(REPO_ROOT, 'apps/desktop/src/preload/preload.ts'), 'utf8');
    const globalTypes = await readFile(resolve(REPO_ROOT, 'apps/desktop/src/global.d.ts'), 'utf8');
    const renderer = await readRendererShellCombinedSource();
    const ui = await readModelSwitcherUiSource();
    const uiPrimitives = await readFile(resolve(REPO_ROOT, 'packages/ui/src/ui.tsx'), 'utf8');
    const styles = await readRendererContractCss();

    assert.match(main, /ipcMain\.handle\('sessions:setModel'[\s\S]*normalizeSessionModelSelection\(input\)/);
    assert.match(main, /getReadyConnection\(llmConnectionSlug, model\)/, 'model switch must reuse the send-path readiness gate');
    assert.match(main, /runtime\.updateSession\(sessionId, \{[\s\S]*llmConnectionSlug: ready\.connection\.slug,[\s\S]*model: ready\.model,[\s\S]*connectionLocked: true/);
    assert.match(main, /当前对话正在运行，等结束后再切换模型/);
    assert.match(main, /当前有工具调用正在等待确认，处理后再切换模型/);
    assert.match(preload, /setModel\(sessionId: string, input: \{ llmConnectionSlug: string; model: string \}\): Promise<SessionSummary>/);
    assert.match(globalTypes, /setModel\(sessionId: string, input: \{ llmConnectionSlug: string; model: string \}\): Promise<SessionSummary>/);
    assert.match(renderer, /modelChoices=\{chatModelChoices\}/);
    assert.match(renderer, /const pendingSessionModelChangesRef = useRef<Set<string>>\(new Set\(\)\);/);
    assert.match(renderer, /const \{[\s\S]*setPendingSessionModelBySession,[\s\S]*\} = useAppShellSessionUiState\(\);/);
    assert.match(renderer, /const \{[\s\S]*pendingSessionModelBySession,[\s\S]*\} = sessionUiState;/);
    assert.match(renderer, /const sessionId = activeIdRef\.current;[\s\S]*pendingSessionModelChangesRef\.current\.has\(sessionId\)[\s\S]*window\.maka\.sessions\.setModel\(sessionId, input\)[\s\S]*finally \{[\s\S]*pendingSessionModelChangesRef\.current\.delete\(sessionId\);/);
    assert.match(
      renderer,
      /pendingSessionModelChangesRef\.current\.add\(sessionId\);[\s\S]*setPendingSessionModelBySession\(\(current\) => \(\{ \.\.\.current, \[sessionId\]: true \}\)\);/,
      'app shell must expose per-session model pending state so switching away and back does not make a guarded request look idle',
    );
    assert.match(renderer, /delete next\[sessionId\];/);
    assert.match(
      renderer,
      /const next = await window\.maka\.sessions\.setModel\(sessionId, input\);[\s\S]*setSessions\([\s\S]*if \(activeIdRef\.current === sessionId\) \{[\s\S]*toastApi\.success\([\s\S]*已切换当前会话模型/,
      'model switch success toast must only describe the current session when the original session is still active',
    );
    assert.match(
      renderer,
      /catch \(error\) \{[\s\S]*if \(activeIdRef\.current === sessionId\) toastApi\.error\('切换模型失败', generalizedErrorMessageChinese\(error, '模型暂时无法切换，请稍后重试。'\)\);[\s\S]*\} finally/,
      'model switch failure toast must not surface stale failures after the user switches sessions',
    );
    assert.doesNotMatch(
      renderer,
      /toastApi\.error\('切换模型失败', cleanErrorMessage\(error\)\)/,
      'model switch failures must not echo raw cleaned Error.message in visible toast feedback',
    );
    assert.match(renderer, /onModelChange=\{\(input\) => setSessionModel\(input\)\}/);
    assert.doesNotMatch(renderer, /onModelChange=\{\(input\) => void setSessionModel\(input\)\}/);
    assert.match(renderer, /modelChangePending=\{activeId \? pendingSessionModelBySession\[activeId\] === true : false\}/);
    assert.match(renderer, /buildCatalogChatModelChoices\(connections\)/);
    const catalogChoices = await readFile(resolve(REPO_ROOT, 'apps/desktop/src/renderer/model-catalog-choices.ts'), 'utf8');
    assert.match(catalogChoices, /PROVIDER_DEFAULTS\[connection\.providerType\]/);
    assert.match(
      catalogChoices,
      /buildConnectionModelCatalogEntries\(\{ connection, savedModelIds \}\)/,
      'chat model choices must derive candidates from the shared model catalog',
    );
    assert.match(catalogChoices, /CODEX_SUBSCRIPTION_UNSUPPORTED_CHATGPT_MODELS\.has\(entry\.id\.trim\(\)\)/);
    assert.match(ui, /function ChatModelSwitcher/);
    assert.match(ui, /modelChangePending\?: boolean/);
    assert.match(ui, /pending=\{props\.modelChangePending\}/);
    assert.match(ui, /activeModel\?: string/);
    assert.match(ui, /const currentModel = props\.activeModel \?\? props\.activeSession\.model/);
    assert.match(ui, /aria-label="切换当前会话模型"/);
    assert.match(ui, /pending\?: boolean/);
    assert.match(ui, /const \[localPending,\s*setLocalPending\] = useState\(false\);/);
    assert.match(ui, /const pendingRef = useRef\(false\);/);
    assert.match(ui, /const pending = props\.pending \|\| localPending;/);
    assert.match(ui, /const modelSwitcherMountedRef = useRef\(true\);/);
    assert.match(ui, /const pendingModelChangeRef = useRef<\{ sessionId: string; token: number \} \| null>\(null\);/);
    assert.match(ui, /const pendingModelChangeTokenRef = useRef\(0\);/);
    assert.match(
      ui,
      /useEffect\(\(\) => \{[\s\S]*modelSwitcherMountedRef\.current = true;[\s\S]*return \(\) => \{[\s\S]*modelSwitcherMountedRef\.current = false;[\s\S]*pendingModelChangeRef\.current = null;[\s\S]*pendingModelChangeTokenRef\.current \+= 1;[\s\S]*pendingRef\.current = false;[\s\S]*\};[\s\S]*\}, \[\]\);/,
      'model switcher must release pending ownership when the chat header unmounts',
    );
    assert.match(
      ui,
      /useEffect\(\(\) => \{[\s\S]*pendingModelChangeRef\.current\?\.sessionId === props\.activeSession\.id[\s\S]*pendingModelChangeRef\.current = null;[\s\S]*pendingModelChangeTokenRef\.current \+= 1;[\s\S]*pendingRef\.current = false;[\s\S]*setLocalPending\(false\);[\s\S]*\}, \[props\.activeSession\.id\]\);/,
      'model switcher must release row-local pending state when the active session changes',
    );
    assert.match(ui, /if \(pendingRef\.current \|\| props\.pending\) return;/);
    assert.match(ui, /const sessionId = props\.activeSession\.id;[\s\S]*const token = pendingModelChangeTokenRef\.current \+ 1;[\s\S]*pendingModelChangeRef\.current = \{ sessionId, token \};/);
    assert.match(
      ui,
      /void \(async \(\) => \{[\s\S]*try \{[\s\S]*await props\.onChange\?\.\(next\);[\s\S]*\} catch \{[\s\S]*\} finally \{[\s\S]*const owner = pendingModelChangeRef\.current;[\s\S]*modelSwitcherMountedRef\.current && owner\?\.sessionId === sessionId && owner\.token === token[\s\S]*pendingModelChangeRef\.current = null;[\s\S]*pendingRef\.current = false;[\s\S]*setLocalPending\(false\);/,
      'model switcher must only clear pending state for the matching session/token owner',
    );
    assert.match(ui, /aria-busy=\{pending \? 'true' : undefined\}/);
    assert.match(ui, /data-pending=\{pending \? 'true' : undefined\}/);
    assert.match(ui, /<SelectRoot<string>[\s\S]*items=\{modelSelectItems\}[\s\S]*value=\{currentValue\}[\s\S]*onValueChange=\{\(value\) => \{/);
    assert.match(ui, /<SelectPositioner alignItemWithTrigger=\{false\} sideOffset=\{8\}/);
    assert.match(ui, /<SelectList>/);
    // The grouped menu renders provider groups keyed by connection, each heading
    // carrying the injected brand mark (kept out of @maka/ui via renderProviderMark),
    // on the shared `.settingsSelectMenu*` recipe.
    assert.match(ui, /<SelectGroup key=\{group\.connectionSlug\}/);
    assert.match(ui, /renderProviderMark\?\.\(group\.providerType\)/);
    assert.match(ui, /className="settingsSelectMenuGroupLogo"/);
    assert.match(uiPrimitives, /<span className="flex h-4 w-4 items-center justify-center" aria-hidden="true">[\s\S]*<BaseSelect\.ItemIndicator>/);
    assert.match(uiPrimitives, /<span className="min-w-0">[\s\S]*<BaseSelect\.ItemText>\{children\}<\/BaseSelect\.ItemText>/);
    assert.doesNotMatch(ui, /<select\b[\s\S]*aria-label="切换当前会话模型"/);
    assert.match(ui, /<span className="maka-model-switcher-label">\{pending \? '切换中' : '模型'\}<\/span>/);
    assert.match(styles, /\.maka-model-switcher\s*\{/);
    assert.match(styles, /\.maka-model-switcher\[data-pending="true"\]\s*\{[\s\S]*cursor: progress;[\s\S]*\}/);
    assert.match(styles, /\.maka-model-switcher-trigger\s*\{/);
    // Popup/positioner/rows now come from the shared settings-select menu recipe
    // (the bespoke `.maka-model-switcher-popup` chrome was folded into it); the
    // trigger above stays the composer pill.
    assert.match(styles, /\.settingsSelectMenuPopup\s*\{/);
    assert.match(styles, /\.settingsSelectMenuPopup \[role="option"\]\s*\{[\s\S]*min-height: 32px;[\s\S]*\}/);
  });

  it('flags per-turn model departures against the session sticky model', async () => {
    const ui = await readModelSwitcherUiSource();

    assert.match(ui, /props\.activeSession\?\.model && props\.activeSession\.model\.length > 0/);
    assert.match(ui, /previousModelId=\{expectedModelId\}/);
    assert.match(ui, /本轮使用 \$\{turn\.modelId\}，session 期望 \$\{props\.previousModelId\}/);
    assert.match(ui, /本轮切换了模型/);
  });
});
