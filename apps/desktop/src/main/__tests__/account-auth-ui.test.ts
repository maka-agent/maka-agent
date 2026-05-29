import { strict as assert } from 'node:assert';
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
      name: 'OAuth preview actions render as non-executable controlled previews, never buttons',
      run() {
        const actions = deriveAccountAuthActions(contract({ providerType: 'claude-subscription' }));
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
