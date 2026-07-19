import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { __TEST__ } from '../dingtalk-bridge.js';

const {
  decideDingTalkClose,
  dingTalkReconnectBackoffMs,
  buildDingTalkGroupSendBody,
  buildDingTalkSingleSendBody,
  pickDingTalkSendRoute,
  classifyDingTalkSendResponse,
  dingTalkPayloadToEvent,
  buildDingTalkAckFrame,
} = __TEST__;

describe('decideDingTalkClose (PR-BOT-DINGTALK-OPERATIONAL-0)', () => {
  it('treats explicit stop as terminal regardless of code', () => {
    assert.deepEqual(decideDingTalkClose(1000, true), { kind: 'stopped' });
    assert.deepEqual(decideDingTalkClose(1006, true), { kind: 'stopped' });
  });

  it('treats any non-explicit close as a reconnect (Stream gateway does not surface fatal codes)', () => {
    assert.deepEqual(decideDingTalkClose(1000, false), { kind: 'reconnect' });
    assert.deepEqual(decideDingTalkClose(1001, false), { kind: 'reconnect' });
    assert.deepEqual(decideDingTalkClose(1006, false), { kind: 'reconnect' });
  });
});

describe('dingTalkReconnectBackoffMs', () => {
  it('starts at 1s and doubles each attempt', () => {
    assert.equal(dingTalkReconnectBackoffMs(0), 1_000);
    assert.equal(dingTalkReconnectBackoffMs(1), 2_000);
    assert.equal(dingTalkReconnectBackoffMs(2), 4_000);
  });

  it('caps at 30s', () => {
    assert.equal(dingTalkReconnectBackoffMs(5), 30_000);
    assert.equal(dingTalkReconnectBackoffMs(50), 30_000);
  });
});

describe('buildDingTalkGroupSendBody', () => {
  it('packs robotCode + openConversationId + text into msgParam JSON', () => {
    const body = buildDingTalkGroupSendBody('cidp-abc', 'app-key-1', 'hello world');
    assert.equal(body.robotCode, 'app-key-1');
    assert.equal(body.openConversationId, 'cidp-abc');
    assert.equal(body.msgKey, 'sampleText');
    assert.equal(body.msgParam, '{"content":"hello world"}');
  });
});

describe('buildDingTalkSingleSendBody', () => {
  it('packs robotCode + userIds + text into msgParam JSON', () => {
    const body = buildDingTalkSingleSendBody('user-99', 'app-key-1', 'hi');
    assert.equal(body.robotCode, 'app-key-1');
    assert.deepEqual(body.userIds, ['user-99']);
    assert.equal(body.msgKey, 'sampleText');
    assert.equal(body.msgParam, '{"content":"hi"}');
  });
});

describe('pickDingTalkSendRoute', () => {
  it('routes cid-prefixed chat ids to group send with trimmed target ids', () => {
    const route = pickDingTalkSendRoute(' cidp-abc ', 'app-key-1', 'hello');
    assert.ok(route);
    assert.equal(route.path, '/v1.0/robot/groupMessages/send');
    assert.equal(route.body.openConversationId, 'cidp-abc');
    assert.equal(route.body.robotCode, 'app-key-1');
  });

  it('routes non-cid chat ids to single send with trimmed user ids', () => {
    const route = pickDingTalkSendRoute(' user-99 ', 'app-key-1', 'hi');
    assert.ok(route);
    assert.equal(route.path, '/v1.0/robot/oToMessages/batchSend');
    assert.deepEqual(route.body.userIds, ['user-99']);
  });

  it('returns null for empty route target ids', () => {
    assert.equal(pickDingTalkSendRoute('', 'app-key-1', 'hi'), null);
    assert.equal(pickDingTalkSendRoute('   ', 'app-key-1', 'hi'), null);
  });
});

describe('classifyDingTalkSendResponse', () => {
  it('returns ok with processQueryKey when present', () => {
    assert.deepEqual(classifyDingTalkSendResponse(200, { processQueryKey: 'pk-1' }), {
      kind: 'ok',
      messageId: 'pk-1',
    });
  });

  it('returns ok with null id when 2xx response has no processQueryKey', () => {
    assert.deepEqual(classifyDingTalkSendResponse(200, {}), { kind: 'ok', messageId: null });
  });

  it('returns fatal when errcode is non-zero even on 200 OK', () => {
    assert.deepEqual(
      classifyDingTalkSendResponse(200, { errcode: 80001, errmsg: 'token invalid' }),
      { kind: 'fatal', description: 'token invalid' },
    );
    assert.deepEqual(classifyDingTalkSendResponse(200, { errcode: 99999 }), {
      kind: 'fatal',
      description: 'errcode 99999',
    });
  });

  it('returns retry on 429', () => {
    const result = classifyDingTalkSendResponse(429, null);
    assert.equal(result.kind, 'retry');
  });

  it('returns fatal on other 4xx / 5xx', () => {
    assert.deepEqual(classifyDingTalkSendResponse(403, { errmsg: 'Forbidden' }), {
      kind: 'fatal',
      description: 'Forbidden',
    });
    assert.deepEqual(classifyDingTalkSendResponse(502, null), {
      kind: 'fatal',
      description: 'HTTP 502',
    });
  });
});

describe('dingTalkPayloadToEvent', () => {
  it('maps a single-chat text message to BotMessageEvent with isGroup=false', () => {
    const event = dingTalkPayloadToEvent(
      {
        senderId: 'user-1',
        senderNick: 'Alice',
        conversationId: 'cidp-single',
        conversationType: '1',
        text: { content: 'hello' },
        robotCode: 'app-key-1',
      },
      1_700_000_000_000,
    );
    assert.ok(event);
    assert.equal(event!.platform, 'dingtalk');
    assert.equal(event!.userId, 'user-1');
    assert.equal(event!.userName, 'Alice');
    assert.equal(event!.chatId, 'cidp-single');
    assert.equal(event!.isGroup, false);
    assert.equal(event!.text, 'hello');
    assert.equal(event!.sourceMessageId, 'cidp-single:1700000000000');
  });

  it('maps a group-chat text message with isGroup=true', () => {
    const event = dingTalkPayloadToEvent(
      {
        senderId: 'user-2',
        senderNick: 'Bob',
        conversationId: 'cidp-group',
        conversationType: '2',
        text: { content: 'hi' },
      },
      1,
    );
    assert.equal(event!.isGroup, true);
  });

  it('drops payloads with no text content', () => {
    assert.equal(dingTalkPayloadToEvent({ senderId: 'u', conversationId: 'c', text: {} }, 1), null);
    assert.equal(dingTalkPayloadToEvent({ senderId: 'u', conversationId: 'c' }, 1), null);
  });

  it('drops payloads missing sender or conversation', () => {
    assert.equal(dingTalkPayloadToEvent({ conversationId: 'c', text: { content: 'x' } }, 1), null);
    assert.equal(dingTalkPayloadToEvent({ senderId: 'u', text: { content: 'x' } }, 1), null);
  });

  it('falls back to senderId when senderNick is absent', () => {
    const event = dingTalkPayloadToEvent(
      { senderId: 'u3', conversationId: 'c3', text: { content: 'x' } },
      1,
    );
    assert.equal(event!.userName, 'u3');
  });
});

describe('buildDingTalkAckFrame', () => {
  it('returns a 200 ack with content-type + messageId headers', () => {
    const ack = buildDingTalkAckFrame('msg-99');
    assert.equal(ack.code, 200);
    assert.equal(ack.headers.contentType, 'application/json');
    assert.equal(ack.headers.messageId, 'msg-99');
    assert.equal(ack.data, '{}');
  });

  it('serializes optional response data as JSON', () => {
    const ack = buildDingTalkAckFrame('msg-100', { received: true });
    assert.equal(ack.data, '{"received":true}');
  });
});
