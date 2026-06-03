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
    // 4. Modal onClose triggers a re-fetch.
    assert.match(
      src,
      /onClose=\{\(\)\s*=>\s*\{[\s\S]*?refreshAllCards\(\)/,
      'modal onClose must call refreshAllCards so the card updates after login',
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
    assert.match(browserModal, /catch \(error\) \{[\s\S]*toast\.error\('登录失败', message\);[\s\S]*setErrorMessage\(message\);/, 'browser OAuth login must toast thrown failures');
    assert.match(browserModal, /catch \(error\) \{[\s\S]*toast\.error\('退出失败', subscriptionActionErrorMessage\(error\)\);/, 'browser OAuth logout must toast thrown failures');
    assert.match(claudeCard, /catch \(error\) \{[\s\S]*toast\.error\('无法开始登录', message\);[\s\S]*setPasteError\(message\);/, 'Claude OAuth start must toast thrown failures');
    assert.match(claudeCard, /catch \(error\) \{[\s\S]*toast\.error\('授权码提交失败', message\);[\s\S]*setPasteError\(message\);/, 'Claude OAuth paste submit must toast thrown failures');
    assert.match(claudeCard, /catch \(error\) \{[\s\S]*toast\.error\('取消登录失败', subscriptionActionErrorMessage\(error\)\);/, 'Claude OAuth cancel must toast thrown failures');
    assert.match(claudeCard, /catch \(error\) \{[\s\S]*toast\.error\('刷新配额失败', subscriptionActionErrorMessage\(error\)\);/, 'Claude OAuth quota refresh must toast thrown failures');
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
