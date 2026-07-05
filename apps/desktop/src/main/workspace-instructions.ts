import { realpath, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { isPathInside, WORKSPACE_INSTRUCTION_FILES } from '@maka/runtime';

/**
 * Desktop file-management surface for workspace instructions.
 *
 * The read-only scan + prompt builder moved to @maka/runtime (see
 * `packages/runtime/src/system-prompt/workspace-instructions.ts`) so the
 * CLI/TUI can reuse them. They are re-exported below to keep existing
 * `./workspace-instructions.js` imports working. This file retains only the
 * desktop-only management surface: opening and creating AGENTS.md / CLAUDE.md /
 * GEMINI.md from the UI, with path-safety guards.
 */

export {
  buildWorkspaceInstructionsPromptFragment,
  getWorkspaceInstructionsState,
  WORKSPACE_INSTRUCTION_FILES,
  MAX_WORKSPACE_INSTRUCTION_FILE_CHARS,
  MAX_WORKSPACE_INSTRUCTIONS_PROMPT_CHARS,
} from '@maka/runtime';
export type {
  WorkspaceInstructionFileStatus,
  WorkspaceInstructionFileState,
  WorkspaceInstructionsState,
} from '@maka/runtime';

export type WorkspaceInstructionOpenFailureReason =
  | 'unknown-file'
  | 'missing'
  | 'blocked'
  | 'not-a-file';

export type WorkspaceInstructionCreateFailureReason =
  | 'unknown-file'
  | 'exists'
  | 'blocked'
  | 'write-failed';

export async function resolveWorkspaceInstructionFileForOpen(
  cwd: string,
  file: string,
): Promise<
  | { ok: true; file: string; path: string }
  | { ok: false; reason: WorkspaceInstructionOpenFailureReason }
> {
  if (!isWorkspaceInstructionFile(file)) return { ok: false, reason: 'unknown-file' };

  let root: string;
  let resolved: string;
  try {
    [root, resolved] = await Promise.all([
      realpath(cwd),
      realpath(join(cwd, file)),
    ]);
  } catch {
    return { ok: false, reason: 'missing' };
  }

  if (!isPathInside(root, resolved)) return { ok: false, reason: 'blocked' };

  const fileStat = await stat(resolved).catch(() => null);
  if (!fileStat) return { ok: false, reason: 'missing' };
  if (!fileStat.isFile()) return { ok: false, reason: 'not-a-file' };

  return { ok: true, file, path: resolved };
}

export async function createWorkspaceInstructionFile(
  cwd: string,
  file: string,
): Promise<
  | { ok: true; file: string }
  | { ok: false; reason: WorkspaceInstructionCreateFailureReason }
> {
  if (!isWorkspaceInstructionFile(file)) return { ok: false, reason: 'unknown-file' };

  let root: string;
  try {
    root = await realpath(cwd);
  } catch {
    return { ok: false, reason: 'blocked' };
  }

  const target = join(root, file);
  if (!isPathInside(root, target)) return { ok: false, reason: 'blocked' };

  try {
    await writeFile(target, defaultWorkspaceInstructionTemplate(file), { encoding: 'utf8', flag: 'wx', mode: 0o644 });
  } catch (error) {
    const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : '';
    return { ok: false, reason: code === 'EEXIST' ? 'exists' : 'write-failed' };
  }

  const resolved = await resolveWorkspaceInstructionFileForOpen(root, file);
  return resolved.ok ? { ok: true, file } : { ok: false, reason: 'blocked' };
}

function isWorkspaceInstructionFile(file: string): file is (typeof WORKSPACE_INSTRUCTION_FILES)[number] {
  return (WORKSPACE_INSTRUCTION_FILES as readonly string[]).includes(file);
}

function defaultWorkspaceInstructionTemplate(file: string): string {
  return [
    `# ${file}`,
    '',
    '- Describe project-specific guidance for this workspace here.',
    '- Keep these instructions local to this project and lower priority than system, developer, safety, and permission rules.',
    '',
  ].join('\n');
}