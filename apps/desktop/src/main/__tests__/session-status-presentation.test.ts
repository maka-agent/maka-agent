/**
 * Tests for SessionStatus + SessionBlockedReason presentation helpers
 * (PR109b).
 *
 * Lock down the two contracts @kenji called out:
 *  - blocked-reason copy must never expose the enum identifier
 *  - status tone matrix follows the design-system tokens
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { SESSION_BLOCKED_REASONS, SESSION_STATUSES } from '@maka/core';
import {
  deriveFailedTurnRecovery,
  describeBlockedReason,
  describeTurnErrorClass,
  presentSessionStatus,
  sessionStatusAriaLabel,
} from '../../renderer/session-status-presentation.js';

const REPO_ROOT = resolve(process.cwd(), '..', '..');

describe('presentSessionStatus', () => {
  it('covers every SessionStatus enum value', () => {
    for (const status of SESSION_STATUSES) {
      const presentation = presentSessionStatus(status);
      assert.ok(presentation.label, `${status} should have a label`);
      assert.ok(presentation.tone, `${status} should have a tone`);
    }
  });

  it('labels are Chinese (no English fallback)', () => {
    for (const status of SESSION_STATUSES) {
      const presentation = presentSessionStatus(status);
      assert.match(presentation.label, /[一-鿿]/, `${status} label should contain Chinese chars`);
      assert.doesNotMatch(presentation.label, /[a-zA-Z]/, `${status} label should have no Latin letters`);
    }
  });

  it('terminal states (archived, aborted) are not interactive', () => {
    assert.equal(presentSessionStatus('archived').interactive, false);
    assert.equal(presentSessionStatus('aborted').interactive, false);
  });

  it('working states (active, running, etc.) are interactive', () => {
    for (const status of ['active', 'running', 'waiting_for_user', 'blocked', 'review', 'done'] as const) {
      assert.equal(presentSessionStatus(status).interactive, true, `${status} should be interactive`);
    }
  });

  it('tones map to a small closed vocabulary', () => {
    const allowedTones = new Set(['accent', 'warning', 'destructive', 'info', 'success', 'muted', 'neutral']);
    for (const status of SESSION_STATUSES) {
      const tone = presentSessionStatus(status).tone;
      assert.ok(allowedTones.has(tone), `${status} tone ${tone} not in allowed set`);
    }
  });

  it('blocked is destructive', () => {
    assert.equal(presentSessionStatus('blocked').tone, 'destructive');
  });

  it('done is success', () => {
    assert.equal(presentSessionStatus('done').tone, 'success');
  });
});

describe('describeBlockedReason (@kenji generalized copy contract)', () => {
  it('covers every SessionBlockedReason enum value', () => {
    for (const reason of SESSION_BLOCKED_REASONS) {
      const text = describeBlockedReason(reason);
      assert.ok(text, `${reason} should have copy`);
    }
  });

  it('NEVER returns the raw enum identifier as the label', () => {
    for (const reason of SESSION_BLOCKED_REASONS) {
      const text = describeBlockedReason(reason);
      // Each enum identifier must not appear literally in the copy
      assert.doesNotMatch(text, new RegExp(reason), `copy "${text}" leaks enum identifier ${reason}`);
    }
  });

  it('all blocked copy is Chinese', () => {
    for (const reason of SESSION_BLOCKED_REASONS) {
      const text = describeBlockedReason(reason);
      assert.match(text, /[一-鿿]/, `"${text}" should contain Chinese chars`);
      assert.doesNotMatch(text, /[a-zA-Z]/, `"${text}" should have no Latin letters`);
    }
  });

  it('falls back to "unknown" copy when reason is undefined', () => {
    const fallback = describeBlockedReason(undefined);
    assert.equal(fallback, describeBlockedReason('unknown'));
  });

  it('NO_REAL_CONNECTION maps to user-facing model-connection phrasing', () => {
    const text = describeBlockedReason('NO_REAL_CONNECTION');
    assert.equal(text, '等待配置可用模型连接');
    assert.doesNotMatch(text, /缺少可用模型连接/);
  });

  it('keeps the shared UI blocked-reason tooltip in sync with actionable waiting copy', async () => {
    const ui = await readFile(join(REPO_ROOT, 'packages/ui/src/components.tsx'), 'utf8');

    assert.match(ui, /NO_REAL_CONNECTION:\s*'等待配置可用模型连接'/);
    assert.doesNotMatch(ui, /NO_REAL_CONNECTION:\s*'缺少可用模型连接'/);
  });

  it('auth maps to re-login phrasing', () => {
    assert.match(describeBlockedReason('auth'), /登录|登陆/);
  });
});

describe('sessionStatusAriaLabel', () => {
  it('non-blocked status returns just the status label', () => {
    assert.equal(sessionStatusAriaLabel('running'), '进行中');
    assert.equal(sessionStatusAriaLabel('active'), '可继续');
  });

  it('blocked status combines status label + blocked reason', () => {
    const text = sessionStatusAriaLabel('blocked', 'auth');
    assert.match(text, /已阻塞/);
    assert.match(text, /登录|登陆/);
    // Separator stays consistent
    assert.match(text, / · /);
  });

  it('blocked without reason falls back to actionable recovery copy', () => {
    const text = sessionStatusAriaLabel('blocked');
    assert.match(text, /已阻塞/);
    assert.match(text, /运行中断，可重试/);
    assert.doesNotMatch(text, /未知阻塞/);
  });
});

describe('permission mode transition guard copy', () => {
  it('disables the mode switcher for running and permission-waiting sessions', async () => {
    const ui = await readFile(join(REPO_ROOT, 'packages/ui/src/components.tsx'), 'utf8');
    const chatShellBlock = ui.match(/const permissionModeDisabledReason[\s\S]*?<PermissionModeSwitcher/)?.[0] ?? '';

    assert.match(chatShellBlock, /status === 'running'/);
    assert.match(chatShellBlock, /当前对话正在运行，等结束后再切换权限模式。/);
    assert.match(chatShellBlock, /status === 'waiting_for_user'/);
    assert.match(chatShellBlock, /当前有工具调用正在等待确认，处理后再切换权限模式。/);
    assert.match(ui, /disabledReason=\{permissionModeDisabledReason\}/);
  });

  it('supports standard radiogroup keyboard navigation on the mode switcher', async () => {
    const ui = await readFile(join(REPO_ROOT, 'packages/ui/src/components.tsx'), 'utf8');
    const switcherBlock = ui.match(/function PermissionModeSwitcher[\s\S]*?function createAbsoluteTimeFormat/)?.[0] ?? '';

    assert.match(switcherBlock, /role="radiogroup"[\s\S]*aria-label="权限模式"/);
    assert.match(switcherBlock, /onKeyDown=\{changeModeByKeyboard\}/);
    assert.match(switcherBlock, /case 'ArrowRight':[\s\S]*case 'ArrowDown':[\s\S]*currentIndex \+ 1/);
    assert.match(switcherBlock, /case 'ArrowLeft':[\s\S]*case 'ArrowUp':[\s\S]*currentIndex - 1/);
    assert.match(switcherBlock, /case 'Home':[\s\S]*nextIndex = 0/);
    assert.match(switcherBlock, /case 'End':[\s\S]*PERMISSION_MODE_ORDER\.length - 1/);
    assert.match(switcherBlock, /data-mode=\{mode\}/);
    assert.match(switcherBlock, /const group = event\.currentTarget/);
    assert.match(switcherBlock, /focus\(\{ preventScroll: true \}\)/);
  });
});

describe('describeTurnErrorClass (PR109e-d @kenji gate #3)', () => {
  it('returns Chinese label for known timeout class', () => {
    assert.match(describeTurnErrorClass('timeout'), /超时/);
  });

  it('returns Chinese label for known auth / 401 / 403 classes', () => {
    for (const cls of ['auth', '401', '403']) {
      assert.match(describeTurnErrorClass(cls), /鉴权/, `${cls} should map to 鉴权失败`);
    }
  });

  it('returns Chinese label for rate_limit / rate_exceeded', () => {
    for (const cls of ['rate_limit', 'rate_exceeded']) {
      assert.match(describeTurnErrorClass(cls), /速率/, `${cls} should map to rate-limit phrasing`);
    }
  });

  it('returns Chinese label for network / fetch / econn classes', () => {
    for (const cls of ['network', 'fetch_failed', 'econnrefused']) {
      assert.match(describeTurnErrorClass(cls), /网络/, `${cls} should map to network error`);
    }
  });

  it('returns Chinese label for provider_unavailable / 5xx codes', () => {
    for (const cls of ['provider_unavailable', '500', '503']) {
      const text = describeTurnErrorClass(cls);
      assert.equal(text, '模型服务返回错误', `${cls} should map to provider error copy`);
      assert.doesNotMatch(text, /暂不可用/);
    }
  });

  it('returns Chinese label for tool_failed', () => {
    assert.match(describeTurnErrorClass('tool_failed'), /工具/);
  });

  it('returns a specific Chinese label for app restart recovery', () => {
    assert.equal(describeTurnErrorClass('app_restarted'), '本地应用重启，上一轮没有完成');
  });

  it('falls back to "未知错误" for unrecognized classes', () => {
    for (const cls of [undefined, 'xyz', 'something_new', '']) {
      assert.match(describeTurnErrorClass(cls), /未知/, `${JSON.stringify(cls)} should fall back to 未知错误`);
    }
  });

  it('NEVER returns the raw enum identifier verbatim (Chinese-only)', () => {
    // Per @kenji review: UI must not display the raw `errorClass`.
    for (const cls of ['timeout', 'auth', 'rate_limit', 'network', 'tool_failed', 'provider_unavailable']) {
      const text = describeTurnErrorClass(cls);
      assert.match(text, /[一-鿿]/, `${cls} should produce Chinese text`);
      assert.doesNotMatch(text, new RegExp(`\\b${cls}\\b`), `${cls} copy "${text}" leaks enum identifier`);
    }
  });

  it('is case-insensitive', () => {
    assert.equal(describeTurnErrorClass('TIMEOUT'), describeTurnErrorClass('timeout'));
    assert.equal(describeTurnErrorClass('Network'), describeTurnErrorClass('network'));
  });
});

describe('deriveFailedTurnRecovery (PawWork run-incident lite)', () => {
  it('asks the user to inspect tool output when a tool failed', () => {
    const result = deriveFailedTurnRecovery({
      errorClass: 'tool_failed',
      partialOutputRetained: false,
      toolActivityCount: 1,
      erroredToolCount: 1,
    });
    assert.equal(result.action, 'inspect_tool');
    assert.match(result.label, /工具|结果/);
  });

  it('routes auth failures to connection/login checks before retrying', () => {
    for (const cls of ['auth', '401', '403']) {
      const result = deriveFailedTurnRecovery({
        errorClass: cls,
        partialOutputRetained: false,
        toolActivityCount: 0,
        erroredToolCount: 0,
      });
      assert.equal(result.action, 'check_connection');
      assert.match(result.label, /模型|连接|登录/);
    }
  });

  it('offers continue when partial output was retained and no tool failed', () => {
    const result = deriveFailedTurnRecovery({
      errorClass: 'timeout',
      partialOutputRetained: true,
      toolActivityCount: 0,
      erroredToolCount: 0,
    });
    assert.equal(result.action, 'continue');
    assert.match(result.label, /保留|继续/);
  });

  it('offers direct retry only when no side-effect or partial-output evidence exists', () => {
    const result = deriveFailedTurnRecovery({
      errorClass: 'timeout',
      partialOutputRetained: false,
      toolActivityCount: 0,
      erroredToolCount: 0,
    });
    assert.equal(result.action, 'retry');
    assert.match(result.label, /重试/);
  });

  it('keeps all recovery labels Chinese and does not echo raw error classes', () => {
    for (const errorClass of ['timeout', 'auth', 'tool_failed', 'provider_unavailable']) {
      const text = deriveFailedTurnRecovery({
        errorClass,
        partialOutputRetained: errorClass === 'provider_unavailable',
        toolActivityCount: errorClass === 'tool_failed' ? 1 : 0,
        erroredToolCount: errorClass === 'tool_failed' ? 1 : 0,
      }).label;
      assert.match(text, /[一-鿿]/);
      assert.ok(!text.includes(errorClass), `${errorClass} leaked into "${text}"`);
    }
  });
});
