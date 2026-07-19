import { useMemo, useState, type CSSProperties } from 'react';
import type { Task, TaskStatus } from '@maka/core';
import {
  AlertCircle,
  Ban,
  CheckCircle2,
  ChevronDown,
  CircleGauge,
  Clock,
  RefreshCcw,
  X,
} from './icons.js';
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from './primitives/collapsible.js';
import { EmptyState } from './empty-state.js';

const STATUS_LABELS: Record<TaskStatus, string> = {
  pending: '待处理',
  in_progress: '进行中',
  blocked: '已阻塞',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

const STATUS_ICONS = {
  pending: Clock,
  in_progress: CircleGauge,
  blocked: AlertCircle,
  completed: CheckCircle2,
  failed: X,
  cancelled: Ban,
} satisfies Record<TaskStatus, typeof Clock>;

export interface TaskLedgerPanelProps {
  tasks: readonly Task[];
  loading?: boolean;
  error?: string;
  onRetry?: () => void;
}

export interface TaskLedgerPanelModel {
  activeCount: number;
  activeTree: Task[];
  recentTerminalCount: number;
  recentTerminalTree: Task[];
}

export function deriveTaskLedgerPanelModel(tasks: readonly Task[]): TaskLedgerPanelModel {
  const activeSeeds = tasks.filter((task) => !isTerminal(task.status));
  const recentTerminalSeeds = tasks
    .filter((task) => isTerminal(task.status))
    .sort((a, b) => (b.endedAt ?? b.updatedAt) - (a.endedAt ?? a.updatedAt))
    .slice(0, 3);
  return {
    activeCount: activeSeeds.length,
    activeTree: orderTaskTree(withAncestors(tasks, activeSeeds)),
    recentTerminalCount: recentTerminalSeeds.length,
    recentTerminalTree: orderTaskTree(withAncestors(tasks, recentTerminalSeeds)),
  };
}

export function TaskLedgerPanel(props: TaskLedgerPanelProps) {
  const [terminalOpen, setTerminalOpen] = useState(false);
  const model = useMemo(() => deriveTaskLedgerPanelModel(props.tasks), [props.tasks]);

  return (
    <section className="maka-task-ledger-panel" aria-label="会话任务">
      {props.error ? (
        <div className="maka-task-ledger-message" role="alert">
          <span>{props.error}</span>
          {props.onRetry && (
            <button type="button" className="maka-task-ledger-retry" onClick={props.onRetry} title="重新载入任务">
              <RefreshCcw size={14} aria-hidden="true" />
              <span className="sr-only">重新载入任务</span>
            </button>
          )}
        </div>
      ) : props.loading && props.tasks.length === 0 ? (
        <div className="maka-task-ledger-message" role="status">正在载入任务…</div>
      ) : (
        <>
          {model.activeCount > 0 ? (
            <div className="maka-task-ledger-tree" role="tree" aria-label="活跃会话任务">
              {model.activeTree.map((task) => <TaskLedgerRow key={task.id} task={task} />)}
            </div>
          ) : (
            <EmptyState variant="inline" title="当前会话没有待推进任务" body="" />
          )}
          {model.recentTerminalCount > 0 && (
            <Collapsible className="maka-task-ledger-terminal" open={terminalOpen} onOpenChange={setTerminalOpen}>
              <CollapsibleTrigger className="maka-task-ledger-terminal-trigger">
                <span>最近结束</span>
                <span>{model.recentTerminalCount}<ChevronDown size={14} aria-hidden="true" data-open={terminalOpen ? 'true' : 'false'} /></span>
              </CollapsibleTrigger>
              <CollapsiblePanel>
                <div className="maka-task-ledger-tree" role="tree" aria-label="最近结束的会话任务">
                  {model.recentTerminalTree.map((task) => <TaskLedgerRow key={task.id} task={task} />)}
                </div>
              </CollapsiblePanel>
            </Collapsible>
          )}
        </>
      )}
    </section>
  );
}

function TaskLedgerRow({ task }: { task: Task }) {
  const StatusIcon = STATUS_ICONS[task.status];
  const depth = Math.max(0, task.key.split('.').length - 1);
  const detail = task.blockedReason ?? task.failureReason ?? task.completionEvidence;
  const owner = task.owner?.actor === 'child_agent'
    ? `子代理${task.owner.agentId ? ` ${task.owner.agentId}` : ''}`
    : task.owner?.actor === 'main_agent' ? '主代理' : undefined;
  return (
    <div
      className="maka-task-ledger-row"
      role="treeitem"
      aria-level={depth + 1}
      data-status={task.status}
      style={{ '--task-depth': Math.min(depth, 6) } as CSSProperties}
    >
      <StatusIcon size={14} aria-hidden="true" />
      <span className="maka-task-ledger-key">{task.key}</span>
      <span className="maka-task-ledger-subject" title={task.subject}>{task.subject}</span>
      <span className="maka-task-ledger-meta">
        <span>{STATUS_LABELS[task.status]}</span>
        {owner && <span title={owner}>{owner}</span>}
      </span>
      {detail && <span className="maka-task-ledger-detail" title={detail}>{detail}</span>}
    </div>
  );
}

function isTerminal(status: TaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function orderTaskTree(tasks: readonly Task[]): Task[] {
  return [...tasks].sort((a, b) => compareKeys(a.key, b.key));
}

function withAncestors(allTasks: readonly Task[], seeds: readonly Task[]): Task[] {
  const byId = new Map(allTasks.map((task) => [task.id, task]));
  const selected = new Map<string, Task>();
  for (const seed of seeds) {
    let current: Task | undefined = seed;
    const seen = new Set<string>();
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      selected.set(current.id, current);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
  }
  return [...selected.values()];
}

function compareKeys(left: string, right: string): number {
  const a = left.slice(1).split('.').map(Number);
  const b = right.slice(1).split('.').map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if (a[index] === undefined) return -1;
    if (b[index] === undefined) return 1;
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return 0;
}
