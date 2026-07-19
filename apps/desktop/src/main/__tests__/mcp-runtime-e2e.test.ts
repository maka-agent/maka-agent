import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { McpClientManager } from '@maka/mcp';
import { buildMcpTools } from '@maka/runtime/mcp-tools';

const fixturePath = fileURLToPath(new URL('../../../../../packages/mcp/dist/__fixtures__/stdio-server.js', import.meta.url));

test('MCP config connects through stdio and executes through MakaTool', async () => {
  const manager = new McpClientManager({
    timeouts: { stdioConnectMs: 5_000, listToolsMs: 5_000, callToolMs: 5_000 },
  });
  try {
    await manager.sync({
      version: 1,
      mcpServers: {
        fixture: { command: process.execPath, args: [fixturePath] },
      },
    });
    const tools = buildMcpTools(manager);
    const echo = tools.find((tool) => tool.name === 'mcp__fixture__echo');
    assert.ok(echo);
    assert.equal(echo.categoryHint, 'network_send');
    const result = await echo.impl({ value: 'runtime-e2e' }, {
      sessionId: 'session', turnId: 'turn', cwd: process.cwd(), toolCallId: 'call',
      abortSignal: new AbortController().signal, emitOutput() {},
    });
    assert.deepEqual(result, {
      content: [{ type: 'text', text: 'runtime-e2e' }],
      structuredContent: { echoed: 'runtime-e2e' },
    });
  } finally {
    await manager.close();
  }
});
