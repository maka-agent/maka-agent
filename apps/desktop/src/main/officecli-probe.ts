import { execFile } from 'node:child_process';

export type OfficeCliProbe =
  | { available: true; version: string; checkedAt: number }
  | { available: false; reason: 'missing' | 'timeout' | 'failed'; checkedAt: number };

export function probeOfficeCli(input: {
  now?: number;
  timeoutMs?: number;
  execFileImpl?: typeof execFile;
} = {}): Promise<OfficeCliProbe> {
  const now = input.now ?? Date.now();
  const timeoutMs = input.timeoutMs ?? 1_500;
  const execFileImpl = input.execFileImpl ?? execFile;

  return new Promise((resolve) => {
    const child = execFileImpl(
      'officecli',
      ['--version'],
      {
        timeout: timeoutMs,
        env: { ...process.env, OFFICECLI_SKIP_UPDATE: '1' },
      },
      (error, stdout) => {
        if (!error) {
          const version = normalizeOfficeCliVersion(stdout);
          resolve({ available: true, version, checkedAt: now });
          return;
        }
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          resolve({ available: false, reason: 'missing', checkedAt: now });
          return;
        }
        if (code === 'ETIMEDOUT' || (error as { killed?: boolean }).killed) {
          resolve({ available: false, reason: 'timeout', checkedAt: now });
          return;
        }
        resolve({ available: false, reason: 'failed', checkedAt: now });
      },
    );

    child.on('error', (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      resolve({ available: false, reason: code === 'ENOENT' ? 'missing' : 'failed', checkedAt: now });
    });
  });
}

export function normalizeOfficeCliVersion(stdout: string): string {
  const text = stdout.trim();
  const match = text.match(/\b(v?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)\b/);
  return match?.[1] ?? (text.length > 0 ? text.split(/\s+/)[0] ?? 'unknown' : 'unknown');
}
