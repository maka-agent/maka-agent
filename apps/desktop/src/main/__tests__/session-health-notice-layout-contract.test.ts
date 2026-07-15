import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { readRendererContractCss } from './contract-css-helpers.js';

const REPO_ROOT = join(process.cwd(), '..', '..');

async function readRepo(relativePath: string): Promise<string> {
  return readFile(join(REPO_ROOT, relativePath), 'utf8');
}

function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`).exec(css);
  assert.ok(match, `${selector} rule should exist`);
  return match[1] ?? '';
}

describe('session health notice layout contract (#1032)', () => {
  it('removes the chat header status cluster and fake-backend banner', async () => {
    const chat = await readRepo('packages/ui/src/chat-view.tsx');
    assert.doesNotMatch(chat, /maka-chat-status-cluster/);
    assert.doesNotMatch(chat, /sessionStatusBadge|connectionAlert|eventStreamAlert/);
    assert.doesNotMatch(chat, /maka-fake-backend-banner|isLocalSimulationBackend/);
    assert.doesNotMatch(chat, /SessionStatusBadge|ChatHeaderAlertBadge|ChatHeaderAlert/);
  });

  it('mounts the hard-only health notice above the composer interaction slot', async () => {
    const shell = await readRepo('apps/desktop/src/renderer/app-shell.tsx');
    const noticeIndex = shell.indexOf('className="maka-session-health-notice"');
    const slotIndex = shell.indexOf('className="maka-composer-interaction-slot"');
    const composerIndex = shell.indexOf('<Composer\n                ref={composerRef}');
    assert.ok(noticeIndex >= 0, 'session health notice should render in app-shell');
    assert.ok(slotIndex >= 0, 'composer interaction slot should remain');
    assert.ok(composerIndex >= 0, 'composer mount should remain');
    assert.ok(
      noticeIndex < slotIndex && slotIndex < composerIndex,
      'notice must sit above the interaction slot and composer',
    );
    assert.match(
      shell,
      /navSelection\.section === 'sessions' && sessionHealthNotice &&/,
      'health notice must stay on the conversation surface, not Skills/Automations/Daily Review',
    );
    assert.match(
      shell,
      /className="maka-session-health-notice"[\s\S]*?role="status"/,
    );
    assert.match(shell, /sessionHealthNotice\.onClickTarget === 'account' \? '去账号' : '去模型'/);
  });

  it('does not surface routine running or event-stream recovery badges', async () => {
    const model = await readRepo('apps/desktop/src/renderer/use-shell-chat-model.ts');
    assert.doesNotMatch(model, /chatEventStreamAlert|事件流恢复中/);
    assert.doesNotMatch(model, /chatConnectionAlert|deriveChatHeaderAlert/);
    assert.match(model, /deriveSessionHealthNotice/);
    assert.match(model, /sessionHealthNotice/);

    const shell = await readRepo('apps/desktop/src/renderer/app-shell.tsx');
    assert.doesNotMatch(shell, /chatSessionStatusBadge|sessionStatusBadge/);
    assert.doesNotMatch(shell, /presentSessionStatus|sessionStatusAriaLabel/);
  });

  it('styles the notice outside the message scroll area', async () => {
    const css = await readRendererContractCss();
    assert.doesNotMatch(css, /\.maka-chat-status-cluster\b/);
    assert.doesNotMatch(css, /\.maka-fake-backend-banner\b/);
    assert.doesNotMatch(css, /\.maka-chat-header-alert\b/);
    assert.doesNotMatch(css, /\.maka-chat-header-status\b/);
    const body = ruleBody(css, '.maka-session-health-notice');
    assert.doesNotMatch(body, /position:\s*absolute/);
    assert.match(body, /margin:/);
  });
});
