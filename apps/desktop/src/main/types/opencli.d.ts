declare module '@jackwener/opencli/types' {
  export interface IPage {
    goto(url: string, options?: { waitUntil?: 'load' | 'none'; settleMs?: number }): Promise<void>;
    evaluate<T = unknown>(js: string): Promise<T>;
    evaluate<Args extends unknown[], T>(
      fn: (...args: Args) => T | Promise<T>,
      ...args: Args
    ): Promise<Awaited<T>>;
    snapshot(opts?: { interactive?: boolean; compact?: boolean; raw?: boolean }): Promise<unknown>;
    click(ref: string, opts?: { nth?: number; firstOnMulti?: boolean }): Promise<{
      matches_n: number;
      match_level: 'exact' | 'stable' | 'reidentified';
    }>;
    fillText(ref: string, text: string, opts?: { nth?: number; firstOnMulti?: boolean }): Promise<{
      filled: boolean;
      verified: boolean;
      expected: string;
      actual: string;
      length: number;
      matches_n: number;
      match_level: 'exact' | 'stable' | 'reidentified';
      mode?: 'input' | 'textarea' | 'contenteditable';
    }>;
    pressKey(key: string): Promise<void>;
    wait(options: number | { text?: string; selector?: string; time?: number; timeout?: number }): Promise<void>;
    getCurrentUrl?(): Promise<string>;
  }
}

declare module '@jackwener/opencli/browser/cdp' {
  import type { IPage } from '@jackwener/opencli/types';

  export class CDPBridge {
    connect(opts?: {
      timeout?: number;
      session?: string;
      cdpEndpoint?: string;
      contextId?: string;
      idleTimeout?: number;
      windowMode?: 'foreground' | 'background';
      surface?: 'browser' | 'adapter';
      siteSession?: 'ephemeral' | 'persistent';
    }): Promise<IPage>;
    close(): Promise<void>;
    send(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
    waitForEvent(event: string, timeoutMs?: number): Promise<unknown>;
  }
}

declare module '@jackwener/opencli/utils' {
  export function htmlToMarkdown(value: string, configure?: (converter: unknown) => void): string;
}
