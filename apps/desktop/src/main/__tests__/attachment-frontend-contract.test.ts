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

  it('renderer attachment import preserves clipboard blobs that have no filesystem path', async () => {
    const preload = await readRepo('apps/desktop/src/preload/preload.ts');
    const globals = await readRepo('apps/desktop/src/global.d.ts');
    const appShell = await readRepo('apps/desktop/src/renderer/app-shell.tsx');
    const chatActions = await readRepo('apps/desktop/src/renderer/app-shell-chat-actions.ts');

    assert.match(
      preload,
      /async ingestFiles\(sessionId: string, files: File\[\]\): Promise<AttachmentRef\[\]>/,
      'preload must expose an async file-ingest helper that can read File bytes when Electron has no path',
    );
    assert.match(
      preload,
      /webUtils\.getPathForFile\(file\)[\s\S]*file\.arrayBuffer\(\)/,
      'preload ingestFiles must preserve path-backed files and fall back to File.arrayBuffer() for pasted blobs',
    );
    assert.match(
      globals,
      /ingestFiles\(sessionId: string, files: File\[\]\): Promise<import\('@maka\/core'\)\.AttachmentRef\[\]>/,
      'renderer global types must expose the blob-capable attachment API',
    );
    assert.doesNotMatch(
      appShell,
      /window\.maka\.attachments\.ingestFiles/,
      'app-shell must not ingest dropped/pasted files at pick time — ingestion is deferred to send so no empty session is created',
    );
    assert.match(
      chatActions,
      /window\.maka\.attachments\.ingestFiles/,
      'composer drop/paste blobs must still reach the blob-capable ingest API, now at send time via ingestAll',
    );
    assert.doesNotMatch(
      appShell,
      /pathsForFiles\(files\)/,
      'composer drop/paste must not silently drop pasted image blobs with empty filesystem paths',
    );
  });

  it('new-chat composer can start attachment import before a session exists', async () => {
    const preload = await readRepo('apps/desktop/src/preload/preload.ts');
    const globals = await readRepo('apps/desktop/src/global.d.ts');
    const appShell = await readRepo('apps/desktop/src/renderer/app-shell.tsx');
    const chatActions = await readRepo('apps/desktop/src/renderer/app-shell-chat-actions.ts');

    assert.match(
      preload,
      /pickFiles\(\): Promise<[\s\S]*files: \{ path: string; mimeType\?: string; size: number \}\[\]/,
      'preload must expose a pick-only API so new chat can avoid creating an empty session when the user cancels',
    );
    assert.match(
      globals,
      /pickFiles\(\): Promise<[\s\S]*files: \{ path: string; mimeType\?: string; size: number \}\[\]/,
      'renderer global types must expose the pick-only attachment API',
    );
    // Cleanest: attachments stage in the renderer and ingest at send time.
    // Pre-send session creation was removed because it renamed the session
    // to a placeholder ("新建对话") and swapped the composer draft key,
    // losing in-progress text on drag/paste.
    assert.doesNotMatch(
      appShell,
      /ensureAttachmentSession/,
      'attachments must not create a session before send — that swapped the draft key and left placeholder session names',
    );
    assert.match(
      chatActions,
      /async function ingestAll[\s\S]*attachments\.ingestPaths[\s\S]*attachments\.ingestFiles/,
      'pending attachments must be ingested at send time, after the session is known',
    );
    assert.match(
      appShell,
      /onPickAttachments=\{pickAttachments\}/,
      'Composer must receive the + attachment handler on the new-chat surface too',
    );
    assert.match(
      appShell,
      /onAttachFilePaths=\{attachFilePaths\}/,
      'Composer must receive drop/paste attachment handlers on the new-chat surface too',
    );
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
