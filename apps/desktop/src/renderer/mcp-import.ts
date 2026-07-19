import type { McpConfigFile, McpServerConfig } from '@maka/core/mcp';

export function parseMcpImport(source: string): McpConfigFile {
  const value: unknown = JSON.parse(source);
  if (!isRecord(value)) throw new Error('MCP JSON 必须是 object');

  if ('mcpServers' in value || 'version' in value) {
    if ('version' in value && value.version !== 1) {
      throw new Error(`不支持 MCP 配置版本 ${String(value.version)}，当前仅支持 version 1`);
    }
    if (!isRecord(value.mcpServers)) throw new Error('mcpServers 必须是 object');
    return { version: 1, mcpServers: value.mcpServers as Record<string, McpServerConfig> };
  }

  return { version: 1, mcpServers: value as Record<string, McpServerConfig> };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
