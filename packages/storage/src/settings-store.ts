import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  AppSettings,
  OnboardingMilestone,
  OnboardingMilestoneId,
  SettingsTestResult,
  UpdateAppSettingsInput,
  UsageRange,
  UsageStats,
} from '@maka/core';
import { createDefaultSettings, mergeSettings, normalizeSettings } from '@maka/core/settings';
import { sanitizeOnboardingMilestones } from '@maka/core/onboarding';
import type { SessionHeader } from '@maka/core/session';

type UsageSessionHeader = Pick<SessionHeader, 'id' | 'llmConnectionSlug' | 'model'>;

type UsageAssistantMessage = {
  type: 'assistant';
  turnId: string;
  modelId: string;
};

type UsageTokenMessage = {
  type: 'token_usage';
  id: string;
  turnId: string;
  ts: number;
  input: number;
  output: number;
  cacheMissInput?: number;
  cacheRead?: number;
  cacheCreation?: number;
  reasoning?: number;
  costUsd?: number;
};

type UsageToolCallMessage = {
  type: 'tool_call';
  id: string;
  turnId: string;
  ts: number;
  toolName: string;
  displayName?: string;
};

type UsageToolResultMessage = {
  type: 'tool_result';
  turnId: string;
  ts: number;
  toolUseId: string;
  isError: boolean;
  durationMs?: number;
};

type UsageMessage =
  | UsageAssistantMessage
  | UsageTokenMessage
  | UsageToolCallMessage
  | UsageToolResultMessage;

export interface SettingsStore {
  get(): Promise<AppSettings>;
  update(patch: UpdateAppSettingsInput): Promise<AppSettings>;
  testNetworkProxy(): Promise<SettingsTestResult>;
  usageStats(range?: UsageRange): Promise<UsageStats>;
  /**
   * PR110b: upsert a single onboarding milestone. Caller passes the
   * desired terminal status; the store stamps `Date.now()` so the
   * renderer cannot tamper with timestamps. Returns the freshly
   * sanitized milestone list. Last-valid-entry-wins dedup applies.
   *
   * @throws if `id` is not in `OnboardingMilestoneId` or status is
   *         not 'completed' | 'skipped'.
   */
  upsertOnboardingMilestone(
    id: OnboardingMilestoneId,
    status: 'completed' | 'skipped',
  ): Promise<OnboardingMilestone[]>;
  /**
   * Remove one milestone entry without disturbing the rest. Used for
   * reversible first-run suggestion dismissal; it still flows through
   * the closed enum so arbitrary renderer strings cannot reshape the
   * onboarding settings section.
   */
  clearOnboardingMilestone(id: OnboardingMilestoneId): Promise<OnboardingMilestone[]>;
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
    let settings: AppSettings | undefined;
    await this.withQueue(async () => {
      settings = await this.readOrCreate();
    });
    if (!settings) throw new Error('Failed to read settings');
    return settings;
  }

  private async readOrCreate(): Promise<AppSettings> {
    try {
      const text = await readFile(this.settingsPath, 'utf8');
      return normalizeSettings(JSON.parse(text));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const settings = createDefaultSettings();
      await this.write(settings);
      return settings;
    }
  }

  async update(patch: UpdateAppSettingsInput): Promise<AppSettings> {
    let next: AppSettings | undefined;
    await this.withQueue(async () => {
      const current = await this.readOrCreate();
      next = mergeSettings(current, patch);
      await this.write(next);
    });
    if (!next) throw new Error('Failed to update settings');
    return next;
  }

  async upsertOnboardingMilestone(
    id: OnboardingMilestoneId,
    status: 'completed' | 'skipped',
  ): Promise<OnboardingMilestone[]> {
    if (status !== 'completed' && status !== 'skipped') {
      throw new Error(`invalid onboarding milestone status: ${String(status)}`);
    }
    const timestamp = Date.now();
    const next: OnboardingMilestone =
      status === 'completed' ? { id, completedAt: timestamp } : { id, skippedAt: timestamp };
    let result: OnboardingMilestone[] | undefined;
    await this.withQueue(async () => {
      const current = await this.readOrCreate();
      // Append the new entry; sanitize() applies last-valid-entry-wins
      // dedup with stable first-seen position. ID validity is enforced
      // by the sanitizer (closed enum).
      const sanitized = sanitizeOnboardingMilestones([...current.onboarding.milestones, next]);
      if (!sanitized.some((entry) => entry.id === id)) {
        // ID was rejected by the validator — propagate so the IPC
        // handler can reject the caller's input.
        throw new Error(`invalid onboarding milestone id: ${String(id)}`);
      }
      const merged: AppSettings = {
        ...current,
        onboarding: { milestones: sanitized },
      };
      await this.write(merged);
      result = sanitized;
    });
    if (!result) throw new Error('Failed to upsert onboarding milestone');
    return result;
  }

  async clearOnboardingMilestone(id: OnboardingMilestoneId): Promise<OnboardingMilestone[]> {
    let result: OnboardingMilestone[] | undefined;
    await this.withQueue(async () => {
      const current = await this.readOrCreate();
      const knownId = sanitizeOnboardingMilestones([{ id }]).some((entry) => entry.id === id);
      if (!knownId) {
        throw new Error(`invalid onboarding milestone id: ${String(id)}`);
      }
      const milestones = current.onboarding.milestones.filter((entry) => entry.id !== id);
      const merged: AppSettings = {
        ...current,
        onboarding: { milestones },
      };
      await this.write(merged);
      result = milestones;
    });
    if (!result) throw new Error('Failed to clear onboarding milestone');
    return result;
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

  async usageStats(range: UsageRange = '24h'): Promise<UsageStats> {
    const since = rangeToSince(range);
    const sessions = await readStoredSessions(join(this.workspaceRoot, 'sessions'));
    const modelLogs = sessions.flatMap(({ header, messages }) => {
      const assistantByTurn = new Map(
        messages
          .filter((message) => message.type === 'assistant')
          .map((message) => [message.turnId, message.modelId]),
      );
      return messages
        .filter((message): message is UsageTokenMessage => message.type === 'token_usage')
        .filter((message) => !since || message.ts >= since)
        .map((message) => ({
          id: message.id,
          ts: message.ts,
          kind: 'model' as const,
          sessionId: header.id,
          turnId: message.turnId,
          provider: header.llmConnectionSlug,
          model: assistantByTurn.get(message.turnId) ?? header.model,
          inputTokens: message.input,
          outputTokens: message.output,
          cacheMiss: message.cacheMissInput,
          cacheRead: message.cacheRead,
          cacheCreation: message.cacheCreation,
          reasoning: message.reasoning,
          costUsd: message.costUsd,
          status: 'success' as const,
        }));
    });

    const toolRows = sessions.flatMap(({ messages }) => toolStatsFromMessages(messages, since));
    const toolLogs = sessions.flatMap(({ header, messages }) =>
      toolLogRowsFromMessages(header, messages, since),
    );
    const logs = [...modelLogs, ...toolLogs].sort((a, b) => b.ts - a.ts);
    const totalInput = sum(modelLogs.map((log) => log.inputTokens));
    const totalOutput = sum(modelLogs.map((log) => log.outputTokens));
    const cacheMiss = sum(modelLogs.map((log) => log.cacheMiss ?? 0));
    const cacheRead = sum(modelLogs.map((log) => log.cacheRead ?? 0));
    const cacheCreation = sum(modelLogs.map((log) => log.cacheCreation ?? 0));
    const reasoning = sum(modelLogs.map((log) => log.reasoning ?? 0));
    return {
      summary: {
        totalRequests: modelLogs.length,
        totalCostUsd: sum(modelLogs.map((log) => log.costUsd ?? 0)),
        totalTokens: totalInput + totalOutput,
        inputTokens: totalInput,
        outputTokens: totalOutput,
        cacheTokens: cacheRead + cacheCreation,
        cacheMiss,
        cacheRead,
        cacheCreation,
        reasoning,
      },
      logs,
      byProvider: aggregateBy(modelLogs, 'provider'),
      byModel: aggregateBy(modelLogs, 'model'),
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

async function readStoredSessions(
  sessionsRoot: string,
): Promise<Array<{ header: UsageSessionHeader; messages: UsageMessage[] }>> {
  const fs = await import('node:fs/promises');
  try {
    const entries = await fs.readdir(sessionsRoot, { withFileTypes: true });
    const sessions: Array<{ header: UsageSessionHeader; messages: UsageMessage[] }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const text = await readFile(join(sessionsRoot, entry.name, 'session.jsonl'), 'utf8');
        const lines = text.split('\n').filter((line) => line.trim());
        if (!lines[0]) continue;
        const header = normalizeUsageSessionHeader(JSON.parse(lines[0]), entry.name);
        if (!header) continue;
        const messages: UsageMessage[] = [];
        for (const line of lines.slice(1)) {
          try {
            const message = normalizeUsageMessage(JSON.parse(line));
            if (message) messages.push(message);
          } catch {
            // A partially-written/corrupt message line must not hide valid usage rows from the same session.
          }
        }
        sessions.push({
          header,
          messages,
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

function normalizeUsageSessionHeader(value: unknown, sessionId: string): UsageSessionHeader | null {
  if (!isRecord(value)) return null;
  if (value.id !== sessionId) return null;
  if (typeof value.llmConnectionSlug !== 'string') return null;
  if (typeof value.model !== 'string') return null;
  return {
    id: value.id,
    llmConnectionSlug: value.llmConnectionSlug,
    model: value.model,
  };
}

function normalizeUsageMessage(value: unknown): UsageMessage | null {
  if (!isRecord(value)) return null;
  switch (value.type) {
    case 'assistant':
      if (typeof value.turnId !== 'string') return null;
      if (typeof value.modelId !== 'string') return null;
      return { type: 'assistant', turnId: value.turnId, modelId: value.modelId };
    case 'token_usage':
      if (typeof value.id !== 'string') return null;
      if (typeof value.turnId !== 'string') return null;
      if (!isFiniteNumber(value.ts)) return null;
      if (!isFiniteNumber(value.input)) return null;
      if (!isFiniteNumber(value.output)) return null;
      if (!isOptionalFiniteNumber(value.cacheMissInput)) return null;
      if (!isOptionalFiniteNumber(value.cacheRead)) return null;
      if (!isOptionalFiniteNumber(value.cacheCreation)) return null;
      if (!isOptionalFiniteNumber(value.reasoning)) return null;
      if (!isOptionalFiniteNumber(value.costUsd)) return null;
      return {
        type: 'token_usage',
        id: value.id,
        turnId: value.turnId,
        ts: value.ts,
        input: value.input,
        output: value.output,
        cacheMissInput: value.cacheMissInput,
        cacheRead: value.cacheRead,
        cacheCreation: value.cacheCreation,
        reasoning: value.reasoning,
        costUsd: value.costUsd,
      };
    case 'tool_call':
      if (typeof value.id !== 'string') return null;
      if (typeof value.turnId !== 'string') return null;
      if (!isFiniteNumber(value.ts)) return null;
      if (typeof value.toolName !== 'string') return null;
      if (value.displayName !== undefined && typeof value.displayName !== 'string') return null;
      return {
        type: 'tool_call',
        id: value.id,
        turnId: value.turnId,
        ts: value.ts,
        toolName: value.toolName,
        displayName: value.displayName,
      };
    case 'tool_result':
      if (typeof value.turnId !== 'string') return null;
      if (!isFiniteNumber(value.ts)) return null;
      if (typeof value.toolUseId !== 'string') return null;
      if (typeof value.isError !== 'boolean') return null;
      if (!isOptionalFiniteNumber(value.durationMs)) return null;
      return {
        type: 'tool_result',
        turnId: value.turnId,
        ts: value.ts,
        toolUseId: value.toolUseId,
        isError: value.isError,
        durationMs: value.durationMs,
      };
    default:
      return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isOptionalFiniteNumber(value: unknown): value is number | undefined {
  return value === undefined || isFiniteNumber(value);
}

function rangeToSince(range: UsageRange): number | null {
  const now = Date.now();
  switch (range) {
    case '24h':
      return now - 24 * 60 * 60 * 1000;
    case '7d':
      return now - 7 * 24 * 60 * 60 * 1000;
    case '30d':
      return now - 30 * 24 * 60 * 60 * 1000;
    case 'all':
      return null;
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

function toolStatsFromMessages(
  messages: UsageMessage[],
  since: number | null,
): UsageStats['byTool'] {
  const calls = messages.filter(
    (message): message is UsageToolCallMessage => message.type === 'tool_call',
  );
  const results = new Map(
    messages
      .filter((message): message is UsageToolResultMessage => message.type === 'tool_result')
      .map((message) => [message.toolUseId, message]),
  );
  const rows = new Map<
    string,
    { calls: number; success: number; errors: number; totalDuration: number; durationCount: number }
  >();
  for (const call of calls) {
    if (since && call.ts < since) continue;
    const result = results.get(call.id);
    const current = rows.get(call.toolName) ?? {
      calls: 0,
      success: 0,
      errors: 0,
      totalDuration: 0,
      durationCount: 0,
    };
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

function toolLogRowsFromMessages(
  header: UsageSessionHeader,
  messages: UsageMessage[],
  since: number | null,
): UsageStats['logs'] {
  const calls = messages.filter(
    (message): message is UsageToolCallMessage => message.type === 'tool_call',
  );
  const results = new Map(
    messages
      .filter((message): message is UsageToolResultMessage => message.type === 'tool_result')
      .map((message) => [message.toolUseId, message]),
  );
  return calls
    .filter((call) => !since || call.ts >= since)
    .map((call) => {
      const result = results.get(call.id);
      const ts = result?.ts ?? call.ts;
      return {
        id: `tool:${call.id}`,
        ts,
        kind: 'tool' as const,
        sessionId: header.id,
        turnId: call.turnId,
        provider: header.llmConnectionSlug,
        model: header.model,
        toolName: call.displayName ?? call.toolName,
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: result?.durationMs,
        status: result?.isError ? ('error' as const) : ('success' as const),
      };
    });
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
