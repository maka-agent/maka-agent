/**
 * Right-side collapsible task rail for the chat shell.
 *
 * The session task ledger is persistent state (unlike the transient tool /
 * reasoning / streaming surfaces in the main column), so it lives in its own
 * rail instead of competing for main-column vertical space. Layout follows
 * the ArtifactPane collapsible-aside precedent: fixed expanded width,
 * thin collapsed strip, localStorage-remembered collapse state, and
 * `return null` when there is nothing to show (the rail never reserves
 * space for an empty ledger).
 *
 * The rail is only the collapse shell — list rendering, cancel affordance,
 * focus recovery, and the aria-live announcement all stay in the controlled
 * `TaskLedgerPanel` (@maka/ui).
 */
import { useEffect, useState } from 'react';
import type { Task } from '@maka/core';
import { ChevronLeft, ChevronRight } from '@maka/ui/icons';
import { Button, Tooltip, TooltipContent, TooltipTrigger } from '@maka/ui';
import { TaskLedgerPanel } from '@maka/ui/task-ledger-panel';
import { safeLocalStorageGet, safeLocalStorageSet } from './browser-storage';

const COLLAPSE_KEY = 'maka-task-rail-collapsed-v1';

export function TaskRail(props: {
  tasks: Task[];
  onCancel?: (taskId: string) => void | Promise<void>;
}) {
  const [collapsed, setCollapsed] = useState<boolean>(() => readCollapsed());

  useEffect(() => {
    safeLocalStorageSet(COLLAPSE_KEY, collapsed ? '1' : '0');
  }, [collapsed]);

  // No tasks → no rail. The host also gates the mount, but the guard keeps
  // the "never reserve space for an empty ledger" contract local.
  if (props.tasks.length === 0) return null;

  const total = props.tasks.length;
  const hasInProgress = props.tasks.some((task) => task.status === 'in_progress');

  return (
    <aside
      className="maka-task-rail"
      data-collapsed={collapsed ? 'true' : 'false'}
      aria-label="会话任务栏"
    >
      <header className="maka-task-rail-header">
        <Tooltip>
          <TooltipTrigger
            render={<Button variant="quiet" size="icon-sm" />}
            type="button"
            className="maka-task-rail-collapse"
            onClick={() => setCollapsed((current) => !current)}
            aria-pressed={collapsed}
            aria-expanded={!collapsed}
            aria-label={collapsed ? `展开任务栏（共 ${total} 项任务）` : '折叠任务栏'}
          >
            {collapsed ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}
          </TooltipTrigger>
          <TooltipContent>{collapsed ? '展开任务栏' : '折叠任务栏'}</TooltipContent>
        </Tooltip>
      </header>
      {collapsed ? (
        // Screen readers get the count via the toggle's aria-label; the strip
        // itself is a purely visual affordance.
        <div className="maka-task-rail-strip" aria-hidden="true">
          <span className="maka-task-rail-strip-label">任务</span>
          <span className="maka-task-rail-strip-count tabular-nums">{total}</span>
          {hasInProgress && <span className="maka-task-rail-strip-dot" />}
        </div>
      ) : (
        <div className="maka-task-rail-body">
          <TaskLedgerPanel tasks={props.tasks} onCancel={props.onCancel} />
        </div>
      )}
    </aside>
  );
}

function readCollapsed(): boolean {
  // Absent key → expanded: a fresh profile (and the visual-smoke fixture's
  // isolated userDataDir) shows the rail open by default.
  return safeLocalStorageGet(COLLAPSE_KEY) === '1';
}
