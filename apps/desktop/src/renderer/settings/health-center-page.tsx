import { useEffect, useState } from 'react';
import type {
  HealthSignal,
  HealthSignalLayer,
  HealthSignalSource,
  HealthSignalStatus,
  HealthSnapshot,
} from '@maka/core';
import { HEALTH_SIGNAL_LAYERS } from '@maka/core';
import { Button, Badge, RelativeTime, PageHeader, StatTile } from '@maka/ui';
import { settingsActionErrorMessage } from './settings-error-copy';
import { statusBadgeVariant } from './settings-status-badge';
import { SettingsSkeletonStack } from './settings-skeleton';

/**
 * PR-UI-9 — Health Center read-only page. Consumes `window.maka.health.getSnapshot()`
 * (shipped by @xuan PR-HC-1).
 *
 * Hard contract (per @xuan): "validation/config/permission/runtime 别聚成
 * 一个绿点". The UI groups signals by `layer` and renders each in its own
 * section so the user sees WHICH layer is okay and WHICH is degraded.
 *
 * Status semantics ≠ tone-by-color only. `ok` (validation pass) on an LLM
 * connection does NOT promote it to operational — that requires a runtime
 * probe in PR-REAL-4. The detail copy below makes the distinction explicit.
 *
 * Read-only boundary: no test buttons, no repair flows. Test/repair entries
 * will be wired in PR-HC-2 once typed actions are exposed.
 */
const HEALTH_LAYER_COPY: Record<HealthSignalLayer, { label: string; description: string }> = {
  configuration: { label: '配置', description: '是否填齐了设置页里的必填项。' },
  validation: { label: '验证', description: '凭据 / 端点的连通性测试结果，仅代表验证通过，不等于发送通路可用。' },
  permission: { label: '系统权限', description: '所需 OS / TCC 权限是否已授权。' },
  feature: { label: '功能开关', description: '功能是否被显式启用、当前是否可使用。' },
  action_approval: { label: '操作审批', description: '每次工具调用 / 高危操作的审批策略状态。' },
  memory_acceptance: { label: '记忆写入', description: '是否接受了记忆写入约定、是否启用了记忆写入。' },
  runtime_probe: { label: '运行态探测', description: '最近一次真实运行（发送 / 流式 / 接收事件）的探测结果。' },
  storage: { label: '存储', description: '工作区文件、JSONL、SQLite 等本地存储健康度。' },
};

const HEALTH_STATUS_COPY: Record<HealthSignalStatus, { label: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'destructive' }> = {
  // Status-color restraint (#651 rule): 正常 is the EXPECTED state — neutral
  // ink; color stays reserved for the signals that need attention.
  ok: { label: '正常', tone: 'neutral' },
  info: { label: '提示', tone: 'info' },
  warning: { label: '警告', tone: 'warning' },
  error: { label: '错误', tone: 'destructive' },
  unknown: { label: '未知', tone: 'neutral' },
};

const HEALTH_SCOPE_LABEL: Record<HealthSignal['scope'], string> = {
  app: '应用',
  llm_connection: 'LLM 连接',
  bot: '机器人',
  capability: '能力',
  storage: '存储',
};

const HEALTH_SOURCE_LABEL: Record<HealthSignalSource, string> = {
  connection_test: '连接测试',
  capability_snapshot: '能力快照',
  permission_snapshot: '权限快照',
  runtime_probe: '运行态探测',
  settings: '设置',
  storage: '本地存储',
};

export function HealthCenterPage() {
  const [snapshot, setSnapshot] = useState<HealthSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    window.maka.health
      .getSnapshot()
      .then((next) => {
        if (cancelled) return;
        setSnapshot(next);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(settingsActionErrorMessage(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshTick]);

  if (loading) {
    return (
      <SettingsSkeletonStack label="正在加载健康快照" />
    );
  }

  if (error || !snapshot) {
    return (
      <div className="settingsHealthPage">
        <div className="settingsHealthError" role="alert">
          <strong>无法读取健康快照</strong>
          <small>{error ?? '健康服务未返回数据。'}</small>
          <Button type="button" onClick={() => setRefreshTick((tick) => tick + 1)}>
            重新读取
          </Button>
        </div>
      </div>
    );
  }

  const healthCheckedAtMs = snapshot.checkedAt;
  const signalsByLayer = groupSignalsByLayer(snapshot.signals);
  const blocksSendCount = snapshot.signals.filter((signal) => signal.blocksSend).length;
  const blocksCapabilityCount = snapshot.signals.filter((signal) => signal.blocksCapability).length;

  return (
    <div className="settingsHealthPage">
      <PageHeader
        className="settingsHealthIntro"
        as="h3"
        title="健康中心"
        subtitle={
          <>
            按层级（配置 · 验证 · 权限 · 功能 · 操作审批 · 记忆 · 运行态 · 存储）展示当前快照。
            <strong>验证通过 ≠ 运行可用</strong> — 凭据测试只属于验证层；发送通路以运行态探测结果为准。
          </>
        }
        meta={
          <div className="settingsHealthMeta">
            <Badge variant="info">只读快照</Badge>
            <small>
              最近一次读取：<RelativeTime ts={healthCheckedAtMs} className="settingsHelpInlineTime" />
            </small>
            <Button
              type="button"
              className="settingsHealthRefresh"
              variant="secondary"
              onClick={() => setRefreshTick((tick) => tick + 1)}
            >
              刷新
            </Button>
          </div>
        }
      />

      {/* PR-HEALTH-SUMMARY-LIST-A11Y-0 (round 19/30): fifth
          application of the ARIA list semantics fix. Was
          `<section role="list">` containing 5 `<div
          role="listitem">` tiles — switched to semantic
          `<ul>` / `<li>`. The HealthSummaryTile component
          drops its `role="listitem"` because the `<li>`
          wrapper already carries it. */}
      <ul aria-label="健康摘要" className="settingsHealthSummary">
        <HealthSummaryTile tone="neutral" label="正常" count={snapshot.summary.ok} />
        <HealthSummaryTile tone="info" label="提示" count={snapshot.summary.info} />
        <HealthSummaryTile tone="warning" label="警告" count={snapshot.summary.warning} />
        <HealthSummaryTile tone="destructive" label="错误" count={snapshot.summary.error} />
        <HealthSummaryTile tone="neutral" label="未知" count={snapshot.summary.unknown} />
      </ul>

      {(blocksSendCount > 0 || blocksCapabilityCount > 0) && (
        <div className="settingsHealthBlockers" role="status">
          {blocksSendCount > 0 && (
            <Badge variant="destructive">
              {blocksSendCount} 条健康信号会阻塞发送
            </Badge>
          )}
          {blocksCapabilityCount > 0 && (
            <Badge variant="warning">
              {blocksCapabilityCount} 条健康信号会阻塞能力
            </Badge>
          )}
        </div>
      )}

      {HEALTH_SIGNAL_LAYERS.map((layer) => {
        const signals = signalsByLayer[layer];
        if (!signals || signals.length === 0) return null;
        const copy = HEALTH_LAYER_COPY[layer];
        return (
          <section key={layer} className="settingsHealthLayer" aria-label={`${copy.label}健康信号`}>
            <header>
              <h4>{copy.label}</h4>
              <small>{copy.description}</small>
            </header>
            <ul className="settingsHealthSignalList" aria-label={`${copy.label}健康信号列表`}>
              {signals.map((signal) => (
                <HealthSignalRow key={signal.id} signal={signal} />
              ))}
            </ul>
          </section>
        );
      })}

      <p className="settingsHealthFootnote">
        本页不直接执行测试、修复或权限变更；它只汇总当前已记录的健康信号。
        需要处理问题时，请进入对应设置页或重新触发相关功能。
      </p>
    </div>
  );
}

function HealthSummaryTile(props: {
  tone: 'neutral' | 'info' | 'success' | 'warning' | 'destructive';
  label: string;
  count: number;
}) {
  // Convergence R4: same StatTile as the permission summary — the two
  // recipes were literal twins hand-rolled twice.
  return (
    <StatTile
      as="li"
      className="settingsHealthSummaryTile"
      label={props.label}
      value={props.count}
      tone={props.tone}
    />
  );
}

function HealthSignalRow(props: { signal: HealthSignal }) {
  const { signal } = props;
  const statusCopy = HEALTH_STATUS_COPY[signal.status];
  return (
    <li className="settingsHealthSignalRow" data-status={signal.status}>
      <div className="settingsHealthSignalHeader">
        <div className="settingsHealthSignalHeading">
          <strong>{signal.label}</strong>
          <small className="settingsHealthSignalScope">{HEALTH_SCOPE_LABEL[signal.scope]}</small>
        </div>
        <Badge variant={statusBadgeVariant(statusCopy.tone)}>{statusCopy.label}</Badge>
      </div>
      <p className="settingsHealthSignalMessage">{signal.message}</p>
      {signal.detail && <small className="settingsHealthSignalDetail">{signal.detail}</small>}
      <div className="settingsHealthSignalMeta">
        <span>来源：{HEALTH_SOURCE_LABEL[signal.source]}</span>
        <span>
          读取：<RelativeTime ts={signal.checkedAt} className="settingsHelpInlineTime" />
        </span>
        {signal.blocksSend && <span className="settingsHealthSignalBlocker" data-tone="destructive">阻塞发送</span>}
        {signal.blocksCapability && <span className="settingsHealthSignalBlocker" data-tone="warning">阻塞能力</span>}
      </div>
    </li>
  );
}

function groupSignalsByLayer(signals: HealthSignal[]): Record<HealthSignalLayer, HealthSignal[]> {
  const byLayer: Record<HealthSignalLayer, HealthSignal[]> = {
    configuration: [],
    validation: [],
    permission: [],
    feature: [],
    action_approval: [],
    memory_acceptance: [],
    runtime_probe: [],
    storage: [],
  };
  for (const signal of signals) {
    byLayer[signal.layer].push(signal);
  }
  return byLayer;
}
