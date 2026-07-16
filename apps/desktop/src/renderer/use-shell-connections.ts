import { useState } from 'react';
import type { ConnectionEvent, LlmConnection } from '@maka/core';
import { generalizedErrorMessageChinese } from '@maka/core';

type ToastApi = {
  error(title: string, description?: string): void;
};

function connectionsEqual(a: LlmConnection[], b: LlmConnection[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].slug !== b[i].slug || a[i].updatedAt !== b[i].updatedAt) return false;
  }
  return true;
}

/**
 * Owns the LLM-connection cluster: the connection list, the default
 * connection slug, and the fire-and-forget refresh glue. `setConnections`
 * and `setDefaultConnection` are returned so the onboarding-snapshot seed
 * (which lives in AppShell so it can also seed sessions) can prime them
 * before the first `connections:list` round-trip. `refreshConnections`
 * dedups via `connectionsEqual` so an unchanged list never churns the
 * dozen derived model/thinking selectors that read `connections`.
 *
 * `connectionsRevision` bumps on EVERY successful refresh — even when
 * `connectionsEqual` keeps the list identity. A `connection_list_changed`
 * event means *something* changed, but not every change bumps `updatedAt`
 * (an external credentials.json edit only changes the credential store),
 * so the list identity alone cannot tell cheap derived probes (the
 * session-health-notice secret probe, #1038 review) that they must
 * re-run. The revision can.
 */
export function useShellConnections(options: { toastApi: ToastApi }): {
  connections: LlmConnection[];
  connectionsRevision: number;
  defaultConnection: string | null;
  setConnections: (updater: LlmConnection[] | ((prev: LlmConnection[]) => LlmConnection[])) => void;
  setDefaultConnection: (next: string | null) => void;
  refreshConnections: () => Promise<void>;
  handleConnectionEvent: (event: ConnectionEvent) => void;
} {
  const { toastApi } = options;
  const [connections, setConnections] = useState<LlmConnection[]>([]);
  const [connectionsRevision, setConnectionsRevision] = useState(0);
  const [defaultConnection, setDefaultConnection] = useState<string | null>(null);

  async function refreshConnections() {
    try {
      const [next, nextDefault] = await Promise.all([
        window.maka.connections.list(),
        window.maka.connections.getDefault(),
      ]);
      setConnections((prev) => connectionsEqual(prev, next) ? prev : next);
      setDefaultConnection(nextDefault);
      setConnectionsRevision((revision) => revision + 1);
    } catch (error) {
      toastApi.error('刷新模型连接失败', generalizedErrorMessageChinese(error, '模型连接暂时无法刷新，请稍后重试。'));
    }
  }

  function handleConnectionEvent(event: ConnectionEvent) {
    switch (event.type) {
      case 'connection_list_changed':
        void refreshConnections();
        break;
    }
  }

  return {
    connections,
    connectionsRevision,
    defaultConnection,
    setConnections,
    setDefaultConnection,
    refreshConnections,
    handleConnectionEvent,
  };
}
