import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  AppSettings,
  BotProvider,
  SettingsTestResult,
  UpdateAppSettingsInput,
  UsageRange,
  UsageStats,
} from '@maka/core';
import {
  createDefaultSettings,
  mergeSettings,
  normalizeSettings,
} from '@maka/core/settings';
import type {
  SessionHeader,
  StoredMessage,
  TokenUsageMessage,
  ToolCallMessage,
  ToolResultMessage,
} from '@maka/core/session';

export interface SettingsStore {
  get(): Promise<AppSettings>;
  update(patch: UpdateAppSettingsInput): Promise<AppSettings>;
  testNetworkProxy(): Promise<SettingsTestResult>;
  testBotChannel(provider: BotProvider): Promise<SettingsTestResult>;
  usageStats(range?: UsageRange): Promise<UsageStats>;
}

export function createSettingsStore(workspaceRoot: string): SettingsStore {
  return new FileSettingsStore(workspaceRoot);
}

class FileSettingsStore implements SettingsStore {
  private readonly settingsPath: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly workspaceRoot: string) {
    this.settingsPath = join(workspaceRoot, 'settings.json');
  }

  async get(): Promise<AppSettings> {
    try {
      const text = await readFile(this.settingsPath, 'utf8');
      return normalizeSettings(JSON.parse(text));
    } catch {
      const settings = createDefaultSettings();
      await this.write(settings);
      return settings;
    }
  }

  async update(patch: UpdateAppSettingsInput): Promise<AppSettings> {
    let next: AppSettings | undefined;
    await this.withQueue(async () => {
      const current = await this.get();
      next = mergeSettings(current, patch);
      await this.write(next);
    });
    if (!next) throw new Error('Failed to update settings');
    return next;
  }

  async testNetworkProxy(): Promise<SettingsTestResult> {
    const started = Date.now();
    const settings = await this.get();
    const proxy = settings.network.proxy;
    if (!proxy.enabled) {
      return { ok: true, message: '代理未启用，当前会直接连接。', latencyMs: Date.now() - started };
    }
    if (!proxy.host.trim()) return { ok: false, message: '代理服务器地址不能为空' };
    if (!Number.isInteger(proxy.port) || proxy.port <= 0 || proxy.port > 65535) {
      return { ok: false, message: '代理端口必须在 1-65535 之间' };
    }
    if (proxy.authEnabled && (!proxy.username.trim() || !proxy.password)) {
      return { ok: false, message: '启用代理认证后需要用户名和密码' };
    }
    return {
      ok: true,
      message: `代理配置有效：${proxy.protocol}://${proxy.host}:${proxy.port}`,
      latencyMs: Date.now() - started,
      details: { bypassList: proxy.bypassList, autoBypassDomains: proxy.autoBypassDomains },
    };
  }

  async testBotChannel(provider: BotProvider): Promise<SettingsTestResult> {
    const started = Date.now();
    const settings = await this.get();
    const channel = settings.botChat.channels[provider];
    if (!channel) return { ok: false, message: `未知机器人渠道：${provider}` };
    if (!channel.token.trim()) return { ok: false, message: 'Bot Token 不能为空' };
    if (provider === 'telegram' && !/^\d+:[\w-]+/.test(channel.token.trim())) {
      return { ok: false, message: 'Telegram Bot Token 格式不正确' };
    }
    const next = await this.update({
      botChat: {
        channels: {
          [provider]: {
            enabled: true,
            connected: true,
            lastTestAt: Date.now(),
            lastError: undefined,
          },
        },
      },
    });
    return {
      ok: next.botChat.channels[provider].connected,
      message: `${provider} 配置已保存，等待 bridge runtime 接管连接。`,
      latencyMs: Date.now() - started,
    };
  }

  async usageStats(range: UsageRange = '24h'): Promise<UsageStats> {
    const since = rangeToSince(range);
    const sessions = await readStoredSessions(join(this.workspaceRoot, 'sessions'));
    const logs = sessions.flatMap(({ header, messages }) => {
      const assistantByTurn = new Map(
        messages
          .filter((message) => message.type === 'assistant')
          .map((message) => [message.turnId, message.modelId]),
      );
      return messages
        .filter((message): message is TokenUsageMessage => message.type === 'token_usage')
        .filter((message) => !since || message.ts >= since)
        .map((message) => ({
          id: message.id,
          ts: message.ts,
          provider: header.llmConnectionSlug,
          model: assistantByTurn.get(message.turnId) ?? header.model,
          inputTokens: message.input,
          outputTokens: message.output,
          cacheRead: message.cacheRead,
          cacheCreation: message.cacheCreation,
          costUsd: message.costUsd,
          status: 'success' as const,
        }));
    });

    const toolRows = sessions.flatMap(({ messages }) => toolStatsFromMessages(messages, since));
    const totalInput = sum(logs.map((log) => log.inputTokens));
    const totalOutput = sum(logs.map((log) => log.outputTokens));
    const cacheRead = sum(logs.map((log) => log.cacheRead ?? 0));
    const cacheCreation = sum(logs.map((log) => log.cacheCreation ?? 0));
    return {
      summary: {
        totalRequests: logs.length,
        totalCostUsd: sum(logs.map((log) => log.costUsd ?? 0)),
        totalTokens: totalInput + totalOutput,
        inputTokens: totalInput,
        outputTokens: totalOutput,
        cacheTokens: cacheRead + cacheCreation,
        cacheRead,
        cacheCreation,
      },
      logs: logs.sort((a, b) => b.ts - a.ts),
      byProvider: aggregateBy(logs, 'provider'),
      byModel: aggregateBy(logs, 'model'),
      byTool: toolRows,
      pricing: [],
    };
  }

  private async write(settings: AppSettings): Promise<void> {
    await mkdir(dirname(this.settingsPath), { recursive: true });
    const tempPath = `${this.settingsPath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
    await rename(tempPath, this.settingsPath);
  }

  private withQueue(operation: () => Promise<void>): Promise<void> {
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => {});
    return next;
  }
}

async function readStoredSessions(sessionsRoot: string): Promise<Array<{ header: SessionHeader; messages: StoredMessage[] }>> {
  const fs = await import('node:fs/promises');
  try {
    const entries = await fs.readdir(sessionsRoot, { withFileTypes: true });
    const sessions: Array<{ header: SessionHeader; messages: StoredMessage[] }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const text = await readFile(join(sessionsRoot, entry.name, 'session.jsonl'), 'utf8');
        const lines = text.split('\n').filter((line) => line.trim());
        if (!lines[0]) continue;
        sessions.push({
          header: JSON.parse(lines[0]) as SessionHeader,
          messages: lines.slice(1).map((line) => JSON.parse(line) as StoredMessage),
        });
      } catch {
        // Ignore partially-written or legacy session folders.
      }
    }
    return sessions;
  } catch {
    return [];
  }
}

function rangeToSince(range: UsageRange): number | null {
  const now = Date.now();
  switch (range) {
    case '24h': return now - 24 * 60 * 60 * 1000;
    case '7d': return now - 7 * 24 * 60 * 60 * 1000;
    case '30d': return now - 30 * 24 * 60 * 60 * 1000;
    case 'all': return null;
  }
}

function aggregateBy(logs: UsageStats['logs'], key: 'provider' | 'model') {
  const rows = new Map<string, { requests: number; tokens: number; costUsd: number }>();
  for (const log of logs) {
    const id = log[key];
    const current = rows.get(id) ?? { requests: 0, tokens: 0, costUsd: 0 };
    current.requests += 1;
    current.tokens += log.inputTokens + log.outputTokens;
    current.costUsd += log.costUsd ?? 0;
    rows.set(id, current);
  }
  return [...rows.entries()]
    .map(([id, row]) => ({ [key]: id, ...row }))
    .sort((a, b) => b.requests - a.requests) as never;
}

function toolStatsFromMessages(messages: StoredMessage[], since: number | null): UsageStats['byTool'] {
  const calls = messages.filter((message): message is ToolCallMessage => message.type === 'tool_call');
  const results = new Map(
    messages
      .filter((message): message is ToolResultMessage => message.type === 'tool_result')
      .map((message) => [message.toolUseId, message]),
  );
  const rows = new Map<string, { calls: number; success: number; errors: number; totalDuration: number; durationCount: number }>();
  for (const call of calls) {
    if (since && call.ts < since) continue;
    const result = results.get(call.id);
    const current = rows.get(call.toolName) ?? { calls: 0, success: 0, errors: 0, totalDuration: 0, durationCount: 0 };
    current.calls += 1;
    if (result?.isError) current.errors += 1;
    else current.success += 1;
    if (result?.durationMs !== undefined) {
      current.totalDuration += result.durationMs;
      current.durationCount += 1;
    }
    rows.set(call.toolName, current);
  }
  return [...rows.entries()].map(([tool, row]) => ({
    tool,
    calls: row.calls,
    success: row.success,
    errors: row.errors,
    avgDurationMs: row.durationCount ? Math.round(row.totalDuration / row.durationCount) : 0,
  }));
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
