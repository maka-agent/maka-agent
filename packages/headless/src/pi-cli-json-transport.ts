import { spawn as nodeSpawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import type { PiAgentFrame, PiAgentSendInput, PiAgentTransport } from '@maka/runtime';

export interface PiCliJsonSpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdio: ['pipe', 'pipe', 'pipe'];
}

export interface PiCliJsonChild {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
}

export type PiCliJsonSpawn = (
  command: string,
  args: string[],
  options: PiCliJsonSpawnOptions,
) => PiCliJsonChild;

export interface PiCliJsonTransportInput {
  command?: string;
  provider?: string;
  model?: string;
  env?: NodeJS.ProcessEnv;
  spawn?: PiCliJsonSpawn;
}

interface PiUsageTotals {
  input: number;
  output: number;
  cacheHitInput: number;
  cacheWriteInput: number;
  reasoning: number;
  total: number;
  costUsd: number;
  sawUsage: boolean;
  sawReasoning: boolean;
  sawCost: boolean;
}

type PiTokenUsageFrame = Extract<PiAgentFrame, { type: 'token_usage' }>;

export class PiCliJsonTransport implements PiAgentTransport {
  private readonly input: Required<Pick<PiCliJsonTransportInput, 'command' | 'spawn'>> &
    Omit<PiCliJsonTransportInput, 'command' | 'spawn'>;
  private child: PiCliJsonChild | null = null;

  constructor(input: PiCliJsonTransportInput = {}) {
    this.input = {
      ...input,
      command: input.command ?? 'pi',
      spawn:
        input.spawn ??
        ((command, args, options) => nodeSpawn(command, args, options) as PiCliJsonChild),
    };
  }

  async *send(input: PiAgentSendInput): AsyncIterable<PiAgentFrame> {
    const child = this.input.spawn(this.input.command, this.args(), {
      cwd: input.cwd,
      env: this.input.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    const close = childClose(child);
    const stderr = collectStderr(child.stderr);
    let stdinError: Error | undefined;
    let rejectStdin: (error: Error) => void = () => {};
    const stdinFailed = new Promise<never>((_, reject) => {
      rejectStdin = reject;
    });
    stdinFailed.catch(() => undefined);
    const onStdinError = (error: Error) => {
      stdinError = new Error(`pi stdin write failed: ${error.message}`);
      rejectStdin(stdinError);
    };
    child.stdin.once('error', onStdinError);
    try {
      child.stdin.end(input.text);
    } catch (error) {
      onStdinError(error instanceof Error ? error : new Error(String(error)));
    }
    let closed = false;
    let buffer = '';
    let sawAgentEnd = false;

    try {
      const stdout = child.stdout[Symbol.asyncIterator]();
      while (true) {
        const next = await Promise.race([stdout.next(), stdinFailed]);
        if (next.done) break;
        const chunk = next.value;
        buffer += String(chunk);
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = parseJsonObject(line);
          if (event.type === 'agent_end') sawAgentEnd = true;
          for (const frame of framesFromEvent(event)) yield frame;
        }
      }
      if (buffer.trim()) {
        const event = parseJsonObject(buffer);
        if (event.type === 'agent_end') sawAgentEnd = true;
        for (const frame of framesFromEvent(event)) yield frame;
      }

      const result = await close;
      closed = true;
      if (stdinError) throw stdinError;
      if (result.code !== 0) {
        const details = await stderr;
        throw new Error(
          `pi exited with code ${result.code ?? 'signal'}${details ? `: ${details}` : ''}`,
        );
      }
      if (!sawAgentEnd) throw new Error('pi exited before agent_end');
      yield { type: 'complete' };
    } finally {
      if (!closed) {
        void close.catch(() => undefined);
        child.kill('SIGTERM');
      }
      this.child = null;
      child.stdin.off('error', onStdinError);
    }
  }

  async stop(): Promise<void> {
    this.child?.kill('SIGTERM');
  }

  private args(): string[] {
    const args = ['--mode', 'json', '--no-context-files', '--no-session'];
    if (this.input.provider) args.push('--provider', this.input.provider);
    if (this.input.model) args.push('--model', this.input.model);
    args.push('-p');
    return args;
  }
}

function childClose(
  child: PiCliJsonChild,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.on('close', (code, signal) => resolve({ code, signal }));
    child.on('error', reject);
  });
}

async function collectStderr(stderr: Readable): Promise<string> {
  let output = '';
  for await (const chunk of stderr) {
    output += String(chunk);
    if (output.length > 4096) output = output.slice(-4096);
  }
  return output.trim();
}

function framesFromEvent(event: Record<string, unknown>): PiAgentFrame[] {
  switch (event.type) {
    case 'session':
    case 'agent_start':
    case 'turn_start':
    case 'turn_end':
    case 'message_start':
      return [];

    case 'message_update': {
      const assistantEvent = record(event.assistantMessageEvent);
      if (!assistantEvent) throw new Error('pi message_update missing assistantMessageEvent');
      switch (assistantEvent.type) {
        case 'thinking_start':
        case 'thinking_delta':
        case 'thinking_end':
        case 'text_start':
        case 'text_end':
        case 'toolcall_start':
          return [];
        case 'text_delta': {
          const textDelta = stringValue(assistantEvent.delta);
          if (textDelta === undefined) throw new Error('pi text_delta missing string delta');
          return [{ type: 'text_delta', text: textDelta }];
        }
        case 'toolcall_end': {
          const toolCalls = toolCallsFromPartial(assistantEvent.partial);
          if (toolCalls.length === 0) throw new Error('pi toolcall_end missing valid tool call');
          return toolCalls;
        }
        default:
          throw new Error(
            `pi emitted unsupported assistant event: ${assistantEvent.type ?? '<missing type>'}`,
          );
      }
    }

    case 'message_end': {
      const message = record(event.message);
      if (message?.role !== 'toolResult') return [];
      const toolUseId = stringValue(message.toolCallId);
      if (!toolUseId) throw new Error('pi toolResult message_end missing toolCallId');
      return [
        {
          type: 'tool_result',
          toolUseId,
          isError: message.isError === true,
          content: { kind: 'text', text: textFromPiContent(message.content) },
        },
      ];
    }

    case 'agent_end': {
      const usage = usageFromAgentEnd(event);
      return usage ? [usage] : [];
    }

    default:
      throw new Error(`pi emitted unsupported JSON event: ${event.type ?? '<missing type>'}`);
  }
}

function toolCallsFromPartial(partial: unknown): Extract<PiAgentFrame, { type: 'tool_start' }>[] {
  const content = record(partial)?.content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((item) => {
    const value = record(item);
    const toolUseId = stringValue(value?.id);
    const toolName = stringValue(value?.name);
    if (value?.type !== 'toolCall' || !toolUseId || !toolName) return [];
    return [{ type: 'tool_start', toolUseId, toolName, args: value.arguments }];
  });
}

function usageFromAgentEnd(event: Record<string, unknown>): PiTokenUsageFrame | null {
  const messages = event.messages;
  if (!Array.isArray(messages)) return null;
  const totals: PiUsageTotals = {
    input: 0,
    output: 0,
    cacheHitInput: 0,
    cacheWriteInput: 0,
    reasoning: 0,
    total: 0,
    costUsd: 0,
    sawUsage: false,
    sawReasoning: false,
    sawCost: false,
  };
  for (const message of messages) {
    if (record(message)?.role !== 'assistant') continue;
    addUsage(totals, record(record(message)?.usage));
  }
  if (!totals.sawUsage) return null;
  return {
    type: 'token_usage',
    input: totals.input,
    output: totals.output,
    cacheHitInput: totals.cacheHitInput,
    cacheWriteInput: totals.cacheWriteInput,
    total: totals.total,
    ...(totals.sawReasoning ? { reasoning: totals.reasoning } : {}),
    ...(totals.sawCost ? { costUsd: totals.costUsd } : {}),
  };
}

function addUsage(totals: PiUsageTotals, usage: Record<string, unknown> | undefined): void {
  if (!usage) return;
  const input = numberValue(usage.input);
  const output = numberValue(usage.output);
  const total = numberValue(usage.totalTokens);
  if (input !== undefined || output !== undefined || total !== undefined) totals.sawUsage = true;
  totals.input += input ?? 0;
  totals.output += output ?? 0;
  totals.cacheHitInput += numberValue(usage.cacheRead) ?? 0;
  totals.cacheWriteInput += numberValue(usage.cacheWrite) ?? 0;
  const reasoning = numberValue(usage.reasoning);
  if (reasoning !== undefined) {
    totals.reasoning += reasoning;
    totals.sawReasoning = true;
  }
  totals.total += total ?? (input ?? 0) + (output ?? 0);
  const costTotal = numberValue(record(usage.cost)?.total);
  if (costTotal !== undefined) {
    totals.costUsd += costTotal;
    totals.sawCost = true;
  }
}

function textFromPiContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((item) => {
      const value = record(item);
      return value?.type === 'text' ? (stringValue(value.text) ?? '') : '';
    })
    .filter(Boolean)
    .join('\n');
}

function parseJsonObject(line: string): Record<string, unknown> {
  try {
    const value = record(JSON.parse(line.trim()));
    if (value) return value;
  } catch {
    // Throw below with the same bounded message for invalid JSON and non-object JSON.
  }
  throw new Error(`pi emitted non-JSON stdout: ${line.slice(0, 200)}`);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
