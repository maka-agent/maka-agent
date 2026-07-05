import { useEffect, useRef, useState } from 'react';
import type { Task, TaskStatus } from '@maka/core';
import { Badge, Button as UiButton } from './ui.js';
import { RelativeTime } from './relative-time.js';

// Controlled panel (plan-reminder-panel paradigm): the session task ledger is
// owned by the model's TaskCreate/TaskUpdate tools, so this surface is
// read-mostly — the only user action is cancelling a task. Data arrives via
// props; the mount owns fetching and refresh.
export interface TaskLedgerPanelProps {
  tasks: Task[];
  onCancel?(taskId: string): void | Promise<void>;
}

const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  pending: '待处理',
  in_progress: '进行中',
  completed: '已完成',
  cancelled: '已取消',
};

const TASK_STATUS_BADGE_VARIANTS: Record<TaskStatus, 'muted' | 'success' | 'secondary' | 'warning'> = {
  pending: 'muted',
  in_progress: 'success',
  completed: 'secondary',
  cancelled: 'warning',
};

function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === 'completed' || status === 'cancelled';
}

export function TaskLedgerPanel(props: TaskLedgerPanelProps) {
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(() => new Set());
  const mountedRef = useRef(true);
  const pendingIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      pendingIdsRef.current = new Set();
    };
  }, []);

  async function cancelTask(taskId: string) {
    if (!props.onCancel || pendingIdsRef.current.has(taskId)) return;
    const withTask = new Set(pendingIdsRef.current);
    withTask.add(taskId);
    pendingIdsRef.current = withTask;
    setPendingIds(withTask);
    try {
      await props.onCancel(taskId);
    } finally {
      const withoutTask = new Set(pendingIdsRef.current);
      withoutTask.delete(taskId);
      pendingIdsRef.current = withoutTask;
      if (mountedRef.current) setPendingIds(withoutTask);
    }
  }

  const doneCount = props.tasks.filter((task) => task.status === 'completed').length;

  return (
    <section className="maka-task-panel" aria-label="会话任务清单">
      <header className="maka-task-header">
        <span className="maka-task-title">任务</span>
        <span className="maka-task-count tabular-nums" aria-label={`已完成 ${doneCount} 项，共 ${props.tasks.length} 项`}>
          {doneCount}/{props.tasks.length}
        </span>
      </header>
      {props.tasks.length === 0 ? (
        <p className="maka-task-empty">当前会话还没有任务；模型规划工作时会在这里记录进展。</p>
      ) : (
        <ul className="maka-task-list">
          {props.tasks.map((task) => {
            const cancelPending = pendingIds.has(task.id);
            return (
              <li key={task.id} className="maka-task-row" data-status={task.status}>
                <Badge variant={TASK_STATUS_BADGE_VARIANTS[task.status]} className="maka-task-status">
                  {TASK_STATUS_LABELS[task.status]}
                </Badge>
                <span className="maka-task-subject" title={task.subject}>{task.subject}</span>
                <RelativeTime ts={task.updatedAt} className="maka-task-time" />
                {!isTerminalTaskStatus(task.status) && props.onCancel ? (
                  <UiButton
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="maka-task-cancel"
                    onClick={() => void cancelTask(task.id)}
                    disabled={cancelPending}
                    aria-busy={cancelPending ? 'true' : undefined}
                    aria-label={`取消任务：${task.subject}`}
                  >
                    取消
                  </UiButton>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
