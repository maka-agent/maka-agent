import assert from 'node:assert/strict';
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_COUNT,
  type AgentRunEvent,
  type AgentRunHeader,
  type AttachmentRef,
  type MessageContent,
  type RuntimeEvent,
} from '@maka/core';
import {
  createAgentRunStore,
  ROOT_TURN_ADMISSION_MAX_CONTENT_BYTES,
  ROOT_TURN_ADMISSION_MAX_SOURCE_MESSAGES,
} from '../agent-run-store.js';
import {
  authenticateExecutionStoresReader,
  authenticateExecutionStoresWriter,
  openHeadlessExecutionStoresForRead,
  openHeadlessExecutionStoresForWrite,
  openInteractiveExecutionStoresForRead,
  openInteractiveExecutionStoresForWrite,
} from '../execution-stores.js';
import {
  createHeadlessRootLease,
  resolveStorageRoot,
  StorageRootAuthorityError,
  tryAcquireInteractiveRootOwner,
  tryAcquireInteractiveRootReader,
  type StorageRootLease,
} from '../root-authority.js';
import { createSessionStore } from '../session-store.js';

const chartAttachment: AttachmentRef = {
  kind: 'image',
  name: 'chart.png',
  mimeType: 'image/png',
  bytes: 1_024,
  ref: {
    kind: 'session_file',
    sessionId: 'session-attachment',
    relativePath: 'attachments/chart.png',
  },
};
const notesAttachment: AttachmentRef = {
  kind: 'doc',
  name: 'notes.txt',
  mimeType: 'text/plain',
  bytes: 128,
  ref: { kind: 'workspace_file', relativePath: 'notes.txt' },
};

describe('execution stores', () => {
  test('binds Headless execution readers and writers to Headless leases', async () => {
    await withRoot(async ({ base, root }) => {
      const capability = await resolveStorageRoot({
        path: root,
        kind: 'headless',
      });
      const writer = await openHeadlessExecutionStoresForWrite(
        createHeadlessRootLease(capability, 'write'),
      );
      assert.equal(writer.kind, 'headless');
      const session = await writer.sessionStore.create(sessionInput(root));
      await writer.sessionStore.appendMessage(session.id, {
        type: 'user',
        id: 'message-1',
        turnId: 'turn-1',
        ts: 10,
        text: 'hello',
      });

      const reader = await openHeadlessExecutionStoresForRead(
        createHeadlessRootLease(capability, 'read'),
      );
      assert.equal(reader.kind, 'headless');
      assert.equal((await reader.sessionStore.list()).length, 1);
      assert.equal((await reader.sessionStore.readMessages(session.id))[0]?.id, 'message-1');

      const interactive = await resolveStorageRoot({
        path: join(base, 'interactive'),
        kind: 'interactive',
      });
      const owner = await tryAcquireInteractiveRootOwner(interactive);
      assert.ok(owner);
      if (!owner) return;
      try {
        await assert.rejects(
          () =>
            openHeadlessExecutionStoresForWrite(
              owner.lease as unknown as StorageRootLease<'headless', 'write'>,
            ),
          (error: unknown) =>
            error instanceof StorageRootAuthorityError && error.code === 'invalid_lease',
        );
      } finally {
        await owner.close();
      }
    });
  });

  test('freezes and authenticates execution store facades', async () => {
    await withRoot(async ({ base, root }) => {
      const capability = await resolveStorageRoot({
        path: root,
        kind: 'headless',
      });
      const writer = await openHeadlessExecutionStoresForWrite(
        createHeadlessRootLease(capability, 'write'),
      );
      const session = await writer.sessionStore.create(sessionInput(root));
      const reader = await openHeadlessExecutionStoresForRead(
        createHeadlessRootLease(capability, 'read'),
      );
      const rawLocalStore = createSessionStore(root);

      assert.equal(Reflect.set(reader, 'sessionStore', rawLocalStore), false);
      assert.equal(
        Reflect.set(
          reader.sessionStore,
          'readHeader',
          rawLocalStore.readHeader.bind(rawLocalStore),
        ),
        false,
      );
      await reader.sessionStore.readHeader(session.id);
      assert.equal((await rawLocalStore.readHeaderSnapshot(session.id)).connectionLocked, false);

      const otherRoot = join(base, 'other-headless');
      await resolveStorageRoot({ path: otherRoot, kind: 'headless' });
      const rawOtherStore = createSessionStore(otherRoot);
      assert.equal(Reflect.set(writer, 'sessionStore', rawOtherStore), false);
      assert.equal(
        Reflect.set(writer.sessionStore, 'create', rawOtherStore.create.bind(rawOtherStore)),
        false,
      );

      const copiedReader = { ...reader, sessionStore: rawLocalStore };
      assert.throws(
        () => authenticateExecutionStoresReader(copiedReader, 'headless'),
        (error: unknown) =>
          error instanceof StorageRootAuthorityError && error.code === 'invalid_lease',
      );
      const copiedWriter = { ...writer, sessionStore: rawOtherStore };
      assert.throws(
        () => authenticateExecutionStoresWriter(copiedWriter, 'headless'),
        (error: unknown) =>
          error instanceof StorageRootAuthorityError && error.code === 'invalid_lease',
      );
    });
  });

  test('commits root-turn admission before Run creation and retains its original identity', async () => {
    await withRoot(async ({ root }) => {
      const capability = await resolveStorageRoot({
        path: root,
        kind: 'interactive',
      });
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      if (!owner) return;
      try {
        const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
        assert.equal(stores.kind, 'interactive');
        const session = await stores.sessionStore.create(sessionInput(root));
        const first = await stores.agentRunStore.admitRootTurn({
          sessionId: session.id,
          turnId: 'turn-1',
          proposedRunId: 'run-1',
          proposedUserMessageId: 'message-1',
          previousRootTurnId: null,
          normalizedInput: {
            text: '<model>hello</model>',
            displayText: 'hello',
            attachments: [chartAttachment, notesAttachment],
          },
          sourceMessages: [
            {
              messageId: 'source-1',
              content: {
                text: '<model>hello</model>',
                displayText: 'hello',
                attachments: [chartAttachment, notesAttachment],
              },
              placement: 'current_turn',
              disposition: 'steering',
            },
          ],
          admittedAt: 10,
        });
        assert.equal(first.kind, 'admitted');
        assert.equal(first.admission.schemaVersion, 4);
        assert.equal(Object.isFrozen(first.admission), true);
        assert.equal(Object.isFrozen(first.admission.normalizedInput), true);
        assert.equal(Object.isFrozen(first.admission.normalizedInput.attachments), true);
        assert.equal(Object.isFrozen(first.admission.normalizedInput.attachments?.[0]), true);
        assert.equal(Object.isFrozen(first.admission.normalizedInput.attachments?.[0]?.ref), true);
        assert.equal(Object.isFrozen(first.admission.sourceMessages), true);
        assert.equal(Object.isFrozen(first.admission.sourceMessages[0]), true);
        assert.equal(Object.isFrozen(first.admission.sourceMessages[0]?.content), true);
        assert.equal(
          Object.isFrozen(first.admission.sourceMessages[0]?.content.attachments?.[0]?.ref),
          true,
        );
        assert.deepEqual(await stores.agentRunStore.listSessionRuns(session.id), []);

        const retry = await stores.agentRunStore.admitRootTurn({
          sessionId: session.id,
          turnId: 'turn-1',
          proposedRunId: 'run-never-used',
          proposedUserMessageId: 'message-never-used',
          previousRootTurnId: null,
          normalizedInput: {
            text: '<model>hello</model>',
            displayText: 'hello',
            attachments: [{ ...chartAttachment }, { ...notesAttachment }],
          },
          sourceMessages: [
            {
              messageId: 'source-1',
              content: {
                text: '<model>hello</model>',
                displayText: 'hello',
                attachments: [{ ...chartAttachment }, { ...notesAttachment }],
              },
              placement: 'current_turn',
              disposition: 'steering',
            },
          ],
          admittedAt: 20,
        });
        assert.equal(retry.kind, 'existing');
        assert.equal(retry.admission.runId, 'run-1');
        assert.equal(retry.admission.userMessageId, 'message-1');
        assert.equal(retry.admission.admittedAt, 10);
        assert.deepEqual(retry.admission.normalizedInput, {
          text: '<model>hello</model>',
          displayText: 'hello',
          attachments: [chartAttachment, notesAttachment],
        });
        assert.deepEqual(retry.admission.sourceMessages, first.admission.sourceMessages);

        const receiptStore = createAgentRunStore(root);
        const receipt = await receiptStore.readRootTurnSourceMessageReceipt(session.id, 'source-1');
        assert.ok(receipt);
        assert.equal(receipt.admission.turnId, 'turn-1');
        assert.deepEqual(receipt.sourceMessage, first.admission.sourceMessages[0]);
        assert.equal(Object.isFrozen(receipt), true);
        assert.equal(
          await receiptStore.readRootTurnSourceMessageReceipt(session.id, 'source-missing'),
          undefined,
        );

        const conflict = await stores.agentRunStore.admitRootTurn({
          sessionId: session.id,
          turnId: 'turn-1',
          proposedRunId: 'run-never-used',
          proposedUserMessageId: 'message-never-used',
          previousRootTurnId: null,
          normalizedInput: {
            text: '<model>hello</model>',
            displayText: 'hello',
            attachments: [notesAttachment, chartAttachment],
          },
          sourceMessages: [
            {
              messageId: 'source-1',
              content: {
                text: '<model>hello</model>',
                displayText: 'hello',
                attachments: [notesAttachment, chartAttachment],
              },
              placement: 'current_turn',
              disposition: 'steering',
            },
          ],
          admittedAt: 30,
        });
        assert.equal(conflict.kind, 'conflict');
        assert.equal(conflict.admission.runId, 'run-1');

        const placementConflict = await stores.agentRunStore.admitRootTurn({
          sessionId: session.id,
          turnId: 'turn-1',
          proposedRunId: 'run-never-used',
          proposedUserMessageId: 'message-never-used',
          previousRootTurnId: null,
          normalizedInput: {
            text: '<model>hello</model>',
            displayText: 'hello',
            attachments: [chartAttachment, notesAttachment],
          },
          sourceMessages: [
            {
              messageId: 'source-1',
              content: {
                text: '<model>hello</model>',
                displayText: 'hello',
                attachments: [chartAttachment, notesAttachment],
              },
              placement: 'next_turn',
              disposition: 'followup',
            },
          ],
          admittedAt: 40,
        });
        assert.equal(placementConflict.kind, 'conflict');

        const header = runHeader(session.id, first.admission.runId);
        await stores.agentRunStore.createRun(header);
        const bytes = await readFile(
          join(root, 'sessions', session.id, 'runs', first.admission.runId, 'run.json'),
          'utf8',
        );
        await assert.rejects(
          () => stores.agentRunStore.createRun({ ...header, updatedAt: 99 }),
          /Agent run already exists/,
        );
        assert.equal(
          await readFile(
            join(root, 'sessions', session.id, 'runs', first.admission.runId, 'run.json'),
            'utf8',
          ),
          bytes,
        );
      } finally {
        await owner.close();
      }
    });
  });

  test('bounds source receipts and fails closed on duplicate or ambiguous message identity', async () => {
    await withRoot(async ({ root }) => {
      const store = createAgentRunStore(root);
      const base = {
        sessionId: 'session-receipts',
        proposedUserMessageId: 'user-message',
        normalizedInput: { text: 'original source text' },
        admittedAt: 10,
      } as const;
      const sourceMessage = {
        messageId: 'source-shared',
        content: { text: 'original source text' },
        placement: 'current_turn',
        disposition: 'turn_started',
      } as const;

      await assert.rejects(
        () =>
          store.admitRootTurn({
            ...base,
            turnId: 'turn-duplicate',
            proposedRunId: 'run-duplicate',
            previousRootTurnId: null,
            sourceMessages: [sourceMessage, sourceMessage],
          }),
        /Duplicate root turn source message id/,
      );
      await assert.rejects(
        () =>
          store.admitRootTurn({
            ...base,
            turnId: 'turn-too-many',
            proposedRunId: 'run-too-many',
            previousRootTurnId: null,
            sourceMessages: Array.from(
              { length: ROOT_TURN_ADMISSION_MAX_SOURCE_MESSAGES + 1 },
              (_, index) => ({ ...sourceMessage, messageId: `source-${index}` }),
            ),
          }),
        /expected a bounded array/,
      );

      const attachmentContentOverhead = Buffer.byteLength(
        JSON.stringify({
          text: 'original source text',
          attachments: [{ ...chartAttachment, name: '' }],
        }),
        'utf8',
      );
      const boundaryContent = {
        text: 'original source text',
        attachments: [
          {
            ...chartAttachment,
            name: 'x'.repeat(ROOT_TURN_ADMISSION_MAX_CONTENT_BYTES - attachmentContentOverhead),
          },
        ],
      };
      const boundaryBase = {
        ...base,
        sessionId: 'session-content-boundary',
        normalizedInput: boundaryContent,
      };
      const boundary = await store.admitRootTurn({
        ...boundaryBase,
        turnId: 'turn-content-boundary',
        proposedRunId: 'run-content-boundary',
        previousRootTurnId: null,
        sourceMessages: [
          {
            ...sourceMessage,
            messageId: 'source-content-boundary',
            content: boundaryContent,
          },
        ],
      });
      assert.equal(boundary.kind, 'admitted');
      await assert.rejects(
        () =>
          store.admitRootTurn({
            ...boundaryBase,
            turnId: 'turn-too-large',
            proposedRunId: 'run-too-large',
            previousRootTurnId: null,
            sourceMessages: [
              {
                ...sourceMessage,
                content: {
                  ...boundaryContent,
                  attachments: [
                    {
                      ...boundaryContent.attachments[0],
                      name: `${boundaryContent.attachments[0]?.name}x`,
                    },
                  ],
                },
              },
            ],
          }),
        /content exceeds size limit/,
      );

      const normalized = await store.admitRootTurn({
        ...base,
        turnId: 'turn-1',
        proposedRunId: 'run-1',
        previousRootTurnId: null,
        sourceMessages: [
          {
            ...sourceMessage,
            content: {
              text: 'original source text',
              displayText: 'original source text',
              attachments: [],
            },
          },
        ],
      });
      assert.equal(normalized.kind, 'admitted');
      assert.deepEqual(normalized.admission.sourceMessages[0]?.content, {
        text: 'original source text',
      });
      const normalizedRetry = await store.admitRootTurn({
        ...base,
        turnId: 'turn-1',
        proposedRunId: 'run-unused',
        previousRootTurnId: null,
        sourceMessages: [sourceMessage],
      });
      assert.equal(normalizedRetry.kind, 'existing');
      await store.admitRootTurn({
        ...base,
        turnId: 'turn-2',
        proposedRunId: 'run-2',
        previousRootTurnId: 'turn-1',
        sourceMessages: [{ ...sourceMessage, disposition: 'followup' }],
      });
      await assert.rejects(
        () => store.readRootTurnSourceMessageReceipt(base.sessionId, sourceMessage.messageId),
        /Ambiguous root turn source message receipt/,
      );
    });
  });

  test('enforces durable MessageContent product boundaries', async () => {
    await withRoot(async ({ root }) => {
      const store = createAgentRunStore(root);
      const directAdmission = (label: string, normalizedInput: MessageContent) =>
        store.admitRootTurn({
          sessionId: `session-${label}`,
          turnId: 'turn-1',
          proposedRunId: `run-${label}`,
          proposedUserMessageId: `message-${label}`,
          previousRootTurnId: null,
          normalizedInput,
          sourceMessages: [],
          admittedAt: 10,
        });
      const directAttachments = Array.from({ length: MAX_ATTACHMENT_COUNT }, (_, index) => ({
        ...notesAttachment,
        name: `note-${index}.txt`,
        ...(index === 0 ? { bytes: MAX_ATTACHMENT_BYTES } : {}),
      }));

      const direct = await directAdmission('content-contract', {
        text: 'model input',
        displayText: '',
        attachments: directAttachments,
      });
      assert.equal(direct.kind, 'admitted');
      assert.deepEqual(direct.admission.normalizedInput, {
        text: 'model input',
        displayText: '',
        attachments: directAttachments,
      });

      const tooManyAttachments = [...directAttachments, chartAttachment];
      await assert.rejects(
        () =>
          directAdmission('direct-attachment-overflow', {
            text: 'direct overflow',
            attachments: tooManyAttachments,
          }),
        /Invalid root turn normalized input/,
      );
      await assert.rejects(
        () =>
          store.admitRootTurn({
            sessionId: 'session-source-attachment-overflow',
            turnId: 'turn-1',
            proposedRunId: 'run-source-attachment-overflow',
            proposedUserMessageId: 'message-source-attachment-overflow',
            previousRootTurnId: null,
            normalizedInput: { text: 'source overflow', attachments: tooManyAttachments },
            sourceMessages: [
              {
                messageId: 'source-attachment-overflow',
                content: { text: 'source overflow', attachments: tooManyAttachments },
                placement: 'current_turn',
                disposition: 'steering',
              },
            ],
            admittedAt: 10,
          }),
        /Invalid root turn source message content at index 0/,
      );
      await assert.rejects(
        () =>
          directAdmission('attachment-byte-overflow', {
            text: 'byte overflow',
            attachments: [{ ...chartAttachment, bytes: MAX_ATTACHMENT_BYTES + 1 }],
          }),
        /Invalid root turn normalized input attachment at index 0/,
      );
      await assert.rejects(
        () =>
          directAdmission('attachment-fractional-bytes', {
            text: 'fractional bytes',
            attachments: [{ ...chartAttachment, bytes: 0.5 }],
          }),
        /Invalid root turn normalized input attachment at index 0/,
      );
      const emptyFieldAttachments: readonly [string, AttachmentRef][] = [
        ['name', { ...chartAttachment, name: '' }],
        ['mime', { ...chartAttachment, mimeType: '' }],
        [
          'session-id',
          {
            ...chartAttachment,
            ref: {
              kind: 'session_file',
              sessionId: '',
              relativePath: 'attachments/chart.png',
            },
          },
        ],
        [
          'relative-path',
          {
            ...notesAttachment,
            ref: { kind: 'workspace_file', relativePath: '' },
          },
        ],
        [
          'absolute-path',
          {
            ...chartAttachment,
            ref: { kind: 'external_file', absolutePath: '' },
          },
        ],
      ];
      for (const [label, attachment] of emptyFieldAttachments) {
        await assert.rejects(
          () =>
            directAdmission(`attachment-empty-${label}`, {
              text: 'empty field',
              attachments: [attachment],
            }),
          /Invalid root turn normalized input attachment at index 0/,
        );
      }
    });
  });

  test('rejects source receipts that cannot prove the admitted execution input', async () => {
    await withRoot(async ({ root }) => {
      const store = createAgentRunStore(root);
      const base = {
        sessionId: 'session-source-integrity',
        proposedUserMessageId: 'user-message',
        previousRootTurnId: null,
        admittedAt: 10,
      } as const;

      await assert.rejects(
        () =>
          store.admitRootTurn({
            ...base,
            turnId: 'turn-text-mismatch',
            proposedRunId: 'run-text-mismatch',
            normalizedInput: { text: 'different execution input' },
            sourceMessages: [
              {
                messageId: 'source-text-mismatch',
                content: { text: 'original source text' },
                placement: 'next_turn',
                disposition: 'followup',
              },
            ],
          }),
        /input content does not match source messages/,
      );
      await assert.rejects(
        () =>
          store.admitRootTurn({
            ...base,
            turnId: 'turn-invalid-steering',
            proposedRunId: 'run-invalid-steering',
            normalizedInput: { text: 'steering text' },
            sourceMessages: [
              {
                messageId: 'source-invalid-steering',
                content: { text: 'steering text' },
                placement: 'next_turn',
                disposition: 'steering',
              },
            ],
          }),
        /Invalid root turn source message/,
      );
      await assert.rejects(
        () =>
          store.admitRootTurn({
            ...base,
            turnId: 'turn-multiple-started',
            proposedRunId: 'run-multiple-started',
            normalizedInput: { text: 'idle start\n\nfollow-up' },
            sourceMessages: [
              {
                messageId: 'source-idle-start',
                content: { text: 'idle start' },
                placement: 'current_turn',
                disposition: 'turn_started',
              },
              {
                messageId: 'source-followup',
                content: { text: 'follow-up' },
                placement: 'next_turn',
                disposition: 'followup',
              },
            ],
          }),
        /turn_started source must be the only source message/,
      );

      const steeringAttachments = [
        chartAttachment,
        notesAttachment,
        chartAttachment,
        notesAttachment,
        chartAttachment,
      ];
      const followupAttachments = [
        notesAttachment,
        chartAttachment,
        notesAttachment,
        chartAttachment,
      ];
      const aggregatedAttachments = [...steeringAttachments, ...followupAttachments];
      const admitted = await store.admitRootTurn({
        ...base,
        turnId: 'turn-valid-batch',
        proposedRunId: 'run-valid-batch',
        normalizedInput: {
          text: '<model>steering text</model>\n\nfollow-up text',
          displayText: 'steering text\n\nfollow-up text',
          attachments: aggregatedAttachments,
        },
        sourceMessages: [
          {
            messageId: 'source-steering',
            content: {
              text: '<model>steering text</model>',
              displayText: 'steering text',
              attachments: steeringAttachments,
            },
            placement: 'current_turn',
            disposition: 'steering',
          },
          {
            messageId: 'source-followup',
            content: {
              text: 'follow-up text',
              displayText: 'follow-up text',
              attachments: followupAttachments,
            },
            placement: 'next_turn',
            disposition: 'followup',
          },
        ],
      });
      assert.equal(admitted.kind, 'admitted');
      assert.deepEqual(admitted.admission.normalizedInput, {
        text: '<model>steering text</model>\n\nfollow-up text',
        displayText: 'steering text\n\nfollow-up text',
        attachments: aggregatedAttachments,
      });
      assert.deepEqual(admitted.admission.sourceMessages[1]?.content, {
        text: 'follow-up text',
        attachments: followupAttachments,
      });

      const admissionPath = join(
        root,
        'sessions',
        base.sessionId,
        'turn-admissions',
        'turn-valid-batch.json',
      );
      const durable = JSON.parse(await readFile(admissionPath, 'utf8')) as Record<string, unknown>;
      await writeFile(
        admissionPath,
        `${JSON.stringify({ ...durable, normalizedInput: { text: 'tampered input' } })}\n`,
      );

      await assert.rejects(
        () => store.readRootTurnAdmission(base.sessionId, 'turn-valid-batch'),
        /input content does not match source messages/,
      );
      await assert.rejects(
        () => store.readRootTurnSourceMessageReceipt(base.sessionId, 'source-steering'),
        /input content does not match source messages/,
      );
      await assert.rejects(
        () => store.listRootTurnAdmissionsForRecovery(base.sessionId),
        /input content does not match source messages/,
      );

      const sourceMessages = durable.sourceMessages as Array<Record<string, unknown>>;
      const firstSource = sourceMessages[0] as Record<string, unknown>;
      const firstContent = firstSource.content as Record<string, unknown>;
      firstSource.content = { ...firstContent, parts: [{ kind: 'image', bytes: 'not allowed' }] };
      await writeFile(admissionPath, `${JSON.stringify(durable)}\n`);
      await assert.rejects(
        () => store.readRootTurnAdmission(base.sessionId, 'turn-valid-batch'),
        /Invalid root turn source message content at index 0/,
      );
    });
  });

  test('recovers root-turn admissions by durable predecessor order instead of timestamp or identity', async () => {
    await withRoot(async ({ root }) => {
      const capability = await resolveStorageRoot({
        path: root,
        kind: 'interactive',
      });
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      if (!owner) return;
      try {
        const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
        const session = await stores.sessionStore.create(sessionInput(root));
        const first = await stores.agentRunStore.admitRootTurn({
          sessionId: session.id,
          turnId: 'turn-z',
          proposedRunId: 'run-z',
          proposedUserMessageId: 'message-z',
          previousRootTurnId: null,
          normalizedInput: { text: 'first' },
          sourceMessages: [],
          admittedAt: 10,
        });
        const second = await stores.agentRunStore.admitRootTurn({
          sessionId: session.id,
          turnId: 'turn-a',
          proposedRunId: 'run-a',
          proposedUserMessageId: 'message-a',
          previousRootTurnId: 'turn-z',
          normalizedInput: { text: 'second' },
          sourceMessages: [],
          admittedAt: 10,
        });
        assert.equal(first.kind, 'admitted');
        assert.equal(second.kind, 'admitted');
        const recovered = await stores.agentRunStore.listRootTurnAdmissionsForRecovery(session.id);
        assert.deepEqual(
          recovered.map((admission) => admission.turnId),
          ['turn-z', 'turn-a'],
        );
        assert.equal(recovered.at(-1)?.previousRootTurnId, 'turn-z');
      } finally {
        await owner.close();
      }
    });
  });

  test('fails recovery when the durable root-turn predecessor graph is not one complete chain', async () => {
    await withRoot(async ({ root }) => {
      const capability = await resolveStorageRoot({
        path: root,
        kind: 'interactive',
      });
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      if (!owner) return;
      try {
        const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
        const seed = async (
          label: string,
          admissions: readonly [turnId: string, previousRootTurnId: string | null][],
        ): Promise<string> => {
          const session = await stores.sessionStore.create({
            ...sessionInput(root),
            name: label,
          });
          for (const [turnId, previousRootTurnId] of admissions) {
            await stores.agentRunStore.admitRootTurn({
              sessionId: session.id,
              turnId,
              proposedRunId: `run-${turnId}`,
              proposedUserMessageId: `message-${turnId}`,
              previousRootTurnId,
              normalizedInput: { text: turnId },
              sourceMessages: [],
              admittedAt: 10,
            });
          }
          return session.id;
        };

        const missing = await seed('missing', [['missing-a', 'absent']]);
        await assert.rejects(
          () => stores.agentRunStore.listRootTurnAdmissionsForRecovery(missing),
          /missing predecessor/,
        );

        const branch = await seed('branch', [
          ['branch-root', null],
          ['branch-left', 'branch-root'],
          ['branch-right', 'branch-root'],
        ]);
        await assert.rejects(
          () => stores.agentRunStore.listRootTurnAdmissionsForRecovery(branch),
          /branches/,
        );

        const cycle = await seed('cycle', [
          ['cycle-a', 'cycle-b'],
          ['cycle-b', 'cycle-a'],
        ]);
        await assert.rejects(
          () => stores.agentRunStore.listRootTurnAdmissionsForRecovery(cycle),
          /contains a cycle/,
        );

        const roots = await seed('roots', [
          ['root-a', null],
          ['root-b', null],
        ]);
        await assert.rejects(
          () => stores.agentRunStore.listRootTurnAdmissionsForRecovery(roots),
          /exactly one root turn admission root/,
        );
      } finally {
        await owner.close();
      }
    });
  });

  test('keeps shared execution reads observational', async () => {
    await withRoot(async ({ root }) => {
      const capability = await resolveStorageRoot({
        path: root,
        kind: 'interactive',
      });
      const rawSessionStore = createSessionStore(root);
      const session = await rawSessionStore.create(sessionInput(root));
      await rawSessionStore.appendMessage(session.id, {
        type: 'user',
        id: 'message-1',
        turnId: 'turn-1',
        ts: 10,
        text: 'hello',
      });
      const rawAgentRunStore = createAgentRunStore(root);
      await rawAgentRunStore.admitRootTurn({
        sessionId: session.id,
        turnId: 'turn-1',
        proposedRunId: 'run-1',
        proposedUserMessageId: 'message-1',
        previousRootTurnId: null,
        normalizedInput: { text: 'hello' },
        sourceMessages: [],
        admittedAt: 9,
      });
      await rawAgentRunStore.createRun(runHeader(session.id, 'run-1'));
      const sessionPath = join(root, 'sessions', session.id, 'session.jsonl');
      const before = await readFile(sessionPath, 'utf8');

      const reader = await tryAcquireInteractiveRootReader(capability);
      assert.ok(reader);
      if (!reader) return;
      try {
        const stores = await openInteractiveExecutionStoresForRead(reader.lease);
        assert.equal((await stores.sessionStore.list()).length, 1);
        assert.equal((await stores.sessionStore.readHeader(session.id)).connectionLocked, false);
        assert.equal((await stores.sessionStore.readMessages(session.id)).length, 1);
        assert.equal((await stores.sessionStore.listTurns(session.id)).length, 1);
        assert.equal((await stores.agentRunStore.listSessionRuns(session.id)).length, 1);
        assert.equal((await stores.agentRunStore.readRun(session.id, 'run-1')).turnId, 'turn-1');
        assert.equal((await stores.agentRunStore.readEvents(session.id, 'run-1')).length, 0);
        assert.equal(
          (await stores.agentRunStore.readRootTurnAdmission(session.id, 'turn-1'))?.runId,
          'run-1',
        );
        assert.equal(
          (await stores.runtimeEventStore.readRuntimeEvents(session.id, 'run-1')).length,
          0,
        );
        assert.equal(
          (await stores.runtimeEventStore.readImmutableRuntimeEvents(session.id, 'run-1')).length,
          0,
        );
        assert.equal(
          (await stores.runtimeEventStore.readSessionRuntimeEvents(session.id)).length,
          0,
        );
      } finally {
        await reader.close();
      }

      assert.equal(await readFile(sessionPath, 'utf8'), before);
      assert.equal((await rawSessionStore.readHeaderSnapshot(session.id)).connectionLocked, false);
    });
  });

  test('repairs only an unterminated JSONL tail before the next durable append', async () => {
    await withRoot(async ({ root }) => {
      const capability = await resolveStorageRoot({
        path: root,
        kind: 'interactive',
      });
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      if (!owner) return;
      try {
        const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
        const session = await stores.sessionStore.create(sessionInput(root));
        const header = runHeader(session.id, 'run-1');
        await stores.agentRunStore.createRun(header);

        const sessionPath = join(root, 'sessions', session.id, 'session.jsonl');
        await appendFile(sessionPath, '{"type":"user"', 'utf8');
        await stores.sessionStore.appendMessage(session.id, {
          type: 'user',
          id: 'message-1',
          turnId: 'turn-1',
          ts: 11,
          text: 'hello',
        });
        assert.deepEqual(
          (await stores.sessionStore.readMessages(session.id)).map((message) => message.id),
          ['message-1'],
        );

        const eventsPath = join(root, 'sessions', session.id, 'runs', header.runId, 'events.jsonl');
        await writeFile(
          eventsPath,
          JSON.stringify(runEvent(session.id, header.runId, 'event-1', 12)),
          'utf8',
        );
        await stores.agentRunStore.appendEvent(
          session.id,
          header.runId,
          runEvent(session.id, header.runId, 'event-2', 13),
        );
        await appendFile(eventsPath, '{"type":"run_started"', 'utf8');
        await stores.agentRunStore.appendEvent(
          session.id,
          header.runId,
          runEvent(session.id, header.runId, 'event-3', 14),
        );
        assert.deepEqual(
          (await stores.agentRunStore.readEvents(session.id, header.runId)).map(
            (event) => event.id,
          ),
          ['event-1', 'event-2', 'event-3'],
        );

        const runtimeEventsPath = join(
          root,
          'sessions',
          session.id,
          'runs',
          header.runId,
          'runtime-events.jsonl',
        );
        await writeFile(runtimeEventsPath, '{"id":"truncated"', 'utf8');
        await stores.runtimeEventStore.appendRuntimeEvent(
          session.id,
          header.runId,
          runtimeEvent(session.id, header.runId, 'runtime-1', 15),
        );
        assert.deepEqual(
          (await stores.runtimeEventStore.readImmutableRuntimeEvents(session.id, header.runId)).map(
            (event) => event.id,
          ),
          ['runtime-1'],
        );

        for (const path of [sessionPath, eventsPath, runtimeEventsPath]) {
          const lines = (await readFile(path, 'utf8')).split('\n').filter(Boolean);
          for (const line of lines) assert.doesNotThrow(() => JSON.parse(line));
        }
      } finally {
        await owner.close();
      }
    });
  });

  test('refuses to truncate a syntactically invalid JSONL tail', async () => {
    await withRoot(async ({ root }) => {
      const capability = await resolveStorageRoot({
        path: root,
        kind: 'interactive',
      });
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      if (!owner) return;
      try {
        const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
        const session = await stores.sessionStore.create(sessionInput(root));
        const sessionPath = join(root, 'sessions', session.id, 'session.jsonl');
        await appendFile(sessionPath, '{"type":]', 'utf8');
        const before = await readFile(sessionPath, 'utf8');

        await assert.rejects(
          () =>
            stores.sessionStore.appendMessage(session.id, {
              type: 'user',
              id: 'message-1',
              turnId: 'turn-1',
              ts: 1,
              text: 'must not overwrite corruption',
            }),
          /Cannot append after an invalid JSONL tail record/,
        );
        assert.equal(await readFile(sessionPath, 'utf8'), before);
      } finally {
        await owner.close();
      }
    });
  });

  test('rejects stale writers before a replacement root is mutated', async () => {
    await withRoot(async ({ base, root }) => {
      const capability = await resolveStorageRoot({
        path: root,
        kind: 'interactive',
      });
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      if (!owner) return;
      const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
      const moved = join(base, 'moved-root');
      await rename(root, moved);
      await mkdir(root);
      try {
        await assert.rejects(
          () => stores.sessionStore.create(sessionInput(root)),
          (error: unknown) =>
            error instanceof StorageRootAuthorityError && error.code === 'root_identity_changed',
        );
        await assert.rejects(() => stat(join(root, 'sessions')), {
          code: 'ENOENT',
        });
      } finally {
        await owner.close();
      }
    });
  });

  test('strict recovery removes recognizable uncommitted exclusive-create staging', async () => {
    await withRoot(async ({ root }) => {
      const capability = await resolveStorageRoot({
        path: root,
        kind: 'interactive',
      });
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      if (!owner) return;
      try {
        const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
        const session = await stores.sessionStore.create(sessionInput(root));
        await stores.agentRunStore.admitRootTurn({
          sessionId: session.id,
          turnId: 'turn-1',
          proposedRunId: 'run-1',
          proposedUserMessageId: 'message-1',
          previousRootTurnId: null,
          normalizedInput: { text: 'hello' },
          sourceMessages: [],
          admittedAt: 10,
        });

        const suffix = '123.00000000-0000-4000-8000-000000000000.tmp';
        const admissionsRoot = join(root, 'sessions', session.id, 'turn-admissions');
        const admissionTemp = join(admissionsRoot, `turn-1.json.${suffix}`);
        await writeFile(admissionTemp, 'staging', 'utf8');
        const runDirectory = join(root, 'sessions', session.id, 'runs', 'run-staging');
        await mkdir(runDirectory, { recursive: true });
        await writeFile(join(runDirectory, `run.json.${suffix}`), 'staging', 'utf8');

        const admissions = await stores.agentRunStore.listRootTurnAdmissionsForRecovery(session.id);
        assert.deepEqual(
          admissions.map((admission) => admission.turnId),
          ['turn-1'],
        );
        assert.deepEqual(await stores.agentRunStore.listSessionRunsForRecovery(session.id), []);
        await assert.rejects(() => stat(admissionTemp), { code: 'ENOENT' });
        await assert.rejects(() => stat(runDirectory), { code: 'ENOENT' });
      } finally {
        await owner.close();
      }
    });
  });

  test('strict recovery enumeration fails on malformed durable entities', async () => {
    await withRoot(async ({ root }) => {
      const capability = await resolveStorageRoot({
        path: root,
        kind: 'interactive',
      });
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      if (!owner) return;
      try {
        const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
        const session = await stores.sessionStore.create(sessionInput(root));
        await stores.agentRunStore.admitRootTurn({
          sessionId: session.id,
          turnId: 'turn-1',
          proposedRunId: 'run-1',
          proposedUserMessageId: 'message-1',
          previousRootTurnId: null,
          normalizedInput: { text: 'hello' },
          sourceMessages: [],
          admittedAt: 10,
        });
        const admissionPath = join(root, 'sessions', session.id, 'turn-admissions', 'turn-1.json');
        const admission = JSON.parse(await readFile(admissionPath, 'utf8')) as Record<
          string,
          unknown
        >;
        await writeFile(admissionPath, `${JSON.stringify({ ...admission, schemaVersion: 3 })}\n`);
        await assert.rejects(
          () => stores.agentRunStore.readRootTurnAdmission(session.id, 'turn-1'),
          /malformed fields/,
        );
        await writeFile(admissionPath, '{"turnId":"wrong"}\n', 'utf8');
        await assert.rejects(() =>
          stores.agentRunStore.listRootTurnAdmissionsForRecovery(session.id),
        );

        await stores.agentRunStore.createRun(runHeader(session.id, 'run-1'));
        await writeFile(
          join(root, 'sessions', session.id, 'runs', 'run-1', 'run.json'),
          '{"runId":"wrong"}\n',
          'utf8',
        );
        await assert.rejects(() => stores.agentRunStore.listSessionRunsForRecovery(session.id));

        await writeFile(
          join(root, 'sessions', session.id, 'session.jsonl'),
          '{"id":"wrong"}\n',
          'utf8',
        );
        await assert.rejects(() => stores.sessionStore.listForRecovery());
      } finally {
        await owner.close();
      }
    });
  });
});

async function withRoot(
  run: (paths: { base: string; root: string }) => Promise<void>,
): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'maka-execution-stores-'));
  const root = join(base, 'root');
  try {
    await run({ base, root });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

function sessionInput(root: string) {
  return {
    cwd: root,
    backend: 'fake' as const,
    llmConnectionSlug: 'fake',
    model: 'fake-model',
    permissionMode: 'ask' as const,
  };
}

function runHeader(sessionId: string, runId: string): AgentRunHeader {
  return {
    runId,
    invocationId: runId,
    sessionId,
    turnId: 'turn-1',
    status: 'created',
    backendKind: 'fake',
    llmConnectionSlug: 'fake',
    modelId: 'fake-model',
    cwd: '/tmp/cwd',
    permissionMode: 'ask',
    createdAt: 10,
    updatedAt: 10,
  };
}

function runEvent(sessionId: string, runId: string, id: string, ts: number): AgentRunEvent {
  return {
    type: 'run_started',
    id,
    runId,
    sessionId,
    turnId: 'turn-1',
    ts,
  };
}

function runtimeEvent(sessionId: string, runId: string, id: string, ts: number): RuntimeEvent {
  return {
    id,
    invocationId: runId,
    runId,
    sessionId,
    turnId: 'turn-1',
    ts,
    partial: false,
    role: 'user',
    author: 'user',
    content: { kind: 'text', text: 'hello' },
  };
}
