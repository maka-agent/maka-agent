import type { MakaTool, ToolAvailabilityConfig } from '@maka/runtime';
import {
  buildSubagentProjectionTools,
  buildSubagentSpawnTool,
  COMPUTE_EDITED_SOURCE_FN_SOURCE,
} from '@maka/runtime';
import { posix as pathPosix } from 'node:path';
import { z } from 'zod';
import type { IsolatedToolExecutor } from './isolation.js';

/**
 * Build Maka's standard headless tool surface with shell and file operations
 * routed through the isolated executor boundary.
 */
export function buildIsolatedHeadlessTools(executor: IsolatedToolExecutor): MakaTool[] {
  return [
    buildIsolatedBashTool(executor),
    buildIsolatedReadTool(executor),
    buildIsolatedWriteTool(executor),
    buildIsolatedEditTool(executor),
    buildIsolatedGlobTool(executor),
    buildIsolatedGrepTool(executor),
    buildSubagentSpawnTool(),
    ...buildSubagentProjectionTools(),
  ];
}

export function buildIsolatedHeadlessToolAvailability(): ToolAvailabilityConfig {
  return {
    economy: true,
    groups: [{
      id: 'agent',
      label: 'Agent',
      description: 'Spawn and inspect foreground child agents.',
      toolNames: ['agent_spawn', 'agent_list', 'agent_output'],
    }],
  };
}

export function buildIsolatedBashTool(executor: IsolatedToolExecutor): MakaTool {
  return {
    name: 'Bash',
    description: 'Run a shell command in the isolated headless task workspace.',
    parameters: z.object({
      command: z.string().describe('The shell command to execute'),
      timeout_ms: z.number().int().positive().max(600_000).optional(),
    }),
    permissionRequired: true,
    impl: async ({ command, timeout_ms }, { cwd, emitOutput }) => {
      const result = await executor.exec({
        command,
        cwd,
        timeoutMs: timeout_ms ?? 120_000,
      });
      if (result.stdout) emitOutput('stdout', result.stdout);
      if (result.stderr) emitOutput('stderr', result.stderr);
      return {
        kind: 'terminal',
        cwd,
        cmd: command,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    },
  };
}

export function buildIsolatedReadTool(executor: IsolatedToolExecutor): MakaTool {
  return {
    name: 'Read',
    description: 'Read a file from the isolated headless task workspace.',
    parameters: z.object({
      path: z.string(),
      offset: z.number().int().nonnegative().optional(),
      limit: z.number().int().positive().optional(),
    }),
    permissionRequired: false,
    impl: async ({ path, offset, limit }, { cwd }) => {
      const normalizedPath = normalizeWorkspacePath(path, cwd, 'Read path');
      if (executor.readFile) return await executor.readFile({ cwd, path: normalizedPath, offset, limit });
      const stdout = await execFileCommand(executor, cwd, shellFileCommand(READ_SCRIPT, [
        normalizedPath,
        numberArg(offset),
        numberArg(limit),
      ]));
      return { content: stdout };
    },
  };
}

export function buildIsolatedWriteTool(executor: IsolatedToolExecutor): MakaTool {
  return {
    name: 'Write',
    description: 'Write content to a file in the isolated headless task workspace.',
    parameters: z.object({ path: z.string(), content: z.string() }),
    permissionRequired: true,
    impl: async ({ path, content }, { cwd }) => {
      const normalizedPath = normalizeWorkspacePath(path, cwd, 'Write path');
      if (executor.writeFile) return await executor.writeFile({ cwd, path: normalizedPath, content });
      await execFileCommand(executor, cwd, shellFileCommand(WRITE_SCRIPT, [
        normalizedPath,
        content,
      ]));
      return { ok: true, path: normalizedPath, bytes: Buffer.byteLength(content, 'utf8') };
    },
  };
}

export function buildIsolatedEditTool(executor: IsolatedToolExecutor): MakaTool {
  return {
    name: 'Edit',
    description: 'Replace an exact string in a file in the isolated headless task workspace.',
    parameters: z.object({
      path: z.string(),
      old_string: z.string(),
      new_string: z.string(),
    }),
    permissionRequired: true,
    impl: async ({ path, old_string, new_string }, { cwd }) => {
      const normalizedPath = normalizeWorkspacePath(path, cwd, 'Edit path');
      if (executor.editFile) {
        return await executor.editFile({ cwd, path: normalizedPath, oldString: old_string, newString: new_string });
      }
      // Edit is the one file tool whose matching logic is non-trivial and must
      // stay byte-identical to the in-process builtin Edit. Rather than keep a
      // second (perl) matcher, it runs the SHARED computeEditedSource via
      // `node -e` (node is guaranteed in the headless/Harbor environment); the
      // other file tools stay on the POSIX-sh scripts. old/new are base64-encoded
      // so arbitrary content survives argv transport unchanged.
      const editStdout = await execFileCommand(executor, cwd, nodeFileCommand(EDIT_SCRIPT, [
        normalizedPath,
        Buffer.from(old_string, 'utf8').toString('base64'),
        Buffer.from(new_string, 'utf8').toString('base64'),
      ]));
      return { ok: true, path: normalizedPath, replacements: 1, ...parseEditMeta(editStdout) };
    },
  };
}

export function buildIsolatedGlobTool(executor: IsolatedToolExecutor): MakaTool {
  return {
    name: 'Glob',
    description: 'Find files in the isolated headless task workspace matching a glob pattern.',
    parameters: z.object({
      pattern: z.string(),
      cwd: z.string().optional(),
    }),
    permissionRequired: false,
    impl: async ({ pattern, cwd: relCwd }, { cwd }) => {
      const normalizedPattern = normalizeWorkspaceGlobPattern(pattern, cwd, 'Glob pattern');
      const normalizedRelCwd = relCwd === undefined ? undefined : normalizeWorkspacePath(relCwd, cwd, 'Glob cwd');
      if (executor.globFiles) return await executor.globFiles({ cwd, pattern: normalizedPattern, searchCwd: normalizedRelCwd });
      const stdout = await execFileCommand(executor, cwd, shellFileCommand(GLOB_SCRIPT, [
        normalizedPattern,
        globPatternToEre(normalizedPattern),
        normalizedRelCwd ?? '',
      ]));
      return { files: parseLineArray(stdout) };
    },
  };
}

export function buildIsolatedGrepTool(executor: IsolatedToolExecutor): MakaTool {
  return {
    name: 'Grep',
    description: 'Search file contents with a regex in the isolated headless task workspace.',
    parameters: z.object({
      pattern: z.string(),
      path: z.string().optional(),
      glob: z.string().optional(),
    }),
    permissionRequired: false,
    impl: async ({ pattern, path, glob }, { cwd }) => {
      const normalizedPath = path === undefined ? undefined : normalizeWorkspacePath(path, cwd, 'Grep path');
      const normalizedGlob = glob === undefined ? undefined : normalizeWorkspaceGlobPattern(glob, cwd, 'Grep glob');
      if (executor.grepFiles) return await executor.grepFiles({
        cwd,
        pattern,
        path: normalizedPath,
        glob: normalizedGlob,
      });
      const stdout = await execFileCommand(executor, cwd, shellFileCommand(GREP_SCRIPT, [
        pattern,
        normalizedPath ?? '',
        normalizedGlob ?? '',
        normalizedGlob === undefined ? '' : globPatternToEre(normalizedGlob),
      ]));
      return { matches: parseLineArray(stdout) };
    },
  };
}

async function execFileCommand(executor: IsolatedToolExecutor, cwd: string, command: string): Promise<string> {
  const result = await executor.exec({ command, cwd, timeoutMs: 120_000 });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `isolated file command failed with exit code ${result.exitCode}`);
  }
  return result.stdout;
}

function shellFileCommand(script: string, args: string[]): string {
  return ['sh', '-c', shellQuote(script), '--', ...args.map(shellQuote)].join(' ');
}

// Like shellFileCommand but runs the script with `node -e`. Used only by Edit,
// whose matcher (computeEditedSource) is shared TypeScript that cannot be
// expressed in POSIX sh. shellQuote escapes the embedded script (including its
// single quotes) so the serialized function survives transport intact.
function nodeFileCommand(script: string, args: string[]): string {
  return ['node', '-e', shellQuote(script), '--', ...args.map(shellQuote)].join(' ');
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function numberArg(value: number | undefined): string {
  return value === undefined ? '' : String(value);
}

function parseLineArray(stdout: string): string[] {
  if (!stdout) return [];
  return stdout.replace(/\n$/, '').split('\n').filter((line) => line.length > 0);
}

// EDIT_SCRIPT applies the edit and THEN prints this metadata, so the file is
// already changed by the time we parse. matchedVia / line range are best-effort
// observability; a malformed payload must not turn a successful edit into a
// reported failure, so this fails open to {} (a protocol regression is caught by
// tests, which assert the metadata is present on success).
function parseEditMeta(stdout: string): { matchedVia?: string; startLine?: number; endLine?: number } {
  try {
    const parsed: unknown = JSON.parse(stdout || '{}');
    if (!parsed || typeof parsed !== 'object') return {};
    const { matchedVia, startLine, endLine } = parsed as Record<string, unknown>;
    return {
      matchedVia: typeof matchedVia === 'string' ? matchedVia : undefined,
      startLine: typeof startLine === 'number' ? startLine : undefined,
      endLine: typeof endLine === 'number' ? endLine : undefined,
    };
  } catch {
    return {};
  }
}

function globPatternToEre(pattern: string): string {
  let output = '^';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    const next = pattern[i + 1];
    if (ch === '*' && next === '*') {
      output += '.*';
      i += 1;
    } else if (ch === '*') {
      output += '[^/]*';
    } else if (ch === '?') {
      output += '[^/]';
    } else {
      output += escapeEreChar(ch);
    }
  }
  return `${output}$`;
}

function escapeEreChar(ch: string): string {
  return /[\\.^$+{}()[\]|]/.test(ch) ? `\\${ch}` : ch;
}

function normalizeWorkspacePath(inputPath: string, cwd: string, label: string): string {
  assertNoDriveOrParentSegment(inputPath, label);
  if (inputPath.startsWith('/')) {
    return assertNormalizedRelativePath(
      pathPosix.relative(normalizeWorkspaceRoot(cwd), pathPosix.normalize(inputPath)) || '.',
      label,
    );
  }
  return assertNormalizedRelativePath(inputPath, label);
}

function normalizeWorkspaceGlobPattern(pattern: string, cwd: string, label: string): string {
  assertNoDriveOrParentSegment(pattern, label);
  if (!pattern.startsWith('/')) return assertNormalizedRelativePath(pattern, label);
  return assertNormalizedRelativePath(pathPosix.relative(normalizeWorkspaceRoot(cwd), pattern) || '.', label);
}

function normalizeWorkspaceRoot(cwd: string): string {
  return pathPosix.normalize(cwd);
}

function assertNoDriveOrParentSegment(inputPath: string, label: string): void {
  if (
    inputPath.length === 0
    || /^[A-Za-z]:[\\/]/.test(inputPath)
    || inputPath.split(/[\\/]+/).includes('..')
  ) {
    throw new Error(`${label} must stay inside the isolated workspace`);
  }
}

function assertNormalizedRelativePath(inputPath: string, label: string): string {
  if (
    inputPath.length === 0
    || inputPath.startsWith('/')
    || /^[A-Za-z]:[\\/]/.test(inputPath)
    || inputPath.split(/[\\/]+/).includes('..')
  ) {
    throw new Error(`${label} must stay inside the isolated workspace`);
  }
  return inputPath;
}

const COMMON_SHELL_HELPERS = String.raw`
fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

inside_workspace() {
  case "$root" in
    /)
      case "$1" in /*) return 0 ;; esac
      ;;
    *)
      case "$1" in "$root"|"$root"/*) return 0 ;; esac
      ;;
  esac
  return 1
}

existing_target() {
  input_path=$1
  label=$2
  target=$root/$input_path
  [ -L "$target" ] && fail "$label must stay inside workspace"
  [ -e "$target" ] || fail "$label does not exist: $input_path"
  if [ -d "$target" ]; then
    real=$(cd -P "$target" 2>/dev/null && pwd -P) || fail "$label must stay inside workspace"
  else
    parent=$(dirname "$target")
    base=$(basename "$target")
    parent_real=$(cd -P "$parent" 2>/dev/null && pwd -P) || fail "$label must stay inside workspace"
    real=$parent_real/$base
  fi
  inside_workspace "$real" || fail "$label must stay inside workspace"
  printf '%s\n' "$real"
}

writable_target() {
  input_path=$1
  label=$2
  target=$root/$input_path
  parent=$(dirname "$target")
  base=$(basename "$target")
  parent_real=$(cd -P "$parent" 2>/dev/null && pwd -P) || fail "$label must stay inside workspace"
  inside_workspace "$parent_real" || fail "$label must stay inside workspace"
  real=$parent_real/$base
  [ -L "$real" ] && fail "$label must stay inside workspace"
  printf '%s\n' "$real"
}
`;

const READ_SCRIPT = `${COMMON_SHELL_HELPERS}
root=$(pwd -P) || exit 1
target=$(existing_target "$1" 'Read path') || exit 1
offset=$2
limit=$3
if [ -z "$offset" ] && [ -z "$limit" ]; then
  cat "$target"
else
  awk -v start="\${offset:-0}" -v limit="$limit" '
    BEGIN { first = start + 1; last = limit == "" ? 0 : start + limit; wrote = 0 }
    NR >= first && (last == 0 || NR <= last) {
      if (wrote) printf "\\n"
      printf "%s", $0
      wrote = 1
    }
  ' "$target"
fi
`;

const WRITE_SCRIPT = `${COMMON_SHELL_HELPERS}
root=$(pwd -P) || exit 1
target=$(writable_target "$1" 'Write path') || exit 1
printf '%s' "$2" > "$target"
`;

// Edit runs as a `node -e` script (not sh) so it can embed the shared
// computeEditedSource matcher verbatim — keeping a single source of truth with
// the in-process builtin Edit instead of a divergent perl reimplementation.
// Path containment mirrors COMMON_SHELL_HELPERS' existing_target(): reject a
// symlinked target outright and require the resolved path to stay inside the
// workspace root. Keep this policy in lockstep with existing_target().
const EDIT_SCRIPT = `const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const computeEditedSource = ${COMPUTE_EDITED_SOURCE_FN_SOURCE};
function inside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
function editTarget(root, inputPath, label) {
  const target = path.join(root, inputPath);
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    if (error && error.code === 'ENOENT') throw new Error(label + ' does not exist: ' + inputPath);
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Error(label + ' must stay inside workspace');
  const real = stat.isDirectory()
    ? fs.realpathSync(target)
    : path.join(fs.realpathSync(path.dirname(target)), path.basename(target));
  if (!inside(root, real)) throw new Error(label + ' must stay inside workspace');
  return real;
}
try {
  const [inputPath, oldBase64, newBase64] = process.argv.slice(1);
  const root = fs.realpathSync(process.cwd());
  const target = editTarget(root, inputPath, 'Edit path');
  const oldString = Buffer.from(oldBase64, 'base64').toString('utf8');
  const newString = Buffer.from(newBase64, 'base64').toString('utf8');
  const current = fs.readFileSync(target, 'utf8');
  const result = computeEditedSource(current, oldString, newString, inputPath);
  // Atomic write (tmp + rename), matching the prior perl EDIT_SCRIPT, so a crash
  // mid-write can never leave a torn file — only the old or the new content. The
  // temp name is unpredictable (crypto) and created with 'wx' (O_CREAT|O_EXCL),
  // so a pre-planted symlink at the temp path can neither be guessed nor
  // followed — equivalent to the old mktemp ...XXXXXX guarantees. Preserve the
  // original file's permission bits (chmod is not subject to umask) so editing a
  // restricted or executable file does not silently change its mode on rename.
  const targetMode = fs.statSync(target).mode & 0o777;
  const tmp = target + '.maka-edit.' + crypto.randomBytes(8).toString('hex');
  fs.writeFileSync(tmp, result.content, { encoding: 'utf8', flag: 'wx' });
  fs.chmodSync(tmp, targetMode);
  fs.renameSync(tmp, target);
  process.stdout.write(JSON.stringify({ matchedVia: result.matchedVia, startLine: result.startLine, endLine: result.endLine }));
} catch (error) {
  // Surface a clean message (matching the prior perl die behavior) instead of a
  // node [eval] stack trace; execFileCommand propagates stderr to the model.
  process.stderr.write(error && error.message ? error.message : String(error));
  process.exit(1);
}
`;

const GLOB_SCRIPT = `${COMMON_SHELL_HELPERS}
root=$(pwd -P) || exit 1
pattern=$1
pattern_re=$2
search_cwd=$3
if [ -n "$search_cwd" ]; then
  base=$(existing_target "$search_cwd" 'Glob cwd') || exit 1
else
  base=$root
fi
find "$base" -type f -print | awk -v root="$root" -v re="$pattern_re" '
  BEGIN { prefix = root "/"; count = 0 }
  {
    rel = $0
    if (index(rel, prefix) == 1) rel = substr(rel, length(prefix) + 1)
    if (rel ~ re) {
      print rel
      count += 1
      if (count >= 200) exit
    }
  }
'
`;

const GREP_SCRIPT = `${COMMON_SHELL_HELPERS}
root=$(pwd -P) || exit 1
grep_pattern=$1
input_path=$2
glob_re=$4
if [ -n "$input_path" ]; then
  start=$(existing_target "$input_path" 'Grep path') || exit 1
else
  start=$root
fi
if [ -f "$start" ]; then
  file_list=$start
else
  file_list=$(find "$start" -type f -print)
fi
printf '%s\n' "$file_list" | while IFS= read -r file; do
  [ -n "$file" ] || continue
  rel=$file
  prefix=$root/
  case "$rel" in "$prefix"*) rel=\${rel#"$prefix"} ;; esac
  if [ -n "$glob_re" ]; then
    printf '%s\n' "$rel" | awk -v re="$glob_re" 'BEGIN { ok = 1 } $0 ~ re { ok = 0 } END { exit ok }' || continue
  fi
  awk -v rel="$rel" -v pattern="$grep_pattern" '
    $0 ~ pattern {
      print rel ":" NR ":" $0
      count += 1
      if (count >= 50) exit
    }
  ' "$file"
done | awk 'NR <= 200'
`;
