// packages/runtime/src/shell-detect.ts
//
// Which shell runs Bash tool commands, and how to tell the model about it.
//
// Node's `spawn(cmd, { shell: true })` silently picks the platform default:
// /bin/sh on POSIX, cmd.exe on Windows. cmd.exe is the weakest shell on any
// modern Windows box (no pipelines over objects, no regex, ancient syntax), so
// the model is trapped writing `dir /s /b` style commands. This module detects
// a better shell (pwsh > powershell > cmd) and carries the result to the two
// places that need it: the spawn call (shell-exec / shell-run-manager) and the
// prompt surfaces that must DECLARE the dialect to the model (tool description,
// session environment fragment). Selection without declaration — or the other
// way round — makes the model guess the dialect, which is the original bug.

import { existsSync } from 'node:fs';

export type ShellKind = 'posix' | 'pwsh' | 'powershell' | 'cmd';

export interface ShellPlan {
  kind: ShellKind;
  /** Human-readable name for prompt surfaces, e.g. "PowerShell 7 (pwsh)". */
  displayName: string;
  /** Executable to spawn explicitly (pwsh/powershell only). */
  exe?: string;
}

export interface DetectShellInput {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  fileExists?: (path: string) => boolean;
}

export function detectShell(input: DetectShellInput = {}): ShellPlan {
  const platform = input.platform ?? process.platform;
  if (platform !== 'win32') return { kind: 'posix', displayName: '/bin/sh' };
  const env = input.env ?? process.env;
  const fileExists = input.fileExists ?? defaultFileExists;
  const pwsh = findOnWindowsPath('pwsh.exe', env, fileExists)
    ?? findAt(env.ProgramFiles, 'PowerShell\\7\\pwsh.exe', fileExists);
  if (pwsh) return { kind: 'pwsh', displayName: 'PowerShell 7 (pwsh)', exe: pwsh };
  const powershell = findOnWindowsPath('powershell.exe', env, fileExists)
    ?? findAt(env.SystemRoot, 'System32\\WindowsPowerShell\\v1.0\\powershell.exe', fileExists);
  if (powershell) return { kind: 'powershell', displayName: 'Windows PowerShell 5.1', exe: powershell };
  return { kind: 'cmd', displayName: 'cmd.exe' };
}

/**
 * The shell for this process's real platform/env, detected once and cached:
 * detection touches the filesystem, and every Bash tool call would otherwise
 * repeat it. The environment a desktop app runs in does not change under it.
 */
export function defaultShellPlan(): ShellPlan {
  cachedDefault ??= detectShell();
  return cachedDefault;
}

let cachedDefault: ShellPlan | undefined;

/**
 * How to hand `command` to spawn() for the given shell. PowerShell is spawned
 * explicitly (never via `shell: true`): Node's shell option only knows cmd.exe
 * quoting on Windows, and PowerShell needs its non-interactive flags anyway.
 */
export interface ShellSpawnPlan {
  file: string;
  args: string[];
  useShellOption: boolean;
}

export function buildShellSpawnPlan(shell: ShellPlan, command: string): ShellSpawnPlan {
  if ((shell.kind === 'pwsh' || shell.kind === 'powershell') && shell.exe) {
    return {
      file: shell.exe,
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
      useShellOption: false,
    };
  }
  return { file: command, args: [], useShellOption: true };
}

/**
 * Shell-dialect sentence for Bash tool descriptions. Empty on POSIX (the
 * historical description is the contract there). On Windows this is the other
 * half of shell selection: without it the model guesses the dialect — the
 * original `dir /s /b` bug.
 */
export function bashToolShellGuidance(shell: ShellPlan): string {
  if (shell.kind === 'posix') return '';
  const dialect =
    shell.kind === 'pwsh' ? 'Commands are executed by PowerShell 7 (pwsh); write PowerShell syntax, not cmd or bash syntax.'
    : shell.kind === 'powershell' ? 'Commands are executed by Windows PowerShell 5.1; write PowerShell 5.1-compatible syntax, not cmd or bash syntax.'
    : 'Commands are executed by cmd.exe; write cmd syntax, not bash syntax.';
  return `${dialect} Prefer \`git ls-files\` or the Grep/Glob tools over recursive directory listings, and always exclude node_modules and build output when enumerating files.`;
}

function findAt(
  base: string | undefined,
  relative: string,
  fileExists: (path: string) => boolean,
): string | undefined {
  if (!base) return undefined;
  const candidate = `${base.replace(/\\+$/, '')}\\${relative}`;
  return fileExists(candidate) ? candidate : undefined;
}

function findOnWindowsPath(
  exeName: string,
  env: NodeJS.ProcessEnv,
  fileExists: (path: string) => boolean,
): string | undefined {
  const pathValue = env.Path ?? env.PATH ?? env.path ?? '';
  for (const dir of pathValue.split(';')) {
    if (!dir) continue;
    const candidate = `${dir.replace(/\\+$/, '')}\\${exeName}`;
    if (fileExists(candidate)) return candidate;
  }
  return undefined;
}

function defaultFileExists(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}
