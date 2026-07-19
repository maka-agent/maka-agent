import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { __TEST__ } from '../discord-bridge.js';

const {
  decideDiscordClose,
  reconnectBackoffMs,
  buildDiscordSendBody,
  normalizeDiscordReplyToMessageId,
  normalizeDiscordChannelId,
  classifyDiscordSendResponse,
  discordMessageToEvent,
  splitDiscordContent,
  DISCORD_INTENTS,
} = __TEST__;

describe('decideDiscordClose (PR-BOT-DISCORD-OPERATIONAL-0)', () => {
  it('treats explicit stop as terminal regardless of code', () => {
    assert.deepEqual(decideDiscordClose(1000, true), { kind: 'stopped' });
    assert.deepEqual(decideDiscordClose(4004, true), { kind: 'stopped' });
  });

  it('flags fatal codes: auth failed, disallowed intent, sharding, invalid api version', () => {
    assert.deepEqual(decideDiscordClose(4004, false), { kind: 'fatal', code: 4004 });
    assert.deepEqual(decideDiscordClose(4014, false), { kind: 'fatal', code: 4014 });
    assert.deepEqual(decideDiscordClose(4013, false), { kind: 'fatal', code: 4013 });
    assert.deepEqual(decideDiscordClose(4012, false), { kind: 'fatal', code: 4012 });
    assert.deepEqual(decideDiscordClose(4010, false), { kind: 'fatal', code: 4010 });
    assert.deepEqual(decideDiscordClose(4011, false), { kind: 'fatal', code: 4011 });
  });

  it('treats normal close (1000/1001) as non-resumable reconnect', () => {
    assert.deepEqual(decideDiscordClose(1000, false), { kind: 'reconnect', resumable: false });
    assert.deepEqual(decideDiscordClose(1001, false), { kind: 'reconnect', resumable: false });
  });

  it('treats other gateway codes as resumable reconnect', () => {
    assert.deepEqual(decideDiscordClose(4000, false), { kind: 'reconnect', resumable: true });
    assert.deepEqual(decideDiscordClose(4007, false), { kind: 'reconnect', resumable: true });
    assert.deepEqual(decideDiscordClose(4009, false), { kind: 'reconnect', resumable: true });
  });
});

describe('reconnectBackoffMs', () => {
  it('starts at the minimum and doubles each attempt', () => {
    assert.equal(reconnectBackoffMs(0), 1_000);
    assert.equal(reconnectBackoffMs(1), 2_000);
    assert.equal(reconnectBackoffMs(2), 4_000);
    assert.equal(reconnectBackoffMs(3), 8_000);
    assert.equal(reconnectBackoffMs(4), 16_000);
  });

  it('caps at the maximum so we never wait minutes between retries', () => {
    assert.equal(reconnectBackoffMs(5), 30_000);
    assert.equal(reconnectBackoffMs(10), 30_000);
    assert.equal(reconnectBackoffMs(100), 30_000);
  });
});

describe('buildDiscordSendBody', () => {
  it('emits content only when no options are provided', () => {
    assert.deepEqual(buildDiscordSendBody('hello', undefined, 0), { content: 'hello' });
  });

  it('threads the first chunk under the originating message via message_reference', () => {
    const body = buildDiscordSendBody('hello', { replyToMessageId: '123' }, 0);
    assert.equal(body.content, 'hello');
    assert.deepEqual(body.message_reference, {
      message_id: '123',
      fail_if_not_exists: false,
    });
  });

  it('does NOT thread continuation chunks (chunkIndex > 0)', () => {
    const body = buildDiscordSendBody('tail', { replyToMessageId: '123' }, 1);
    assert.deepEqual(body, { content: 'tail' });
  });

  it('trims valid reply ids before threading the first chunk', () => {
    const body = buildDiscordSendBody('hello', { replyToMessageId: ' 123 ' }, 0);
    assert.deepEqual(body.message_reference, {
      message_id: '123',
      fail_if_not_exists: false,
    });
  });

  it('omits invalid reply ids rather than sending malformed message_reference', () => {
    for (const replyToMessageId of ['abc', '  ', '0', '-1', '1.5']) {
      const body = buildDiscordSendBody('hello', { replyToMessageId }, 0);
      assert.deepEqual(body, { content: 'hello' }, replyToMessageId);
    }
  });
});

describe('normalizeDiscordReplyToMessageId', () => {
  it('trims and accepts positive decimal snowflake strings', () => {
    assert.equal(normalizeDiscordReplyToMessageId(' 123456789012345678 '), '123456789012345678');
  });

  it('rejects missing, non-decimal, zero, and negative values', () => {
    assert.equal(normalizeDiscordReplyToMessageId(undefined), undefined);
    assert.equal(normalizeDiscordReplyToMessageId(''), undefined);
    assert.equal(normalizeDiscordReplyToMessageId('abc'), undefined);
    assert.equal(normalizeDiscordReplyToMessageId('0'), undefined);
    assert.equal(normalizeDiscordReplyToMessageId('-1'), undefined);
    assert.equal(normalizeDiscordReplyToMessageId('1.5'), undefined);
  });
});

describe('normalizeDiscordChannelId', () => {
  it('trims and accepts positive decimal snowflake strings', () => {
    assert.equal(normalizeDiscordChannelId(' 123456789012345678 '), '123456789012345678');
  });

  it('rejects empty, non-decimal, zero, and negative values', () => {
    for (const value of ['', '   ', 'abc', '0', '-1', '1.5']) {
      assert.equal(normalizeDiscordChannelId(value), undefined, value);
    }
  });
});

describe('classifyDiscordSendResponse', () => {
  it('returns ok with the message id on 2xx', () => {
    assert.deepEqual(classifyDiscordSendResponse(200, { id: '999' }), {
      kind: 'ok',
      messageId: '999',
    });
    assert.deepEqual(classifyDiscordSendResponse(201, { id: 123 }), {
      kind: 'ok',
      messageId: '123',
    });
  });

  it('returns ok with null id when 2xx response has no id', () => {
    assert.deepEqual(classifyDiscordSendResponse(200, {}), { kind: 'ok', messageId: null });
    assert.deepEqual(classifyDiscordSendResponse(200, null), { kind: 'ok', messageId: null });
  });

  it('returns retry on 429 with retry_after in seconds → milliseconds', () => {
    const result = classifyDiscordSendResponse(429, { retry_after: 2 });
    assert.equal(result.kind, 'retry');
    if (result.kind === 'retry') {
      assert.equal(result.delayMs, 2_000);
    }
  });

  it('floors retry delay at the minimum if Discord returns 0', () => {
    const result = classifyDiscordSendResponse(429, { retry_after: 0 });
    assert.equal(result.kind, 'retry');
    if (result.kind === 'retry') {
      assert.equal(result.delayMs, 1_000);
    }
  });

  it('caps retry delay at 30s defensively', () => {
    const result = classifyDiscordSendResponse(429, { retry_after: 600 });
    assert.equal(result.kind, 'retry');
    if (result.kind === 'retry') {
      assert.equal(result.delayMs, 30_000);
    }
  });

  it('returns fatal on 4xx (non-429) with the API-provided message', () => {
    assert.deepEqual(classifyDiscordSendResponse(403, { message: 'Missing Permissions' }), {
      kind: 'fatal',
      description: 'Missing Permissions',
    });
  });

  it('returns fatal on 5xx — Discord outages do not resolve within send timeout', () => {
    assert.deepEqual(classifyDiscordSendResponse(502, null), {
      kind: 'fatal',
      description: 'HTTP 502',
    });
  });
});

describe('discordMessageToEvent', () => {
  it('maps a guild message to BotMessageEvent with isGroup=true', () => {
    const event = discordMessageToEvent(
      {
        id: 'msg-1',
        channel_id: 'chan-1',
        guild_id: 'guild-1',
        content: 'hello',
        author: { id: 'user-1', username: 'alice', global_name: 'Alice' },
      },
      1_700_000_000_000,
    );
    assert.ok(event);
    assert.equal(event!.platform, 'discord');
    assert.equal(event!.userId, 'user-1');
    assert.equal(event!.userName, 'Alice');
    assert.equal(event!.chatId, 'chan-1');
    assert.equal(event!.isGroup, true);
    assert.equal(event!.text, 'hello');
    assert.equal(event!.sourceMessageId, 'msg-1');
    assert.equal(event!.receivedAt, 1_700_000_000_000);
  });

  it('maps a DM (no guild_id) to isGroup=false', () => {
    const event = discordMessageToEvent(
      {
        id: 'msg-2',
        channel_id: 'dm-1',
        content: 'hi',
        author: { id: 'user-2', username: 'bob' },
      },
      1_700_000_000_001,
    );
    assert.ok(event);
    assert.equal(event!.isGroup, false);
    assert.equal(event!.userName, 'bob');
  });

  it('drops messages from other bots (silent dedup)', () => {
    assert.equal(
      discordMessageToEvent(
        {
          id: 'msg-3',
          channel_id: 'chan-3',
          content: 'beep',
          author: { id: 'other-bot', username: 'OtherBot', bot: true },
        },
        1_700_000_000_002,
      ),
      null,
    );
  });

  it('drops webhook system messages with no author', () => {
    assert.equal(
      discordMessageToEvent(
        { id: 'msg-4', channel_id: 'chan-4', content: 'sys' },
        1_700_000_000_003,
      ),
      null,
    );
  });

  it('falls back to username when global_name is not present', () => {
    const event = discordMessageToEvent(
      {
        id: 'msg-5',
        channel_id: 'chan-5',
        content: 'hi',
        author: { id: 'user-5', username: 'charlie' },
      },
      1,
    );
    assert.equal(event!.userName, 'charlie');
  });
});

describe('splitDiscordContent', () => {
  it('returns input untouched when within the 2000-char limit', () => {
    assert.deepEqual(splitDiscordContent(''), ['']);
    assert.deepEqual(splitDiscordContent('hello'), ['hello']);
    assert.deepEqual(splitDiscordContent('a'.repeat(2000)), ['a'.repeat(2000)]);
  });

  it('splits content past 2000 chars into multiple chunks', () => {
    const input = 'a'.repeat(3500);
    const chunks = splitDiscordContent(input);
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0].length, 2000);
    assert.equal(chunks[1].length, 1500);
  });

  it('preserves total content across chunks', () => {
    const input = 'x'.repeat(5000);
    const chunks = splitDiscordContent(input);
    assert.equal(chunks.join(''), input);
  });
});

describe('DISCORD_INTENTS', () => {
  it('requests GUILD_MESSAGES + DIRECT_MESSAGES + MESSAGE_CONTENT', () => {
    // 512 (GUILD_MESSAGES) | 4096 (DIRECT_MESSAGES) | 32768 (MESSAGE_CONTENT)
    assert.equal(DISCORD_INTENTS, 512 | 4096 | 32768);
    assert.equal(DISCORD_INTENTS, 37376);
  });
});
