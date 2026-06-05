import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
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
          assert.match(action.label, /模型设置/);
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
          assert.match(action.detail, /不会连接 OAuth IPC/);
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
        assert.match(state.detail, /不代表 agent 发送、流式、中断路径已经运行可用/);
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
  it('sanitizes account-page connection test failures before toast', async () => {
    const source = await readFile(join(process.cwd(), 'src/renderer/settings/SettingsModal.tsx'), 'utf8');
    const page = source.match(/function AccountSettingsPage[\s\S]*?function AccountConnectionRow/)?.[0] ?? '';
    const helper = source.match(/function accountConnectionTestFailureMessage\(result: ConnectionTestResult\): string \{[\s\S]*?\n\}/)?.[0] ?? '';
    const fallback = source.match(/function accountConnectionTestFailureFallback\(result: ConnectionTestResult\): string \{[\s\S]*?\n\}/)?.[0] ?? '';

    assert.match(
      helper,
      /generalizedErrorMessageChinese\(new Error\(result\.errorMessage\), fallback\)/,
      'Account page connection-test failures must classify/redact raw provider messages before toast',
    );
    assert.match(fallback, /statusCode === 429[\s\S]*触发速率限制/);
    assert.match(fallback, /errorClass === 'auth'[\s\S]*鉴权失败/);
    assert.match(fallback, /errorClass === 'network'[\s\S]*网络错误/);
    assert.match(
      page,
      /toast\.error\('连接测试失败', accountConnectionTestFailureMessage\(result\)\)/,
      'Account page test failure toast must not use result.errorMessage directly',
    );
    assert.match(
      page,
      /toast\.error\('测试出错', settingsActionErrorMessage\(error\)\)/,
      'Account page thrown test failures must use the shared Settings sanitized error helper',
    );
    assert.doesNotMatch(
      page,
      /toast\.error\('连接测试失败', result\.errorMessage \?\? '未知错误'\)|error instanceof Error \? error\.message : String\(error\)/,
      'Account page connection test must not echo raw result.errorMessage or raw Error.message',
    );
  });

  it('does not display credential-probe failures as missing credentials', async () => {
    // task #38 sweep: Settings -> 账号 used to map a thrown
    // `connections.hasSecret(slug)` to `false`, which rendered an
    // unknown safeStorage/OAuth read failure as "待配置". Unknown is
    // not missing.
    const source = await readFile(join(process.cwd(), 'src/renderer/settings/SettingsModal.tsx'), 'utf8');
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
