import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { __TEST__ } from '../qq-bridge.js';

const {
  decideQQClose,
  qqReconnectBackoffMs,
  classifyQQSendResponse,
  qqChannelMessageToEvent,
  qqGroupMessageToEvent,
  qqC2CMessageToEvent,
  pickQQSendRoute,
  pickQQTypingRoute,
  QQ_INTENTS,
} = __TEST__;

describe('decideQQClose (PR-BOT-QQ-OPERATIONAL-0)', () => {
  it('treats explicit stop as terminal regardless of code', () => {
    assert.deepEqual(decideQQClose(1000, true), { kind: 'stopped' });
    assert.deepEqual(decideQQClose(4004, true), { kind: 'stopped' });
  });

  it('flags fatal codes 4004 / 4014', () => {
    assert.deepEqual(decideQQClose(4004, false), { kind: 'fatal', code: 4004 });
    assert.deepEqual(decideQQClose(4014, false), { kind: 'fatal', code: 4014 });
  });

  it('treats normal close as non-resumable reconnect', () => {
    assert.deepEqual(decideQQClose(1000, false), { kind: 'reconnect', resumable: false });
    assert.deepEqual(decideQQClose(1001, false), { kind: 'reconnect', resumable: false });
  });

  it('treats other gateway codes as resumable reconnect', () => {
    assert.deepEqual(decideQQClose(4000, false), { kind: 'reconnect', resumable: true });
    assert.deepEqual(decideQQClose(4007, false), { kind: 'reconnect', resumable: true });
  });
});

describe('qqReconnectBackoffMs', () => {
  it('starts at 1s and caps at 30s', () => {
    assert.equal(qqReconnectBackoffMs(0), 1_000);
    assert.equal(qqReconnectBackoffMs(1), 2_000);
    assert.equal(qqReconnectBackoffMs(5), 30_000);
    assert.equal(qqReconnectBackoffMs(50), 30_000);
  });
});

describe('classifyQQSendResponse', () => {
  it('returns ok with id from `id` or `msg_id`', () => {
    assert.deepEqual(classifyQQSendResponse(200, { id: '999' }), { kind: 'ok', messageId: '999' });
    assert.deepEqual(classifyQQSendResponse(200, { msg_id: 'mid-1' }), {
      kind: 'ok',
      messageId: 'mid-1',
    });
  });

  it('returns ok with null id when 2xx has neither', () => {
    assert.deepEqual(classifyQQSendResponse(200, {}), { kind: 'ok', messageId: null });
  });

  it('returns retry on 429', () => {
    const result = classifyQQSendResponse(429, null);
    assert.equal(result.kind, 'retry');
  });

  it('returns fatal on 4xx (non-429) with API message or code', () => {
    assert.deepEqual(classifyQQSendResponse(403, { message: 'Forbidden' }), {
      kind: 'fatal',
      description: 'Forbidden',
    });
    assert.deepEqual(classifyQQSendResponse(400, { code: 304023 }), {
      kind: 'fatal',
      description: 'code 304023',
    });
  });

  it('returns fatal on 5xx', () => {
    assert.deepEqual(classifyQQSendResponse(502, null), { kind: 'fatal', description: 'HTTP 502' });
  });
});

describe('qqChannelMessageToEvent (AT_MESSAGE_CREATE)', () => {
  it('maps a channel @-mention to BotMessageEvent with channel: chatId prefix', () => {
    const event = qqChannelMessageToEvent(
      {
        id: 'm-1',
        channel_id: 'chan-1',
        guild_id: 'guild-1',
        content: '@bot hello',
        author: { id: 'u-1', username: 'Alice' },
      },
      1_700_000_000_000,
    );
    assert.ok(event);
    assert.equal(event!.platform, 'qq');
    assert.equal(event!.userId, 'u-1');
    assert.equal(event!.userName, 'Alice');
    assert.equal(event!.chatId, 'channel:chan-1');
    assert.equal(event!.isGroup, true);
    assert.equal(event!.text, '@bot hello');
    assert.equal(event!.sourceMessageId, 'm-1');
  });

  it('drops messages from bots', () => {
    assert.equal(
      qqChannelMessageToEvent({ id: 'm-2', channel_id: 'c', author: { id: 'b', bot: true } }, 1),
      null,
    );
  });

  it('drops messages with no author', () => {
    assert.equal(qqChannelMessageToEvent({ id: 'm-3', channel_id: 'c' }, 1), null);
  });
});

describe('qqGroupMessageToEvent (GROUP_AT_MESSAGE_CREATE)', () => {
  it('maps a group @-mention with group: chatId prefix and member_openid as userId', () => {
    const event = qqGroupMessageToEvent(
      {
        id: 'gm-1',
        group_openid: 'g-1',
        content: 'hello',
        author: { member_openid: 'mo-1' },
      },
      1,
    );
    assert.ok(event);
    assert.equal(event!.chatId, 'group:g-1');
    assert.equal(event!.userId, 'mo-1');
    assert.equal(event!.isGroup, true);
  });

  it('falls back through user_openid → id when member_openid is missing', () => {
    assert.equal(
      qqGroupMessageToEvent({ id: 'gm-2', group_openid: 'g-2', author: { user_openid: 'uo-2' } }, 1)
        ?.userId,
      'uo-2',
    );
    assert.equal(
      qqGroupMessageToEvent({ id: 'gm-3', group_openid: 'g-3', author: { id: 'i-3' } }, 1)?.userId,
      'i-3',
    );
  });

  it('drops messages with no group_openid or no author identity', () => {
    assert.equal(
      qqGroupMessageToEvent(
        { id: 'gm-4', group_openid: '' as string, author: { id: 'x' } } as any,
        1,
      ),
      null,
    );
    assert.equal(qqGroupMessageToEvent({ id: 'gm-5', group_openid: 'g', author: {} }, 1), null);
  });
});

describe('qqC2CMessageToEvent (C2C_MESSAGE_CREATE)', () => {
  it('maps a 1-on-1 user message with c2c: chatId prefix and isGroup=false', () => {
    const event = qqC2CMessageToEvent(
      {
        id: 'c2c-1',
        content: 'hi',
        author: { user_openid: 'uo-1' },
      },
      1,
    );
    assert.ok(event);
    assert.equal(event!.chatId, 'c2c:uo-1');
    assert.equal(event!.isGroup, false);
    assert.equal(event!.userId, 'uo-1');
  });
});

describe('pickQQSendRoute', () => {
  it('routes channel: chatIds to /channels/{id}/messages', () => {
    const route = pickQQSendRoute('channel:chan-1', 'hi');
    assert.ok(route);
    assert.equal(route!.path, '/channels/chan-1/messages');
    assert.equal(route!.body.content, 'hi');
    assert.equal(route!.body.msg_type, 0);
  });

  it('trims accidental whitespace around route target ids', () => {
    assert.equal(pickQQSendRoute('channel: chan-1 ', 'hi')?.path, '/channels/chan-1/messages');
    assert.equal(pickQQSendRoute('group: g-1 ', 'hi')?.path, '/v2/groups/g-1/messages');
    assert.equal(pickQQSendRoute('c2c: uo-1 ', 'hi')?.path, '/v2/users/uo-1/messages');
  });

  it('routes group: chatIds to /v2/groups/{id}/messages', () => {
    const route = pickQQSendRoute('group:g-1', 'hi');
    assert.ok(route);
    assert.equal(route!.path, '/v2/groups/g-1/messages');
  });

  it('routes c2c: chatIds to /v2/users/{id}/messages', () => {
    const route = pickQQSendRoute('c2c:uo-1', 'hi');
    assert.ok(route);
    assert.equal(route!.path, '/v2/users/uo-1/messages');
  });

  it('includes msg_id when replyToMessageId is provided', () => {
    const route = pickQQSendRoute('group:g-1', 'hi', { replyToMessageId: 'm-99' });
    assert.equal(route!.body.msg_id, 'm-99');
  });

  it('returns null for unknown chatId prefix (defensive)', () => {
    assert.equal(pickQQSendRoute('unknown:foo', 'hi'), null);
    assert.equal(pickQQSendRoute('', 'hi'), null);
  });

  it('returns null for known prefixes with no route target id', () => {
    assert.equal(pickQQSendRoute('channel:', 'hi'), null);
    assert.equal(pickQQSendRoute('channel:   ', 'hi'), null);
    assert.equal(pickQQSendRoute('group:', 'hi'), null);
    assert.equal(pickQQSendRoute('group:   ', 'hi'), null);
    assert.equal(pickQQSendRoute('c2c:', 'hi'), null);
    assert.equal(pickQQSendRoute('c2c:   ', 'hi'), null);
  });
});

describe('QQ_INTENTS', () => {
  it('includes GUILDS + DIRECT_MESSAGE + PUBLIC_GUILD_MESSAGES + PUBLIC_MESSAGES', () => {
    // 1 (GUILDS) | 4096 (DIRECT_MESSAGE) | 1<<25 (PUBLIC_MESSAGES) | 1<<30 (PUBLIC_GUILD_MESSAGES)
    assert.equal(QQ_INTENTS, 1 | 4096 | (1 << 25) | (1 << 30));
  });
});

// PR-BOT-QQ-TYPING-INDICATOR-0: pin the chatId-prefix gate that decides
// whether the bridge attempts a POST to /channels/{id}/typing. The
// actual REST call is exercised at the integration / desktop layer;
// here we pin the routing decision so a future PR cannot accidentally
// drop the channel-only restriction (Groups and C2C use a different
// messaging stack with no typing endpoint).
describe('QQ sendTypingIndicator routing (PR-BOT-QQ-TYPING-INDICATOR-0)', () => {
  it('only routes channel: chatIds to the typing endpoint', () => {
    assert.equal(pickQQTypingRoute('channel:c-1'), '/channels/c-1/typing');
    assert.equal(pickQQTypingRoute('group:g-1'), null);
    assert.equal(pickQQTypingRoute('c2c:u-1'), null);
    assert.equal(pickQQTypingRoute('dm:dm-1'), null);
    assert.equal(pickQQTypingRoute(''), null);
  });

  it('trims channel ids and skips empty typing targets', () => {
    assert.equal(pickQQTypingRoute('channel: c-1 '), '/channels/c-1/typing');
    assert.equal(pickQQTypingRoute('channel:'), null);
    assert.equal(pickQQTypingRoute('channel:   '), null);
  });
});
