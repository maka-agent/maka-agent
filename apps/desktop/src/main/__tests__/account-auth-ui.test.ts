import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { readSettingsCombinedSource } from './settings-contract-source-helpers.js';
import { readProviderSettingsSources } from './provider-contract-source-helpers.js';
import {
  deriveProviderAuthContract,
  type ProviderAuthContract,
  type ProviderType,
} from '@maka/core';
import {
  deriveAccountAuthActions,
  presentAccountAuthState,
} from '../../renderer/settings/account-auth-ui.js';

function contract(input: {
  providerType: ProviderType;
  enabled?: boolean;
  hasSecret?: boolean;
  lastTestStatus?: 'verified' | 'needs_reauth' | 'error';
}): ProviderAuthContract {
  return deriveProviderAuthContract(input);
}

describe('Account auth UI contract mapping', () => {
  const gates: Array<{ name: string; run(): void }> = [
    {
      name: 'disabled swallows all actions, including OAuth preview providers',
      run() {
        for (const providerType of ['anthropic', 'claude-subscription'] as const) {
          const c = contract({ providerType, enabled: false, hasSecret: true, lastTestStatus: 'verified' });
          assert.equal(presentAccountAuthState(c).stateLabel, '已关闭');
          assert.deepEqual(deriveAccountAuthActions(c), []);
        }
      },
    },
    {
      name: 'wired OAuth actions render as model-settings guidance, not preview placeholders',
      run() {
        const actions = deriveAccountAuthActions(
          contract({ providerType: 'claude-subscription', hasSecret: true, lastTestStatus: 'verified' }),
        );
        const state = presentAccountAuthState(
          contract({ providerType: 'claude-subscription', hasSecret: true, lastTestStatus: 'verified' }),
        );
        assert.equal(state.stateLabel, 'OAuth 已验证');
        assert.match(state.label, /OAuth 已验证/);
        assert.deepEqual(actions.map((action) => action.action), [
          'test_credentials',
          'fetch_models',
          'refresh_oauth',
          'revoke_auth',
        ]);
        for (const action of actions) {
          if (action.action === 'test_credentials') {
            assert.equal(action.kind, 'button');
            assert.equal(action.executable, true);
            assert.equal(action.label, '测试 OAuth');
            continue;
          }
          assert.equal(action.kind, 'guidance');
          assert.equal(action.executable, false);
          // Location guarantee moved from the label to the detail tooltip:
          // labels are the bare action, the detail must still say WHERE.
          assert.match(action.detail, /设置 · 模型|模型设置/);
          assert.doesNotMatch(action.label, /Roadmap|路线图|即将|TODO/i);
          assert.doesNotMatch(action.detail, /Roadmap|路线图|即将|TODO/i);
        }
      },
    },
    {
      name: 'unwired OAuth preview actions stay non-executable controlled previews',
      run() {
        const actions = deriveAccountAuthActions(contract({ providerType: 'gemini-cli' }));
        assert.equal(actions.length, 3);
        assert.deepEqual(actions.map((action) => action.action), [
          'start_oauth',
          'refresh_oauth',
          'revoke_auth',
        ]);
        for (const action of actions) {
          assert.equal(action.kind, 'preview');
          assert.equal(action.executable, false);
          assert.match(action.label, /预览/);
          assert.match(action.detail, /受控入口/);
          assert.match(action.detail, /不会连接登录服务或远端登录流程/);
          assert.doesNotMatch(action.label, /Roadmap|路线图|即将|TODO/i);
          assert.doesNotMatch(action.detail, /Roadmap|路线图|即将|TODO/i);
        }
      },
    },
    {
      name: 'validated copy stays scoped to credential validation, not runtime readiness',
      run() {
        const c = contract({ providerType: 'anthropic', hasSecret: true, lastTestStatus: 'verified' });
        const state = presentAccountAuthState(c);
        const actions = deriveAccountAuthActions(c);
        assert.equal(state.stateLabel, '凭据已验证');
        assert.match(state.detail, /只代表凭据和端点验证通过/);
        assert.match(state.detail, /不代表消息发送、流式响应或中断恢复已经运行可用/);
        assert.equal(actions.find((action) => action.action === 'test_credentials')?.label, '测试凭据');
        assert.equal(actions.find((action) => action.action === 'test_credentials')?.executable, true);
      },
    },
    {
      name: 'needs_reauth and error stay visually and textually distinct with generalized copy',
      run() {
        const needsReauth = presentAccountAuthState(
          contract({ providerType: 'anthropic', hasSecret: true, lastTestStatus: 'needs_reauth' }),
        );
        const error = presentAccountAuthState(
          contract({ providerType: 'anthropic', hasSecret: true, lastTestStatus: 'error' }),
        );
        assert.equal(needsReauth.stateLabel, '需重新授权');
        assert.equal(needsReauth.tone, 'warning');
        assert.match(needsReauth.detail, /替换凭据后重新测试/);
        assert.equal(error.stateLabel, '测试失败');
        assert.equal(error.tone, 'destructive');
        assert.match(error.detail, /概括后的错误信息/);
        assert.doesNotMatch(error.detail, /401|403|sk-/);
      },
    },
    {
      name: "setupMode 'none' uses local service probe copy, not credential-test copy",
      run() {
        const c = contract({ providerType: 'ollama' });
        const state = presentAccountAuthState(c);
        const actions = deriveAccountAuthActions(c);
        const probe = actions.find((action) => action.action === 'test_credentials');
        assert.equal(state.label, 'Ollama 不需要凭据');
        assert.match(state.detail, /本地服务和模型列表/);
        assert.equal(probe?.label, '探测本地服务');
        assert.match(probe?.detail ?? '', /不是凭据测试/);
        assert.doesNotMatch(probe?.label ?? '', /凭据/);
      },
    },
  ];

  for (const gate of gates) {
    it(gate.name, gate.run);
  }
});

describe('Account settings credential probe UI', () => {
  it('keeps account overview security and status copy Chinese-first', async () => {
    const source = await readSettingsCombinedSource();
    const authUi = await readFile(join(process.cwd(), 'src/renderer/settings/account-auth-ui.ts'), 'utf8');
    const connectionStatus = await readFile(join(process.cwd(), 'src/renderer/connection-status.ts'), 'utf8');
    const providerAuth = await readFile(join(process.cwd(), '../../packages/core/src/provider-auth.ts'), 'utf8');
    const page = source.match(/function AccountSettingsPage[\s\S]*?function AccountConnectionRow/)?.[0] ?? '';
    const row = source.match(/function AccountConnectionRow[\s\S]*?function AccountAuthActionView/)?.[0] ?? '';

    assert.match(page, /模型密钥保存在本机凭据文件内；订阅账号令牌交给系统安全存储/);
    assert.match(page, /每个会话都会在本机保留消息、工具调用、权限决策与模式变更记录/);
    assert.match(page, /修改模型密钥、服务地址或默认模型会清掉「已验证」状态/);
    // PR-CONNECTION-LIST-A11Y-0 (round 17/30): list container
    // switched from `<div role="list">` to semantic `<ul>`. The
    // aria-label is preserved.
    assert.match(page, /<ul className="settingsConnectionList" aria-label="模型连接列表">/);
    assert.match(row, /<div className="settingsConnectionActions" role="group" aria-label=\{`\$\{props\.connection\.name\} 账号操作`\}>/);
    assert.doesNotMatch(row, /<div className="settingsConnectionActions" aria-label=\{`\$\{props\.connection\.name\} 账号操作`\}>/);
    assert.match(connectionStatus, /最近一次测试成功。修改模型密钥、服务地址或默认模型会清掉此状态；发送链路需独立验证/);
    assert.match(row, /正在读取本机凭据和账号登录状态/);
    assert.match(row, /读取本机凭据和账号登录状态失败/);
    // Guidance chips carry the bare action; the 设置 · 模型 location lives in
    // the detail tooltip — the 在模型设置中 prefix repeated across four sibling
    // chips was pure noise once #645 gave guidance its own visual form.
    assert.match(authUi, /label: '保存密钥',/);
    assert.doesNotMatch(authUi, /在模型设置中/);
    assert.match(authUi, /账号页只展示状态；密钥输入仍在 设置 · 模型/);
    assert.match(authUi, /本页不直接写入凭据存储/);
    assert.match(authUi, /模型密钥管理/);

    for (const block of [page, row, authUi, connectionStatus, providerAuth]) {
      assert.doesNotMatch(block, /Electron safeStorage/);
      assert.doesNotMatch(block, /macOS Keychain|Windows DPAPI|Linux libsecret/);
      assert.doesNotMatch(block, /JSONL/);
      assert.doesNotMatch(block, /tool 调用/);
      assert.doesNotMatch(block, /mode_change/);
      assert.doesNotMatch(block, /API key|OAuth token/);
      assert.doesNotMatch(block, /等待 API key|API key 连接|此 provider|provider 原始响应|provider 返回错误/);
      assert.doesNotMatch(block, /API key 管理|在模型设置中保存 API key/);
      assert.doesNotMatch(block, /credential store/);
      assert.doesNotMatch(block, /修改 API key \/ baseUrl/);
      assert.doesNotMatch(block, /修改 key\/baseUrl/);
      assert.doesNotMatch(block, /读取 safeStorage \/ OAuth 登录状态/);
      assert.doesNotMatch(block, /agent 发送/);
      assert.doesNotMatch(block, /运行通路/);
    }
  });

  it('sanitizes account-page connection test failures before toast', async () => {
    const source = await readSettingsCombinedSource();
    const { shared } = await readProviderSettingsSources();
    const page = source.match(/function AccountSettingsPage[\s\S]*?function AccountConnectionRow/)?.[0] ?? '';
    const helper = shared.match(/function connectionTestFailureMessage\([\s\S]*?\n\}/)?.[0] ?? '';
    const fallback = shared.match(/function connectionTestFailureFallback\([\s\S]*?\n\}/)?.[0] ?? '';

    assert.match(
      helper,
      /generalizedErrorMessageChinese\(new Error\(result\.errorMessage\), fallback\)/,
      'Account page connection-test failures must classify/redact raw provider messages before toast',
    );
    assert.match(fallback, /statusCode === 429[\s\S]*触发速率限制/);
    assert.match(fallback, /errorClass === 'auth'[\s\S]*copy\.auth/);
    assert.match(fallback, /errorClass === 'network'[\s\S]*网络错误，请检查服务地址或代理设置后重试/);
    assert.doesNotMatch(fallback, /Base URL/);
    assert.match(
      source,
      /const ACCOUNT_CONNECTION_TEST_COPY = \{[\s\S]*auth: '鉴权失败，请检查模型密钥、订阅账号登录或凭据配置后重试。',[\s\S]*recheck: '连接测试失败，请检查模型连接配置后重试。',[\s\S]*\} as const;/,
      'Account page must inject its broader troubleshooting copy into the shared helper',
    );
    assert.match(
      page,
      /toast\.error\('连接测试失败', connectionTestFailureMessage\(result, ACCOUNT_CONNECTION_TEST_COPY\)\)/,
      'Account page test failure toast must not use result.errorMessage directly',
    );
    assert.match(
      page,
      /toast\.error\('测试出错', settingsActionErrorMessage\(error\)\)/,
      'Account page thrown test failures must use the shared Settings sanitized error helper',
    );
    assert.doesNotMatch(
      page,
      /function accountConnectionTestFailure(?:Message|Fallback)\(/,
      'Account page must not keep a private connection-test failure classifier after sharing',
    );
    assert.doesNotMatch(
      page,
      /toast\.error\('连接测试失败', result\.errorMessage \?\? '未知错误'\)|error instanceof Error \? error\.message : String\(error\)/,
      'Account page connection test must not echo raw result.errorMessage or raw Error.message',
    );
  });

  it('gates account-page connection tests and handles post-test refresh failures', async () => {
    const source = await readSettingsCombinedSource();
    const page = source.match(/function AccountSettingsPage[\s\S]*?function AccountConnectionRow/)?.[0] ?? '';

    assert.match(
      page,
      /const connectionTestGuard = useActionGuard<string>\(\)/,
      'Account page connection tests need a synchronous duplicate-click guard from the shared hook, not only React state',
    );
    assert.match(
      page,
      /async function testConnection\(slug: string\) \{[\s\S]*if \(!connectionTestGuard\.begin\(slug\)\) return;[\s\S]*await window\.maka\.connections\.test\(slug\)[\s\S]*if \(!accountPageMountedRef\.current \|\| connectionTestGuard\.current !== slug\) return;/,
      'Account page connection test must set the duplicate-click guard before awaiting IPC',
    );
    assert.match(
      page,
      /finally \{[\s\S]*if \(accountPageMountedRef\.current && connectionTestGuard\.current === slug\) \{[\s\S]*try \{[\s\S]*await props\.onRefresh\(\);[\s\S]*\} catch \(error\) \{[\s\S]*if \(accountPageMountedRef\.current && connectionTestGuard\.current === slug\) \{[\s\S]*toast\.error\('刷新模型连接状态失败', settingsActionErrorMessage\(error\)\);[\s\S]*\} finally \{[\s\S]*connectionTestGuard\.finish\(\);[\s\S]*if \(accountPageMountedRef\.current\) \{[\s\S]*setTestingSlug\(null\);/,
      'Account page connection test must keep the button pending through status refresh and surface refresh failures',
    );
    assert.doesNotMatch(
      page,
      /finally \{[\s\S]*setTestingSlug\(null\);[\s\S]*await props\.onRefresh\(\);[\s\S]*\}/,
      'Account page connection test must not re-enable the button before the status refresh finishes',
    );
  });

  it('drops late account-page connection test feedback after Settings is closed', async () => {
    const source = await readSettingsCombinedSource();
    const page = source.match(/function AccountSettingsPage[\s\S]*?function AccountConnectionRow/)?.[0] ?? '';

    assert.match(
      page,
      /const accountPageMountedRef = useMountedRef\(\);/,
      'Account page must track mounted ownership for connection tests',
    );
    assert.match(
      page,
      /const connectionTestGuard = useActionGuard<string>\(\)/,
      'Account page must hold its in-flight connection test owner in the shared guard (released on unmount)',
    );
    assert.match(
      page,
      /const result = await window\.maka\.connections\.test\(slug\);[\s\S]*if \(!accountPageMountedRef\.current \|\| connectionTestGuard\.current !== slug\) return;[\s\S]*if \(result\.ok\) \{/,
      'Connection test success/failure toasts must not fire after unmount',
    );
    assert.match(
      page,
      /catch \(error\) \{[\s\S]*if \(accountPageMountedRef\.current && connectionTestGuard\.current === slug\) \{[\s\S]*toast\.error\('测试出错', settingsActionErrorMessage\(error\)\);/,
      'Thrown connection-test errors must not toast after unmount',
    );
    assert.match(
      page,
      /finally \{[\s\S]*if \(accountPageMountedRef\.current && connectionTestGuard\.current === slug\) \{[\s\S]*await props\.onRefresh\(\);/,
      'Post-test status refresh must not run after the account page unmounts',
    );
    assert.match(
      page,
      /connectionTestGuard\.finish\(\);[\s\S]*if \(accountPageMountedRef\.current\) \{[\s\S]*setTestingSlug\(null\);/,
      'Connection-test cleanup must release the guard but not write React pending state after unmount',
    );
  });

  it('normalizes legacy persisted connection-test messages before display', async () => {
    const [source, providerSources] = await Promise.all([
      readSettingsCombinedSource(),
      readProviderSettingsSources(),
    ]);
    const helper = providerSources.shared.match(/function connectionLastTestMessageDisplay\(message: string \| undefined\): string \| undefined \{[\s\S]*?\n\}/)?.[0] ?? '';
    const row = source.match(/function AccountConnectionRow[\s\S]*?function AccountAuthActionView/)?.[0] ?? '';

    assert.match(helper, /'connection verified': '连接已验证'/);
    assert.match(helper, /'authentication failed': '鉴权失败'/);
    assert.match(helper, /'request timed out': '请求超时'/);
    assert.match(helper, /'network error': '网络错误'/);
    assert.match(helper, /'provider returned an error': '模型服务返回错误'/);
    assert.match(helper, /'connection test failed': '连接测试失败'/);
    assert.match(
      helper,
      /generalizedErrorMessageChinese\(new Error\(trimmed\), ''\)/,
      'unknown legacy raw provider messages should be classified/redacted before display',
    );
    assert.match(
      row,
      /const lastTestMessage = connectionLastTestMessageDisplay\(props\.connection\.lastTestMessage\)/,
      'Account connection rows must not render persisted lastTestMessage directly',
    );
    assert.doesNotMatch(
      row,
      /const lastTestMessage = props\.connection\.lastTestMessage/,
      'legacy English persisted status such as Connection verified must be normalized at render time',
    );
  });

  it('does not display credential-probe failures as missing credentials', async () => {
    // task #38 sweep: Settings -> 账号 used to map a thrown
    // `connections.hasSecret(slug)` to `false`, which rendered an
    // unknown safeStorage/OAuth read failure as "待配置". Unknown is
    // not missing.
    const source = await readSettingsCombinedSource();
    const page = source.match(/function AccountSettingsPage[\s\S]*?function AccountConnectionRow/)?.[0] ?? '';
    const row = source.match(/function AccountConnectionRow[\s\S]*?function AccountAuthActionView/)?.[0] ?? '';

    assert.match(source, /type AccountSecretProbeStatus = boolean \| 'loading' \| 'error'/);
    assert.match(page, /useState<Record<string, AccountSecretProbeStatus>>\(\{\}\)/);
    assert.match(
      page,
      /catch \(error\) \{[\s\S]*return \{ slug: connection\.slug, status: 'error', message: settingsActionErrorMessage\(error\) \}/,
      'hasSecret probe failures must be carried as error state with a message',
    );
    assert.doesNotMatch(
      page,
      /catch \{[\s\S]*return \[connection\.slug, false\] as const/,
      'hasSecret probe failures must not be downgraded to missing credentials',
    );
    assert.match(page, /toast\.error\('读取模型凭据状态失败', failure\.message\)/);
    assert.match(page, /模型凭据状态暂时没刷新成功，已避免把未知状态显示成待配置/);
    assert.match(page, /secretStatus=\{secretMap\[connection\.slug\] \?\? 'loading'\}/);
    assert.match(row, /const secretProbePending = requiresSecret && \(props\.secretStatus === 'loading' \|\| props\.secretStatus === 'error'\)/);
    assert.match(row, /secretProbePending \? true : hasSecretForKnownStatus/);
    assert.match(row, /label: props\.secretStatus === 'loading' \? '读取凭据状态…' : '凭据状态未知'/);
    assert.match(row, /stateLabel: props\.secretStatus === 'loading' \? '读取中' : '读取失败'/);
  });
});
