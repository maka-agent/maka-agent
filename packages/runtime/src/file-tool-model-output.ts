import { countDiffLineStats } from '@maka/core';
import type { ToolResultOutput } from './model-protocol.js';
import { toolResultOutput } from './tool-result-output.js';

/**
 * The diff is for the reader; the model is owed only what happened — a bounded
 * one-line summary. Editing is the hottest tool in the loop, so anything
 * attached to its output compounds across a turn; the full diff stays in the
 * durable result where the UI renders it.
 */
export function fileWriteToolResultToModelOutput(
  toolName: 'Write' | 'Edit' | 'FormatJson',
  output: unknown,
): ToolResultOutput {
  const summary = fileWriteToolResultSummary(toolName, output);
  return summary !== undefined ? { type: 'text', value: summary } : toolResultOutput(output, false);
}

export function applyPatchToolResultToModelOutput(output: unknown): ToolResultOutput {
  const result = applyPatchResult(output);
  if (!result) return toolResultOutput(output, false);
  const completed = result.operations
    .filter((operation) => operation.status === 'completed')
    .map((operation) => `${patchOperationMarker(operation.operation)} ${operation.path}`);
  if (result.ok) {
    return {
      type: 'text',
      value: `Applied patch:${completed.length ? `\n${completed.join('\n')}` : ''}`,
    };
  }
  const prefix =
    completed.length > 0 ? `Patch partially applied:\n${completed.join('\n')}` : 'Patch failed';
  const error = typeof result.error === 'string' ? `\n${result.error.slice(0, 240)}` : '';
  return { type: 'text', value: `${prefix}${error}` };
}

/**
 * Replay counterpart of `fileWriteToolResultToModelOutput`. The durable ledger
 * keeps the full diff for the UI, and every model re-read of history — prior
 * turns, compaction, resume — flows through the replay plan. Without this
 * projection the model saw a one-line summary live but the full diff JSON on
 * every later turn, which is both a token leak and a shape inconsistency.
 * Same precedent as `projectBashToolResultForModel`.
 */
export function projectFileWriteToolResultForModel(toolName: string, output: unknown): unknown {
  if (toolName === 'ApplyPatch') {
    const projected = applyPatchToolResultToModelOutput(output);
    return projected.type === 'text' ? projected.value : output;
  }
  if (toolName !== 'Edit' && toolName !== 'Write' && toolName !== 'FormatJson') return output;
  return fileWriteToolResultSummary(toolName, output) ?? output;
}

function applyPatchResult(output: unknown):
  | {
      ok: boolean;
      error?: string;
      operations: { operation: 'add' | 'update' | 'delete'; path: string; status: string }[];
    }
  | undefined {
  if (typeof output !== 'object' || output === null) return undefined;
  const value = output as { ok?: unknown; error?: unknown; operations?: unknown };
  if (typeof value.ok !== 'boolean' || !Array.isArray(value.operations)) return undefined;
  const operations = value.operations.filter(
    (
      operation,
    ): operation is {
      operation: 'add' | 'update' | 'delete';
      path: string;
      status: string;
    } => {
      if (typeof operation !== 'object' || operation === null) return false;
      const item = operation as { operation?: unknown; path?: unknown; status?: unknown };
      return (
        (item.operation === 'add' || item.operation === 'update' || item.operation === 'delete') &&
        typeof item.path === 'string' &&
        typeof item.status === 'string'
      );
    },
  );
  return {
    ok: value.ok,
    operations,
    ...(typeof value.error === 'string' ? { error: value.error } : {}),
  };
}

function patchOperationMarker(operation: 'add' | 'update' | 'delete'): 'A' | 'M' | 'D' {
  if (operation === 'add') return 'A';
  if (operation === 'delete') return 'D';
  return 'M';
}

function fileWriteToolResultSummary(
  toolName: 'Write' | 'Edit' | 'FormatJson',
  output: unknown,
): string | undefined {
  if (isFileDiff(output)) {
    const path = output.paths[0] ?? 'file';
    const { additions, deletions } = countDiffLineStats(output.diff);
    if (toolName === 'Write' && output.diff.startsWith('--- /dev/null'))
      return `Created ${path} (+${additions})`;
    const verb = toolName === 'Write' ? 'Overwrote' : toolName === 'Edit' ? 'Edited' : 'Formatted';
    return `${verb} ${path} (+${additions} -${deletions})`;
  }
  if (isFileWrite(output)) return `Wrote ${output.bytes} bytes to ${output.path}`;
  return undefined;
}

function isFileDiff(
  output: unknown,
): output is { kind: 'file_diff'; paths: string[]; diff: string } {
  return (
    typeof output === 'object' &&
    output !== null &&
    (output as { kind?: unknown }).kind === 'file_diff' &&
    Array.isArray((output as { paths?: unknown }).paths) &&
    typeof (output as { diff?: unknown }).diff === 'string'
  );
}

function isFileWrite(
  output: unknown,
): output is { kind: 'file_write'; path: string; bytes: number } {
  return (
    typeof output === 'object' &&
    output !== null &&
    (output as { kind?: unknown }).kind === 'file_write' &&
    typeof (output as { bytes?: unknown }).bytes === 'number'
  );
}
