/**
 * Static-analysis contract for the OAuth model-provider catalog in
 * `apps/desktop/src/renderer/settings/ProvidersPanel.tsx`
 * (PR-MODEL-OAUTH-ALL-0).
 *
 * Pins the user-visible OAuth login surface: four cards
 * (claude / codex / antigravity / cursor), each marked
 * `status: 'available'`, and each click wires through to its
 * matching `window.maka.<provider>Subscription` bridge namespace.
 *
 * This is a source-grep contract, not a DOM render — we don't
 * pull React into the desktop test runner. Stamp shapes are
 * verified by reading the panel source.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(process.cwd(), '..', '..');
const PROVIDERS_PANEL_SOURCE = resolve(
  REPO_ROOT,
  'apps',
  'desktop',
  'src',
  'renderer',
  'settings',
  'ProvidersPanel.tsx',
);
const MAIN_SOURCE = resolve(REPO_ROOT, 'apps', 'desktop', 'src', 'main', 'main.ts');
const PRELOAD_SOURCE = resolve(REPO_ROOT, 'apps', 'desktop', 'src', 'preload', 'preload.ts');

describe('Model OAuth catalog contract (PR-MODEL-OAUTH-ALL-0 + PR-CLAUDE-CARD-MOVE-0)', () => {
  it('renders OAuth as a catalog tab peer, not a standalone section above the market', async () => {
    const src = await readFile(PROVIDERS_PANEL_SOURCE, 'utf8');
    const tabs = src.match(/const CATALOG_TABS:[\s\S]*?\];/);
    assert.ok(tabs, 'CATALOG_TABS literal must exist');
    assert.match(tabs[0], /id:\s*'oauth'[\s\S]*label:\s*'OAuth'/, 'OAuth must be a catalog tab');
    assert.match(
      src,
      /catalogTab === 'oauth'\s*\?\s*\(\s*<ModelOAuthSection\s+onConnectionsChanged=\{reload\}\s*\/>/,
      'OAuth login UI must render from the tab content branch and refresh enabled models',
    );
    const marketStart = src.indexOf('<section className="providerMarket">');
    const firstOAuthRender = src.indexOf('<ModelOAuthSection');
    assert.ok(marketStart !== -1, 'provider market section must exist');
    assert.ok(firstOAuthRender > marketStart, 'ModelOAuthSection must not be pinned above providerMarket');
    assert.doesNotMatch(src, /providerOAuthHeader/, 'OAuth tab must not carry a second standalone section header');
  });

  it('catalog tabs support keyboard navigation as a real tablist', async () => {
    const src = await readFile(PROVIDERS_PANEL_SOURCE, 'utf8');
    const handler = src.match(/function onCatalogTabsKeyDown[\s\S]*?\n  \}/)?.[0] ?? '';
    const tablist = src.match(/<div\s+className="catalogTabs catalogPillTabs"[\s\S]*?\{catalogTab === 'oauth'/)?.[0] ?? '';

    assert.match(handler, /nextRadioId\(catalogTab, visibleTabs, event\.key\)/);
    assert.match(handler, /event\.preventDefault\(\)/);
    assert.match(handler, /setCatalogTab\(next\)/);
    assert.match(handler, /data-catalog-tab="\$\{CSS\.escape\(next\)\}"/);
    assert.match(handler, /focus\(\{ preventScroll: true \}\)/);
    assert.match(tablist, /role="tablist"[\s\S]*aria-label="模型供应商分类"[\s\S]*onKeyDown=\{onCatalogTabsKeyDown\}/);
    assert.match(tablist, /role="tab"[\s\S]*aria-selected=\{catalogTab === tab\.id\}/);
    assert.match(tablist, /data-catalog-tab=\{tab\.id\}/);
    assert.match(tablist, /tabIndex=\{catalogTab === tab\.id \? 0 : -1\}/);
  });

  it('ProvidersPanel surfaces model connection reload failures instead of sticking on loading', async () => {
    const src = await readFile(PROVIDERS_PANEL_SOURCE, 'utf8');
    const reloadMatch = src.match(/async function reload\(\) \{[\s\S]*?\n  \}/);
    assert.ok(reloadMatch, 'ProvidersPanel reload() must exist');
    assert.match(
      reloadMatch[0],
      /try \{[\s\S]*Promise\.all\(\[[\s\S]*bridge\.list\(\),[\s\S]*bridge\.getDefault\(\),[\s\S]*\]\)[\s\S]*setLoadError\(null\)[\s\S]*setLoading\(false\)/,
      'successful reload must clear load error and exit loading state',
    );
    assert.match(
      reloadMatch[0],
      /catch \(error\) \{[\s\S]*providerPanelActionErrorMessage\(error\)[\s\S]*setLoadError\(message\)[\s\S]*setLoading\(false\)[\s\S]*toast\.error\('载入模型连接失败', message\)/,
      'failed reload must not leave the provider panel in a skeleton-only state',
    );
    assert.match(
      src,
      /loadError \? \([\s\S]*模型连接载入失败[\s\S]*点击重试/,
      'enabled-model strip must show a retryable load-failure state',
    );
  });

  it('provider detail actions localize and sanitize model-test / model-fetch failures', async () => {
    const providers = await readFile(PROVIDERS_PANEL_SOURCE, 'utf8');
    const main = await readFile(MAIN_SOURCE, 'utf8');
    const detail = providers.match(/function ConnectionDetail[\s\S]*?function ModelTable/)?.[0] ?? '';
    const addForm = providers.match(/function AddProviderForm[\s\S]*?function nextSlug/)?.[0] ?? '';

    assert.match(
      providers,
      /generalizedErrorMessageChinese\(error,\s*'模型连接服务暂时不可用，请稍后重试。'\)/,
      'provider action errors must go through the Chinese redaction classifier before reaching toast detail',
    );
    assert.match(
      providers,
      /function connectionTestFailureMessage\(result: ConnectionTestResult, troubleshootingCopy: string\)[\s\S]*generalizedErrorMessageChinese\(new Error\(result\.errorMessage\), fallback\)/,
      'failed connection tests must not toast raw provider response bodies',
    );
    assert.match(
      detail,
      /toast\.error\([\s\S]*`连接失败 · \$\{connection\.name\}`,[\s\S]*connectionTestFailureMessage\(result, credentialTroubleshootingCopy\)/,
      'ConnectionDetail test failure toast must use localized sanitized copy',
    );
    assert.match(
      detail,
      /catch \(error\) \{[\s\S]*const message = providerPanelActionErrorMessage\(error\);[\s\S]*toast\.error\(`连接测试出错 · \$\{connection\.name\}`, message\)/,
      'ConnectionDetail test IPC failures must use the shared localized action-error helper',
    );
    assert.match(
      detail,
      /catch \(error\) \{[\s\S]*const message = providerPanelActionErrorMessage\(error\);[\s\S]*toast\.error\([\s\S]*`拉取模型失败 · \$\{connection\.name\}`,[\s\S]*`\$\{message\} · 当前继续显示静态列表/,
      'ConnectionDetail model-fetch failures must use the shared localized action-error helper',
    );
    assert.doesNotMatch(
      detail,
      /error instanceof Error \? error\.message : String\(error\)/,
      'provider detail action toasts must not directly echo raw Error.message',
    );
    assert.match(
      addForm,
      /catch \(err\) \{[\s\S]*setError\(providerPanelActionErrorMessage\(err\)\)/,
      'AddProviderForm create failures must use the shared localized action-error helper',
    );
    assert.doesNotMatch(
      addForm,
      /setError\(err instanceof Error \? err\.message : String\(err\)\)/,
      'AddProviderForm must not render raw create-connection Error.message inline',
    );
    assert.match(
      main,
      /connections:fetchModels[\s\S]*generalizedErrorMessageChinese\(error,\s*'拉取模型列表失败'\)/,
      'main-process fetchModels errors must be localized before crossing IPC to renderer toasts',
    );
    assert.doesNotMatch(
      main,
      /No OAuth login stored for this connection|No API key set for this connection|Failed to fetch provider models/,
      'main-process model connection IPC must not throw English user-visible fallback copy',
    );
  });

  it('provider config sheets expose their own accessible close button', async () => {
    const src = await readFile(PROVIDERS_PANEL_SOURCE, 'utf8');
    const styles = await readFile(resolve(REPO_ROOT, 'apps', 'desktop', 'src', 'renderer', 'styles.css'), 'utf8');
    const overlay = src.match(/function ProviderConfigSheetOverlay[\s\S]*?function ProviderCatalogCard/)?.[0] ?? '';

    assert.match(overlay, /className="providerConfigSheetClose"/);
    assert.match(overlay, /aria-label="关闭模型配置"/);
    assert.match(overlay, /<X strokeWidth=\{1\.75\} aria-hidden="true" \/>/);
    assert.match(styles, /\.providerConfigSheet\s*\{[\s\S]*position:\s*relative;/);
    assert.match(styles, /\.providerConfigSheetClose\s*\{[\s\S]*position:\s*absolute;[\s\S]*right:\s*14px;/);
    assert.match(styles, /\.providerConfigSheetClose:focus-visible\s*\{[\s\S]*outline:\s*2px solid var\(--accent\);/);
  });

  it('provider config sheets hide the blurred Settings background from accessibility', async () => {
    const src = await readFile(PROVIDERS_PANEL_SOURCE, 'utf8');
    const hook = src.match(/function useProviderSheetBackgroundInert[\s\S]*?function ProviderCatalogCard/)?.[0] ?? '';

    assert.match(
      src,
      /useProviderSheetBackgroundInert\(dialogRef\)/,
      'every provider config / OAuth sheet must activate the background inert hook',
    );
    assert.match(
      hook,
      /dialog\.closest\('\.settingsSurface'\)/,
      'nested provider sheets must scope background hiding to the Settings modal surface',
    );
    assert.match(
      hook,
      /sibling\.setAttribute\('aria-hidden', 'true'\)/,
      'blurred Settings background siblings must be hidden from assistive tech',
    );
    assert.match(
      hook,
      /sibling\.inert = true/,
      'blurred Settings background siblings must be inert while the sheet is open',
    );
    assert.match(
      hook,
      /data-provider-sheet-background-hidden/,
      'the hidden background state should be observable for regression tests',
    );
    assert.match(
      hook,
      /item\.element\.inert = item\.inert/,
      'background inert state must be restored when the sheet closes',
    );
  });

  it('does not auto-open the first provider config sheet after loading connections', async () => {
    // WAWQAQ goal sweep: Settings -> 模型 kept reopening the first
    // provider config sheet on every Settings open because reload()
    // defaulted selectedSlug to list[0]. A model list refresh should
    // preserve an already-open sheet if that connection still exists,
    // but it must not select the first provider by default.
    const src = await readFile(PROVIDERS_PANEL_SOURCE, 'utf8');
    const reloadBlock = src.match(/async function reload\(\)[\s\S]*?^\s*\}/m)?.[0] ?? '';

    assert.match(reloadBlock, /setSelectedSlug\(\(current\) =>[\s\S]*list\.some\(\(connection\) => connection\.slug === current\)/);
    assert.match(reloadBlock, /\?\s*current\s*:\s*null/);
    assert.doesNotMatch(reloadBlock, /current\s*\?\?\s*list\[0\]\?\.slug/, 'reload must not auto-select the first provider');
  });

  it('enabled model chips expose a concise aria-label instead of concatenated duplicate visible text', async () => {
    const src = await readFile(PROVIDERS_PANEL_SOURCE, 'utf8');

    assert.match(
      src,
      /function chipAriaLabel\(connection: LlmConnection\): string/,
      'enabled model chips need a dedicated accessible name',
    );
    assert.match(
      src,
      /function chipStatusText\(connection: LlmConnection\): string/,
      'status copy must be a dedicated helper, not parsed out of the chip title',
    );
    assert.match(
      src,
      /已启用模型：\$\{connection\.name\}，供应商：\$\{provider\}/,
      'enabled model chip aria-label must describe the model and provider explicitly',
    );
    assert.match(
      src,
      /aria-label=\{chipAriaLabel\(connection\)\}/,
      'enabled model chip buttons must use the dedicated accessible name',
    );
    assert.doesNotMatch(
      src,
      /chipStatusLabel\(connection\)\.split\(' · '\)/,
      'connection names can contain " · ", so status text must not be recovered by splitting the title',
    );
  });

  it('provider catalog cards expose explicit names and localized custom-provider copy', async () => {
    const src = await readFile(PROVIDERS_PANEL_SOURCE, 'utf8');
    const card = src.match(/function ProviderCatalogCard[\s\S]*?function providerDisabledStatus/)?.[0] ?? '';

    assert.match(
      src,
      /function providerCatalogAriaLabel\(display: ReturnType<typeof providerDisplay>, count: number\): string/,
      'provider catalog cards need a dedicated accessible name instead of concatenated badge/title/description text',
    );
    assert.match(
      card,
      /aria-label=\{providerCatalogAriaLabel\(display, props\.count\)\}/,
      'ready provider catalog buttons must use the dedicated accessible name',
    );
    assert.match(
      src,
      /添加模型供应商：\$\{display\.name\}/,
      'provider catalog accessible name should start from the user action and provider name',
    );
    assert.match(
      src,
      /parts\.push\(display\.description\.replace\(\/\[。\.!！？\?\]\+\$\/u, ''\)\)/,
      'provider catalog accessible name should trim sentence punctuation before joining follow-up status parts',
    );
    assert.match(
      src,
      /if \(display\.badge\) parts\.push\(`标签：\$\{display\.badge\}`\)/,
      'provider badges must be separated in the accessible name instead of glued to the provider name',
    );
    assert.match(src, /自定义 OpenAI 兼容接口/);
    assert.match(src, /添加 OpenAI 兼容接口/);
    assert.match(src, /OpenAI 兼容协议/);
    assert.doesNotMatch(
      src,
      /OpenAI-compatible|endpoint/,
      'model provider settings visible copy must not mix English technical fallback such as OpenAI-compatible endpoint',
    );
  });

  it('exposes exactly four equal OAuth cards: claude, codex, antigravity, cursor', async () => {
    // WAWQAQ msg 8bb7e186: Claude must not be a huge standalone
    // inline card while the other OAuth providers are compact
    // cards. All four login entries live in the same grid.
    const src = await readFile(PROVIDERS_PANEL_SOURCE, 'utf8');
    const match = src.match(/MODEL_OAUTH_CARDS:\s*ReadonlyArray<ModelOAuthCard>\s*=\s*\[([\s\S]*?)\];/);
    assert.ok(match, 'MODEL_OAUTH_CARDS literal must exist');
    const body = match[1]!;
    const ids = [...body.matchAll(/id:\s*'([a-z]+)'/g)].map((m) => m[1]);
    assert.deepEqual(
      ids.sort(),
      ['antigravity', 'claude', 'codex', 'cursor'],
      'grid must include exactly claude / codex / antigravity / cursor',
    );
  });

  it('every card declares status: "available" (no more "planned" placeholders)', async () => {
    const src = await readFile(PROVIDERS_PANEL_SOURCE, 'utf8');
    const match = src.match(/MODEL_OAUTH_CARDS:\s*ReadonlyArray<ModelOAuthCard>\s*=\s*\[([\s\S]*?)\];/);
    assert.ok(match, 'MODEL_OAUTH_CARDS literal must exist');
    const body = match[1]!;
    const statuses = [...body.matchAll(/status:\s*'([a-z_]+)'/g)].map((m) => m[1]);
    assert.equal(statuses.length, 4, 'each card must declare a status');
    for (const s of statuses) {
      assert.equal(s, 'available', `card status must be 'available', got '${s}'`);
    }
    assert.doesNotMatch(body, /'planned'/, 'no card may still claim "planned" status');
  });

  it('wired OAuth provider copy does not say account login is separate from model connections', async () => {
    const src = await readFile(PROVIDERS_PANEL_SOURCE, 'utf8');
    assert.doesNotMatch(
      src,
      /账号登录不作为模型连接|这类账号登录不会出现在模型连接入口|当前请使用 API key 连接聊天模型|默认隐藏/,
      'Claude/Codex OAuth copy must reflect that successful login creates a usable model connection',
    );
    assert.match(
      src,
      /Claude Pro \/ Max 订阅账号登录；登录后自动成为可用模型连接/,
      'Claude provider display copy must point to the wired OAuth model connection path',
    );
    assert.match(
      src,
      /ChatGPT \/ Codex 账号登录；登录后自动成为可用模型连接/,
      'Codex provider display copy must point to the wired OAuth model connection path',
    );
    assert.match(
      src,
      /Google 账号登录暂未接入聊天发送/,
      'unwired OAuth providers must still fail closed without claiming they are wired',
    );
  });

  it('OAuth model connection detail treats Base URL as fixed provider metadata, not an editable endpoint', async () => {
    const src = await readFile(PROVIDERS_PANEL_SOURCE, 'utf8');
    const detail = src.match(/function ConnectionDetail[\s\S]*?function ModelTable/)?.[0] ?? '';

    assert.match(
      detail,
      /const hasFixedOAuthBaseUrl = needsOAuth && Boolean\(defaults\.baseUrl\)/,
      'ConnectionDetail must detect fixed OAuth provider endpoints',
    );
    assert.match(
      detail,
      /baseUrl:\s*hasFixedOAuthBaseUrl\s*\?\s*defaults\.baseUrl\s*:\s*baseUrl \|\| undefined/,
      'saving an OAuth connection must submit the provider default endpoint, not renderer-edited text',
    );
    assert.match(
      detail,
      /value=\{hasFixedOAuthBaseUrl \? defaults\.baseUrl : baseUrl\}/,
      'OAuth Base URL input must display the canonical provider endpoint',
    );
    assert.match(
      detail,
      /readOnly=\{hasFixedOAuthBaseUrl\}/,
      'OAuth Base URL must be read-only in the provider detail sheet',
    );
    assert.match(
      detail,
      /aria-readonly=\{hasFixedOAuthBaseUrl \? 'true' : undefined\}/,
      'the fixed OAuth Base URL state must be exposed to assistive tech',
    );
  });

  it('does not let disabled OAuth connections become the default model', async () => {
    const src = await readFile(PROVIDERS_PANEL_SOURCE, 'utf8');
    const detail = src.match(/function ConnectionDetail[\s\S]*?function ModelTable/)?.[0] ?? '';

    assert.match(
      detail,
      /if \(!connection\.enabled\) \{[\s\S]*toast\.error\('无法设为默认'/,
      'ConnectionDetail must guard against stale disabled connections before setDefault',
    );
    assert.match(
      detail,
      /!\s*props\.isDefault && connection\.enabled && <button className="maka-button" type="button" onClick=\{setAsDefault\}>设为默认<\/button>/,
      'disabled connections must not render the set-default action',
    );
  });

  it('does not leave Save enabled when an existing connection has no draft changes', async () => {
    const src = await readFile(PROVIDERS_PANEL_SOURCE, 'utf8');
    const detail = src.match(/function ConnectionDetail[\s\S]*?function ModelTable/)?.[0] ?? '';

    assert.match(
      detail,
      /const hasSaveChanges =[\s\S]*apiKey\.length > 0[\s\S]*draftBaseUrl !== savedBaseUrl[\s\S]*defaultModel !== connection\.defaultModel/,
      'ConnectionDetail must compute dirty state from the fields that Save actually writes',
    );
    assert.match(
      detail,
      /disabled=\{busy \|\| !hasSaveChanges\}/,
      'Save must be disabled until the user changes a writable field',
    );
  });

  it('surfaces provider detail save/delete failures instead of leaking rejected promises from actions', async () => {
    const src = await readFile(PROVIDERS_PANEL_SOURCE, 'utf8');
    const detail = src.match(/function ConnectionDetail[\s\S]*?function ModelTable/)?.[0] ?? '';

    assert.match(
      detail,
      /async function save\(\) \{[\s\S]*let saved = false;[\s\S]*await props\.bridge\.update\(connection\.slug,[\s\S]*saved = true;[\s\S]*catch \(error\) \{[\s\S]*toast\.error\([\s\S]*saved \? '刷新模型连接失败' : '保存模型连接失败'/,
      'ConnectionDetail save failures and post-save refresh failures must be visible',
    );
    assert.match(
      detail,
      /async function remove\(\) \{[\s\S]*setBusy\(true\);[\s\S]*let deleted = false;[\s\S]*await props\.bridge\.delete\(connection\.slug\);[\s\S]*deleted = true;[\s\S]*await props\.onDeleted\(\);[\s\S]*catch \(error\) \{[\s\S]*toast\.error\([\s\S]*deleted \? '刷新模型列表失败' : '删除模型连接失败'/,
      'ConnectionDetail delete failures and post-delete refresh failures must be visible',
    );
    assert.match(
      detail,
      /<button className="maka-button" data-variant="destructive" type="button" disabled=\{busy\} onClick=\{remove\}>删除<\/button>/,
      'Delete should be disabled while provider detail actions are busy',
    );
  });

  it('surfaces provider detail credential-presence probe failures', async () => {
    const src = await readFile(PROVIDERS_PANEL_SOURCE, 'utf8');
    const detail = src.match(/function ConnectionDetail[\s\S]*?function ModelTable/)?.[0] ?? '';

    assert.match(src, /type CredentialPresenceStatus = boolean \| 'loading' \| 'error'/);
    assert.match(detail, /useState<CredentialPresenceStatus>\([\s\S]*defaults\.authKind === 'none' \? true : 'loading'/);
    assert.match(detail, /const credentialProbePending = requiresCredential && \(hasSecret === 'loading' \|\| hasSecret === 'error'\)/);
    assert.match(detail, /const hasUsableCredential = !requiresCredential \|\| hasSecret === true/);
    assert.match(
      detail,
      /props\.bridge[\s\S]*\.hasSecret\(connection\.slug\)[\s\S]*\.then\(setHasSecret\)[\s\S]*\.catch\(\(error\) => \{[\s\S]*setHasSecret\('error'\);[\s\S]*toast\.error\('读取模型凭据状态失败', providerPanelActionErrorMessage\(error\)\)/,
      'ConnectionDetail must show a visible error and keep unknown credential state distinct when probing fails',
    );
    assert.doesNotMatch(
      detail,
      /catch\(\(error\) => \{[\s\S]*setHasSecret\(false\)/,
      'credential-presence probe failures must not be downgraded to missing credentials',
    );
    assert.match(detail, /role="alert"[\s\S]*模型凭据状态暂时没刷新成功，已避免把未知状态显示成未登录或未配置/);
    assert.match(detail, /canRefresh=\{!fetchingModels && hasUsableCredential\}/);
    assert.match(detail, /disabled=\{testing \|\| !hasUsableCredential\}/);
    assert.doesNotMatch(
      detail,
      /void props\.bridge\.hasSecret\(connection\.slug\)\.then\(setHasSecret\);/,
      'ConnectionDetail must not leave credential-presence probe rejections unhandled',
    );
  });

  it('keeps an open provider detail sheet in sync with refreshed connection props without clobbering dirty drafts', async () => {
    // task #38 sweep: OAuth login/model refresh can update the same
    // connection while its detail sheet is open. State initialized from
    // props via useState would otherwise keep showing stale models /
    // defaultModel until the sheet is closed and reopened.
    const src = await readFile(PROVIDERS_PANEL_SOURCE, 'utf8');
    const detail = src.match(/function ConnectionDetail[\s\S]*?function ModelTable/)?.[0] ?? '';

    assert.match(
      src,
      /function connectionDetailSnapshot\([\s\S]*connection: LlmConnection,[\s\S]*defaultBaseUrl: string \| undefined,[\s\S]*\): ConnectionDetailSnapshot/,
      'ConnectionDetail must capture the last synced connection snapshot',
    );
    assert.match(
      detail,
      /useState\(connection\.baseUrl \?\? defaults\.baseUrl \?\? ''\)/,
      'ConnectionDetail must normalize an absent Base URL to an empty controlled input value',
    );
    assert.match(
      src,
      /function connectionDetailDraftMatchesSnapshot\(/,
      'ConnectionDetail must compare local draft state before syncing props',
    );
    assert.match(
      detail,
      /const syncedConnectionSnapshotRef = useRef\(connectionDetailSnapshot\(connection, defaults\.baseUrl\)\)/,
      'ConnectionDetail must keep a stable baseline for stale-prop detection',
    );
    assert.match(
      detail,
      /connection\.slug !== previousSnapshot\.slug \|\| \(apiKey\.length === 0 && localStillSynced\)/,
      'same-slug prop refresh should sync only when the local draft is still clean',
    );
    assert.match(
      detail,
      /setBaseUrl\(nextSnapshot\.baseUrl\)[\s\S]*setDefaultModel\(nextSnapshot\.defaultModel\)[\s\S]*setModels\(nextSnapshot\.models\)[\s\S]*setModelSource\(nextSnapshot\.modelSource\)/,
      'prop refresh must update every draft field derived from connection props',
    );
    assert.match(
      detail,
      /if \(localAlreadyMatchesNext\) \{[\s\S]*syncedConnectionSnapshotRef\.current = nextSnapshot/,
      'when local fetch state already matches new props, the baseline must advance',
    );
  });

  it('claude opens a modal from the equal-size card instead of rendering a full inline card above the grid', async () => {
    const src = await readFile(PROVIDERS_PANEL_SOURCE, 'utf8');
    const sectionMatch = src.match(/function ModelOAuthSection[\s\S]*?function ClaudeSubscriptionModal/);
    assert.ok(sectionMatch, 'ModelOAuthSection and ClaudeSubscriptionModal must exist');
    assert.doesNotMatch(
      sectionMatch[0],
      /<ClaudeSubscriptionCard\s*\/>/,
      'ModelOAuthSection must not render the full Claude card inline above the OAuth grid',
    );
    assert.match(
      src,
      /openModal === 'claude'[\s\S]*<ClaudeSubscriptionModal/,
      'Claude card must open the provider-specific modal',
    );
    assert.doesNotMatch(
      src,
      /maka:jumpToSettingsSection[\s\S]*?'account'/,
      'after the card move, ModelOAuthSection must NOT jump to the account section',
    );
    assert.match(
      src,
      /setOpenModal\(card\.id\)/,
      'all OAuth cards must open a modal from the grid',
    );
  });

  it('ModelOAuthSection re-fetches account state on modal close so card badges stay live (PR-OAUTH-CARD-LIVE-STATE-0)', async () => {
    // WAWQAQ msg d79fd115 follow-up: after a user completed the
    // OAuth flow in SubscriptionLoginModal, the parent card still
    // showed "可用 / 预览" — no live login indicator. The fix
    // lifts a per-service snapshot map into the section and
    // refreshes on every modal close (success OR cancel).
    const src = await readFile(PROVIDERS_PANEL_SOURCE, 'utf8');
    // 1. cardStates map keyed by service id must exist.
    assert.match(
      src,
      /cardStates\s*,\s*setCardStates\b/,
      'ModelOAuthSection must track per-service snapshots',
    );
    // 2. refreshAllCards must call getAccountState for each card.
    assert.match(
      src,
      /async function refreshAllCards\(\)/,
      'must define refreshAllCards()',
    );
    assert.match(
      src,
      /getSubscriptionSnapshot\(card\.id\)/,
      'refreshAllCards must query each subscription snapshot',
    );
    // 3. useEffect on mount fires the initial refresh.
    const refreshOnMount = src.match(/useEffect\(\(\) =>\s*\{\s*void refreshAllCards\(\);[\s\S]*?\},\s*\[\]\)/);
    assert.ok(refreshOnMount, 'ModelOAuthSection must refresh on mount');
    // 4. Modal onClose triggers a re-fetch through a helper that also
    // catches enabled-model refresh failures.
    assert.match(
      src,
      /async function refreshAfterModalClose\(\)[\s\S]*?await refreshAllCards\(\)[\s\S]*?await props\.onConnectionsChanged\(\)/,
      'modal onClose must call refreshAllCards so the card updates after login',
    );
    assert.match(
      src,
      /catch \(error\) \{[\s\S]*toast\.error\('刷新已启用模型失败', subscriptionActionErrorMessage\(error\)\)/,
      'OAuth modal close must surface enabled-model refresh failures',
    );
    assert.match(
      src,
      /onClose=\{\(\)\s*=>\s*\{[\s\S]*?void refreshAfterModalClose\(\)/,
      'modal onClose must call the fail-soft refresh helper',
    );
    // 5. Card render shows "已登录" badge when authenticated.
    assert.match(
      src,
      /isLoggedIn\s*\?\s*'已登录'\s*:\s*card\.statusLabel/,
      'logged-in cards must show 已登录 instead of the static statusLabel',
    );
    // 6. data-logged-in attribute exposes the state to CSS / tests.
    assert.match(
      src,
      /data-logged-in=\{isLoggedIn\s*\?\s*'true'\s*:\s*undefined\}/,
      'logged-in cards must surface a data-logged-in attribute',
    );
  });

  it('OAuth card refresh failures preserve the last known login state and alert the user', async () => {
    // task #38 sweep: a transient getAccountState IPC failure must
    // not overwrite a logged-in card snapshot with null. "Unknown"
    // is not the same thing as "not logged in".
    const src = await readFile(PROVIDERS_PANEL_SOURCE, 'utf8');
    const sectionMatch = src.match(/function ModelOAuthSection[\s\S]*?function ClaudeSubscriptionModal/);
    assert.ok(sectionMatch, 'ModelOAuthSection must exist');
    const section = sectionMatch[0]!;
    const refreshMatch = section.match(/async function refreshAllCards\(\)[\s\S]*?async function refreshAfterModalClose/);
    assert.ok(refreshMatch, 'refreshAllCards must exist inside ModelOAuthSection');
    const refresh = refreshMatch[0]!;

    assert.match(
      refresh,
      /return \{ id: card\.id, error \} as const/,
      'refresh failures must be represented as failures, not as null snapshots',
    );
    assert.match(
      refresh,
      /setCardStates\(\(prev\) => \{[\s\S]*const next = \{ \.\.\.prev \};[\s\S]*if \('snapshot' in result && result\.snapshot !== undefined\) next\[result\.id\] = result\.snapshot;/,
      'failed OAuth card refreshes must preserve previous snapshots',
    );
    assert.doesNotMatch(
      refresh,
      /catch[\s\S]*return \[card\.id,\s*null\] as const/,
      'refreshAllCards must not downgrade a failed snapshot probe to logged-out/null',
    );
    assert.match(
      section,
      /toast\.error\('刷新 OAuth 登录状态失败', message\)/,
      'failed OAuth card refreshes must be visible instead of silently changing badges',
    );
    assert.match(
      section,
      /className="providerOAuthError" role="alert"/,
      'the OAuth tab must expose refresh failures as an accessible inline alert',
    );
    const styles = await readFile(resolve(REPO_ROOT, 'apps', 'desktop', 'src', 'renderer', 'styles.css'), 'utf8');
    assert.match(styles, /\.providerOAuthError\s*\{/, 'OAuth refresh alert must have a stable style hook');
  });

  it('SettingsModal validates jumpToSettingsSection payloads against SETTINGS_NAV (PR-OAUTH-CARD-LIVE-STATE-0)', async () => {
    // Before: any truthy `detail.section` was passed to setSection,
    // so a typo or stale dispatch would silently land the user on
    // the "该设置页已纳入 Maka 设置树…" fallback page with no clue.
    const SETTINGS_MODAL = resolve(
      REPO_ROOT, 'apps', 'desktop', 'src', 'renderer', 'settings', 'SettingsModal.tsx',
    );
    const src = await readFile(SETTINGS_MODAL, 'utf8');
    // Find the handler body — match from `const handler = ` up to
    // its `addEventListener(...)` registration.
    const handler = src.match(
      /const handler =[\s\S]*?window\.addEventListener\(\s*'maka:jumpToSettingsSection'/,
    );
    assert.ok(handler, 'jumpToSettingsSection handler must exist');
    assert.match(
      handler[0],
      /SETTINGS_NAV\.some\(/,
      'jump handler must validate the section id against SETTINGS_NAV before calling setSection',
    );
  });

  it('AccountSettingsPage no longer renders ClaudeSubscriptionCard', async () => {
    // The 账户 panel used to host the card; PR-CLAUDE-CARD-MOVE-0
    // removed it. Confirm SettingsModal no longer references it.
    const SETTINGS_MODAL = resolve(
      REPO_ROOT, 'apps', 'desktop', 'src', 'renderer', 'settings', 'SettingsModal.tsx',
    );
    const src = await readFile(SETTINGS_MODAL, 'utf8');
    assert.doesNotMatch(
      src,
      /<ClaudeSubscriptionCard\s*\/>/,
      'SettingsModal must not render ClaudeSubscriptionCard — it lives in ProvidersPanel now',
    );
    assert.doesNotMatch(
      src,
      /function ClaudeSubscriptionCard\b/,
      'ClaudeSubscriptionCard definition must be in ProvidersPanel, not SettingsModal',
    );
  });

  it('SubscriptionLoginModal picks the right service bridge per id', async () => {
    const src = await readFile(PROVIDERS_PANEL_SOURCE, 'utf8');
    const fnMatch = src.match(/function pickSubscriptionBridge\(serviceId:[\s\S]*?^\}/m);
    assert.ok(fnMatch, 'pickSubscriptionBridge helper must exist');
    const body = fnMatch[0];
    assert.doesNotMatch(body, /case 'claude'/, 'Claude has a paste-code modal and must not use the loopback generic bridge');
    assert.match(body, /case 'codex'[\s\S]*?window\.maka\.codexSubscription/);
    assert.match(body, /case 'cursor'[\s\S]*?window\.maka\.cursorSubscription/);
    assert.match(body, /case 'antigravity'[\s\S]*?window\.maka\.antigravitySubscription/);
  });

  it('modal flow calls getAuthUrl → openAuthUrl → completeAuthorization on the bridge', async () => {
    const src = await readFile(PROVIDERS_PANEL_SOURCE, 'utf8');
    const fnMatch = src.match(/async function startLogin\(\)[\s\S]*?\n  \}/);
    assert.ok(fnMatch, 'startLogin must exist on SubscriptionLoginModal');
    const body = fnMatch[0];
    assert.match(body, /bridge\.getAuthUrl\(\)/);
    assert.match(body, /bridge\.openAuthUrl\(payload\.authRequestId\)/);
    assert.match(body, /bridge\.completeAuthorization\(payload\.authRequestId\)/);
  });

  it('OAuth login modals surface thrown IPC/service failures instead of leaving console-only rejections', async () => {
    const src = await readFile(PROVIDERS_PANEL_SOURCE, 'utf8');
    const helper = src.match(/function subscriptionActionErrorMessage[\s\S]*?async function getSubscriptionSnapshot/)?.[0] ?? '';
    const browserModal = src.match(/function SubscriptionLoginModal[\s\S]*?function ClaudeSubscriptionCard/)?.[0] ?? '';
    const claudeCard = src.match(/function ClaudeSubscriptionCard[\s\S]*?function presentSubscriptionState/)?.[0] ?? '';

    assert.match(helper, /登录服务暂时不可用，请检查网络后重试。/, 'OAuth thrown-error fallback must be user-facing Chinese copy');
    assert.match(helper, /redactSecrets\(message \?\? ''\)\.trim\(\)/, 'OAuth service messages must be redacted before reaching visible UI');
    assert.match(helper, /generalizedErrorMessageChinese\(new Error\(raw\), ''\)/, 'OAuth service messages must pass through Chinese error classification');
    assert.match(helper, /\/\[\\u4e00-\\u9fff\]\/\.test\(raw\)/, 'already-Chinese OAuth diagnostics may be preserved after redaction');
    assert.match(browserModal, /async function refresh\(\)[\s\S]*catch \(error\) \{[\s\S]*toast\.error\('刷新登录状态失败', message\);[\s\S]*setErrorMessage\(message\);/, 'browser OAuth state refresh must surface thrown failures');
    assert.match(browserModal, /catch \(error\) \{[\s\S]*toast\.error\('登录失败', message\);[\s\S]*setErrorMessage\(message\);/, 'browser OAuth login must toast thrown failures');
    assert.match(browserModal, /catch \(error\) \{[\s\S]*toast\.error\('退出失败', subscriptionActionErrorMessage\(error\)\);/, 'browser OAuth logout must toast thrown failures');
    assert.doesNotMatch(browserModal, /toast\.error\('[^']+', (?:payload|opened|result)\.message\)/, 'browser OAuth action envelopes must not toast raw service messages');
    assert.doesNotMatch(browserModal, /setErrorMessage\((?:payload|opened|result)\.message\)/, 'browser OAuth action envelopes must not render raw service messages');
    assert.match(browserModal, /subscriptionResultMessage\(payload\.message, '无法开始登录，请稍后再试。'\)/, 'browser OAuth getAuthUrl failures must be localized');
    assert.match(browserModal, /subscriptionResultMessage\(opened\.message, '无法打开浏览器，请稍后重试。'\)/, 'browser OAuth openAuthUrl failures must be localized');
    assert.match(browserModal, /subscriptionResultMessage\(result\.message, '登录未完成，请重新打开浏览器授权。'\)/, 'browser OAuth completion failures must be localized');
    assert.match(claudeCard, /const refresh = async \(\) => \{[\s\S]*catch \(error\) \{[\s\S]*toast\.error\('刷新登录状态失败', message\);[\s\S]*setPasteError\(message\);/, 'Claude OAuth state refresh must surface thrown failures');
    assert.match(claudeCard, /settingsErrorText" role="alert"\>\{pasteError\}/, 'Claude OAuth refresh failures must be visible in the modal body');
    assert.match(claudeCard, /catch \(error\) \{[\s\S]*toast\.error\('无法开始登录', message\);[\s\S]*setPasteError\(message\);/, 'Claude OAuth start must toast thrown failures');
    assert.match(claudeCard, /catch \(error\) \{[\s\S]*toast\.error\('授权码提交失败', message\);[\s\S]*setPasteError\(message\);/, 'Claude OAuth paste submit must toast thrown failures');
    assert.match(claudeCard, /catch \(error\) \{[\s\S]*toast\.error\('取消登录失败', subscriptionActionErrorMessage\(error\)\);/, 'Claude OAuth cancel must toast thrown failures');
    assert.match(claudeCard, /catch \(error\) \{[\s\S]*toast\.error\('刷新配额失败', subscriptionActionErrorMessage\(error\)\);/, 'Claude OAuth quota refresh must toast thrown failures');
    assert.doesNotMatch(claudeCard, /toast\.error\('[^']+', (?:payload|opened|result)\.message\)/, 'Claude OAuth action envelopes must not toast raw service messages');
    assert.doesNotMatch(claudeCard, /setPasteError\(result\.message\)/, 'Claude OAuth paste failures must not render raw service messages');
    assert.match(claudeCard, /subscriptionResultMessage\(payload\.message, '无法开始登录，请稍后再试。'\)/, 'Claude OAuth getAuthUrl failures must be localized');
    assert.match(claudeCard, /subscriptionResultMessage\(opened\.message, '无法打开浏览器，请稍后重试。'\)/, 'Claude OAuth openAuthUrl failures must be localized');
    assert.match(claudeCard, /subscriptionResultMessage\(result\.message, '授权码提交失败，请重新登录后再试。'\)/, 'Claude OAuth paste failures must be localized');
  });

  it('OAuth local credential storage failures are visible and repairable', async () => {
    const src = await readFile(PROVIDERS_PANEL_SOURCE, 'utf8');
    const snapshotPresenter = src.match(/function presentSnapshotDetail[\s\S]*?function ProviderLogoMark/)?.[0] ?? '';
    const claudePresenter = src.match(/function presentSubscriptionState[\s\S]*?\n\}/)?.[0] ?? '';
    const claudeCard = src.match(/function ClaudeSubscriptionCard[\s\S]*?function presentSubscriptionState/)?.[0] ?? '';

    assert.match(
      src,
      /storage_failed/,
      'OAuth UI must understand storage_failed instead of collapsing it to not_logged_in',
    );
    assert.match(
      snapshotPresenter,
      /case 'storage_failed':[\s\S]*本地凭据读取失败，请重新登录/,
      'browser OAuth cards must explain local credential read failures',
    );
    assert.match(
      claudePresenter,
      /case 'storage_failed':[\s\S]*label: '凭据读取失败'[\s\S]*本地 OAuth 凭据读取失败，请重新登录/,
      'Claude OAuth card must explain local credential read failures',
    );
    assert.match(
      claudeCard,
      /const canStartClaudeLogin =[\s\S]*state\?\.runtimeState === 'not_logged_in'[\s\S]*state\?\.runtimeState === 'refresh_failed'[\s\S]*state\?\.runtimeState === 'storage_failed'/,
      'Claude OAuth storage failures must keep the re-login action visible so the user can repair the local credential',
    );
  });

  it('Claude paste-code login keeps authorizing out of logout/refresh actions', async () => {
    const src = await readFile(PROVIDERS_PANEL_SOURCE, 'utf8');
    const claudeCard = src.match(/function ClaudeSubscriptionCard[\s\S]*?function presentSubscriptionState/)?.[0] ?? '';
    const actionsBlock = claudeCard.match(/<div className="settingsConnectionActions">[\s\S]*?\{authRequestId &&/)?.[0] ?? '';

    assert.match(
      claudeCard,
      /const claudeLoginPending = authRequestId !== null \|\| state\?\.runtimeState === 'authorizing'/,
      'Claude OAuth must model paste-code authorization as an in-progress login, not an authenticated account',
    );
    assert.match(
      actionsBlock,
      /\{canStartClaudeLogin \|\| claudeLoginPending \? \(/,
      'authorizing must take the start/login branch instead of the authenticated refresh/logout branch',
    );
    assert.match(actionsBlock, /disabled=\{pendingAction \|\| claudeLoginPending\}/);
    assert.match(actionsBlock, /\? '登录中…'/, 'pending Claude OAuth should show a disabled login-in-progress action');
    assert.match(
      actionsBlock,
      /\{canStartClaudeLogin \|\| claudeLoginPending \? \([\s\S]*'登录中…'[\s\S]*\) : \([\s\S]*刷新配额[\s\S]*退出登录/,
      'refresh/logout actions must be behind the non-pending branch so they cannot clear pending authorization before paste submit',
    );
  });

  it('preload exposes the three new subscription namespaces alongside claudeSubscription', async () => {
    const src = await readFile(PRELOAD_SOURCE, 'utf8');
    assert.match(src, /codexSubscription:\s*\{/, 'preload must expose window.maka.codexSubscription');
    assert.match(src, /cursorSubscription:\s*\{/, 'preload must expose window.maka.cursorSubscription');
    assert.match(
      src,
      /antigravitySubscription:\s*\{/,
      'preload must expose window.maka.antigravitySubscription',
    );
    for (const channel of [
      'codex-subscription:get-auth-url',
      'codex-subscription:complete-authorization',
      'codex-subscription:get-account-state',
      'codex-subscription:logout',
      'cursor-subscription:get-auth-url',
      'cursor-subscription:complete-authorization',
      'cursor-subscription:get-account-state',
      'cursor-subscription:logout',
      'antigravity-subscription:get-auth-url',
      'antigravity-subscription:complete-authorization',
      'antigravity-subscription:get-account-state',
      'antigravity-subscription:logout',
    ]) {
      assert.match(
        src,
        new RegExp(channel.replace(/:/g, ':').replace(/-/g, '-')),
        `preload must invoke '${channel}' on the IPC bus`,
      );
    }
  });
});
