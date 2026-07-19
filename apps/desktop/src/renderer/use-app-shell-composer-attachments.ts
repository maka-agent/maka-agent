import { useState } from 'react';
import { attachmentKindFromMimeType, guessMimeFromName } from '@maka/core';
import { useUiLocale } from '@maka/ui';
import type { PendingAttachment } from './app-shell-chat-actions';
import { getDesktopConversationCopy } from './locales/conversation-copy.js';
import { localizedShellErrorMessage } from './locales/shell-copy.js';
import {
  appendPending,
  removePending,
  removePendingItems,
  selectPending,
  type PendingByKey,
} from './app-shell-pending-attachments';

type ToastApi = {
  error(title: string, description?: string): void;
};

function approvalToPending(file: {
  approvalId: string;
  name: string;
  mimeType?: string;
  size: number;
}): PendingAttachment {
  const mimeType = file.mimeType ?? guessMimeFromName(file.name);
  return {
    displayName: file.name,
    mimeType,
    kind: attachmentKindFromMimeType(mimeType, file.name),
    size: file.size,
    source: { type: 'approval', approvalId: file.approvalId, name: file.name },
  };
}

function fileToPending(file: File): PendingAttachment {
  const mimeType = file.type || undefined;
  return {
    displayName: file.name,
    mimeType,
    kind: attachmentKindFromMimeType(mimeType ?? '', file.name),
    size: file.size,
    source: { type: 'file', file },
  };
}

export function useAppShellComposerAttachments(options: {
  draftKey: string;
  toastApi: ToastApi;
}) {
  const uiLocale = useUiLocale();
  const copy = getDesktopConversationCopy(uiLocale).actions;
  const [pendingByKey, setPendingByKey] = useState<PendingByKey<PendingAttachment>>({});
  const pendingAttachments = selectPending(pendingByKey, options.draftKey);

  async function pickAttachments(): Promise<void> {
    const ownerKey = options.draftKey;
    try {
      const result = await window.maka.attachments.pickFiles();
      if (!result.ok) return;
      setPendingByKey((map) => appendPending(map, ownerKey, result.files.map(approvalToPending)));
    } catch (error) {
      options.toastApi.error(
        copy.attachmentFailedTitle,
        localizedShellErrorMessage(error, copy.tryAgain, uiLocale),
      );
    }
  }

  async function attachFilePaths(files: File[]): Promise<void> {
    if (files.length === 0) return;
    const ownerKey = options.draftKey;
    setPendingByKey((map) => appendPending(map, ownerKey, files.map(fileToPending)));
  }

  function removeAttachment(index: number): void {
    const ownerKey = options.draftKey;
    setPendingByKey((map) => removePending(map, ownerKey, index));
  }

  function clearSubmittedAttachments(submitted: readonly PendingAttachment[]): void {
    const ownerKey = options.draftKey;
    setPendingByKey((map) => removePendingItems(map, ownerKey, submitted));
  }

  return {
    pendingAttachments,
    pickAttachments,
    attachFilePaths,
    removeAttachment,
    clearSubmittedAttachments,
  };
}
