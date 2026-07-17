import { useState } from 'react';
import { generalizedErrorMessageChinese } from '@maka/core';

type ToastApi = {
  error(title: string, description?: string): void;
};

/**
 * Owns the chat-header memory-visibility pill (issue #1043): the `memoryActive`
 * flag surfaced when xuan's MEMORY.md is injected into the agent's system
 * prompt, plus the fire-and-forget `refreshMemoryActive` that re-reads
 * `window.maka.memory.getState()`.
 *
 * Refresh failures must stay visible (toast) and must preserve the last known
 * pill state - never silently flip to false. The mount recompute is driven by
 * `useAppShellBootstrapSubscriptions`; the Settings-close recompute is driven
 * by `closeSettings`. Both call the returned `refreshMemoryActive`.
 */
export function useShellMemoryPill({ toastApi }: { toastApi: ToastApi }): {
  memoryActive: boolean;
  refreshMemoryActive: (failureTitle?: string) => Promise<void>;
} {
  const [memoryActive, setMemoryActive] = useState(false);
  async function refreshMemoryActive(failureTitle = '刷新本地记忆状态失败') {
    try {
      const next = await window.maka.memory.getState();
      setMemoryActive(next.agentReadEnabled && next.status === 'ok' && next.content.trim().length > 0);
    } catch (error) {
      toastApi.error(failureTitle, generalizedErrorMessageChinese(error, '本地记忆状态暂时无法刷新，请稍后重试。'));
    }
  }
  return { memoryActive, refreshMemoryActive };
}
