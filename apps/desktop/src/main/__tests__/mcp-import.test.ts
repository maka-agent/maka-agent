import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMcpImport } from '../../renderer/mcp-import.js';

test('MCP import accepts a version 1 config or a direct server map', () => {
  assert.deepEqual(parseMcpImport('{"version":1,"mcpServers":{"local":{"command":"node"}}}'), {
    version: 1,
    mcpServers: { local: { command: 'node' } },
  });
  assert.deepEqual(parseMcpImport('{"remote":{"url":"https://example.com/mcp"}}'), {
    version: 1,
    mcpServers: { remote: { url: 'https://example.com/mcp' } },
  });
});

test('MCP import rejects unsupported versions and malformed full configs', () => {
  assert.throws(
    () => parseMcpImport('{"version":2,"mcpServers":{}}'),
    /当前仅支持 version 1/u,
  );
  assert.throws(() => parseMcpImport('{"version":1}'), /mcpServers 必须是 object/u);
});
