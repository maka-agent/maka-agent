import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  sessionMarkReadFailureMessage,
  sessionReadMessagesFailureMessage,
} from '../session-read-error-copy.js';

describe('session read error copy', () => {
  it('classifies active in-flight cache read failures without leaking paths', () => {
    const error = Object.assign(new Error('RuntimeEvent active projection cache read failed'), {
      name: 'RuntimeReadModelError',
      diagnostics: [
        {
          message: 'SessionProjectionCache.readMessages failed',
          details: {
            error: 'EPERM: operation not permitted, open C:\\Users\\alice\\AppData\\Roaming\\Maka\\workspaces\\default\\sessions\\s1\\session.jsonl',
          },
        },
      ],
    });

    const message = sessionReadMessagesFailureMessage(error);

    assert.equal(message, '读取进行中的对话缓存失败：本地会话文件暂时被占用或不可访问，请稍后重试。');
    assert.equal(message.includes('C:\\Users'), false);
    assert.equal(message.includes('session.jsonl'), false);
  });

  it('classifies durable runtime ledger read failures', () => {
    const error = Object.assign(new Error('RuntimeEvent ledger read failed'), {
      name: 'RuntimeReadModelError',
      diagnostics: [
        {
          message: 'RuntimeEventStore.readRuntimeEvents failed',
          details: {
            error: 'Invalid RuntimeEvent JSONL line 2 for run run_1: Unexpected token',
          },
        },
      ],
    });

    assert.equal(
      sessionReadMessagesFailureMessage(error),
      '读取对话运行记录失败：本地运行记录暂时无法读取，请稍后重试。',
    );
  });

  it('classifies mark-read write failures separately from content reads', () => {
    const error = Object.assign(new Error('EPERM: operation not permitted, rename session.jsonl.tmp -> session.jsonl'), {
      code: 'EPERM',
    });

    assert.equal(
      sessionMarkReadFailureMessage(error),
      '对话内容已读取，但标记已读失败：本地会话文件暂时被占用或不可访问，请稍后重试。',
    );
  });
});
