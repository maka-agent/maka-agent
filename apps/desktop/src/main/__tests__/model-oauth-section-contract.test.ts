/**
 * Static-analysis contract for the OAuth model-provider catalog in
 * the provider settings source files
 * (PR-MODEL-OAUTH-ALL-0).
 *
 * Pins the user-visible OAuth login surface: four cards
 * (claude / codex / antigravity / cursor), each marked
 * `status: 'available'`, and each click wires through to its
 * matching `window.maka.<provider>Subscription` bridge namespace.
 *
 * This is a source-grep contract, not a DOM render — we don't
 * pull React into the desktop test runner. Stamp shapes are
 * verified by reading the provider settings sources.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { resolve } from 'node:path';
import { readRendererContractCss } from './contract-css-helpers.js';
import { readProviderSettingsCombinedSource } from './provider-contract-source-helpers.js';
import { readSettingsCombinedSource } from './settings-contract-source-helpers.js';
import { readMainProcessCombinedSource } from './main-process-contract-source-helpers.js';

const REPO_ROOT = resolve(process.cwd(), '..', '..');
const PRELOAD_SOURCE = resolve(REPO_ROOT, 'apps', 'desktop', 'src', 'preload', 'preload.ts');

describe('Model OAuth catalog contract (PR-MODEL-OAUTH-ALL-0 + PR-CLAUDE-CARD-MOVE-0)', () => {
  it('renders OAuth as a catalog tab peer, not a standalone section above the market', async () => {
    const src = await readProviderSettingsCombinedSource();
    const tabs = src.match(/const CATALOG_TABS:[\s\S]*?\];/);
    assert.ok(tabs, 'CATALOG_TABS literal must exist');
    assert.match(tabs[0], /id:\s*'oauth'[\s\S]*label:\s*'OAuth'/, 'OAuth must be a catalog tab');
    assert.match(
      src,
      /<PrimitiveTabsPanel value="oauth">\s*<ModelOAuthSection\s+onConnectionsChanged=\{async \(\) => \{ await reload\(\); \}\}\s*\/>\s*<\/PrimitiveTabsPanel>/,
      'OAuth login UI must render inside the oauth TabsPanel and refresh enabled models',
    );
    const marketStart = src.indexOf('<section className="providerMarket">');
    const firstOAuthRender = src.indexOf('<ModelOAuthSection');
    assert.ok(marketStart !== -1, 'provider market section must exist');
    assert.ok(firstOAuthRender > marketStart, 'ModelOAuthSection must not be pinned above providerMarket');
    assert.doesNotMatch(src, /providerOAuthHeader/, 'OAuth tab must not carry a second standalone section header');
  });

  it('catalog tabs use the shared primitive Tabs primitive as a real tablist', async () => {
    const src = await readProviderSettingsCombinedSource();
    const tabs = src.match(/<PrimitiveTabs\s+className="catalogTabsRoot"[\s\S]*?<\/PrimitiveTabs>/)?.[0] ?? '';

    // Provider settings files must source UI from the shared @maka/ui
    // primitives (component governance), not hand-rolled markup.
    const uiImports = src.match(/import \{[^}]*\} from '@maka\/ui';/g)?.join('\n') ?? '';
    for (const name of [
      'Button',
      'PrimitiveTabs', 'PrimitiveTabsList', 'PrimitiveTabsTrigger',
      'PrimitiveAccordion', 'PrimitiveAccordionItem', 'PrimitiveAccordionTrigger', 'PrimitiveAccordionPanel',
      'Item', 'ItemContent', 'ItemTitle', 'ItemActions',
      'Input', 'RelativeTime', 'Textarea', 'useToast',
    ]) {
      assert.ok(
        uiImports.includes(name),
        `provider settings files should import ${name} from the shared @maka/ui primitives`,
      );
    }
    assert.doesNotMatch(src, /function onCatalogTabsKeyDown/, 'provider catalog tabs should not keep a custom keyboard handler');
    assert.doesNotMatch(src, /data-catalog-tab="\$\{CSS\.escape/, 'provider catalog tabs should not use manual focus queries');
    assert.match(tabs, /value=\{catalogTab\}[\s\S]*onValueChange=\{\(value\) => setCatalogTab\(value as CatalogTab\)\}/);
    assert.match(tabs, /<PrimitiveTabsList[^>]*variant="pill"[^>]*aria-label="模型供应商分类">/);
    assert.match(tabs, /<PrimitiveTabsTrigger[\s\S]*value=\{tab\.id\}/, 'catalog tabs use PrimitiveTabsTrigger as a real tablist (maka-tab comes from the primitive)');
    assert.match(tabs, /data-catalog-tab=\{tab\.id\}/);
  });

  it('ProvidersPanel surfaces model connection reload failures instead of sticking on loading', async () => {
    const src = await readProviderSettingsCombinedSource();
    const panel = src.match(/export function ProvidersPanel[\s\S]*?const selected = useMemo/)?.[0] ?? '';
    const reloadMatch = src.match(/async function reload\(\): Promise<boolean> \{[\s\S]*?\n  \}/);
    assert.ok(reloadMatch, 'ProvidersPanel reload() must exist');
    assert.match(
      panel,
      /const providersPanelMountedRef = useRef\(false\);[\s\S]*const providersReloadTicketRef = useRef\(0\);[\s\S]*const providerSheetLifecycleRef = useRef\(0\);/,
      'ProvidersPanel reloads must track mounted state and latest request ownership',
    );
    assert.match(
      reloadMatch[0],
      /const ticket = \+\+providersReloadTicketRef\.current;[\s\S]*Promise\.all\(\[[\s\S]*bridge\.list\(\),[\s\S]*bridge\.getDefault\(\),[\s\S]*\]\)[\s\S]*if \(!providersPanelMountedRef\.current \|\| providersReloadTicketRef\.current !== ticket\) return false;[\s\S]*setLoadError\(null\)[\s\S]*setLoading\(false\)[\s\S]*return true;/,
      'successful reload must clear load error only for the latest mounted request',
    );
    assert.match(
      reloadMatch[0],
      /catch \(error\) \{[\s\S]*if \(!providersPanelMountedRef\.current \|\| providersReloadTicketRef\.current !== ticket\) return false;[\s\S]*providerPanelActionErrorMessage\(error\)[\s\S]*setLoadError\(message\)[\s\S]*setLoading\(false\)[\s\S]*toast\.error\('载入模型连接失败', message\)[\s\S]*return false;/,
      'failed reload must not toast or write stale failure state after unmount or a newer reload',
    );
    assert.match(
      panel,
      /return \(\) => \{[\s\S]*providersPanelMountedRef\.current = false;[\s\S]*providersReloadTicketRef\.current \+= 1;[\s\S]*unsubscribe\?\.\(\);/,
      'ProvidersPanel cleanup must invalidate in-flight reloads and unsubscribe from connection events',
    );
    assert.match(
      src,
      /loadError \? \([\s\S]*模型连接载入失败[\s\S]*点击重试/,
      'enabled-model strip must show a retryable load-failure state',
    );
    assert.match(
      src,
      /function closeProviderConfigSheet\(\) \{[\s\S]*providerSheetLifecycleRef\.current \+= 1;[\s\S]*setAddingType\(null\);[\s\S]*setSelectedSlug\(null\);[\s\S]*\}/,
      'closing a provider config sheet must invalidate pending sheet-scoped continuations',
    );
    assert.match(
      src,
      /onCreated=\{async \(slug\) => \{[\s\S]*const providerSheetLifecycle = providerSheetLifecycleRef\.current;[\s\S]*const reloaded = await reload\(\);[\s\S]*providerSheetLifecycleRef\.current !== providerSheetLifecycle[\s\S]*\) return;[\s\S]*setSelectedSlug\(slug\);[\s\S]*setAddingType\(null\);/,
      'AddProviderForm completion must not select/close a stale sheet after ProvidersPanel unmounts or sheet close',
    );
    assert.match(
      src,
      /onDeleted=\{async \(\) => \{[\s\S]*if \(!providersPanelMountedRef\.current\) return;[\s\S]*setSelectedSlug\(null\);[\s\S]*await reload\(\);/,
      'Connection delete completion must not write ProvidersPanel state after unmount',
    );
  });

  it('provider detail actions localize and sanitize model-test / model-fetch failures', async () => {
    const providers = await readProviderSettingsCombinedSource();
    const main = await readMainProcessCombinedSource();
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
      /const busyRef = useRef\(false\)[\s\S]*const testingRef = useRef\(false\)[\s\S]*const fetchingModelsRef = useRef\(false\)[\s\S]*const settingDefaultRef = useRef\(false\)[\s\S]*const deletingRef = useRef\(false\)/,
      'ConnectionDetail actions must have synchronous duplicate-action guards, not only React state',
    );
    assert.match(
      detail,
      /async function save\(\) \{[\s\S]*if \(busyRef\.current \|\| testingRef\.current \|\| fetchingModelsRef\.current \|\| settingDefaultRef\.current \|\| deletingRef\.current\) return;[\s\S]*busyRef\.current = true;[\s\S]*props\.bridge\.update\(/,
      'ConnectionDetail save must set its duplicate-submit guard before awaiting bridge.update()',
    );
    assert.match(
      detail,
      /async function runTest\(\) \{[\s\S]*if \(testingRef\.current \|\| busyRef\.current \|\| fetchingModelsRef\.current \|\| settingDefaultRef\.current \|\| deletingRef\.current\) return;[\s\S]*testingRef\.current = true;[\s\S]*props\.bridge\.test\(/,
      'ConnectionDetail test must be gated synchronously before awaiting bridge.test()',
    );
    assert.match(
      detail,
      /async function refreshModels\(opts: \{ silent\?: boolean \} = \{\}\) \{[\s\S]*if \(fetchingModelsRef\.current\) return;[\s\S]*if \(!opts\.silent && \(busyRef\.current \|\| testingRef\.current \|\| settingDefaultRef\.current \|\| deletingRef\.current\)\) return;[\s\S]*fetchingModelsRef\.current = true;[\s\S]*props\.bridge\.fetchModels\(/,
      'ConnectionDetail model refresh must be duplicate-gated while preserving the post-save silent refresh',
    );
    assert.match(
      detail,
      /async function setAsDefault\(\) \{[\s\S]*if \(settingDefaultRef\.current \|\| busyRef\.current \|\| testingRef\.current \|\| fetchingModelsRef\.current \|\| deletingRef\.current\) return;[\s\S]*settingDefaultRef\.current = true;[\s\S]*props\.bridge\.setDefault\(/,
      'ConnectionDetail default-switch must be gated synchronously before awaiting bridge.setDefault()',
    );
    assert.match(
      detail,
      /async function remove\(\) \{[\s\S]*if \(deletingRef\.current \|\| busyRef\.current \|\| testingRef\.current \|\| fetchingModelsRef\.current \|\| settingDefaultRef\.current\) return;[\s\S]*deletingRef\.current = true;[\s\S]*props\.bridge\.delete\(/,
      'ConnectionDetail delete must be gated synchronously before awaiting bridge.delete()',
    );
    assert.match(
      detail,
      /const detailActionBusy = busy \|\| testing \|\| fetchingModels \|\| settingDefault \|\| deleting/,
      'ConnectionDetail must expose one visible busy state that freezes payload-affecting controls',
    );
    assert.match(
      detail,
      /disabled=\{detailActionBusy\}[\s\S]*aria-label=\{hasFixedOAuthBaseUrl \? '模型连接服务地址，OAuth 固定' : '模型连接服务地址'\}/,
      'ConnectionDetail service-address draft must freeze while any detail action is in flight',
    );
    assert.match(
      detail,
      /<PasswordInput[\s\S]*disabled=\{detailActionBusy\}/,
      'ConnectionDetail API key draft must freeze while any detail action is in flight',
    );
    assert.match(
      detail,
      /<ModelTable[\s\S]*canRefresh=\{!detailActionBusy && hasUsableCredential\}[\s\S]*disabled=\{detailActionBusy\}/,
      'ConnectionDetail model picker must freeze while any detail action is in flight',
    );
    assert.match(
      detail,
      /disabled=\{detailActionBusy \|\| !hasSaveChanges\} onClick=\{save\}[\s\S]*\{busy \? '保存中…' : '保存修改'\}/,
      'ConnectionDetail save button must show visible pending feedback and disable all peer actions',
    );
    assert.match(
      detail,
      /disabled=\{detailActionBusy \|\| !hasUsableCredential\} onClick=\{runTest\}[\s\S]*\{testing \? '测试中…' : '测试连接'\}/,
      'ConnectionDetail test button must show visible pending feedback and disable all peer actions',
    );
    assert.match(
      detail,
      /disabled=\{detailActionBusy\} onClick=\{setAsDefault\}[\s\S]*\{settingDefault \? '设置中…' : '设为默认'\}/,
      'ConnectionDetail default button must show visible pending feedback and disable all peer actions',
    );
    assert.match(
      detail,
      /disabled=\{detailActionBusy\} onClick=\{remove\}[\s\S]*\{deleting \? '删除中…' : '删除'\}/,
      'ConnectionDetail delete button must show visible pending feedback and disable all peer actions',
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
    assert.match(
      addForm,
      /const busyRef = useRef\(false\)/,
      'AddProviderForm create must have a synchronous duplicate-submit guard',
    );
    assert.match(
      addForm,
      /const addProviderMountedRef = useRef\(false\)[\s\S]*useEffect\(\(\) => \{[\s\S]*addProviderMountedRef\.current = true;[\s\S]*return \(\) => \{[\s\S]*addProviderMountedRef\.current = false;[\s\S]*busyRef\.current = false;[\s\S]*\};[\s\S]*\}, \[\]\);/,
      'AddProviderForm must track its own sheet lifetime so pending create continuations cannot write after overlay close',
    );
    assert.match(
      addForm,
      /async function submit\(\) \{[\s\S]*if \(busyRef\.current\) return;[\s\S]*busyRef\.current = true;[\s\S]*setBusy\(true\);[\s\S]*props\.bridge\.create\(/,
      'AddProviderForm create must set the duplicate-submit guard before awaiting bridge.create()',
    );
    assert.match(
      addForm,
      /const connection = await props\.bridge\.create\([\s\S]*\);[\s\S]*if \(!addProviderMountedRef\.current\) return;[\s\S]*await props\.onCreated\(connection\.slug\);/,
      'AddProviderForm create completion must not re-open/select provider detail after the sheet was closed mid-save',
    );
    assert.match(
      addForm,
      /catch \(err\) \{[\s\S]*if \(addProviderMountedRef\.current\) setError\(providerPanelActionErrorMessage\(err\)\);[\s\S]*\} finally \{[\s\S]*busyRef\.current = false;[\s\S]*if \(addProviderMountedRef\.current\) setBusy\(false\);[\s\S]*\}/,
      'AddProviderForm create guard must release without setting React state after sheet unmount',
    );
    assert.match(
      addForm,
      /disabled=\{isExperimental \|\| busy\} aria-label="模型供应商连接标识"/,
      'AddProviderForm fields must freeze while a create request is in flight so visible draft cannot drift from the submitted payload',
    );
    assert.match(
      addForm,
      /<Button variant="ghost" type="button" disabled=\{busy\} onClick=\{props\.onCancel\}>取消<\/Button>/,
      'AddProviderForm cancel must be disabled while create is in flight',
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
    const src = await readProviderSettingsCombinedSource();
    const styles = await readRendererContractCss();
    const overlay = src.match(/function ProviderConfigSheetOverlay[\s\S]*?function ProviderCatalogCard/)?.[0] ?? '';

    assert.match(overlay, /className="providerConfigSheetClose"/);
    assert.match(overlay, /aria-label="关闭模型配置"/);
    // Icon stroke governance round: per-call-site strokeWidth props were
    // deleted so lucide glyphs ride one governed weight (svg.lucide CSS rule).
    assert.match(overlay, /<X aria-hidden="true" \/>/);
    assert.match(styles, /\.providerConfigOverlay\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0;/);
    assert.doesNotMatch(
      styles,
      /\.providerConfigOverlay\s*\{[^}]*justify-content:\s*flex-end;/,
      'Base UI renders Backdrop and Popup as siblings; overlay flex must not be treated as sheet layout',
    );
    assert.match(styles, /\.providerConfigSheet\s*\{[^}]*position:\s*absolute;/);
    assert.match(styles, /\.providerConfigSheet\s*\{[^}]*inset:\s*var\(--space-3\)\s+var\(--space-3\)\s+var\(--space-3\)\s+auto;/);
    assert.match(styles, /\.providerConfigSheet\s*\{[^}]*width:\s*min\(430px,\s*calc\(100%\s*-\s*\(var\(--space-3\)\s*\*\s*2\)\)\);/);
    assert.match(styles, /\.providerConfigSheetClose\s*\{[\s\S]*position:\s*absolute;[\s\S]*right:\s*14px;/);
    // The close button reuses the governed quiet icon Button, so its rest /
    // hover / focus states come from the component, not hand-written CSS. The
    // local class only positions and rounds it.
    assert.match(
      overlay,
      /variant="quiet"[\s\S]*?size="icon-sm"[\s\S]*?className="providerConfigSheetClose"/,
      'close button must reuse the governed quiet icon Button for its hover/focus states',
    );
  });

  it('provider config sheets route through Base UI Dialog nested in the settings surface', async () => {
    const src = await readProviderSettingsCombinedSource();

    // ProviderSheet wraps Base UI Dialog so the nested modal layer handles
    // focus trap / Esc / aria-hidden on the settings nav, replacing the old
    // useModalA11y + useProviderSheetBackgroundInert DOM walker.
    assert.match(src, /export function ProviderSheet/, 'ProviderSheet primitive must exist');
    assert.match(src, /BaseDialog\.Root/, 'uses Base UI Dialog.Root');
    assert.match(src, /BaseDialog\.Portal/, 'uses Dialog.Portal');
    assert.match(src, /BaseDialog\.Backdrop/, 'uses Dialog.Backdrop');
    assert.match(src, /BaseDialog\.Popup/, 'uses Dialog.Popup');
    assert.match(
      src,
      /querySelector<HTMLElement>\('\.settingsSurface'\)/,
      'Portal container must be the settings surface (nested visual: scrim covers the surface, not the viewport)',
    );
    assert.match(
      src,
      /Backdrop[\s\S]{0,80}forceRender/,
      'nested backdrop must forceRender (Base UI skips nested backdrops by default; provider sheets want the scrim)',
    );
    assert.match(src, /<ProviderSheet/, 'provider/OAuth sheets must render via ProviderSheet');
    assert.doesNotMatch(
      src,
      /\buseProviderSheetBackgroundInert\(/,
      'useProviderSheetBackgroundInert removed (Base UI nested modal handles aria-hidden)',
    );
    assert.doesNotMatch(
      src,
      /import[^}]*\buseModalA11y\b/,
      'useModalA11y removed from provider sheets (Base UI Dialog owns focus/Esc)',
    );
  });

  it('does not auto-open the first provider config sheet after loading connections', async () => {
    // WAWQAQ goal sweep: Settings -> 模型 kept reopening the first
    // provider config sheet on every Settings open because reload()
    // defaulted selectedSlug to list[0]. A model list refresh should
    // preserve an already-open sheet if that connection still exists,
    // but it must not select the first provider by default.
    const src = await readProviderSettingsCombinedSource();
    const reloadBlock = src.match(/async function reload\(\)[\s\S]*?^\s*\}/m)?.[0] ?? '';

    assert.match(reloadBlock, /setSelectedSlug\(\(current\) =>[\s\S]*list\.some\(\(connection\) => connection\.slug === current\)/);
    assert.match(reloadBlock, /\?\s*current\s*:\s*null/);
    assert.doesNotMatch(reloadBlock, /current\s*\?\?\s*list\[0\]\?\.slug/, 'reload must not auto-select the first provider');
  });

  it('enabled model chips expose a concise aria-label instead of concatenated duplicate visible text', async () => {
    const src = await readProviderSettingsCombinedSource();

    assert.match(
      src,
      /function chipAriaLabel\(connection: LlmConnection\): string/,
      'enabled model chips need a dedicated accessible name',
    );
    assert.match(
      src,
      /import \{[^}]*chipStatusText[^}]*\} from '\.\/provider-connection-status'/,
      'status copy must come from the dedicated provider-connection-status helper (behaviour is covered by provider-connection-status.test.ts), not be parsed out of the chip title',
    );
    assert.match(
      src,
      /模型连接：\$\{connection\.name\}，供应商：\$\{provider\}/,
      'model connection chip aria-label must describe the model and provider explicitly',
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
    const src = await readProviderSettingsCombinedSource();
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
    assert.match(src, /智谱 · OpenAI 兼容/);
    assert.match(
      src,
      /case 'codex-subscription':\s*return \{ name: 'OpenAI OAuth', description: 'ChatGPT \/ Codex 账号登录；登录后自动成为可用模型连接。' \}/,
      'OpenAI OAuth account path should not be presented as a Codex subscription in provider settings',
    );
    assert.doesNotMatch(
      src,
      /OpenAI-compatible|endpoint/,
      'model provider settings visible copy must not mix English technical fallback such as OpenAI-compatible endpoint',
    );
  });

  it('keeps model provider form copy Chinese-first', async () => {
    const src = await readProviderSettingsCombinedSource();
    const addForm = src.match(/function AddProviderForm[\s\S]*?function ConnectionDetail/)?.[0] ?? '';
    const detail = src.match(/function ConnectionDetail[\s\S]*?function connectionDetailSnapshot/)?.[0] ?? '';
    const modelTable = src.match(/function ModelTable[\s\S]*?function ModelCapabilityChips/)?.[0] ?? '';

    assert.match(addForm, /<span>连接标识<\/span>/);
    assert.match(addForm, /aria-label="模型供应商连接标识"/);
    assert.match(addForm, /<span>服务地址 \{requiresBaseUrl \? '（必填）' : ''\}<\/span>/);
    assert.match(addForm, /aria-label="模型供应商服务地址"/);
    assert.match(addForm, /连接标识已存在/);
    assert.match(addForm, /这个供应商需要填写服务地址/);

    // PR-FIELD-PRIMITIVE-PILOT: ConnectionDetail's form rows moved off the
    // hand-written <label><span/> markup onto the governed Base UI Field
    // primitive (FieldRoot + Label + FieldDescription). Label copy stays
    // Chinese-first; the parenthetical state hints split into their own
    // FieldDescription lines. AddProviderForm is intentionally left on the
    // legacy <label><span/> markup this round (single-page pilot).
    assert.match(detail, /<Label[^>]*>连接标识<\/Label>/);
    assert.match(detail, /aria-label="模型连接标识"/);
    assert.match(detail, /<Label[^>]*>服务地址<\/Label>/);
    assert.match(detail, /hasFixedOAuthBaseUrl && <FieldDescription>OAuth 固定<\/FieldDescription>/);
    assert.match(detail, /<Label[^>]*>模型密钥<\/Label>/);
    assert.match(detail, /hasSecret === true && <FieldDescription>已设置，粘贴新值可替换<\/FieldDescription>/);
    assert.match(detail, /placeholder=\{hasSecret === true \? '••••••••' : '粘贴模型密钥'\}/);
    assert.match(detail, /ariaLabel=\{`\$\{display\.name\} 模型密钥`\}/);
    assert.match(detail, /获取模型密钥/);
    assert.match(detail, /模型密钥 \/ 服务地址 \/ 代理设置/);

    assert.match(modelTable, /刷新模型列表/);
    assert.match(modelTable, /先配置模型密钥/);
    assert.match(modelTable, /该供应商的真实模型清单/);
    assert.match(src, /网络错误，请检查服务地址或代理设置后重试。/);
    // Provider descriptions are version-agnostic (provider + access path,
    // never a model generation that goes stale).
    assert.match(src, /Anthropic 官方接入/);
    assert.match(src, /OpenAI 官方接入/);

    for (const block of [addForm, detail, modelTable]) {
      assert.doesNotMatch(block, />Slug</);
      assert.doesNotMatch(block, /Base URL|\(required\)|API key|从 API 刷新|粘贴 API key|获取 API key|该 provider 的真实模型清单/);
    }
  });

  it('exposes exactly four equal OAuth cards: claude, codex, antigravity, cursor', async () => {
    // WAWQAQ msg 8bb7e186: Claude must not be a huge standalone
    // inline card while the other OAuth providers are compact
    // cards. All four login entries live in the same grid.
    const src = await readProviderSettingsCombinedSource();
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

  it('keeps OAuth cards visually aligned with domestic and overseas provider cards', async () => {
    const src = await readProviderSettingsCombinedSource();
    const styles = await readRendererContractCss();
    const sectionMatch = src.match(/function ModelOAuthSection[\s\S]*?function providerOAuthAriaLabel/);
    assert.ok(sectionMatch, 'ModelOAuthSection render block must exist');
    const section = sectionMatch[0]!;

    assert.match(
      section,
      /className="providerCatalogRow providerOAuthCard rounded-none"/,
      'OAuth tab rows must reuse the same governed provider catalog row chrome as 国内 / 海外 / 本地 rows',
    );
    assert.match(
      section,
      /<ProviderLogo type=\{card\.providerType\} \/>/,
      'OAuth cards must show the same provider logo affordance as provider catalog cards',
    );
    assert.match(
      section,
      /<ItemTitle className="providerCatalogTitle"[\s\S]*<ItemDescription className="providerCatalogDesc providerOAuthCardDescription"/,
      'OAuth rows must reuse the same Item title/description hierarchy as provider catalog rows',
    );
    assert.doesNotMatch(
      section,
      /style=\{\{\s*\['--oauth-accent' as string\]/,
      'OAuth cards must not keep a separate accent-tinted card surface',
    );

    assert.match(
      styles,
      /\.providerMarketGrid,[\s\S]*?grid-template-columns:\s*1fr/,
      'provider market tabs must use a single-column seamless row list so 国内 and 海外 stay visually identical',
    );
    assert.match(
      styles,
      /\.providerCatalogRow\s*\{/,
      'provider catalog + OAuth rows share the governed .providerCatalogRow chrome so the tabs do not look like unrelated surfaces',
    );
    assert.match(
      styles,
      /\.providerOAuthGrid\s*\{[\s\S]*?grid-template-columns:\s*1fr/,
      'OAuth tab must use the same single-column row list as the API-key provider tabs',
    );
    assert.match(
      styles,
      /\.providerMarketGrid \.providerCatalogRow \+ \.providerCatalogRow/,
      'API-key provider rows must use the same seamless hairline separators as OAuth rows',
    );
    assert.match(
      styles,
      /\.providerOAuthGrid \.providerCatalogRow \+ \.providerCatalogRow/,
      'OAuth rows must use the same seamless hairline separators as provider catalog rows',
    );
    assert.match(
      styles,
      /\.providerOAuthCardDescription\s*\{[\s\S]*?-webkit-line-clamp:\s*2;/,
      'OAuth account labels and descriptions must not stretch the card grid vertically',
    );
    assert.doesNotMatch(
      styles,
      /\.providerOAuthCard\s*\{[\s\S]*?display:\s*flex;[\s\S]*?background:\s*color-mix/,
      'OAuth cards must not keep the old separate flex/color-mix card implementation',
    );
  });

  it('every card declares status: "available" (no more "planned" placeholders)', async () => {
    const src = await readProviderSettingsCombinedSource();
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
    const src = await readProviderSettingsCombinedSource();
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
    const src = await readProviderSettingsCombinedSource();
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
    const src = await readProviderSettingsCombinedSource();
    const detail = src.match(/function ConnectionDetail[\s\S]*?function ModelTable/)?.[0] ?? '';

    assert.match(
      detail,
      /if \(!connection\.enabled\) \{[\s\S]*toast\.error\('无法设为默认'/,
      'ConnectionDetail must guard against stale disabled connections before setDefault',
    );
    assert.match(
      detail,
      /!\s*props\.isDefault && connection\.enabled && \([\s\S]*<Button variant="secondary" type="button" disabled=\{detailActionBusy\} onClick=\{setAsDefault\}>[\s\S]*\{settingDefault \? '设置中…' : '设为默认'\}[\s\S]*<\/Button>/,
      'disabled connections must not render the set-default action',
    );
  });

  it('does not leave Save enabled when an existing connection has no draft changes', async () => {
    const src = await readProviderSettingsCombinedSource();
    const detail = src.match(/function ConnectionDetail[\s\S]*?function ModelTable/)?.[0] ?? '';

    assert.match(
      detail,
      /const hasSaveChanges =[\s\S]*apiKey\.length > 0[\s\S]*draftBaseUrl !== savedBaseUrl[\s\S]*defaultModel !== connection\.defaultModel/,
      'ConnectionDetail must compute dirty state from the fields that Save actually writes',
    );
    assert.match(
      detail,
      /disabled=\{detailActionBusy \|\| !hasSaveChanges\}/,
      'Save must be disabled until the user changes a writable field',
    );
  });

  it('keeps the model picker radiogroup free of nested listitem semantics', async () => {
    const src = await readProviderSettingsCombinedSource();
    const modelTable = src.match(/function ModelTable[\s\S]*?function ModelCapabilityChips/)?.[0] ?? '';

    assert.match(
      modelTable,
      /<ul[\s\S]*className="modelTableList"[\s\S]*role="radiogroup"[\s\S]*aria-label="默认模型"/,
      'ModelTable must expose the default-model picker as a named radiogroup',
    );
    assert.match(
      modelTable,
      /<li key=\{model\.id\} role="none">[\s\S]*role="radio"/,
      'structural list items inside the radiogroup must be presentational so assistive tech reaches the radio options directly',
    );
    assert.doesNotMatch(
      modelTable,
      /<li key=\{model\.id\}>\s*<Button[\s\S]*role="radio"/,
      'ModelTable must not wrap radio options in exposed listitem semantics',
    );
  });

  it('surfaces provider detail save/delete failures instead of leaking rejected promises from actions', async () => {
    const src = await readProviderSettingsCombinedSource();
    const detail = src.match(/function ConnectionDetail[\s\S]*?function ModelTable/)?.[0] ?? '';

    assert.match(
      detail,
      /async function save\(\) \{[\s\S]*let saved = false;[\s\S]*await props\.bridge\.update\(connection\.slug,[\s\S]*saved = true;[\s\S]*catch \(error\) \{[\s\S]*toast\.error\([\s\S]*saved \? '刷新模型连接失败' : '保存模型连接失败'/,
      'ConnectionDetail save failures and post-save refresh failures must be visible',
    );
    assert.match(
      detail,
      /async function remove\(\) \{[\s\S]*deletingRef\.current = true;[\s\S]*setDeleting\(true\);[\s\S]*let deleted = false;[\s\S]*await props\.bridge\.delete\(connection\.slug\);[\s\S]*deleted = true;[\s\S]*await props\.onDeleted\(\);[\s\S]*catch \(error\) \{[\s\S]*toast\.error\([\s\S]*deleted \? '刷新模型列表失败' : '删除模型连接失败'/,
      'ConnectionDetail delete failures and post-delete refresh failures must be visible',
    );
    assert.match(
      detail,
      /<Button variant="destructive" type="button" disabled=\{detailActionBusy\} onClick=\{remove\}>[\s\S]*\{deleting \? '删除中…' : '删除'\}[\s\S]*<\/Button>/,
      'Delete should be disabled while provider detail actions are busy and show its own pending copy',
    );
  });

  it('surfaces provider detail credential-presence probe failures', async () => {
    const src = await readProviderSettingsCombinedSource();
    const detail = src.match(/function ConnectionDetail[\s\S]*?function ModelTable/)?.[0] ?? '';

    assert.match(src, /type CredentialPresenceStatus = boolean \| 'loading' \| 'error'/);
    assert.match(detail, /useState<CredentialPresenceStatus>\([\s\S]*defaults\.authKind === 'none' \? true : 'loading'/);
    assert.match(detail, /const credentialProbePending = requiresCredential && \(hasSecret === 'loading' \|\| hasSecret === 'error'\)/);
    assert.match(detail, /const hasUsableCredential = !requiresCredential \|\| hasSecret === true/);
    assert.match(
      detail,
      /props\.bridge[\s\S]*\.hasSecret\(connection\.slug\)[\s\S]*\.then\(\(next\) => \{[\s\S]*if \(isConnectionDetailCurrent\(lifecycle\)\) setHasSecret\(next\);[\s\S]*\.catch\(\(error\) => \{[\s\S]*if \(!isConnectionDetailCurrent\(lifecycle\)\) return;[\s\S]*setHasSecret\('error'\);[\s\S]*toast\.error\('读取模型凭据状态失败', providerPanelActionErrorMessage\(error\)\)/,
      'ConnectionDetail must show a visible error and keep unknown credential state distinct when probing fails',
    );
    assert.doesNotMatch(
      detail,
      /catch\(\(error\) => \{[\s\S]*setHasSecret\(false\)/,
      'credential-presence probe failures must not be downgraded to missing credentials',
    );
    assert.match(detail, /role="alert"[\s\S]*模型凭据状态暂时没刷新成功，已避免把未知状态显示成未登录或未配置/);
    assert.match(detail, /canRefresh=\{!detailActionBusy && hasUsableCredential\}/);
    assert.match(detail, /disabled=\{detailActionBusy \|\| !hasUsableCredential\}/);
    assert.doesNotMatch(
      detail,
      /void props\.bridge\.hasSecret\(connection\.slug\)\.then\(setHasSecret\);/,
      'ConnectionDetail must not leave credential-presence probe rejections unhandled',
    );
  });

  it('provider detail async actions stop writing UI after the detail sheet is closed or switched', async () => {
    const src = await readProviderSettingsCombinedSource();
    const detail = src.match(/function ConnectionDetail[\s\S]*?function ModelTable/)?.[0] ?? '';

    assert.match(
      detail,
      /const connectionDetailMountedRef = useRef\(false\);[\s\S]*const connectionDetailLifecycleRef = useRef\(0\);/,
      'ConnectionDetail must track mounted/lifecycle ownership',
    );
    assert.match(
      detail,
      /useEffect\(\(\) => \{[\s\S]*connectionDetailMountedRef\.current = true;[\s\S]*connectionDetailLifecycleRef\.current \+= 1;[\s\S]*return \(\) => \{[\s\S]*connectionDetailMountedRef\.current = false;[\s\S]*connectionDetailLifecycleRef\.current \+= 1;[\s\S]*busyRef\.current = false;[\s\S]*testingRef\.current = false;[\s\S]*fetchingModelsRef\.current = false;[\s\S]*settingDefaultRef\.current = false;[\s\S]*deletingRef\.current = false;[\s\S]*\};[\s\S]*\}, \[connection\.slug\]\);/,
      'ConnectionDetail cleanup must release every pending action owner on close or provider switch',
    );
    assert.match(
      detail,
      /function isConnectionDetailCurrent\(lifecycle: number\): boolean \{[\s\S]*return connectionDetailMountedRef\.current && connectionDetailLifecycleRef\.current === lifecycle;[\s\S]*\}/,
      'ConnectionDetail must expose a single current-owner predicate',
    );
    assert.match(
      detail,
      /async function save\(\) \{[\s\S]*const lifecycle = connectionDetailLifecycleRef\.current;[\s\S]*await props\.bridge\.update\(connection\.slug,[\s\S]*saved = true;[\s\S]*if \(!isConnectionDetailCurrent\(lifecycle\)\) return;[\s\S]*await props\.onChanged\(\);[\s\S]*if \(!isConnectionDetailCurrent\(lifecycle\)\) return;[\s\S]*catch \(error\) \{[\s\S]*if \(!isConnectionDetailCurrent\(lifecycle\)\) return;[\s\S]*toast\.error/,
      'ConnectionDetail save must not write stale state or toast after close',
    );
    assert.match(
      detail,
      /async function runTest\(\) \{[\s\S]*const lifecycle = connectionDetailLifecycleRef\.current;[\s\S]*await props\.bridge\.test\(connection\.slug,[\s\S]*if \(!isConnectionDetailCurrent\(lifecycle\)\) return;[\s\S]*catch \(error\) \{[\s\S]*if \(!isConnectionDetailCurrent\(lifecycle\)\) return;[\s\S]*toast\.error/,
      'ConnectionDetail test must not toast after close',
    );
    assert.match(
      detail,
      /async function refreshModels\(opts: \{ silent\?: boolean \} = \{\}\) \{[\s\S]*const lifecycle = connectionDetailLifecycleRef\.current;[\s\S]*await props\.bridge\.fetchModels\(connection\.slug\);[\s\S]*if \(!isConnectionDetailCurrent\(lifecycle\)\) return;[\s\S]*await props\.onChanged\(\);[\s\S]*if \(!isConnectionDetailCurrent\(lifecycle\)\) return;[\s\S]*catch \(error\) \{[\s\S]*if \(!isConnectionDetailCurrent\(lifecycle\)\) return;[\s\S]*toast\.error/,
      'ConnectionDetail model refresh must not write stale model state or toast after close',
    );
    assert.match(
      detail,
      /async function setAsDefault\(\) \{[\s\S]*const lifecycle = connectionDetailLifecycleRef\.current;[\s\S]*await props\.bridge\.setDefault\(connection\.slug\);[\s\S]*if \(!isConnectionDetailCurrent\(lifecycle\)\) return;[\s\S]*await props\.onChanged\(\);[\s\S]*if \(!isConnectionDetailCurrent\(lifecycle\)\) return;[\s\S]*toast\.success\(`已设为默认/,
      'ConnectionDetail set-default must not toast after close',
    );
    assert.match(
      detail,
      /async function remove\(\) \{[\s\S]*const lifecycle = connectionDetailLifecycleRef\.current;[\s\S]*const ok = await toast\.confirm[\s\S]*if \(!isConnectionDetailCurrent\(lifecycle\)\) return;[\s\S]*await props\.bridge\.delete\(connection\.slug\);[\s\S]*deleted = true;[\s\S]*if \(!isConnectionDetailCurrent\(lifecycle\)\) return;[\s\S]*await props\.onDeleted\(\);[\s\S]*catch \(error\) \{[\s\S]*if \(!isConnectionDetailCurrent\(lifecycle\)\) return;[\s\S]*toast\.error/,
      'ConnectionDetail delete must not continue or toast after close',
    );
  });

  it('keeps an open provider detail sheet in sync with refreshed connection props without clobbering dirty drafts', async () => {
    // task #38 sweep: OAuth login/model refresh can update the same
    // connection while its detail sheet is open. State initialized from
    // props via useState would otherwise keep showing stale models /
    // defaultModel until the sheet is closed and reopened.
    const src = await readProviderSettingsCombinedSource();
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
    const src = await readProviderSettingsCombinedSource();
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
    const src = await readProviderSettingsCombinedSource();
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
    const refreshOnMount = src.match(/useEffect\(\(\) =>\s*\{[\s\S]*void refreshAllCards\(\);[\s\S]*?\},\s*\[\]\)/);
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
      /catch \(error\) \{[\s\S]*toast\.error\('刷新模型连接失败', subscriptionActionErrorMessage\(error\)\)/,
      'OAuth modal close must surface model-connection refresh failures',
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
    const src = await readProviderSettingsCombinedSource();
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
    const styles = await readRendererContractCss();
    assert.match(styles, /\.providerOAuthError\s*\{/, 'OAuth refresh alert must have a stable style hook');
  });

  it('OAuth card refresh owns the mounted latest request before writing Settings UI feedback', async () => {
    const src = await readProviderSettingsCombinedSource();
    const sectionMatch = src.match(/function ModelOAuthSection[\s\S]*?function ClaudeSubscriptionModal/);
    assert.ok(sectionMatch, 'ModelOAuthSection must exist');
    const section = sectionMatch[0]!;

    assert.match(
      section,
      /const modelOAuthMountedRef = useRef\(false\);[\s\S]*const modelOAuthRefreshTicketRef = useRef\(0\);/,
      'ModelOAuthSection must keep mounted and latest-refresh ownership refs',
    );
    assert.match(
      section,
      /async function refreshAllCards\(\) \{[\s\S]*const ticket = modelOAuthRefreshTicketRef\.current \+ 1;[\s\S]*modelOAuthRefreshTicketRef\.current = ticket;[\s\S]*await Promise\.all[\s\S]*if \(!modelOAuthMountedRef\.current \|\| modelOAuthRefreshTicketRef\.current !== ticket\) return false;[\s\S]*setCardStates/,
      'OAuth card refresh must drop stale or unmounted snapshot results before setState',
    );
    assert.match(
      section,
      /useEffect\(\(\) => \{[\s\S]*modelOAuthMountedRef\.current = true;[\s\S]*void refreshAllCards\(\);[\s\S]*return \(\) => \{[\s\S]*modelOAuthMountedRef\.current = false;[\s\S]*modelOAuthRefreshTicketRef\.current \+= 1;[\s\S]*\};[\s\S]*\}, \[\]\);/,
      'OAuth card refresh must invalidate in-flight requests on unmount',
    );
    assert.match(
      section,
      /async function refreshAfterModalClose\(\) \{[\s\S]*const refreshed = await refreshAllCards\(\);[\s\S]*if \(!modelOAuthMountedRef\.current \|\| !refreshed\) return;[\s\S]*await props\.onConnectionsChanged\(\);/,
      'modal close continuation must not refresh enabled providers after a stale OAuth card refresh',
    );
    assert.match(
      section,
      /catch \(error\) \{[\s\S]*if \(!modelOAuthMountedRef\.current\) return;[\s\S]*toast\.error\('刷新模型连接失败', subscriptionActionErrorMessage\(error\)\)/,
      'enabled-provider refresh failures after modal close must not toast after Settings unmount',
    );
  });

  it('SettingsModal validates jumpToSettingsSection payloads against SETTINGS_NAV (PR-OAUTH-CARD-LIVE-STATE-0)', async () => {
    // Before: any truthy `detail.section` was passed to setSection,
    // so a typo or stale dispatch would silently land the user on
    // the "该设置页已纳入 Maka 设置树…" fallback page with no clue.
    const src = await readSettingsCombinedSource();
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
    const src = await readSettingsCombinedSource();
    assert.doesNotMatch(
      src,
      /<ClaudeSubscriptionCard\s*\/>/,
      'SettingsModal must not render ClaudeSubscriptionCard — it lives in provider OAuth settings now',
    );
    assert.doesNotMatch(
      src,
      /function ClaudeSubscriptionCard\b/,
      'ClaudeSubscriptionCard definition must be in provider OAuth settings, not SettingsModal',
    );
  });

  it('SubscriptionLoginModal picks the right service bridge per id', async () => {
    const src = await readProviderSettingsCombinedSource();
    const fnMatch = src.match(/function pickSubscriptionBridge\(serviceId:[\s\S]*?^\}/m);
    assert.ok(fnMatch, 'pickSubscriptionBridge helper must exist');
    const body = fnMatch[0];
    assert.doesNotMatch(body, /case 'claude'/, 'Claude has a paste-code modal and must not use the loopback generic bridge');
    assert.match(body, /case 'codex'[\s\S]*?window\.maka\.codexSubscription/);
    assert.match(body, /case 'cursor'[\s\S]*?window\.maka\.cursorSubscription/);
    assert.match(body, /case 'antigravity'[\s\S]*?window\.maka\.antigravitySubscription/);
  });

  it('modal flow calls getAuthUrl → openAuthUrl → completeAuthorization on the bridge', async () => {
    const src = await readProviderSettingsCombinedSource();
    const fnMatch = src.match(/async function startLogin\(\)[\s\S]*?\n  \}/);
    assert.ok(fnMatch, 'startLogin must exist on SubscriptionLoginModal');
    const body = fnMatch[0];
    assert.match(body, /bridge\.getAuthUrl\(\)/);
    assert.match(body, /bridge\.openAuthUrl\(payload\.authRequestId\)/);
    assert.match(body, /bridge\.completeAuthorization\(payload\.authRequestId\)/);
  });

  it('OAuth login modals surface thrown IPC/service failures instead of leaving console-only rejections', async () => {
    const src = await readProviderSettingsCombinedSource();
    const helper = src.match(/function subscriptionActionErrorMessage[\s\S]*?async function getSubscriptionSnapshot/)?.[0] ?? '';
    const browserModal = src.match(/function SubscriptionLoginModal[\s\S]*?function ClaudeSubscriptionCard/)?.[0] ?? '';
    const claudeCard = src.match(/function ClaudeSubscriptionCard[\s\S]*?function presentSubscriptionState/)?.[0] ?? '';

    assert.match(helper, /登录服务暂时不可用，请检查网络后重试。/, 'OAuth thrown-error fallback must be user-facing Chinese copy');
    assert.match(helper, /redactSecrets\(message \?\? ''\)\.trim\(\)/, 'OAuth service messages must be redacted before reaching visible UI');
    assert.match(helper, /generalizedErrorMessageChinese\(new Error\(raw\), ''\)/, 'OAuth service messages must pass through Chinese error classification');
    assert.match(helper, /\/\[\\u4e00-\\u9fff\]\/\.test\(raw\)/, 'already-Chinese OAuth diagnostics may be preserved after redaction');
    assert.match(browserModal, /async function refresh\(\)(?:: Promise<boolean>)?[\s\S]*catch \(error\) \{[\s\S]*toast\.error\('刷新登录状态失败', message\);[\s\S]*setErrorMessage\(message\);/, 'browser OAuth state refresh must surface thrown failures');
    assert.match(browserModal, /catch \(error\) \{[\s\S]*toast\.error\('登录失败', message\);[\s\S]*setErrorMessage\(message\);/, 'browser OAuth login must toast thrown failures');
    assert.match(browserModal, /catch \(error\) \{[\s\S]*toast\.error\('退出失败', subscriptionActionErrorMessage\(error\)\);/, 'browser OAuth logout must toast thrown failures');
    assert.doesNotMatch(browserModal, /toast\.error\('[^']+', (?:payload|opened|result)\.message\)/, 'browser OAuth action envelopes must not toast raw service messages');
    assert.doesNotMatch(browserModal, /setErrorMessage\((?:payload|opened|result)\.message\)/, 'browser OAuth action envelopes must not render raw service messages');
    assert.match(browserModal, /subscriptionResultMessage\(payload\.message, '无法开始登录，请稍后再试。'\)/, 'browser OAuth getAuthUrl failures must be localized');
    assert.match(browserModal, /subscriptionResultMessage\(opened\.message, '无法打开浏览器，请稍后重试。'\)/, 'browser OAuth openAuthUrl failures must be localized');
    assert.match(browserModal, /subscriptionResultMessage\(result\.message, '登录未完成，请重新打开浏览器授权。'\)/, 'browser OAuth completion failures must be localized');
    assert.match(
      browserModal,
      /const \[pendingAction, setPendingAction\] = useState<BrowserSubscriptionPendingAction \| null>\(null\)/,
      'browser OAuth modal needs a named pending action, not a bare boolean',
    );
    assert.match(
      browserModal,
      /const pendingActionRef = useRef<BrowserSubscriptionPendingAction \| null>\(null\)/,
      'browser OAuth modal must gate one-shot auth actions synchronously through a ref',
    );
    assert.match(
      browserModal,
      /const browserSubscriptionMountedRef = useRef\(false\)/,
      'browser OAuth modal must own mounted state before writing async feedback',
    );
    assert.match(
      browserModal,
      /const authRequestIdRef = useRef<string \| null>\(null\)/,
      'browser OAuth modal must keep the pending authorization request in a ref for cleanup',
    );
    assert.match(
      browserModal,
      /async function refresh\(\): Promise<boolean> \{[\s\S]*const next = \(await bridge\.getAccountState\(\)\) as SubscriptionSnapshot;[\s\S]*if \(!browserSubscriptionMountedRef\.current\) return false;[\s\S]*setState\(next\);[\s\S]*catch \(error\) \{[\s\S]*if \(!browserSubscriptionMountedRef\.current\) return false;[\s\S]*toast\.error\('刷新登录状态失败', message\);[\s\S]*return true;/,
      'browser OAuth refresh must drop late state/error writes after modal close',
    );
    assert.match(
      browserModal,
      /useEffect\(\(\) => \{[\s\S]*browserSubscriptionMountedRef\.current = true;[\s\S]*void refresh\(\);[\s\S]*return \(\) => \{[\s\S]*browserSubscriptionMountedRef\.current = false;[\s\S]*pendingActionRef\.current = null;[\s\S]*const pendingAuthRequestId = authRequestIdRef\.current;[\s\S]*authRequestIdRef\.current = null;[\s\S]*if \(pendingAuthRequestId\) void bridge\.cancelAuthorization\(pendingAuthRequestId\);[\s\S]*\};[\s\S]*\}, \[\]\);/,
      'browser OAuth modal cleanup must invalidate async feedback and cancel pending authorization',
    );
    assert.match(
      browserModal,
      /function finishPendingAction\(\) \{[\s\S]*pendingActionRef\.current = null;[\s\S]*if \(browserSubscriptionMountedRef\.current\) setPendingAction\(null\);[\s\S]*\}/,
      'browser OAuth pending cleanup must not set state after unmount',
    );
    assert.match(
      browserModal,
      /function beginPendingAction\(action: BrowserSubscriptionPendingAction\): boolean \{[\s\S]*if \(pendingActionRef\.current !== null\) return false;[\s\S]*pendingActionRef\.current = action;[\s\S]*setPendingAction\(action\);[\s\S]*return true;/,
      'browser OAuth duplicate clicks must be rejected before React re-renders disabled buttons',
    );
    assert.match(browserModal, /if \(!beginPendingAction\('login'\)\) return;/, 'browser OAuth login must use the ref-backed action guard');
    assert.match(browserModal, /if \(!beginPendingAction\('logout'\)\) return;/, 'browser OAuth logout must use the ref-backed action guard');
    assert.match(
      browserModal,
      /const payload = await bridge\.getAuthUrl\(\);[\s\S]*authRequestIdRef\.current = payload\.authRequestId;[\s\S]*if \(!browserSubscriptionMountedRef\.current\) \{[\s\S]*authRequestIdRef\.current = null;[\s\S]*void bridge\.cancelAuthorization\(payload\.authRequestId\);[\s\S]*return;[\s\S]*\}[\s\S]*const opened = await bridge\.openAuthUrl\(payload\.authRequestId\);[\s\S]*if \(!browserSubscriptionMountedRef\.current\) return;[\s\S]*const refreshed = await refresh\(\);[\s\S]*if \(!browserSubscriptionMountedRef\.current \|\| !refreshed\) return;[\s\S]*const result = await bridge\.completeAuthorization\(payload\.authRequestId\);[\s\S]*if \(!browserSubscriptionMountedRef\.current\) return;[\s\S]*authRequestIdRef\.current = null;/,
      'browser OAuth login must stop each async continuation after modal close',
    );
    assert.match(
      browserModal,
      /if \(!opened\.ok\) \{[\s\S]*void bridge\.cancelAuthorization\(payload\.authRequestId\);[\s\S]*authRequestIdRef\.current = null;[\s\S]*setAuthRequestId\(null\);[\s\S]*setStateHint\(null\);/,
      'browser OAuth open-browser failures must clear and cancel the pending authorization request',
    );
    assert.match(
      browserModal,
      /catch \(error\) \{[\s\S]*const pendingAuthRequestId = authRequestIdRef\.current;[\s\S]*authRequestIdRef\.current = null;[\s\S]*if \(pendingAuthRequestId\) void bridge\.cancelAuthorization\(pendingAuthRequestId\);[\s\S]*setAuthRequestId\(null\);[\s\S]*setStateHint\(null\);/,
      'browser OAuth thrown login failures must clear and cancel the pending authorization request',
    );
    assert.match(
      browserModal,
      /const result = await bridge\.logout\(\);[\s\S]*if \(!browserSubscriptionMountedRef\.current\) return;[\s\S]*catch \(error\) \{[\s\S]*if \(!browserSubscriptionMountedRef\.current\) return;[\s\S]*toast\.error\('退出失败', subscriptionActionErrorMessage\(error\)\);/,
      'browser OAuth logout must not toast after modal close',
    );
    assert.match(browserModal, /const actionBusy = pendingAction !== null/, 'browser OAuth modal needs a shared busy flag derived from the named action');
    assert.match(browserModal, /disabled=\{actionBusy\}/, 'browser OAuth action buttons must disable while another one-shot action is pending');
    assert.match(browserModal, /pendingAction === 'login' \? '打开浏览器…' : `登录 \$\{display\.shortName\}`/, 'browser OAuth login start must expose specific pending copy');
    assert.match(browserModal, /pendingAction === 'logout' \? '退出中…' : '退出登录'/, 'browser OAuth logout must expose local progress feedback');
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
    const src = await readProviderSettingsCombinedSource();
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
    const src = await readProviderSettingsCombinedSource();
    const claudeCard = src.match(/function ClaudeSubscriptionCard[\s\S]*?function presentSubscriptionState/)?.[0] ?? '';
    const actionsBlock = claudeCard.match(/<div className="settingsConnectionActions">[\s\S]*?\{authRequestId &&/)?.[0] ?? '';

    assert.match(
      claudeCard,
      /const claudeLoginPending = authRequestId !== null \|\| state\?\.runtimeState === 'authorizing'/,
      'Claude OAuth must model paste-code authorization as an in-progress login, not an authenticated account',
    );
    assert.match(
      claudeCard,
      /const \[pendingAction, setPendingAction\] = useState<ClaudeSubscriptionPendingAction \| null>\(null\)/,
      'Claude OAuth needs a named pending action, not a bare boolean that cannot explain what is happening',
    );
    assert.match(
      claudeCard,
      /const pendingActionRef = useRef<ClaudeSubscriptionPendingAction \| null>\(null\)/,
      'Claude OAuth must gate one-shot auth actions synchronously through a ref',
    );
    assert.match(
      claudeCard,
      /const claudeAuthRequestIdRef = useRef<string \| null>\(null\)/,
      'Claude OAuth must keep the active auth request in a ref so unmount cleanup can cancel it',
    );
    assert.match(
      claudeCard,
      /return \(\) => \{[\s\S]*claudeCardMountedRef\.current = false;[\s\S]*const pendingAuthRequestId = claudeAuthRequestIdRef\.current;[\s\S]*claudeAuthRequestIdRef\.current = null;[\s\S]*if \(pendingAuthRequestId\) void window\.maka\.claudeSubscription\.cancelAuthorization\(pendingAuthRequestId\);[\s\S]*\};/,
      'closing the Claude OAuth modal mid-login must cancel the pending auth request',
    );
    assert.match(
      claudeCard,
      /function beginPendingAction\(action: ClaudeSubscriptionPendingAction\): boolean \{[\s\S]*if \(pendingActionRef\.current !== null\) return false;[\s\S]*pendingActionRef\.current = action;[\s\S]*setPendingAction\(action\);[\s\S]*return true;/,
      'Claude OAuth duplicate clicks must be rejected before React re-renders disabled buttons',
    );
    assert.match(
      claudeCard,
      /claudeAuthRequestIdRef\.current = payload\.authRequestId;[\s\S]*if \(!claudeCardMountedRef\.current\) \{[\s\S]*claudeAuthRequestIdRef\.current = null;[\s\S]*void window\.maka\.claudeSubscription\.cancelAuthorization\(payload\.authRequestId\);[\s\S]*return;[\s\S]*\}/,
      'Claude OAuth must cancel auth requests created after the component was already closed',
    );
    assert.match(
      claudeCard,
      /if \(!opened\.ok\) \{[\s\S]*claudeAuthRequestIdRef\.current = null;[\s\S]*void window\.maka\.claudeSubscription\.cancelAuthorization\(payload\.authRequestId\);[\s\S]*setAuthRequestId\(null\);/,
      'Claude OAuth must cancel a pending request when opening the browser fails',
    );
    assert.match(
      claudeCard,
      /if \(result\.ok\) \{[\s\S]*claudeAuthRequestIdRef\.current = null;[\s\S]*setAuthRequestId\(null\);/,
      'successful Claude paste-code completion must clear the pending auth request ref',
    );
    assert.match(
      claudeCard,
      /await window\.maka\.claudeSubscription\.cancelAuthorization\(authRequestId\);[\s\S]*claudeAuthRequestIdRef\.current = null;[\s\S]*setAuthRequestId\(null\);/,
      'explicit Claude OAuth cancellation must clear the pending auth request ref',
    );
    assert.match(claudeCard, /if \(!beginPendingAction\('login'\)\) return;/, 'starting login must use the ref-backed action guard');
    assert.match(claudeCard, /if \(!beginPendingAction\('submit'\)\) return;/, 'submitting an authorization code must use the ref-backed action guard');
    assert.match(claudeCard, /if \(!beginPendingAction\('cancel'\)\) return;/, 'canceling authorization must use the ref-backed action guard');
    assert.match(claudeCard, /if \(!beginPendingAction\('logout'\)\) return;/, 'logging out must use the ref-backed action guard');
    assert.match(claudeCard, /if \(!beginPendingAction\('quota'\)\) return;/, 'refreshing quota must use the ref-backed action guard');
    assert.match(
      actionsBlock,
      /\{canStartClaudeLogin \|\| claudeLoginPending \? \(/,
      'authorizing must take the start/login branch instead of the authenticated refresh/logout branch',
    );
    assert.match(claudeCard, /const actionBusy = pendingAction !== null/);
    assert.match(actionsBlock, /disabled=\{actionBusy \|\| claudeLoginPending\}/);
    assert.match(actionsBlock, /\? '登录中…'/, 'pending Claude OAuth should show a disabled login-in-progress action');
    assert.match(actionsBlock, /pendingAction === 'login'[\s\S]*'打开浏览器…'/, 'login start must expose a specific pending label before the auth code panel appears');
    assert.match(actionsBlock, /pendingAction === 'quota' \? '刷新中…' : '刷新配额'/, 'quota refresh must expose local progress feedback');
    assert.match(actionsBlock, /pendingAction === 'logout' \? '退出中…' : '退出登录'/, 'logout must expose local progress feedback');
    assert.match(
      actionsBlock,
      /\{canStartClaudeLogin \|\| claudeLoginPending \? \([\s\S]*'登录中…'[\s\S]*\) : \([\s\S]*刷新配额[\s\S]*退出登录/,
      'refresh/logout actions must be behind the non-pending branch so they cannot clear pending authorization before paste submit',
    );
    assert.match(claudeCard, /pendingAction === 'submit' \? '提交中…' : '提交授权码'/, 'authorization-code submit must expose local progress feedback');
    assert.match(claudeCard, /pendingAction === 'cancel' \? '取消中…' : '取消'/, 'authorization cancel must expose local progress feedback');
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
