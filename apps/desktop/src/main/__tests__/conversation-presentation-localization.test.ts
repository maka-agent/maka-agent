import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { preflightAttachmentItems } from '../../renderer/attachment-preflight.js';
import { deriveTurnLineageBadges } from '../../renderer/derive-turn-lineage-badges.js';
import { getDesktopConversationCopy } from '../../renderer/locales/conversation-copy.js';
import {
  modelSetupToastCopy,
  noRealConnectionSetupDescription,
  sessionEventErrorMessage,
} from '../../renderer/model-connection-errors.js';
import {
  deriveFailedTurnRecovery,
  describeTurnErrorClass,
  sessionStatusAriaLabel,
} from '../../renderer/session-status-presentation.js';
import { deriveTurnFooterActions } from '../../renderer/turn-footer-actions.js';

describe('desktop conversation presentation localization', () => {
  it('selects English model-setup and safe event-error copy', () => {
    assert.match(noRealConnectionSetupDescription('missing_api_key', 'en'), /credentials|API key/i);
    assert.doesNotMatch(noRealConnectionSetupDescription('missing_api_key', 'en'), /当前|模型连接/);
    assert.deepEqual(modelSetupToastCopy('connection_missing', 'fallback', 'en'), {
      title: 'Connection deleted',
      description: getDesktopConversationCopy('en').model.configurationReason.connection_missing,
    });

    const message = sessionEventErrorMessage({
      id: 'error-1',
      turnId: 'turn-1',
      ts: 1,
      type: 'error',
      recoverable: false,
      message: '数据库内部异常',
    }, 'en');
    assert.equal(message, 'The conversation run failed. Try again later.');
    assert.doesNotMatch(message, /数据库/);
  });

  it('localizes status, recovery, footer, and lineage helpers', () => {
    assert.equal(sessionStatusAriaLabel('running', undefined, 'en'), 'Running');
    assert.equal(sessionStatusAriaLabel('blocked', 'auth', 'en'), 'Needs attention · Sign in again');
    assert.equal(describeTurnErrorClass('timeout', 'en'), 'Request timed out');
    assert.equal(deriveFailedTurnRecovery({
      errorClass: 'tool_failed',
      partialOutputRetained: false,
      toolActivityCount: 1,
      erroredToolCount: 1,
    }, 'en').label, 'Inspect the tool result before retrying');

    const footer = deriveTurnFooterActions({ status: 'completed', hasContent: true, locale: 'en' });
    assert.equal(footer.find((action) => action.id === 'regenerate')?.label, 'Regenerate');
    assert.equal(footer.find((action) => action.id === 'copy')?.tooltip, 'Copy response to clipboard');

    const lineage = deriveTurnLineageBadges({
      turnId: 'new-turn',
      regeneratedFromTurnId: 'old-turn',
      existsTurn: () => true,
      locale: 'en',
    });
    assert.equal(lineage[0]?.label, 'Regenerated from previous response');
  });

  it('localizes preflight failures without changing attachment limits', () => {
    const tooMany = Array.from({ length: 9 }, (_, index) => ({
      size: 1,
      source: { type: 'approval' as const, approvalId: `approval-${index}` },
    }));
    assert.throws(() => preflightAttachmentItems(tooMany, 'zh'), /附件数量超过 8 个/);
    assert.throws(() => preflightAttachmentItems(tooMany, 'en'), /at most 8 files/);
  });
});
