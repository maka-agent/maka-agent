import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_COUNT } from '@maka/core/attachments';
import { createDefaultRuntimePolicy } from '@maka/core/runtime-policy';
import {
  decodeClientFrame,
  decodeHostFrame,
  CONNECTION_CATALOG_PAGE_MAX_ITEMS,
  CREDENTIAL_SECRET_MAX_BYTES,
  encodeProtocolFrame,
  HOST_OPERATION_SPECS,
  MESSAGE_QUEUE_MAX_ENTRIES,
  negotiateProtocol,
  ProtocolFrameDecoder,
  RUNTIME_HOST_MAX_FRAME_BYTES,
  RUNTIME_HOST_PROTOCOL_VERSION,
  RUNTIME_POLICY_SNAPSHOT_MAX_BYTES,
  SESSION_CONTINUITY_SCHEMA_VERSION,
  SESSION_LIVE_DELTA_MAX_BYTES,
  TURN_MESSAGE_CONTENT_MAX_BYTES,
  TURN_MESSAGE_TEXT_MAX_BYTES,
  RuntimeHostProtocolError,
} from '../protocol/index.js';

describe('Runtime Host bootstrap protocol', () => {
  test('selects the highest mutually supported protocol and rejects a gap', () => {
    assert.equal(negotiateProtocol({ min: 1, max: 3 }, { min: 2, max: 4 }), 3);
    assert.equal(negotiateProtocol({ min: 1, max: 1 }, { min: 2, max: 2 }), undefined);
  });

  test('uses protocol v7 and Session continuity schema v3 without compatibility aliases', () => {
    assert.equal(RUNTIME_HOST_PROTOCOL_VERSION, 7);
    assert.equal(SESSION_CONTINUITY_SCHEMA_VERSION, 3);
  });

  test('declares Runtime Policy Host operations with ready admission and closed retry metadata', () => {
    const queries = [
      'runtime.policy.query',
      'connection.catalog.query',
      'credential.vault.query',
    ] as const;
    const mutations = [
      'runtime.policy.mutate',
      'connection.catalog.create',
      'connection.catalog.update',
      'connection.catalog.remove',
      'connection.catalog.set-default-target',
      'credential.vault.set',
      'credential.vault.delete',
    ] as const;
    for (const operation of queries) {
      assert.equal(HOST_OPERATION_SPECS[operation].admission, 'ready');
      assert.equal(HOST_OPERATION_SPECS[operation].retry, 'safe');
      assert.ok(HOST_OPERATION_SPECS[operation].errors.includes('persistence_failed'));
    }
    for (const operation of mutations) {
      assert.equal(HOST_OPERATION_SPECS[operation].admission, 'ready');
      assert.equal(HOST_OPERATION_SPECS[operation].retry, 'none');
      assert.ok(HOST_OPERATION_SPECS[operation].errors.includes('commit_outcome_unknown'));
      assert.ok(HOST_OPERATION_SPECS[operation].errors.includes('invalid_request'));
    }
    assert.ok(HOST_OPERATION_SPECS['connection.catalog.query'].errors.includes('invalid_request'));
    assert.ok(HOST_OPERATION_SPECS['credential.vault.query'].errors.includes('invalid_request'));
  });

  test('keeps Runtime Policy query and mutation unions exact and document bounded', () => {
    assert.doesNotThrow(() =>
      decodeClientFrame({ requestId: 'policy-1', operation: 'runtime.policy.query', input: {} }),
    );
    assert.throws(
      () =>
        decodeClientFrame({
          requestId: 'policy-2',
          operation: 'runtime.policy.query',
          input: { revision: 1 },
        }),
      isInvalidFrame,
    );
    const mutation = {
      requestId: 'policy-3',
      operation: 'runtime.policy.mutate' as const,
      input: {
        expectedRevision: 0,
        operation: {
          kind: 'set_personalization' as const,
          value: { displayName: 'Maka', assistantTone: '界'.repeat(4_096) },
        },
      },
    };
    assert.doesNotThrow(() => decodeClientFrame(mutation));
    assert.throws(
      () =>
        decodeClientFrame({
          ...mutation,
          input: {
            ...mutation.input,
            operation: {
              ...mutation.input.operation,
              value: { ...mutation.input.operation.value, assistantTone: '界'.repeat(4_097) },
            },
          },
        }),
      isInvalidFrame,
    );
    assert.throws(
      () =>
        decodeClientFrame({
          ...mutation,
          input: { ...mutation.input, operation: { kind: 'replace_snapshot', value: {} } },
        }),
      isInvalidFrame,
    );
    const policy = createDefaultRuntimePolicy();
    assert.doesNotThrow(() =>
      decodeHostFrame({
        requestId: 'policy-4',
        operation: 'runtime.policy.query',
        ok: true,
        result: {
          revision: 1,
          policy: {
            ...policy,
            networkProxy: {
              ...policy.networkProxy,
              bypassList: Array.from({ length: 33 }, (_, index) => `domain-${index}`),
            },
            personalization: { ...policy.personalization, assistantTone: '界'.repeat(4_096) },
          },
        },
      }),
    );
    const oversizedPolicy = {
      ...policy,
      networkProxy: {
        ...policy.networkProxy,
        bypassList: Array.from({ length: 256 }, (_, index) => `${index}-${'x'.repeat(196)}`),
      },
    };
    assert.ok(
      Buffer.byteLength(JSON.stringify({ revision: 1, policy: oversizedPolicy }), 'utf8') >
        RUNTIME_POLICY_SNAPSHOT_MAX_BYTES,
    );
    assert.throws(
      () =>
        decodeHostFrame({
          requestId: 'policy-5',
          operation: 'runtime.policy.query',
          ok: true,
          result: { revision: 1, policy: oversizedPolicy },
        }),
      isInvalidFrame,
    );
    assert.throws(
      () =>
        decodeHostFrame({
          requestId: 'policy-noncanonical-host',
          operation: 'runtime.policy.query',
          ok: true,
          result: {
            revision: 1,
            policy: {
              ...policy,
              networkProxy: { ...policy.networkProxy, host: ' 127.0.0.1 ' },
            },
          },
        }),
      isInvalidFrame,
    );
    assert.throws(
      () =>
        decodeHostFrame({
          requestId: 'policy-6',
          operation: 'runtime.policy.mutate',
          ok: true,
          result: { kind: 'committed', revision: 1, snapshot: { revision: 1, policy: {} } },
        }),
      isInvalidFrame,
    );
  });

  test('decodes revision-pinned catalog pages and enforces page item and byte bounds', () => {
    const connectionId = '123e4567-e89b-42d3-a456-426614174000';
    const page = {
      kind: 'page' as const,
      revision: 4,
      defaultTarget: { connectionId, modelId: 'gpt-5' },
      connectionCount: 1,
      items: [
        {
          kind: 'connection' as const,
          connectionIndex: 0,
          connectionId,
          revision: 2,
          slug: 'openai-main',
          name: 'OpenAI',
          providerType: 'openai',
          enabled: true,
          modelSource: 'fetched' as const,
          modelsFetchedAt: 1,
          enabledModelIdCount: 1,
          modelCount: 1,
        },
        {
          kind: 'enabled_model_id' as const,
          connectionIndex: 0,
          itemIndex: 0,
          modelId: 'gpt-5',
        },
        {
          kind: 'model' as const,
          connectionIndex: 0,
          itemIndex: 0,
          model: { id: 'gpt-5', capabilities: { chat: true, reasoning: true } },
        },
      ],
      nextCursor: null,
    };
    assert.doesNotThrow(() =>
      decodeHostFrame({
        requestId: 'catalog-1',
        operation: 'connection.catalog.query',
        ok: true,
        result: page,
      }),
    );
    assert.throws(
      () =>
        decodeHostFrame({
          requestId: 'catalog-noncanonical-base-url',
          operation: 'connection.catalog.query',
          ok: true,
          result: {
            ...page,
            items: [
              {
                ...page.items[0],
                baseUrl: 'HTTPS://API.OPENAI.COM:443/v1',
                enabledModelIdCount: 0,
                modelCount: 0,
              },
            ],
          },
        }),
      isInvalidFrame,
    );
    assert.doesNotThrow(() =>
      decodeHostFrame({
        requestId: 'catalog-observe-512',
        operation: 'connection.catalog.query',
        ok: true,
        result: {
          ...page,
          items: [
            { ...page.items[0], enabledModelIdCount: 512, modelCount: 0 },
            {
              kind: 'enabled_model_id',
              connectionIndex: 0,
              itemIndex: 511,
              modelId: '界'.repeat(512),
            },
          ],
        },
      }),
    );
    assert.doesNotThrow(() =>
      decodeClientFrame({
        requestId: 'catalog-continue-512',
        operation: 'connection.catalog.query',
        input: {
          kind: 'continue',
          revision: 4,
          cursor: { connectionIndex: 0, part: 'enabled_model_id', itemIndex: 511 },
        },
      }),
    );
    assert.throws(
      () =>
        decodeClientFrame({
          requestId: 'catalog-continue-513',
          operation: 'connection.catalog.query',
          input: {
            kind: 'continue',
            revision: 4,
            cursor: { connectionIndex: 0, part: 'enabled_model_id', itemIndex: 512 },
          },
        }),
      isInvalidFrame,
    );
    assert.throws(
      () =>
        decodeHostFrame({
          requestId: 'catalog-2',
          operation: 'connection.catalog.query',
          ok: true,
          result: {
            ...page,
            items: Array.from(
              { length: CONNECTION_CATALOG_PAGE_MAX_ITEMS + 1 },
              () => page.items[1],
            ),
          },
        }),
      isInvalidFrame,
    );
    assert.throws(
      () =>
        decodeHostFrame({
          requestId: 'catalog-4',
          operation: 'connection.catalog.query',
          ok: true,
          result: { ...page, nextCursor: { connectionIndex: 1, part: 'connection' } },
        }),
      isInvalidFrame,
    );
    assert.throws(
      () =>
        decodeHostFrame({
          requestId: 'catalog-3',
          operation: 'connection.catalog.query',
          ok: true,
          result: {
            ...page,
            items: Array.from({ length: CONNECTION_CATALOG_PAGE_MAX_ITEMS }, (_, itemIndex) => ({
              kind: 'model',
              connectionIndex: 0,
              itemIndex,
              model: { id: `model-${itemIndex}`, displayName: '界'.repeat(170) },
            })),
          },
        }),
      isInvalidFrame,
    );
  });

  test('keeps catalog mutation requests bounded and committed results snapshot-free', () => {
    const request = {
      requestId: 'catalog-create-1',
      operation: 'connection.catalog.create' as const,
      input: {
        expectedCatalogRevision: 0,
        connection: {
          slug: 'openai-main',
          name: 'OpenAI',
          providerType: 'openai',
          enabled: true,
          enabledModelIds: ['gpt-5'],
        },
      },
    };
    assert.doesNotThrow(() => decodeClientFrame(request));
    assert.throws(
      () =>
        decodeClientFrame({
          ...request,
          input: {
            ...request.input,
            connection: { ...request.input.connection, models: [] },
          },
        }),
      isInvalidFrame,
    );
    assert.throws(
      () =>
        decodeClientFrame({
          ...request,
          input: {
            ...request.input,
            connection: {
              ...request.input.connection,
              enabledModelIds: Array.from({ length: 65 }, (_, index) => `model-${index}`),
            },
          },
        }),
      isInvalidFrame,
    );
    assert.throws(
      () =>
        decodeHostFrame({
          requestId: 'catalog-create-1',
          operation: 'connection.catalog.create',
          ok: true,
          result: {
            kind: 'committed',
            catalogRevision: 1,
            connection: { connectionId: '123e4567-e89b-42d3-a456-426614174000', revision: 1 },
            snapshot: { revision: 1, connections: [] },
          },
        }),
      isInvalidFrame,
    );
  });

  test('bounds credential secrets and rejects secret-bearing status output', () => {
    const connectionId = '123e4567-e89b-42d3-a456-426614174000';
    const credentialId = '123e4567-e89b-42d3-a456-426614174001';
    const locator = { scope: 'connection' as const, connectionId, kind: 'oauth_token' as const };
    const setFrame = (secret: string) => ({
      requestId: 'r'.repeat(128),
      operation: 'credential.vault.set' as const,
      input: {
        locator,
        expected: { credentialId, revision: Number.MAX_SAFE_INTEGER },
        secret,
      },
    });
    const worstCaseSecret = '\0'.repeat(CREDENTIAL_SECRET_MAX_BYTES);
    const encoded = encodeProtocolFrame(decodeClientFrame(setFrame(worstCaseSecret)));
    assert.ok(encoded.byteLength <= RUNTIME_HOST_MAX_FRAME_BYTES);
    assert.doesNotThrow(() => decodeClientFrame(setFrame(worstCaseSecret)));
    assert.throws(
      () => decodeClientFrame(setFrame('\0'.repeat(CREDENTIAL_SECRET_MAX_BYTES + 1))),
      isInvalidFrame,
    );
    assert.doesNotThrow(() =>
      decodeHostFrame({
        requestId: 'credential-delete-1',
        operation: 'credential.vault.delete',
        ok: true,
        result: { kind: 'connection_not_found' },
      }),
    );
    assert.throws(
      () =>
        decodeHostFrame({
          requestId: 'credential-query-1',
          operation: 'credential.vault.query',
          ok: true,
          result: {
            kind: 'status',
            status: {
              locator,
              configured: false,
              credentialId: null,
              revision: null,
              updatedAt: null,
              secret: 'must-not-cross-wire',
            },
          },
        }),
      isInvalidFrame,
    );
  });

  test('decodes split UTF-8 and multiple newline-delimited frames without an unbounded tail', () => {
    const decoder = new ProtocolFrameDecoder();
    const wire = Buffer.from(
      `${JSON.stringify({ kind: 'hello', clientInstanceId: '客户端', surface: 'tui', protocolMin: 1, protocolMax: 1 })}\n` +
        `${JSON.stringify({ requestId: 'status-1', operation: 'host.status', input: {} })}\n`,
    );
    const split = wire.indexOf(Buffer.from('端')) + 1;
    assert.deepEqual(decoder.push(wire.subarray(0, split)), []);
    const frames = decoder.push(wire.subarray(split));
    assert.equal(frames.length, 2);
    assert.deepEqual(decodeClientFrame(frames[0]), {
      kind: 'hello',
      clientInstanceId: '客户端',
      surface: 'tui',
      protocolMin: 1,
      protocolMax: 1,
    });
    assert.deepEqual(decodeClientFrame(frames[1]), {
      requestId: 'status-1',
      operation: 'host.status',
      input: {},
    });
    decoder.end();
  });

  test('keeps the operation registry closed at request and response boundaries', () => {
    assert.throws(
      () => decodeClientFrame({ requestId: 'request-1', operation: 'store.read', input: {} }),
      isInvalidFrame,
    );
    assert.throws(
      () =>
        decodeClientFrame({
          requestId: 'request-2',
          operation: 'turn.query',
          input: { sessionId: 'session-1', turnId: 'turn-1', path: '/tmp/private' },
        }),
      isInvalidFrame,
    );
    assert.throws(
      () =>
        decodeHostFrame({
          requestId: 'request-3',
          operation: 'turn.query',
          ok: false,
          error: { code: 'session_busy', message: 'busy' },
        }),
      isInvalidFrame,
    );
  });

  test('declares subscription open non-retryable and decodes its domain input', () => {
    assert.equal(HOST_OPERATION_SPECS['subscription.open'].retry, 'none');
    assert.deepEqual(
      decodeClientFrame({
        requestId: 'subscription-open-1',
        operation: 'subscription.open',
        input: { sessionId: 'session-1' },
      }),
      {
        requestId: 'subscription-open-1',
        operation: 'subscription.open',
        input: { sessionId: 'session-1' },
      },
    );
  });

  test('declares the Message coordinator operations as semantic retries', () => {
    const expectedErrors = [
      'host_not_ready',
      'host_draining',
      'operation_unavailable',
      'not_found',
      'session_archived',
      'session_busy',
      'operation_conflict',
      'outcome_unknown',
      'internal_failure',
    ];
    for (const operation of ['turn.message.submit', 'queue.retract', 'turn.interrupt'] as const) {
      assert.equal(HOST_OPERATION_SPECS[operation].retry, 'semantic');
      assert.deepEqual(HOST_OPERATION_SPECS[operation].errors, expectedErrors);
    }
  });

  test('requires origin Host Epoch and stable semantic identities for Message commands', () => {
    const submit = {
      requestId: 'submit-request-1',
      operation: 'turn.message.submit' as const,
      input: {
        originHostEpoch: 'epoch-1',
        sessionId: 'session-1',
        messageId: 'message-1',
        content: { text: 'please adjust the active turn' },
        placement: 'current_turn' as const,
      },
    };
    const retract = {
      requestId: 'retract-request-1',
      operation: 'queue.retract' as const,
      input: {
        originHostEpoch: 'epoch-1',
        sessionId: 'session-1',
        retractId: 'retract-1',
      },
    };
    const interrupt = {
      requestId: 'interrupt-request-1',
      operation: 'turn.interrupt' as const,
      input: {
        originHostEpoch: 'epoch-1',
        sessionId: 'session-1',
        interruptId: 'interrupt-1',
        turnId: 'turn-1',
        runId: 'run-1',
      },
    };
    assert.deepEqual(decodeClientFrame(submit), submit);
    assert.deepEqual(decodeClientFrame(retract), retract);
    assert.deepEqual(decodeClientFrame(interrupt), interrupt);
    assert.throws(
      () =>
        decodeClientFrame({ ...submit, input: { ...submit.input, originHostEpoch: undefined } }),
      isInvalidFrame,
    );
    assert.throws(
      () => decodeClientFrame({ ...retract, input: { ...retract.input, generation: 3 } }),
      isInvalidFrame,
    );
  });

  test('decodes every Message submit disposition as a closed result union', () => {
    for (const result of [
      { disposition: 'steering', queueRevision: 2 },
      { disposition: 'followup', queueRevision: 3 },
      { disposition: 'turn_started', turnId: 'turn-2' },
    ]) {
      assert.doesNotThrow(() =>
        decodeHostFrame({
          requestId: 'submit-request-1',
          operation: 'turn.message.submit',
          ok: true,
          result,
        }),
      );
    }
    assert.throws(
      () =>
        decodeHostFrame({
          requestId: 'submit-request-2',
          operation: 'turn.message.submit',
          ok: true,
          result: { disposition: 'turn_started', turnId: 'turn-2', queueRevision: 4 },
        }),
      isInvalidFrame,
    );
  });

  test('returns structured retracted entries from retract and interrupt', () => {
    const retracted = [retractedMessage()];
    assert.doesNotThrow(() =>
      decodeHostFrame({
        requestId: 'retract-request-1',
        operation: 'queue.retract',
        ok: true,
        result: { queueRevision: 4, retracted },
      }),
    );
    assert.doesNotThrow(() =>
      decodeHostFrame({
        requestId: 'interrupt-request-1',
        operation: 'turn.interrupt',
        ok: true,
        result: {
          queueRevision: 5,
          retracted,
          turn: {
            sessionId: 'session-1',
            turnId: 'turn-1',
            runId: 'run-1',
            status: 'cancelled',
            terminalEventId: 'event-1',
            abortSource: 'user_interrupt',
          },
        },
      }),
    );
    assert.throws(
      () =>
        decodeHostFrame({
          requestId: 'retract-request-2',
          operation: 'queue.retract',
          ok: true,
          result: { queueRevision: 6, retracted: ['queued text'] },
        }),
      isInvalidFrame,
    );
    assert.throws(
      () =>
        decodeHostFrame({
          requestId: 'retract-request-3',
          operation: 'queue.retract',
          ok: true,
          result: {
            queueRevision: 6,
            retracted: [{ ...retractedMessage(), state: 'queued' }],
          },
        }),
      isInvalidFrame,
    );
  });

  test('requires nested canonical content for turn start and Message submit', () => {
    const start = {
      requestId: 'start-request-1',
      operation: 'turn.start' as const,
      input: {
        sessionId: 'session-1',
        turnId: 'turn-1',
        content: { text: 'start with context', displayText: 'start' },
      },
    };
    assert.deepEqual(decodeClientFrame(start), start);
    assert.throws(
      () =>
        decodeClientFrame({
          ...start,
          input: { sessionId: 'session-1', turnId: 'turn-1', text: 'legacy' },
        }),
      isInvalidFrame,
    );
  });

  test('normalizes Message content while preserving ordered AttachmentRefs', () => {
    const content = {
      text: 'model input',
      displayText: 'model input',
      attachments: [
        attachmentRef({ kind: 'workspace_file', relativePath: 'second.ts' }, 'second.ts'),
        attachmentRef(
          { kind: 'session_file', sessionId: 'session-1', relativePath: 'first.ts' },
          'first.ts',
        ),
        attachmentRef({ kind: 'external_file', absolutePath: '/tmp/third.ts' }, 'third.ts'),
      ],
    };
    const decoded = decodeClientFrame({
      requestId: 'submit-request-1',
      operation: 'turn.message.submit',
      input: {
        originHostEpoch: 'epoch-1',
        sessionId: 'session-1',
        messageId: 'message-1',
        content,
        placement: 'next_turn',
      },
    });
    assert.deepEqual(decoded, {
      requestId: 'submit-request-1',
      operation: 'turn.message.submit',
      input: {
        originHostEpoch: 'epoch-1',
        sessionId: 'session-1',
        messageId: 'message-1',
        content: { text: 'model input', attachments: content.attachments },
        placement: 'next_turn',
      },
    });

    const empty = decodeClientFrame({
      requestId: 'submit-request-2',
      operation: 'turn.message.submit',
      input: {
        originHostEpoch: 'epoch-1',
        sessionId: 'session-1',
        messageId: 'message-2',
        content: { text: 'model input', displayText: '', attachments: [] },
        placement: 'next_turn',
      },
    });
    assert.deepEqual(empty, {
      requestId: 'submit-request-2',
      operation: 'turn.message.submit',
      input: {
        originHostEpoch: 'epoch-1',
        sessionId: 'session-1',
        messageId: 'message-2',
        content: { text: 'model input', displayText: '' },
        placement: 'next_turn',
      },
    });
  });

  test('closes and bounds Message content and every AttachmentRef field', () => {
    const submit = (content: unknown) =>
      decodeClientFrame({
        requestId: 'submit-request-bounds',
        operation: 'turn.message.submit',
        input: {
          originHostEpoch: 'epoch-1',
          sessionId: 'session-1',
          messageId: 'message-bounds',
          content,
          placement: 'next_turn',
        },
      });
    assert.throws(() => submit({ text: 'valid', parts: [] }), isInvalidFrame);
    assert.throws(
      () =>
        submit({
          text: 'valid',
          attachments: [
            { ...attachmentRef({ kind: 'workspace_file', relativePath: 'a.ts' }), sha256: 'guess' },
          ],
        }),
      isInvalidFrame,
    );
    assert.throws(
      () =>
        submit({
          text: 'valid',
          attachments: [
            attachmentRef({ kind: 'workspace_file', relativePath: 'a.ts', absolutePath: '/a.ts' }),
          ],
        }),
      isInvalidFrame,
    );
    assert.doesNotThrow(() =>
      submit({
        text: 'valid',
        attachments: Array.from({ length: MAX_ATTACHMENT_COUNT }, (_, index) =>
          attachmentRef({ kind: 'workspace_file', relativePath: `${index}.ts` }),
        ),
      }),
    );
    assert.throws(
      () =>
        submit({
          text: 'valid',
          attachments: Array.from({ length: MAX_ATTACHMENT_COUNT + 1 }, (_, index) =>
            attachmentRef({ kind: 'workspace_file', relativePath: `${index}.ts` }),
          ),
        }),
      isInvalidFrame,
    );
    assert.doesNotThrow(() =>
      submit({
        text: 'valid',
        attachments: [
          {
            ...attachmentRef({ kind: 'workspace_file', relativePath: 'a.ts' }),
            bytes: MAX_ATTACHMENT_BYTES,
          },
        ],
      }),
    );
    for (const bytes of [-1, 1.5, MAX_ATTACHMENT_BYTES + 1]) {
      assert.throws(
        () =>
          submit({
            text: 'valid',
            attachments: [
              { ...attachmentRef({ kind: 'workspace_file', relativePath: 'a.ts' }), bytes },
            ],
          }),
        isInvalidFrame,
      );
    }
    assert.throws(
      () =>
        submit({
          text: 'valid',
          attachments: [
            { ...attachmentRef({ kind: 'workspace_file', relativePath: 'a.ts' }), name: '' },
          ],
        }),
      isInvalidFrame,
    );
    const halfOverallBudget = Math.floor(TURN_MESSAGE_CONTENT_MAX_BYTES / 2);
    assert.throws(
      () =>
        submit({
          text: 'a'.repeat(halfOverallBudget),
          displayText: 'b'.repeat(halfOverallBudget),
        }),
      isInvalidFrame,
    );
  });

  test('bounds Message text in UTF-8 bytes while leaving enough room for frame overhead', () => {
    const input = {
      originHostEpoch: 'epoch-1',
      sessionId: 'session-1',
      messageId: 'message-1',
      content: { text: 'a'.repeat(TURN_MESSAGE_TEXT_MAX_BYTES) },
      placement: 'next_turn' as const,
    };
    const frame = decodeClientFrame({
      requestId: 'submit-request-1',
      operation: 'turn.message.submit',
      input,
    });
    assert.ok(encodeProtocolFrame(frame).byteLength < RUNTIME_HOST_MAX_FRAME_BYTES);
    assert.throws(
      () =>
        decodeClientFrame({
          requestId: 'submit-request-empty',
          operation: 'turn.message.submit',
          input: { ...input, content: { text: '' } },
        }),
      isInvalidFrame,
    );
    assert.throws(
      () =>
        decodeClientFrame({
          requestId: 'submit-request-display',
          operation: 'turn.message.submit',
          input: {
            ...input,
            content: { text: 'valid', displayText: 'a'.repeat(TURN_MESSAGE_TEXT_MAX_BYTES + 1) },
          },
        }),
      isInvalidFrame,
    );
    assert.throws(
      () =>
        decodeClientFrame({
          requestId: 'submit-request-2',
          operation: 'turn.message.submit',
          input: {
            ...input,
            content: {
              text: '界'.repeat(Math.floor(TURN_MESSAGE_TEXT_MAX_BYTES / 3) + 1),
            },
          },
        }),
      isInvalidFrame,
    );
  });

  test('routes Interaction answers only by stable Interaction identity', () => {
    const frame = {
      requestId: 'interaction-answer-1',
      operation: 'interaction.answer' as const,
      input: {
        interactionId: 'interaction-1',
        answer: { kind: 'question' as const, answers: ['yes'] },
      },
    };
    assert.deepEqual(decodeClientFrame(frame), frame);
    assert.throws(
      () =>
        decodeClientFrame({
          ...frame,
          input: { ...frame.input, sessionId: 'session-1' },
        }),
      isInvalidFrame,
    );
  });

  test('rejects terminal snapshots with fields from another terminal variant', () => {
    assert.throws(
      () =>
        decodeHostFrame({
          requestId: 'request-4',
          operation: 'turn.query',
          ok: true,
          result: {
            sessionId: 'session-1',
            turnId: 'turn-1',
            runId: 'run-1',
            status: 'completed',
            terminalEventId: 'event-1',
            abortSource: 'user',
          },
        }),
      isInvalidFrame,
    );
  });

  test('rejects a frame before buffering more than the byte cap', () => {
    const decoder = new ProtocolFrameDecoder();
    assert.throws(
      () => decoder.push(Buffer.alloc(RUNTIME_HOST_MAX_FRAME_BYTES + 1, 0x61)),
      (error: unknown) =>
        error instanceof RuntimeHostProtocolError && error.code === 'frame_too_large',
    );
  });

  test('keeps Session continuity snapshots closed to canonical identity and root Turn', () => {
    const frame = sessionProjectionFrame();
    assert.doesNotThrow(() => decodeHostFrame(frame));
    assert.throws(
      () =>
        decodeHostFrame({
          ...frame,
          snapshot: {
            ...frame.snapshot,
            transcript: [{ role: 'assistant', text: 'private' }],
          },
        }),
      isInvalidFrame,
    );
    assert.throws(
      () =>
        decodeHostFrame({
          ...frame,
          snapshot: {
            ...frame.snapshot,
            interaction: { kind: 'permission', args: { path: '/private' } },
          },
        }),
      isInvalidFrame,
    );
  });

  test('projects only bounded public queue state from the current Host Epoch', () => {
    const frame = sessionProjectionFrame();
    assert.doesNotThrow(() => decodeHostFrame(frame));
    assert.throws(
      () =>
        decodeHostFrame({
          ...frame,
          snapshot: {
            ...frame.snapshot,
            queue: { ...frame.snapshot.queue, phase: 'accepting' },
          },
        }),
      isInvalidFrame,
    );
    assert.throws(
      () =>
        decodeHostFrame({
          ...frame,
          snapshot: {
            ...frame.snapshot,
            queue: {
              ...frame.snapshot.queue,
              steering: [{ ...queuedMessage(), generation: 7 }],
            },
          },
        }),
      isInvalidFrame,
    );
    assert.throws(
      () =>
        decodeHostFrame({
          ...frame,
          snapshot: {
            ...frame.snapshot,
            queue: { ...frame.snapshot.queue, hostEpoch: 'epoch-2' },
          },
        }),
      isInvalidFrame,
    );
    assert.throws(
      () =>
        decodeHostFrame({
          ...frame,
          snapshot: {
            ...frame.snapshot,
            queue: {
              ...frame.snapshot.queue,
              steering: Array.from({ length: MESSAGE_QUEUE_MAX_ENTRIES + 1 }, (_, index) => ({
                ...queuedMessage(),
                entryId: `entry-${index}`,
                messageId: `message-${index}`,
              })),
            },
          },
        }),
      isInvalidFrame,
    );
    const maximalTextFrame = {
      ...frame,
      snapshot: {
        ...frame.snapshot,
        queue: {
          ...frame.snapshot.queue,
          steering: [queuedMessage('a'.repeat(TURN_MESSAGE_TEXT_MAX_BYTES))],
        },
      },
    };
    const decoded = decodeHostFrame(maximalTextFrame);
    assert.ok(encodeProtocolFrame(decoded).byteLength < RUNTIME_HOST_MAX_FRAME_BYTES);
  });

  test('projects in-flight steering and preserves placement when steering folds into followup', () => {
    const frame = sessionProjectionFrame();
    const folded = {
      ...queuedMessage('folded steering', 'current_turn'),
      entryId: 'entry-folded-1',
      messageId: 'message-folded-1',
    };
    const explicitFollowup = {
      ...queuedMessage('explicit followup', 'next_turn'),
      entryId: 'entry-followup-1',
      messageId: 'message-followup-1',
    };
    const decoded = decodeHostFrame({
      ...frame,
      snapshot: {
        ...frame.snapshot,
        queue: {
          ...frame.snapshot.queue,
          steering: [queuedMessage(), inFlightMessage()],
          followup: [folded, explicitFollowup],
        },
      },
    });
    assert.deepEqual(
      'kind' in decoded && decoded.kind === 'subscription.session_projection'
        ? decoded.snapshot.queue
        : null,
      {
        hostEpoch: 'epoch-1',
        queueRevision: 1,
        steering: [queuedMessage(), inFlightMessage()],
        followup: [folded, explicitFollowup],
      },
    );
  });

  test('rejects next-turn steering and in-flight followup entries', () => {
    const frame = sessionProjectionFrame();
    assert.throws(
      () =>
        decodeHostFrame({
          ...frame,
          snapshot: {
            ...frame.snapshot,
            queue: {
              ...frame.snapshot.queue,
              steering: [queuedMessage('next turn only', 'next_turn')],
            },
          },
        }),
      isInvalidFrame,
    );
    assert.throws(
      () =>
        decodeHostFrame({
          ...frame,
          snapshot: {
            ...frame.snapshot,
            queue: { ...frame.snapshot.queue, followup: [inFlightMessage()] },
          },
        }),
      isInvalidFrame,
    );
  });

  test('rejects Session continuity root Turns from another Session', () => {
    const projection = sessionProjectionFrame();
    assert.doesNotThrow(() => decodeHostFrame(projection));
    const snapshot = {
      ...projection.snapshot,
      rootTurn: {
        ...projection.snapshot.rootTurn,
        sessionId: 'session-2',
      },
    };
    assert.throws(
      () =>
        decodeHostFrame({
          requestId: 'subscription-open-2',
          operation: 'subscription.open',
          ok: true,
          result: {
            hostEpoch: 'epoch-1',
            subscriptionId: 'subscription-1',
            nextSequence: 1,
            snapshot,
          },
        }),
      isInvalidFrame,
    );
    assert.throws(() => decodeHostFrame({ ...projection, snapshot }), isInvalidFrame);
  });

  test('rejects private delta fields and enforces the text limit in UTF-8 bytes', () => {
    const frame = sessionDeltaFrame('visible');
    assert.throws(
      () =>
        decodeHostFrame({
          ...frame,
          delta: { ...frame.delta, signature: 'private-signature' },
        }),
      isInvalidFrame,
    );
    assert.throws(
      () =>
        decodeHostFrame({
          ...frame,
          delta: { ...frame.delta, toolArgs: { path: '/private' } },
        }),
      isInvalidFrame,
    );
    assert.throws(
      () =>
        decodeHostFrame(
          sessionDeltaFrame('界'.repeat(Math.floor(SESSION_LIVE_DELTA_MAX_BYTES / 3) + 1)),
        ),
      isInvalidFrame,
    );
    const decoded = decodeHostFrame(sessionDeltaFrame('a'.repeat(SESSION_LIVE_DELTA_MAX_BYTES)));
    assert.equal('kind' in decoded && decoded.kind, 'subscription.session_delta');
  });
});

function sessionProjectionFrame() {
  return {
    kind: 'subscription.session_projection' as const,
    hostEpoch: 'epoch-1',
    subscriptionId: 'subscription-1',
    sequence: 1,
    snapshot: {
      schemaVersion: SESSION_CONTINUITY_SCHEMA_VERSION,
      session: {
        sessionId: 'session-1',
        status: 'running' as const,
        createdAt: 1,
        lastUsedAt: 2,
        isArchived: false,
      },
      projectionRevision: 1,
      rootTurn: {
        sessionId: 'session-1',
        turnId: 'turn-1',
        runId: 'run-1',
        status: 'running' as const,
      },
      interactions: { pending: [] },
      queue: {
        hostEpoch: 'epoch-1',
        queueRevision: 1,
        steering: [queuedMessage()],
        followup: [],
      },
    },
  };
}

function queuedMessage(
  text = 'adjust this turn',
  placement: 'current_turn' | 'next_turn' = 'current_turn',
) {
  return {
    entryId: 'entry-1',
    messageId: 'message-queued-1',
    content: { text },
    placement,
    state: 'queued' as const,
  };
}

function inFlightMessage() {
  return {
    ...queuedMessage('already pulled'),
    entryId: 'entry-in-flight-1',
    messageId: 'message-in-flight-1',
    state: 'in_flight' as const,
  };
}

function retractedMessage() {
  return {
    entryId: 'entry-2',
    messageId: 'message-retracted-1',
    content: { text: 'do this next' },
    placement: 'next_turn' as const,
    state: 'retracted' as const,
  };
}

function attachmentRef(
  ref:
    | { kind: 'session_file'; sessionId: string; relativePath: string }
    | { kind: 'workspace_file'; relativePath: string; absolutePath?: string }
    | { kind: 'external_file'; absolutePath: string },
  name = 'a.ts',
) {
  return {
    kind: 'code' as const,
    name,
    mimeType: 'text/typescript',
    bytes: 1,
    ref,
  };
}

function sessionDeltaFrame(text: string) {
  return {
    kind: 'subscription.session_delta' as const,
    hostEpoch: 'epoch-1',
    subscriptionId: 'subscription-1',
    sequence: 1,
    sessionId: 'session-1',
    delta: {
      kind: 'text' as const,
      turnId: 'turn-1',
      runId: 'run-1',
      messageId: 'message-1',
      text,
    },
  };
}

function isInvalidFrame(error: unknown): boolean {
  return error instanceof RuntimeHostProtocolError && error.code === 'invalid_frame';
}
