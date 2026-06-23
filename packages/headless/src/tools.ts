import type { MakaTool, ToolAvailabilityConfig } from '@maka/runtime';
import {
  buildSubagentProjectionTools,
  buildSubagentSpawnTool,
  COMPUTE_EDITED_SOURCE_FN_SOURCE,
  truncateToolOutput,
} from '@maka/runtime';
import { posix as pathPosix } from 'node:path';
import { z } from 'zod';
import { buildHeavyTaskEngineeringTools, type HeavyTaskEngineeringRecorder } from './heavy-task-engineering.js';
import type { HeavyTaskEvidenceRecorder } from './heavy-task-evidence.js';
import { buildHeavyTaskProgressTools, type HeavyTaskProgressRecorder } from './heavy-task-progress.js';
import { buildHeavyTaskSelfCheckTools, type HeavyTaskSelfCheckRecorder } from './heavy-task-self-check.js';
import type { IsolatedToolExecutor } from './isolation.js';

export interface BuildIsolatedHeadlessToolsOptions {
  heavyTaskEvidence?: HeavyTaskEvidenceRecorder;
  heavyTaskProgress?: HeavyTaskProgressRecorder;
  heavyTaskSelfCheck?: HeavyTaskSelfCheckRecorder;
  heavyTaskEngineering?: HeavyTaskEngineeringRecorder;
}

/**
 * Build Maka's standard headless tool surface with shell and file operations
 * routed through the isolated executor boundary.
 */
export function buildIsolatedHeadlessTools(
  executor: IsolatedToolExecutor,
  options: BuildIsolatedHeadlessToolsOptions = {},
): MakaTool[] {
  const tools = [
    buildIsolatedBashTool(executor, options),
    buildIsolatedReadTool(executor, options),
    buildIsolatedWriteTool(executor, options),
    buildIsolatedEditTool(executor, options),
    buildIsolatedGlobTool(executor, options),
    buildIsolatedGrepTool(executor, options),
    buildSubagentSpawnTool(),
    ...buildSubagentProjectionTools(),
  ];
  if (options.heavyTaskProgress) {
    tools.push(...buildHeavyTaskProgressTools(options.heavyTaskProgress));
  }
  if (options.heavyTaskSelfCheck) {
    tools.push(...buildHeavyTaskSelfCheckTools(options.heavyTaskSelfCheck));
  }
  if (options.heavyTaskEngineering) {
    tools.push(...buildHeavyTaskEngineeringTools(options.heavyTaskEngineering));
  }
  return tools;
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

export function buildIsolatedBashTool(
  executor: IsolatedToolExecutor,
  options: Pick<BuildIsolatedHeadlessToolsOptions, 'heavyTaskEvidence'> = {},
): MakaTool {
  return {
    name: 'Bash',
    description: 'Run a shell command in the isolated headless task workspace.',
    parameters: z.object({
      command: z.string().describe('The shell command to execute'),
      timeout_ms: z.number().int().positive().max(600_000).optional(),
    }),
    permissionRequired: true,
    impl: async ({ command, timeout_ms }, ctx) => {
      const { cwd, emitOutput } = ctx;
      const input = {
        command,
        cwd,
        timeoutMs: timeout_ms ?? 120_000,
      };
      // boundedTail: Bash is the one caller that wants a recoverable tail of a
      // huge, never-killed output. Read/Glob/Grep deliberately omit it so they
      // get full, head-first content from the executor.
      const result = await executor.exec({
        command: input.command,
        cwd: input.cwd,
        timeoutMs: input.timeoutMs,
        boundedTail: true,
      });
      // The isolated executor returns a single (already tail-bounded) result —
      // there is no live per-chunk channel across the executor boundary, so we
      // surface that result to history here, then bound it further for the model.
      if (result.stdout) emitOutput('stdout', result.stdout);
      if (result.stderr) emitOutput('stderr', result.stderr);
      await options.heavyTaskEvidence?.recordToolEvidence({ name: 'Bash', input, result }, ctx);
      return {
        kind: 'terminal',
        cwd,
        cmd: command,
        exitCode: result.exitCode,
        stdout: truncateToolOutput(result.stdout, { direction: 'tail' }).content,
        stderr: truncateToolOutput(result.stderr, { direction: 'tail' }).content,
      };
    },
  };
}

export function buildIsolatedReadTool(
  executor: IsolatedToolExecutor,
  options: Pick<BuildIsolatedHeadlessToolsOptions, 'heavyTaskEvidence'> = {},
): MakaTool {
  return {
    name: 'Read',
    description: 'Read a file from the isolated headless task workspace.',
    parameters: z.object({
      path: z.string(),
      offset: z.number().int().nonnegative().optional(),
      limit: z.number().int().positive().optional(),
    }),
    permissionRequired: false,
    impl: async ({ path, offset, limit }, ctx) => {
      const { cwd } = ctx;
      const normalizedPath = normalizeWorkspacePath(path, cwd, 'Read path');
      const input = { cwd, path: normalizedPath, offset, limit };
      if (executor.readFile) {
        const result = await executor.readFile(input);
        await options.heavyTaskEvidence?.recordToolEvidence({ name: 'Read', input, result }, ctx);
        return result;
      }
      const stdout = await execFileCommand(executor, cwd, shellFileCommand(READ_SCRIPT, [
        normalizedPath,
        numberArg(offset),
        numberArg(limit),
      ]));
      const result = { content: stdout };
      await options.heavyTaskEvidence?.recordToolEvidence({ name: 'Read', input, result }, ctx);
      return result;
    },
  };
}

export function buildIsolatedWriteTool(
  executor: IsolatedToolExecutor,
  options: Pick<BuildIsolatedHeadlessToolsOptions, 'heavyTaskEvidence'> = {},
): MakaTool {
  return {
    name: 'Write',
    description: 'Write content to a file in the isolated headless task workspace.',
    parameters: z.object({ path: z.string(), content: z.string() }),
    permissionRequired: true,
    impl: async ({ path, content }, ctx) => {
      const { cwd } = ctx;
      const normalizedPath = normalizeWorkspacePath(path, cwd, 'Write path');
      const input = { cwd, path: normalizedPath, content };
      if (executor.writeFile) {
        const result = await executor.writeFile(input);
        await options.heavyTaskEvidence?.recordToolEvidence({ name: 'Write', input, result }, ctx);
        return result;
      }
      await execFileCommand(executor, cwd, shellFileCommand(WRITE_SCRIPT, [
        normalizedPath,
        content,
      ]));
      const result = { ok: true, path: normalizedPath, bytes: Buffer.byteLength(content, 'utf8') };
      await options.heavyTaskEvidence?.recordToolEvidence({ name: 'Write', input, result }, ctx);
      return result;
    },
  };
}

export function buildIsolatedEditTool(
  executor: IsolatedToolExecutor,
  options: Pick<BuildIsolatedHeadlessToolsOptions, 'heavyTaskEvidence'> = {},
): MakaTool {
  return {
    name: 'Edit',
    description:
      'Replace old_string with new_string in a file in the isolated headless task workspace. '
      + 'Prefers an exact, unique match; if exact fails it tolerates limited whitespace/indentation/escape '
      + 'drift in old_string, but only when the match is unambiguous (otherwise it errors — re-read and retry '
      + 'with exact text). new_string is written verbatim, so provide the exact final text/indentation you want. '
      + 'Errors if old_string is not found or not unique.',
    parameters: z.object({
      path: z.string(),
      old_string: z.string(),
      new_string: z.string(),
    }),
    permissionRequired: true,
    impl: async ({ path, old_string, new_string }, ctx) => {
      const { cwd } = ctx;
      const normalizedPath = normalizeWorkspacePath(path, cwd, 'Edit path');
      const input = { cwd, path: normalizedPath, oldString: old_string, newString: new_string };
      // Edit ALWAYS runs the shared computeEditedSource — unlike Read/Write/Glob/
      // Grep it has NO native-executor fast path, because its matching logic is
      // non-trivial and must stay the single source of truth with the in-process
      // builtin Edit. It runs via `node -e` (node is guaranteed in the headless/
      // Harbor environment); the other file tools stay on the POSIX-sh scripts.
      // old/new are base64-encoded so arbitrary content survives argv transport.
      const editStdout = await execFileCommand(executor, cwd, nodeFileCommand(EDIT_SCRIPT, [
        normalizedPath,
        Buffer.from(old_string, 'utf8').toString('base64'),
        Buffer.from(new_string, 'utf8').toString('base64'),
      ]));
      const result = { ok: true, path: normalizedPath, replacements: 1, ...parseEditMeta(editStdout) };
      await options.heavyTaskEvidence?.recordToolEvidence({ name: 'Edit', input, result }, ctx);
      return result;
    },
  };
}

export function buildIsolatedGlobTool(
  executor: IsolatedToolExecutor,
  options: Pick<BuildIsolatedHeadlessToolsOptions, 'heavyTaskEvidence'> = {},
): MakaTool {
  return {
    name: 'Glob',
    description: 'Find files in the isolated headless task workspace matching a glob pattern.',
    parameters: z.object({
      pattern: z.string(),
      cwd: z.string().optional(),
    }),
    permissionRequired: false,
    impl: async ({ pattern, cwd: relCwd }, ctx) => {
      const { cwd } = ctx;
      const normalizedPattern = normalizeWorkspaceGlobPattern(pattern, cwd, 'Glob pattern');
      const normalizedRelCwd = relCwd === undefined ? undefined : normalizeWorkspacePath(relCwd, cwd, 'Glob cwd');
      const input = { cwd, pattern: normalizedPattern, searchCwd: normalizedRelCwd };
      if (executor.globFiles) {
        const result = await executor.globFiles(input);
        await options.heavyTaskEvidence?.recordToolEvidence({ name: 'Glob', input, result }, ctx);
        return result;
      }
      const stdout = await execFileCommand(executor, cwd, shellFileCommand(GLOB_SCRIPT, [
        normalizedPattern,
        globPatternToEre(normalizedPattern),
        normalizedRelCwd ?? '',
      ]));
      const result = { files: parseLineArray(stdout) };
      await options.heavyTaskEvidence?.recordToolEvidence({ name: 'Glob', input, result }, ctx);
      return result;
    },
  };
}

export function buildIsolatedGrepTool(
  executor: IsolatedToolExecutor,
  options: Pick<BuildIsolatedHeadlessToolsOptions, 'heavyTaskEvidence'> = {},
): MakaTool {
  return {
    name: 'Grep',
    description: 'Search file contents with a regex in the isolated headless task workspace.',
    parameters: z.object({
      pattern: z.string(),
      path: z.string().optional(),
      glob: z.string().optional(),
    }),
    permissionRequired: false,
    impl: async ({ pattern, path, glob }, ctx) => {
      const { cwd } = ctx;
      const normalizedPath = path === undefined ? undefined : normalizeWorkspacePath(path, cwd, 'Grep path');
      const normalizedGlob = glob === undefined ? undefined : normalizeWorkspaceGlobPattern(glob, cwd, 'Grep glob');
      const input = {
        cwd,
        pattern,
        path: normalizedPath,
        glob: normalizedGlob,
      };
      if (executor.grepFiles) {
        const result = await executor.grepFiles(input);
        await options.heavyTaskEvidence?.recordToolEvidence({ name: 'Grep', input, result }, ctx);
        return result;
      }
      const stdout = await execFileCommand(executor, cwd, shellFileCommand(GREP_SCRIPT, [
        pattern,
        normalizedPath ?? '',
        normalizedGlob ?? '',
        normalizedGlob === undefined ? '' : globPatternToEre(normalizedGlob),
      ]));
      const result = { matches: parseLineArray(stdout) };
      await options.heavyTaskEvidence?.recordToolEvidence({ name: 'Grep', input, result }, ctx);
      return result;
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
//
// The file is read as raw BYTES. A valid-UTF-8 file goes through the shared
// computeEditedSource (exact + fuzzy) because its utf8 round-trip is lossless; a
// binary / invalid-UTF-8 file is NEVER decoded (that would replace stray bytes
// with U+FFFD and corrupt it) — it only permits a unique, exact, byte-level
// replacement, preserving the prior perl ':raw' guarantee that an exact edit can
// never corrupt a binary file.
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
function countNewlines(buf, end) {
  let n = 0;
  for (let i = 0; i < end; i++) if (buf[i] === 10) n += 1;
  return n;
}
function writeAtomic(target, data) {
  // Atomic write (tmp + rename), matching the prior perl EDIT_SCRIPT, so a crash
  // mid-write can never leave a torn file — only the old or the new content. The
  // temp name is unpredictable (crypto) and created with 'wx' (O_CREAT|O_EXCL) at
  // the target's OWN permission bits, so a pre-planted symlink at the temp path
  // can neither be guessed nor followed, and the temp is never briefly wider than
  // the target. A chmod after creation still applies any bits umask stripped. On
  // a later failure we unlink ONLY the temp we created (guarded by 'created'), so
  // a partial/looser-mode file is never left and a foreign file at an EEXIST temp
  // path is never deleted.
  const mode = fs.statSync(target).mode & 0o777;
  const tmp = target + '.maka-edit.' + crypto.randomBytes(8).toString('hex');
  let created = false;
  try {
    fs.writeFileSync(tmp, data, { flag: 'wx', mode: mode });
    created = true;
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, target);
  } catch (error) {
    if (created) { try { fs.unlinkSync(tmp); } catch (_) {} }
    throw error;
  }
}
try {
  const [inputPath, oldBase64, newBase64] = process.argv.slice(1);
  const root = fs.realpathSync(process.cwd());
  const target = editTarget(root, inputPath, 'Edit path');
  const raw = fs.readFileSync(target);
  const source = raw.toString('utf8');
  if (Buffer.compare(Buffer.from(source, 'utf8'), raw) === 0) {
    // Valid UTF-8: the decode is lossless, so the shared matcher (exact + fuzzy)
    // runs on the decoded text with no risk of byte corruption.
    const oldString = Buffer.from(oldBase64, 'base64').toString('utf8');
    const newString = Buffer.from(newBase64, 'base64').toString('utf8');
    const result = computeEditedSource(source, oldString, newString, inputPath);
    writeAtomic(target, Buffer.from(result.content, 'utf8'));
    process.stdout.write(JSON.stringify({ matchedVia: result.matchedVia, startLine: result.startLine, endLine: result.endLine }));
  } else {
    // Binary / invalid UTF-8: never decode. Allow only a unique, exact, byte-level
    // replacement so an exact edit can never corrupt the file; fuzzy is impossible
    // here by construction (it needs text).
    const oldBuf = Buffer.from(oldBase64, 'base64');
    const newBuf = Buffer.from(newBase64, 'base64');
    if (oldBuf.length === 0) throw new Error('old_string must not be empty in ' + inputPath);
    const first = raw.indexOf(oldBuf);
    if (first === -1) {
      throw new Error('Refusing a non-exact match in ' + inputPath + ': the file is not valid UTF-8 (looks binary). Re-read it and pass the exact bytes to replace.');
    }
    if (raw.indexOf(oldBuf, first + oldBuf.length) !== -1) {
      throw new Error('old_string is not unique in ' + inputPath + ' (binary file: the exact bytes match more than once)');
    }
    writeAtomic(target, Buffer.concat([raw.slice(0, first), newBuf, raw.slice(first + oldBuf.length)]));
    const startLine = countNewlines(raw, first) + 1;
    const endsWithNewline = oldBuf[oldBuf.length - 1] === 10;
    const spanLineCount = Math.max(countNewlines(oldBuf, oldBuf.length) + 1 - (endsWithNewline ? 1 : 0), 1);
    process.stdout.write(JSON.stringify({ matchedVia: 'exact', startLine: startLine, endLine: startLine + spanLineCount - 1 }));
  }
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
