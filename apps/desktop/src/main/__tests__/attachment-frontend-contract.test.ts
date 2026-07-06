import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AttachmentRef, SessionSummary, StoredMessage } from '@maka/core';
import { ChatView } from '@maka/ui';

const REPO_ROOT = process.cwd().endsWith('apps/desktop')
  ? resolve(process.cwd(), '..', '..')
  : process.cwd();

async function readRepo(relativePath: string): Promise<string> {
  return readFile(resolve(REPO_ROOT, relativePath), 'utf8');
}

describe('attachment frontend contract', () => {
  it('global file-drop navigation guard lets explicit renderer import targets handle drag/drop', async () => {
    const mainWindow = await readRepo('apps/desktop/src/main/main-window.ts');
    const composer = await readRepo('packages/ui/src/composer.tsx');
    const onboarding = await readRepo('apps/desktop/src/renderer/OnboardingHero.tsx');

    assert.match(
      mainWindow,
      /closest\('\[data-maka-file-drop-target="true"\]'\)/,
      'BrowserWindow capture guard must skip declared file-drop targets so React drop handlers can ingest files',
    );
    assert.match(
      composer,
      /data-maka-file-drop-target=\{canAcceptDroppedFiles\(\) \? 'true' : undefined\}/,
      'Composer must declare itself as a file-drop target only while attachment import is available',
    );
    assert.match(
      onboarding,
      /data-maka-file-drop-target=\{canAcceptDroppedTextFiles\(\) \? 'true' : undefined\}/,
      'Onboarding quick chat must keep its text-file drop target compatible with the same guard',
    );
  });

  it('dragged/pasted blobs are sent as bytes and never round-trip a renderer path', async () => {
    const preload = await readRepo('apps/desktop/src/preload/preload.ts');
    const globals = await readRepo('apps/desktop/src/global.d.ts');
    const chatActions = await readRepo('apps/desktop/src/renderer/app-shell-chat-actions.ts');

    // No webUtils.getPathForFile: a renderer-supplied path is untrustworthy.
    assert.doesNotMatch(preload, /webUtils/);
    // preload encodes File blobs to bytes via the shared encoder before IPC.
    assert.match(preload, /encodeIngestItems/);
    // sessions.send carries attachmentItems (File or approvalId), not pre-ingested refs.
    assert.match(globals, /attachmentItems\?: RendererIngestInput\[\]/);
    // renderer maps pending attachments to ingest items at send time.
    assert.match(chatActions, /toIngestItems\(pending\)/);
    assert.match(chatActions, /sessions\.send[\s\S]*attachmentItems/);
  });

  it('new-chat composer stages attachments via opaque approval tokens and ingests at send time', async () => {
    const preload = await readRepo('apps/desktop/src/preload/preload.ts');
    const globals = await readRepo('apps/desktop/src/global.d.ts');
    const appShell = await readRepo('apps/desktop/src/renderer/app-shell.tsx');
    const chatActions = await readRepo('apps/desktop/src/renderer/app-shell-chat-actions.ts');

    // pickFiles returns opaque approval tokens, never a path.
    assert.match(preload, /pickFiles\(\): Promise<[\s\S]*files: \{ approvalId: string; name: string/);
    assert.match(globals, /pickFiles\(\): Promise<[\s\S]*files: \{ approvalId: string; name: string/);
    // No pre-send session creation.
    assert.doesNotMatch(appShell, /ensureAttachmentSession/);
    // pending attachments are carried as items in sessions.send, ingested main-side at send time.
    assert.match(chatActions, /toIngestItems\(pending\)/);
    assert.match(chatActions, /sessions\.send[\s\S]*attachmentItems/);
    assert.match(appShell, /onPickAttachments=\{pickAttachments\}/);
    assert.match(appShell, /onAttachFilePaths=\{attachFilePaths\}/);
  });

  it('generated-files pane excludes user-uploaded attachments', async () => {
    const artifactPane = await readRepo('apps/desktop/src/renderer/artifact-pane.tsx');

    assert.match(
      artifactPane,
      /record\.source !== 'user_upload'/,
      'ArtifactPane is labeled generated files and must not list user-uploaded attachment snapshots',
    );
  });

  it('passes selected model vision capability to the runtime attachment renderer', async () => {
    const main = await readRepo('apps/desktop/src/main/main.ts');

    assert.match(
      main,
      /function modelSupportsVision\(connection: LlmConnection, model: string\): boolean/,
      'main must derive image-input support from the selected model before wiring AiSdkBackend',
    );
    assert.match(
      main,
      /resolveModelVisionSupport\(connection\.providerType, connection\.models, model\)/,
      'vision support must consult stored capabilities, then fall back to in-repo metadata for bare-id models (provider /models responses do not return image capability)',
    );
    assert.match(
      main,
      /const supportsVision = modelSupportsVision\(connection, model\)/,
      'main must evaluate the selected model vision capability in the ai-sdk backend path',
    );
    assert.match(
      main,
      /\bsupportsVision,\s*\n/,
      'AiSdkBackend must always receive the resolved vision support (true = send image parts, false = fallback notice)',
    );
  });

  it('renders user image attachments inside the chat turn stream', () => {
    const attachment: AttachmentRef = {
      kind: 'image',
      name: 'clipboard.png',
      mimeType: 'image/png',
      bytes: 4,
      ref: { kind: 'session_file', sessionId: 's1', relativePath: 'artifact-1' },
    };
    const messages: StoredMessage[] = [
      { type: 'user', id: 'u1', turnId: 't1', ts: 1, text: '看这张图', attachments: [attachment] },
    ];
    const activeSession: SessionSummary = {
      id: 's1',
      name: 'Attachment check',
      isFlagged: false,
      isArchived: false,
      labels: [],
      hasUnread: false,
      status: 'active',
      backend: 'ai-sdk',
      llmConnectionSlug: 'fixture',
      model: 'fixture-model',
      permissionMode: 'ask',
    };

    const markup = renderToStaticMarkup(createElement(ChatView, {
      messages,
      streamingText: '',
      tools: [],
      activeSession,
      mode: 'sessions',
      onNew: () => {},
    } satisfies Parameters<typeof ChatView>[0]));

    assert.match(markup, /maka-user-attachments/);
    assert.match(markup, /maka-user-attachment-thumb-pending/);
  });
});
