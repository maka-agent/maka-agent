import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';

// The default production path (desktop / CLI) calls the fragment WITHOUT a
// timezone argument, so the date must be formatted in the process local
// timezone. We lock that path by spawning a child with a fixed TZ and asserting
// the output, instead of passing a timeZone option that production never uses.
const here = dirname(fileURLToPath(import.meta.url));
const fragmentUrl = pathToFileURL(
  join(here, '..', 'system-prompt', 'session-environment-prompt.js'),
).href;

function runWithTimezone(timeZone: string, nowIso: string): string {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { buildSessionEnvironmentPromptFragment } from ${JSON.stringify(fragmentUrl)};
       const prompt = buildSessionEnvironmentPromptFragment({
         cwd: '/repo',
         projectGit: { isGitRepo: true, branch: 'main' },
         platform: 'darwin',
         now: new Date(${JSON.stringify(nowIso)}),
       });
       process.stdout.write(prompt);`,
    ],
    { env: { ...process.env, TZ: timeZone }, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, `child failed: ${result.stderr || ''}`);
  return result.stdout;
}

describe('session environment prompt date', () => {
  it('uses the process local timezone by default so a UTC instant near local midnight is not off by one', () => {
    // 2026-05-29T16:30:00Z in Asia/Shanghai (UTC+8) is 2026-05-30 00:30 local.
    // The fragment is called WITHOUT a timezone arg; the default path must read
    // the process timezone and report the local calendar day, not the UTC day.
    const prompt = runWithTimezone('Asia/Shanghai', '2026-05-29T16:30:00.000Z');
    assert.match(prompt, /Today's date: 2026-05-30/);
  });

  it('keeps the same calendar day when the process timezone is UTC and the instant is midday UTC', () => {
    const prompt = runWithTimezone('UTC', '2026-05-29T12:34:56.000Z');
    assert.match(prompt, /Today's date: 2026-05-29/);
  });
});
describe('session environment prompt shell line', () => {
  it('declares the executing shell inside the env block', async () => {
    const { buildSessionEnvironmentPromptFragment } = await import(
      '../system-prompt/session-environment-prompt.js'
    );
    const prompt = buildSessionEnvironmentPromptFragment({
      cwd: '/repo',
      projectGit: { isGitRepo: true, branch: 'main' },
      platform: 'win32',
      shell: 'PowerShell 7 (pwsh)',
    });
    assert.match(prompt, /  Shell: PowerShell 7 \(pwsh\)\n/);
  });

  it('defaults the shell line to the detected process shell', async () => {
    const { buildSessionEnvironmentPromptFragment } = await import(
      '../system-prompt/session-environment-prompt.js'
    );
    const { defaultShellPlan } = await import('../shell-detect.js');
    const prompt = buildSessionEnvironmentPromptFragment({
      cwd: '/repo',
      projectGit: { isGitRepo: false },
    });
    assert.ok(prompt.includes(`  Shell: ${defaultShellPlan().displayName}`));
  });
});
