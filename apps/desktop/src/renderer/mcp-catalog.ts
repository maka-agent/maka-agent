import type { McpServerConfig } from '@maka/core/mcp';

export type McpCatalogEntry = {
  id: string;
  name: string;
  description: string;
  category: string;
  mark: string;
  aliases?: string[];
  config: McpServerConfig;
  setupRequired?: boolean;
  setupLabel?: string;
  platform?: 'darwin';
};

export const MCP_CATALOG: McpCatalogEntry[] = [
  {
    id: 'dingtalk',
    name: '钉钉',
    description: '管理联系人、日历、待办与协作信息。',
    category: '沟通协作',
    mark: '钉',
    aliases: ['DingTalk'],
    setupRequired: true,
    setupLabel: '需要 Client ID 与 Client Secret',
    config: {
      enabled: false,
      command: 'npx',
      args: ['-y', 'dingtalk-mcp@1.1.21'],
      env: {
        DINGTALK_Client_ID: '',
        DINGTALK_Client_Secret: '',
        ACTIVE_PROFILES: 'dingtalk-contacts,dingtalk-calendar',
      },
    },
  },
  {
    id: 'feishu',
    name: '飞书',
    description: '访问飞书文档、日历、消息与 OpenAPI。',
    category: '沟通协作',
    mark: '飞',
    aliases: ['Feishu', 'Lark'],
    setupRequired: true,
    setupLabel: '需要 App ID 与 App Secret',
    config: {
      enabled: false,
      command: 'npx',
      args: ['-y', '@larksuiteoapi/lark-mcp@0.5.1', 'mcp'],
      env: { APP_ID: '', APP_SECRET: '' },
    },
  },
  {
    id: 'slack',
    name: 'Slack',
    description: '发送消息、管理频道并与 Slack workspace 协作。',
    category: '沟通协作',
    mark: 'S',
    setupRequired: true,
    setupLabel: '需要 Bot Token 与 Team ID',
    config: {
      enabled: false,
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-slack@2025.4.25'],
      env: { SLACK_BOT_TOKEN: '', SLACK_TEAM_ID: '', SLACK_CHANNEL_IDS: '' },
    },
  },
  {
    id: 'line',
    name: 'LINE',
    description: '通过 LINE Bot Messaging API 发送和管理消息。',
    category: '沟通协作',
    mark: 'LINE',
    setupRequired: true,
    setupLabel: '需要 Channel Access Token',
    config: {
      enabled: false,
      command: 'npx',
      args: ['-y', '@line/line-bot-mcp-server@0.5.0'],
      env: { NPM_CONFIG_IGNORE_SCRIPTS: 'true', CHANNEL_ACCESS_TOKEN: '', DESTINATION_USER_ID: '' },
    },
  },
  {
    id: 'notion',
    name: 'Notion',
    description: '搜索、读取和更新 Notion workspace。',
    category: '知识与文档',
    mark: 'N',
    setupRequired: true,
    setupLabel: '需要登录授权',
    config: { enabled: false, url: 'https://mcp.notion.com/mcp', transport: 'streamable-http' },
  },
  {
    id: 'macos-apps',
    name: 'macOS 应用',
    description: '连接系统日历与提醒事项，并使用原生权限模型。',
    category: '系统与效率',
    mark: '⌘',
    aliases: ['Apple', 'Calendar', 'Reminders'],
    platform: 'darwin',
    config: { enabled: true, command: 'npx', args: ['-y', 'mcp-server-apple-events@1.4.0'] },
  },
  {
    id: 'google-calendar',
    name: 'Google 日历',
    description: '管理日程、创建会议并查询空闲时间。',
    category: '系统与效率',
    mark: '31',
    aliases: ['Google Calendar'],
    setupRequired: true,
    setupLabel: '需要 OAuth credentials 文件',
    config: {
      enabled: false,
      command: 'npx',
      args: ['-y', '@cocal/google-calendar-mcp@2.6.2'],
      env: { GOOGLE_OAUTH_CREDENTIALS: '' },
    },
  },
  {
    id: 'figma',
    name: 'Figma',
    description: '读取设计文件、组件与开发交付信息。',
    category: '设计与开发',
    mark: 'F',
    setupRequired: true,
    setupLabel: '需要 Personal Access Token',
    config: {
      enabled: false,
      command: 'npx',
      args: ['-y', 'figma-developer-mcp@0.13.2', '--stdio'],
      env: { FIGMA_API_KEY: '' },
    },
  },
  {
    id: 'vercel',
    name: 'Vercel',
    description: '检查项目、部署状态、日志与平台文档。',
    category: '设计与开发',
    mark: '▲',
    setupRequired: true,
    setupLabel: '需要登录授权',
    config: { enabled: false, url: 'https://mcp.vercel.com', transport: 'streamable-http' },
  },
  {
    id: 'supabase',
    name: 'Supabase',
    description: '管理数据库、项目配置、迁移与 Edge Functions。',
    category: '设计与开发',
    mark: 'S',
    setupRequired: true,
    setupLabel: '需要登录授权',
    config: { enabled: false, url: 'https://mcp.supabase.com/mcp', transport: 'streamable-http' },
  },
  {
    id: 'filesystem',
    name: '本地文件',
    description: '在指定目录中安全地读取、写入和管理文件。',
    category: '文件与知识',
    mark: 'FS',
    setupRequired: true,
    setupLabel: '需要选择允许访问的目录',
    config: {
      enabled: false,
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/path/to/folder'],
    },
  },
  {
    id: 'memory',
    name: '持久记忆',
    description: '用结构化知识图谱记住实体、关系和重要事实。',
    category: '文件与知识',
    mark: 'M',
    config: { enabled: true, command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] },
  },
  {
    id: 'playwright',
    name: '浏览器自动化',
    description: '让 Maka 通过 Playwright 读取和操作真实网页。',
    category: '设计与开发',
    mark: 'PW',
    config: { enabled: true, command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
  },
  {
    id: 'sequential-thinking',
    name: '序列思考',
    description: '为复杂问题提供可修正、可验证的结构化推理。',
    category: '推理与规划',
    mark: 'ST',
    config: {
      enabled: true,
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    },
  },
];

export function catalogEntryMatches(entry: McpCatalogEntry, normalizedQuery: string): boolean {
  if (!normalizedQuery) return true;
  return [entry.id, entry.name, entry.description, entry.category, ...(entry.aliases ?? [])]
    .some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
}
