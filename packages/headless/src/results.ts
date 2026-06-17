import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ResultRecord } from './contracts.js';

/**
 * ResultRecord JSONL is the canonical truth — one record per line. Every
 * other view (the markdown table, a future HTML report) is derived from
 * it and never the other way around.
 */
export async function writeResults(path: string, records: ResultRecord[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const body = records.map((record) => JSON.stringify(record)).join('\n');
  await writeFile(path, records.length ? `${body}\n` : '', 'utf8');
}

export async function readResults(path: string): Promise<ResultRecord[]> {
  const raw = await readFile(path, 'utf8');
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as ResultRecord);
}

/**
 * Derive a git-diffable markdown comparison: tasks down the rows, configs
 * across the columns, a cell each, and a pass-rate footer per config.
 * Order follows first appearance in `records` so the table is stable
 * across runs of the same spec.
 *
 * Cells: ✅ completed + verified, ❌ completed but verification failed,
 * ⚠️ the run itself failed (crash / error) so the result is not trustworthy.
 */
export function toComparisonTable(records: ResultRecord[]): string {
  const taskIds = distinct(records.map((r) => r.taskId));
  const configIds = distinct(records.map((r) => r.configId));
  const byCell = new Map<string, ResultRecord>();
  for (const record of records) byCell.set(cellKey(record.taskId, record.configId), record);

  const header = `| Task | ${configIds.map(md).join(' | ')} |`;
  const divider = `| --- | ${configIds.map(() => '---').join(' | ')} |`;
  const rows = taskIds.map((taskId) => {
    const cells = configIds.map((configId) => cell(byCell.get(cellKey(taskId, configId))));
    return `| ${md(taskId)} | ${cells.join(' | ')} |`;
  });
  const passRate = configIds.map((configId) => {
    const cells = taskIds.map((taskId) => byCell.get(cellKey(taskId, configId)));
    const total = cells.filter(Boolean).length;
    const passed = cells.filter((c) => c?.status === 'completed' && c.passed).length;
    return `${passed}/${total}`;
  });
  const footer = `| **pass rate** | ${passRate.join(' | ')} |`;

  return [header, divider, ...rows, footer].join('\n') + '\n';
}

function cell(record: ResultRecord | undefined): string {
  if (!record) return '·';
  // The run itself failed (crash / provider error) — distinct from a run
  // that completed but failed verification.
  if (record.error || record.status === 'failed') return '⚠️';
  return record.passed ? '✅' : '❌';
}

/** Escape a value so an id with `|` or a newline cannot break the table. */
function md(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function cellKey(taskId: string, configId: string): string {
  return JSON.stringify([taskId, configId]);
}

function distinct(values: string[]): string[] {
  return [...new Set(values)];
}
