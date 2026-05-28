import type { BotProvider, BotReadinessState } from '@maka/core';
import type { BotMessageEvent, BotPlatform } from '@maka/core/bot-events';

export type { BotPlatform };

export interface BotStatus {
  platform: BotPlatform;
  /**
   * Runtime process/polling loop state only. This is not operational
   * readiness; use `readiness` for user-facing health.
   */
  running: boolean;
  readiness: BotReadinessState;
  reason?: string;
  startedAt?: number;
  lastEventAt?: number;
  connection: 'polling' | 'gateway' | 'webhook' | 'none';
  identity?: {
    id?: string;
    username?: string;
    displayName?: string;
  };
}

export type BotIncomingMessage = BotMessageEvent;

export interface BotBridge {
  readonly platform: BotPlatform;
  start(): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;
  getStatus(): BotStatus;
}

export interface SendCapable {
  sendMessage(chatId: string, text: string): Promise<string | null>;
}

export interface BotTestResult {
  ok: boolean;
  identity?: { id: string; username?: string; displayName?: string };
  messageSent?: boolean;
  capabilities?: Record<string, boolean>;
  error?: string;
  hint?: string;
}
