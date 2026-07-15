import { useEffect, useState, type CSSProperties } from 'react';
import {
  PrimitiveTabs,
  PrimitiveTabsList,
  PrimitiveTabsPanel,
  PrimitiveTabsTrigger,
  TaskLedgerPanel,
  deriveTaskLedgerPanelModel,
  type TaskLedgerPanelProps,
} from '@maka/ui';
import { ArtifactPane } from './artifact-pane';
import { BrowserPanel } from './browser-panel';
import type { SessionWorkbarTab } from './session-workbar-layout';

export function SessionWorkbar(props: {
  sessionId: string;
  tasks: TaskLedgerPanelProps;
  browserLive: boolean;
  hidden: boolean;
  width: number;
  onDismiss: () => void;
  activeTab: SessionWorkbarTab;
  onActiveTabChange: (tab: SessionWorkbarTab) => void;
}) {
  const taskCount = deriveTaskLedgerPanelModel(props.tasks.tasks).activeCount;
  const [artifactCount, setArtifactCount] = useState(0);

  useEffect(() => {
    if (props.activeTab === 'browser' && !props.browserLive) props.onActiveTabChange('tasks');
  }, [props.activeTab, props.browserLive, props.onActiveTabChange]);

  return (
    <aside
      className="maka-session-workbar"
      aria-label="会话工作栏"
      style={{ '--maka-session-workbar-width': `${props.width}px` } as CSSProperties}
    >
      <PrimitiveTabs value={props.activeTab} onValueChange={(value) => props.onActiveTabChange(value as SessionWorkbarTab)} className="maka-session-workbar-tabs">
        <PrimitiveTabsList variant="underline" className="maka-session-workbar-tab-list" aria-label="会话工作栏栏目">
          <PrimitiveTabsTrigger value="tasks">
            <span>任务</span>
            <span className="maka-session-workbar-count">{taskCount}</span>
          </PrimitiveTabsTrigger>
          <PrimitiveTabsTrigger value="browser" disabled={!props.browserLive}>
            <span>浏览器</span>
            <span className="maka-session-workbar-count">{props.browserLive ? 1 : 0}</span>
          </PrimitiveTabsTrigger>
          <PrimitiveTabsTrigger value="files">
            <span>文件</span>
            <span className="maka-session-workbar-count">{artifactCount}</span>
          </PrimitiveTabsTrigger>
        </PrimitiveTabsList>
        <PrimitiveTabsPanel value="tasks" className="maka-session-workbar-panel" keepMounted>
          <TaskLedgerPanel {...props.tasks} />
        </PrimitiveTabsPanel>
        <PrimitiveTabsPanel value="browser" className="maka-session-workbar-panel" keepMounted>
          {props.browserLive && <BrowserPanel sessionId={props.sessionId} hidden={props.hidden || props.activeTab !== 'browser'} />}
        </PrimitiveTabsPanel>
        <PrimitiveTabsPanel value="files" className="maka-session-workbar-panel" keepMounted>
          <ArtifactPane sessionId={props.sessionId} onCountChange={setArtifactCount} onDismiss={props.onDismiss} />
        </PrimitiveTabsPanel>
      </PrimitiveTabs>
    </aside>
  );
}
