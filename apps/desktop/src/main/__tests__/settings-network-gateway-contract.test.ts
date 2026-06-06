import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const settingsSource = readFileSync(
  join(process.cwd(), 'src/renderer/settings/SettingsModal.tsx'),
  'utf8',
);
const mainSource = readFileSync(
  join(process.cwd(), 'src/main/main.ts'),
  'utf8',
);

function blockBetween(start: string, end: string): string {
  return settingsSource.match(new RegExp(`${start}[\\s\\S]*?${end}`))?.[0] ?? '';
}

describe('Settings network and gateway persistence contract', () => {
  it('ignores stale settings save responses after newer field edits', () => {
    assert.match(
      settingsSource,
      /const settingsUpdateTicketRef = useRef\(0\)/,
      'Settings updates need a latest-response ticket so rapid field edits cannot be overwritten by an older save response',
    );
    assert.match(
      settingsSource,
      /async function updateSettings\(patch: Parameters<typeof window\.maka\.settings\.update>\[0\]\) \{[\s\S]*const ticket = settingsUpdateTicketRef\.current \+ 1;[\s\S]*settingsUpdateTicketRef\.current = ticket;[\s\S]*const result = await window\.maka\.settings\.update\(patch\);[\s\S]*if \(settingsModalMountedRef\.current && ticket === settingsUpdateTicketRef\.current\) \{[\s\S]*setSettings\(next\);[\s\S]*props\.onUserLabelChange\?\.\(next\.personalization\.displayName\);[\s\S]*\}/,
      'Settings update responses should only refresh parent state when they belong to the latest save and the modal is still mounted',
    );
  });

  it('surfaces network proxy save failures instead of returning raw rejected promises from field handlers', () => {
    const networkBlock = blockBetween('function NetworkSettingsPage', 'function OpenGatewaySettingsPage');

    assert.match(
      networkBlock,
      /const \[proxyDraft, setProxyDraft\] = useState<NetworkProxySettings>\(persistedProxy\)/,
      'Network proxy text fields must use a local draft so typing does not wait for IPC persistence',
    );
    assert.match(
      networkBlock,
      /const proxyDraftRef = useRef<NetworkProxySettings>\(persistedProxy\)/,
      'Network proxy draft updates must have a synchronous ref for rapid consecutive field changes',
    );
    assert.match(
      networkBlock,
      /function commitProxyDraft\(next: NetworkProxySettings\) \{[\s\S]*proxyDraftRef\.current = next;[\s\S]*setProxyDraft\(next\);[\s\S]*\}/,
      'Network proxy local draft must update the rendered value immediately',
    );
    assert.match(
      networkBlock,
      /async function updateProxy\(patch: Partial<NetworkProxySettings>\) \{[\s\S]*const nextDraft = \{ \.\.\.proxyDraftRef\.current, \.\.\.patch \};[\s\S]*commitProxyDraft\(nextDraft\);[\s\S]*try \{[\s\S]*const result = await props\.onUpdate\(\{ network: \{ proxy: patch \} \}\)[\s\S]*commitProxyDraft\(result\.settings\.network\.proxy\)[\s\S]*catch \(error\) \{[\s\S]*commitProxyDraft\(persistedProxyRef\.current\)[\s\S]*toast\.error\('保存网络设置失败', settingsActionErrorMessage\(error\)\)/,
      'Network proxy settings updates must show a visible failure toast',
    );
    assert.match(
      networkBlock,
      /value=\{proxyDraft\.host\}[\s\S]*onChange=\{\(event\) => void updateProxy\(\{ host: event\.currentTarget\.value \}\)\}/,
      'Network proxy host input must render from the local draft while persisting in the background',
    );
    assert.match(
      networkBlock,
      /value=\{String\(proxyDraft\.port \|\| ''\)\}[\s\S]*onChange=\{\(event\) => void updateProxy\(\{ port: Number\(event\.currentTarget\.value\) \|\| 0 \}\)\}/,
      'Network proxy port input must render from the local draft while persisting in the background',
    );
    assert.match(
      networkBlock,
      /value=\{proxyDraft\.bypassList\.join\(', '\)\}[\s\S]*onChange=\{\(event\) => void updateProxy\(\{ bypassList: csvList\(event\.currentTarget\.value\) \}\)\}/,
      'Network proxy bypass-list input must render from the local draft while persisting in the background',
    );
    assert.doesNotMatch(
      networkBlock,
      /onChange=\{\([^)]*\) => updateProxy\(/,
      'Network proxy field handlers must not leak a returned rejected promise',
    );
    assert.match(
      networkBlock,
      /onChange=\{\(enabled\) => void updateProxy\(\{ enabled \}\)\}/,
      'Network proxy enable switch should explicitly fire-and-report via updateProxy',
    );
  });

  it('localizes proxy test failure messages before returning them to Settings', () => {
    const helper = mainSource.match(/function proxyTestFailureMessage\(result: TestProxyResult\): string \{[\s\S]*?\n\}/);
    const handler = mainSource.match(/settings:testNetworkProxy[\s\S]*?satisfies SettingsTestResult;/)?.[0] ?? '';
    const networkBlock = blockBetween('function NetworkSettingsPage', 'function OpenGatewaySettingsPage');

    assert.ok(helper, 'main must normalize proxy test failures at the IPC boundary');
    assert.match(helper![0], /proxy disabled[\s\S]*代理未启用，请先打开代理开关/);
    assert.match(helper![0], /proxy host\/port required[\s\S]*请填写代理服务器地址和端口后再测试/);
    assert.match(helper![0], /proxy test timeout[\s\S]*代理测试超时，请检查代理服务是否可达/);
    assert.match(helper![0], /result\.status[\s\S]*代理测试返回 HTTP \$\{result\.status\}/);
    assert.match(helper![0], /redactSecrets\(result\.error \?\? ''\)/);
    assert.match(helper![0], /generalizedErrorMessageChinese\(raw, ''\)/);
    assert.match(handler, /message: proxyTestFailureMessage\(result\)/);
    assert.doesNotMatch(
      handler,
      /message: result\.error \?\? \(result\.status \? `HTTP \$\{result\.status\}` : '代理不可达'\)/,
      'proxy test IPC must not pass through runtime English/raw failure messages',
    );
    assert.match(
      networkBlock,
      /catch \(error\) \{[\s\S]*toast\.error\('代理测试出错', settingsActionErrorMessage\(error\)\)/,
      'Renderer-side proxy test IPC rejections must use the Settings error scrubber',
    );
    assert.doesNotMatch(
      networkBlock,
      /代理测试出错[\s\S]{0,120}error instanceof Error \? error\.message : String\(error\)/,
      'Renderer-side proxy test must not toast raw Error.message on rejected IPC',
    );
  });

  it('gates proxy tests and reads the latest draft snapshot', () => {
    const networkBlock = blockBetween('function NetworkSettingsPage', 'function OpenGatewaySettingsPage');

    assert.match(
      networkBlock,
      /const proxyTestRunningRef = useRef\(false\);/,
      'Network proxy test needs a ref gate so fast double-clicks cannot duplicate proxy test IPC before React disables the button',
    );
    assert.match(
      networkBlock,
      /async function testProxy\(\) \{\s*if \(proxyTestRunningRef\.current\) return;[\s\S]*proxyTestRunningRef\.current = true;[\s\S]*window\.maka\.settings\.testNetworkProxy\(toProxyTestInput\(proxyDraftRef\.current\)\)/,
      'Network proxy test must lock synchronously and test the latest local draft snapshot, not the previous render value',
    );
    assert.match(
      networkBlock,
      /finally \{[\s\S]*proxyTestRunningRef\.current = false;[\s\S]*setTesting\(false\);[\s\S]*\}/,
      'Network proxy test must release the ref gate after the IPC settles',
    );
    assert.doesNotMatch(
      networkBlock,
      /testNetworkProxy\(toProxyTestInput\(proxyDraft\)\)/,
      'Network proxy test must not read stale React state after a just-typed proxy edit',
    );
    assert.match(networkBlock, /aria-busy=\{testing\}/, 'Network proxy test button must expose pending state to assistive tech');
    assert.match(networkBlock, /data-pending=\{testing \? 'true' : undefined\}/, 'Network proxy test button must expose a stable pending hook');
    assert.match(networkBlock, /onClick=\{\(\) => void testProxy\(\)\}/, 'Network proxy test click handler must explicitly discard the async promise');
  });

  it('drops late network proxy save and test UI writes after Settings is closed', () => {
    const networkBlock = blockBetween('function NetworkSettingsPage', 'function OpenGatewaySettingsPage');

    assert.match(
      networkBlock,
      /const networkPageMountedRef = useRef\(false\);/,
      'Network proxy page must track mounted ownership for async save/test actions',
    );
    assert.match(
      networkBlock,
      /useEffect\(\(\) => \{[\s\S]*networkPageMountedRef\.current = true;[\s\S]*return \(\) => \{[\s\S]*networkPageMountedRef\.current = false;[\s\S]*proxySaveTicketRef\.current \+= 1;[\s\S]*proxyTestRunningRef\.current = false;/,
      'Network proxy cleanup must invalidate save tickets and release test ownership when Settings closes',
    );
    assert.match(
      networkBlock,
      /if \(networkPageMountedRef\.current && ticket === proxySaveTicketRef\.current\) \{[\s\S]*commitProxyDraft\(result\.settings\.network\.proxy\);/,
      'Network proxy save success must not write local draft state after unmount',
    );
    assert.match(
      networkBlock,
      /catch \(error\) \{[\s\S]*if \(networkPageMountedRef\.current && ticket === proxySaveTicketRef\.current\) \{[\s\S]*commitProxyDraft\(persistedProxyRef\.current\);[\s\S]*toast\.error\('保存网络设置失败', settingsActionErrorMessage\(error\)\);/,
      'Network proxy save failure must not rollback draft state or toast after unmount',
    );
    assert.match(
      networkBlock,
      /if \(result\.ok && networkPageMountedRef\.current\) \{[\s\S]*toast\.success\('代理可达'/,
      'Network proxy test success toast must only fire while the page is still mounted',
    );
    assert.match(
      networkBlock,
      /else if \(networkPageMountedRef\.current\) \{[\s\S]*toast\.error\('代理测试失败', result\.message\);/,
      'Network proxy test failure toast must only fire while the page is still mounted',
    );
    assert.match(
      networkBlock,
      /catch \(error\) \{[\s\S]*if \(networkPageMountedRef\.current\) \{[\s\S]*toast\.error\('代理测试出错', settingsActionErrorMessage\(error\)\);/,
      'Network proxy test thrown-error toast must only fire while the page is still mounted',
    );
    assert.match(
      networkBlock,
      /finally \{[\s\S]*proxyTestRunningRef\.current = false;[\s\S]*if \(networkPageMountedRef\.current\) \{[\s\S]*setTesting\(false\);/,
      'Network proxy test cleanup must release the ref but not write React state after unmount',
    );
  });

  it('keeps gateway success toasts behind a successful settings save', () => {
    const gatewayBlock = blockBetween('function OpenGatewaySettingsPage', 'function presentGatewayStatus');

    assert.match(
      gatewayBlock,
      /const \[gatewayDraft, setGatewayDraft\] = useState\(persistedGateway\)/,
      'Open Gateway host/port controls must use a local draft so typing does not wait for IPC persistence',
    );
    assert.match(
      gatewayBlock,
      /const gatewayDraftRef = useRef\(persistedGateway\)/,
      'Open Gateway draft updates must have a synchronous ref for rapid consecutive field changes',
    );
    assert.match(
      gatewayBlock,
      /function commitGatewayDraft\(next: AppSettings\['openGateway'\]\) \{[\s\S]*gatewayDraftRef\.current = next;[\s\S]*setGatewayDraft\(next\);[\s\S]*\}/,
      'Open Gateway local draft must update the rendered value immediately',
    );
    assert.match(
      gatewayBlock,
      /async function updateGateway\(patch: Partial<AppSettings\['openGateway'\]>\): Promise<boolean> \{[\s\S]*const nextDraft = \{ \.\.\.gatewayDraftRef\.current, \.\.\.patch \};[\s\S]*commitGatewayDraft\(nextDraft\);[\s\S]*const result = await props\.onUpdate\(\{ openGateway: patch \}\);[\s\S]*commitGatewayDraft\(result\.settings\.openGateway\);[\s\S]*catch \(error\) \{[\s\S]*commitGatewayDraft\(persistedGatewayRef\.current\);[\s\S]*toast\.error\('保存开放网关设置失败', settingsActionErrorMessage\(error\)\)[\s\S]*return false;/,
      'Open Gateway settings updates must return a boolean and surface failures',
    );
    assert.match(
      gatewayBlock,
      /value=\{gatewayDraft\.host\}[\s\S]*onChange=\{\(event\) => void updateGateway\(\{ host: event\.currentTarget\.value as AppSettings\['openGateway'\]\['host'\] \}\)\}/,
      'Open Gateway host select must render from the local draft while persisting in the background',
    );
    assert.match(
      gatewayBlock,
      /value=\{String\(gatewayDraft\.port\)\}[\s\S]*onChange=\{\(event\) => void updateGateway\(\{ port: Number\(event\.currentTarget\.value\) \|\| 3939 \}\)\}/,
      'Open Gateway port input must render from the local draft while persisting in the background',
    );
    assert.doesNotMatch(
      gatewayBlock,
      /aria-label="开放网关端口"[\s\S]{0,180}disabled=\{saving\}/,
      'Open Gateway port input must not lock after each digit while background save is pending',
    );
    assert.match(
      gatewayBlock,
      /const saved = await updateGateway\(\{ token: nextToken \}\);[\s\S]*if \(!saved\) return;[\s\S]*toast\.success\(nextToken \? '网关 token 已保存' : '网关 token 已清空'\)/,
      'Saving or clearing the gateway token must not show success after a failed save',
    );
    assert.match(
      gatewayBlock,
      /const saved = await updateGateway\(\{ token \}\);[\s\S]*if \(!saved\) return;[\s\S]*toast\.success\('网关 token 已生成'/,
      'Generated gateway tokens must not show success after a failed save',
    );
    assert.doesNotMatch(
      gatewayBlock,
      /onChange=\{\([^)]*\) => updateGateway\(/,
      'Open Gateway field handlers must not leak a returned rejected promise',
    );
  });

  it('renders gateway runtime start errors from closed reasons instead of raw listen errors', () => {
    const helper = blockBetween('function gatewayErrorCopy', 'function generateGatewayToken');

    assert.match(helper, /error === 'start_failed'/);
    assert.match(helper, /开放网关暂时无法启动，请检查监听地址和端口。/);
    assert.match(helper, /EADDRINUSE[\s\S]*端口已被占用/);
    assert.doesNotMatch(
      helper,
      /return error;/,
      'Open Gateway Settings must not render raw runtime lastError strings',
    );
  });
});
