import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { McpConfigFile, McpServerStatus } from '@maka/core/mcp';
import { registerMcpIpcMain } from '../mcp-ipc-main.js';

test('MCP IPC reconciles config before invalidating idle backends and emitting status', async () => {
  const handlers = new Map<string, (...args: any[]) => Promise<any>>();
  let config: McpConfigFile = { version: 1, mcpServers: {} };
  const calls: string[] = [];
  const connected: McpServerStatus = {
    serverId: 'fixture', state: 'connected', transport: 'stdio', toolCount: 1,
    tools: [{ serverId: 'fixture', name: 'echo', inputSchema: { type: 'object' } }], updatedAt: 1,
  };
  registerMcpIpcMain({
    ipcMain: { handle(channel, handler) { handlers.set(channel, handler as (...args: any[]) => Promise<any>); } },
    store: {
      get: async () => config,
      set: async (next) => { calls.push('store'); config = next; return next; },
      upsert: async (serverId, server) => {
        calls.push('store');
        config = { version: 1, mcpServers: { ...config.mcpServers, [serverId]: server } };
        return config;
      },
      remove: async (serverId) => {
        const { [serverId]: _removed, ...mcpServers } = config.mcpServers;
        config = { version: 1, mcpServers };
        return config;
      },
    },
    manager: {
      sync: async () => { calls.push('sync'); },
      statuses: () => [connected],
      reconnect: async () => connected,
      test: async () => ({ ok: true, status: connected, latencyMs: 1 }),
    },
    ensureReady: async () => { calls.push('ready'); },
    refreshIdleBackends: async () => { calls.push('refresh'); },
    emitChanged: () => { calls.push('emit'); },
  });

  const upsert = handlers.get('mcp:upsert');
  assert.ok(upsert);
  const result = await upsert({}, 'fixture', { command: 'node' });
  assert.deepEqual(result.mcpServers.fixture, { command: 'node' });
  assert.deepEqual(calls, ['store', 'sync', 'refresh', 'emit']);

  calls.length = 0;
  const setConfig = handlers.get('mcp:setConfig');
  assert.ok(setConfig);
  const imported = await setConfig({}, {
    version: 1,
    mcpServers: { remote: { url: 'https://example.com/mcp', enabled: false } },
  });
  assert.deepEqual(imported.mcpServers, {
    remote: { url: 'https://example.com/mcp', enabled: false },
  });
  assert.deepEqual(calls, ['store', 'sync', 'refresh', 'emit']);

  calls.length = 0;
  const testHandler = handlers.get('mcp:test');
  assert.ok(testHandler);
  assert.equal((await testHandler({}, 'fixture')).ok, true);
  assert.deepEqual(calls, ['ready', 'emit']);
});
