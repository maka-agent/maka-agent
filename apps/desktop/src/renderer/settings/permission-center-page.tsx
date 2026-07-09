import { useEffect, useRef, useState, type ComponentType } from 'react';
import {
  Accessibility as AccessibilityIcon,
  Bell,
  Mic,
  Monitor,
  MousePointer2,
  type LucideProps,
} from '@maka/ui/icons';
import type {
  CapabilityId,
  CapabilityReadinessState,
  CapabilitySnapshot,
  CapabilitySnapshotCollection,
  OsPermissionId,
  OsPermissionSnapshot,
  OsPermissionState,
  PermissionSnapshot,
} from '@maka/core';
import { OS_PERMISSION_IDS } from '@maka/core';
import { Button, Badge, RelativeTime, PageHeader, StatTile, useToast } from '@maka/ui';
import { settingsActionErrorMessage } from './settings-error-copy';
import { statusBadgeVariant } from './settings-status-badge';
import { SettingsSkeletonStack } from './settings-skeleton';

/**
 * PR-UI-8 — Permission Center read-only page. Consumes `window.maka.permissions.getSnapshot()`
 * and `window.maka.capabilities.getSnapshot()` (both shipped by @xuan PR-REAL-2).
 *
 * Stage 1 Hard Gate contract:
 * - Renders the live snapshot per capability with explicit four-layer breakdown
 *   (OS permission · feature toggle · action approval · memory acceptance), so
 *   the user can see WHY each capability lands on its readiness state.
 * - Surfaces every OS permission separately at the bottom so users can verify
 *   the underlying TCC state without re-deriving it from capabilities.
 * - **Read-only by design.** @xuan/@kenji review (2026-05-22): the UI must
 *   NOT pretend to revoke OS TCC or guide the user through grant flows here;
 *   that lands in PR-CU-0 / PR-CU-1 once the drag-`.app` helper exists.
 * - Audit hint slot is reserved (`auditEvents` is empty for now) — once
 *   PR-REAL-3 wires the audit log, the slot fills without UI change.
 */
const CAPABILITY_READINESS_COPY: Record<CapabilityReadinessState, { label: string; detail: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'destructive' }> = {
  not_configured: { label: '等待配置', detail: '需要先打开开关或补齐配置才能启用。', tone: 'neutral' },
  denied: { label: '系统拒绝', detail: '所需系统权限被拒绝或当前平台不支持。', tone: 'destructive' },
  enabled: { label: '运行可用', detail: '当前快照标记为可用，具体层级见下方。', tone: 'success' },
  degraded: { label: '部分可用', detail: '已有一部分能力可用，但仍有运行态、权限或子功能需要处理。', tone: 'warning' },
  paused: { label: '已暂停', detail: '功能开关被显式关闭，但配置仍保留。', tone: 'info' },
};

interface OsPermissionUiCopy {
  label: string;
  purpose: string;
  impact: string;
  icon: ComponentType<LucideProps>;
}

const OS_PERMISSION_COPY: Record<OsPermissionId, OsPermissionUiCopy> = {
  accessibility: {
    label: '辅助功能',
    purpose: 'Computer Use 需要它来读取窗口焦点 / 模拟键盘鼠标。',
    impact: 'Computer Use · 自动化键鼠操作',
    icon: AccessibilityIcon,
  },
  screen_recording: {
    label: '屏幕录制',
    purpose: 'Computer Use 需要它来读取窗口内容；未来屏幕活动录制也会使用。',
    impact: 'Computer Use · 截屏上下文',
    icon: Monitor,
  },
  microphone: {
    label: '麦克风',
    purpose: 'Voice 通道需要它来采集语音输入。',
    impact: '语音输入',
    icon: Mic,
  },
  notifications: {
    label: '通知',
    purpose: '权限申请、回顾完成等系统通知需要它。',
    impact: '权限申请提醒 · 每日回顾完成通知',
    icon: Bell,
  },
  automation: {
    label: '自动化（Apple Events）',
    purpose: 'Computer Use 控制其他 App 需要逐 target 授权。',
    impact: 'Computer Use · 跨 App 自动化',
    icon: MousePointer2,
  },
};

const OS_PERMISSION_STATE_COPY: Record<OsPermissionState, { label: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'destructive' }> = {
  unsupported: { label: '当前平台不支持', tone: 'neutral' },
  unknown: { label: '无法读取状态', tone: 'neutral' },
  not_determined: { label: '等待授权', tone: 'warning' },
  denied: { label: '已拒绝', tone: 'destructive' },
  // Status-color restraint: granted is the expected state — neutral badge;
  // color is reserved for the states that need the user's attention.
  granted: { label: '已授权', tone: 'neutral' },
};

const OFFICECLI_INSTALL_COMMAND = 'curl -fsSL https://raw.githubusercontent.com/iOfficeAI/OfficeCLI/main/install.sh | bash';
const OFFICECLI_RELEASES_URL = 'https://github.com/iOfficeAI/OfficeCLI/releases';

export function PermissionCenterPage() {
  const [permissions, setPermissions] = useState<PermissionSnapshot | null>(null);
  const [capabilities, setCapabilities] = useState<CapabilitySnapshotCollection | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [pendingPermAction, setPendingPermAction] = useState<string | null>(null);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const toast = useToast();
  const mountedRef = useRef(true);
  const pendingPermActionRef = useRef<string | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      pendingPermActionRef.current = null;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      window.maka.permissions.getSnapshot(),
      window.maka.capabilities.getSnapshot(),
    ])
      .then(([perm, caps]) => {
        if (cancelled) return;
        setPermissions(perm);
        setCapabilities(caps);
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

  async function runPermissionAction(
    permId: OsPermissionId,
    kind: 'request' | 'openSettings',
  ) {
    const actionKey = `${permId}:${kind}`;
    if (pendingPermActionRef.current) return;
    pendingPermActionRef.current = actionKey;
    setPendingPermAction(actionKey);
    try {
      const result =
        kind === 'request'
          ? await window.maka.permissions.requestAccess(permId)
          : await window.maka.permissions.openSystemSettings(permId);
      if (result.ok) {
        // Refresh snapshot so the user sees the new state when they
        // return from System Settings.
        if (mountedRef.current) setRefreshTick((tick) => tick + 1);
      } else if (mountedRef.current) {
        toast.error('权限操作失败', permissionActionFailureCopy(result.reason, result.message));
      }
    } catch (err) {
      if (mountedRef.current) toast.error('权限操作失败', settingsActionErrorMessage(err));
    } finally {
      if (pendingPermActionRef.current === actionKey) {
        pendingPermActionRef.current = null;
      }
      if (mountedRef.current) setPendingPermAction(null);
    }
  }

  if (loading) {
    return (
      <SettingsSkeletonStack label="正在加载权限快照" />
    );
  }

  if (error || !permissions || !capabilities) {
    return (
      <div className="settingsPermissionPage">
        <div className="settingsPermissionError" role="alert">
          <strong>无法读取权限快照</strong>
          <small>{error ?? '权限服务未返回数据。'}</small>
          <Button type="button" onClick={() => setRefreshTick((tick) => tick + 1)}>
            重新读取
          </Button>
        </div>
      </div>
    );
  }

  const checkedAtMs = capabilities.checkedAt;
  const counts = summarizePermissionStatuses(permissions);

  return (
    <div className="settingsPermissionPage">
      <PageHeader
        className="settingsPermissionIntro"
        as="h3"
        title="权限与能力"
        subtitle="查看 Maka 需要的系统权限和当前授权状态，直接从这里前往「系统设置 → 隐私与安全性」完成授权或撤销，不必自己翻菜单。"
        meta={
          <div className="settingsPermissionMeta">
            <small>
              最近读取：<RelativeTime ts={checkedAtMs} className="settingsHelpInlineTime" />
            </small>
            <Button
              type="button"
              className="settingsPermissionRefresh"
              variant="secondary"
              onClick={() => setRefreshTick((tick) => tick + 1)}
            >
              重新检测
            </Button>
          </div>
        }
      />

      <section className="settingsPermissionSummary" aria-label="权限概览">
        <PermissionSummaryTile label="已授权" value={counts.granted} tone="success" />
        <PermissionSummaryTile label="等待授权" value={counts.pending} tone="warning" />
        <PermissionSummaryTile label="已拒绝" value={counts.denied} tone="destructive" />
        <PermissionSummaryTile label="未知 / 不支持" value={counts.other} tone="neutral" />
      </section>

      <section aria-label="系统权限" className="settingsPermissionSection">
        <header>
          <h4>系统权限</h4>
          <small>Maka 读到的 OS 级权限状态。点击右侧按钮可以直接前往「系统设置 → 隐私与安全性」对应分区。</small>
        </header>
        <ul className="settingsOsPermissionList" aria-label="系统权限列表">
          {OS_PERMISSION_IDS.map((id) => (
            <OsPermissionRow
              key={id}
              snapshot={permissions.permissions[id]}
              busy={pendingPermAction !== null}
              pendingKey={pendingPermAction === `${id}:request` ? 'request' : pendingPermAction === `${id}:openSettings` ? 'openSettings' : null}
              onRequest={() => void runPermissionAction(id, 'request')}
              onOpenSettings={() => void runPermissionAction(id, 'openSettings')}
            />
          ))}
        </ul>
      </section>

      <section aria-label="功能能力" className="settingsPermissionSection">
        <header className="settingsPermissionSectionHeader">
          <div>
            <h4>功能能力</h4>
            <small>每个能力的就绪状态由「功能开关 · 配置 · 系统权限 · 运行态探测」共同决定。</small>
          </div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => setDiagnosticsOpen((open) => !open)}
            aria-expanded={diagnosticsOpen}
          >
            {diagnosticsOpen ? '收起详情' : '展开详情'}
          </Button>
        </header>
        <ul className="settingsCapabilityList" aria-label="功能能力列表" data-diagnostics-open={diagnosticsOpen ? 'true' : undefined}>
          {capabilities.capabilities.map((capability) => (
            <CapabilityRow key={capability.id} capability={capability} />
          ))}
        </ul>
      </section>

      <p className="settingsPermissionFootnote">
        Maka 不会自动授予 Accessibility、Automation 或 Screen Recording。
        高风险自动化能力必须保持逐项审批、可审计、可撤销。
        这里只读取系统权限与功能能力的当前快照，授权变更仍需在「系统设置 → 隐私与安全性」完成。
      </p>
    </div>
  );
}

function PermissionSummaryTile(props: {
  label: string;
  value: number;
  tone: 'success' | 'warning' | 'destructive' | 'neutral';
}) {
  // Convergence R4: StatTile owns the recipe (incl. the zero-is-not-an-
  // exception tone gate this tile pioneered).
  return (
    <StatTile
      className="settingsPermissionSummaryTile"
      label={props.label}
      value={props.value}
      tone={props.tone}
    />
  );
}

function summarizePermissionStatuses(snapshot: PermissionSnapshot): {
  granted: number;
  pending: number;
  denied: number;
  other: number;
} {
  let granted = 0;
  let pending = 0;
  let denied = 0;
  let other = 0;
  for (const id of OS_PERMISSION_IDS) {
    const status = snapshot.permissions[id]?.status;
    switch (status) {
      case 'granted':
        granted += 1;
        break;
      case 'not_determined':
        pending += 1;
        break;
      case 'denied':
        denied += 1;
        break;
      default:
        other += 1;
    }
  }
  return { granted, pending, denied, other };
}

function permissionActionFailureCopy(reason: string, message?: string): string {
  switch (reason) {
    case 'invalid_id':
      return '内部错误：权限 id 无法识别。';
    case 'unsupported_platform':
      return '当前操作系统不支持这个权限操作。';
    case 'unsupported_permission':
      return '当前平台没有提供这个权限的直接入口。';
    case 'failed':
      return message ?? '权限操作未成功，请稍后重试。';
    default:
      return message ?? '权限操作未成功，请稍后重试。';
  }
}

function CapabilityRow(props: { capability: CapabilitySnapshot }) {
  const { capability } = props;
  const toast = useToast();
  const [copyingOfficeCliInstall, setCopyingOfficeCliInstall] = useState(false);
  const copyingOfficeCliInstallRef = useRef(false);
  const capabilityRowMountedRef = useRef(false);
  const readinessCopy = CAPABILITY_READINESS_COPY[capability.readiness];
  const showOfficeCliInstallActions =
    capability.id === 'office_documents' && capability.runtimeProbe.state !== 'healthy';

  useEffect(() => {
    capabilityRowMountedRef.current = true;
    return () => {
      capabilityRowMountedRef.current = false;
      copyingOfficeCliInstallRef.current = false;
    };
  }, []);

  async function copyOfficeCliInstallCommand() {
    if (copyingOfficeCliInstallRef.current) return;
    copyingOfficeCliInstallRef.current = true;
    setCopyingOfficeCliInstall(true);
    try {
      await navigator.clipboard.writeText(OFFICECLI_INSTALL_COMMAND);
      if (capabilityRowMountedRef.current) {
        toast.success('已复制安装命令', '在终端执行后点击刷新重新探测。');
      }
    } catch {
      if (capabilityRowMountedRef.current) {
        toast.error('复制失败', '剪贴板不可用或被系统拒绝。');
      }
    } finally {
      copyingOfficeCliInstallRef.current = false;
      if (capabilityRowMountedRef.current) {
        setCopyingOfficeCliInstall(false);
      }
    }
  }

  return (
    <li className="settingsCapabilityRow" data-readiness={capability.readiness}>
      <div className="settingsCapabilityHeader">
        <div className="settingsCapabilityHeading">
          <strong>{capability.label}</strong>
          <small className="settingsCapabilityId">{prettyCapabilityId(capability.id)}</small>
        </div>
        <Badge variant={statusBadgeVariant(readinessCopy.tone)}>{readinessCopy.label}</Badge>
      </div>
      <p className="settingsCapabilityDetail">{readinessCopy.detail}</p>
      <dl className="settingsCapabilityLayers" aria-label={`${capability.label}能力状态明细`}>
        <div>
          <dt>功能开关</dt>
          <dd data-tone={featureTone(capability.feature.state)}>
            {featureLabel(capability.feature.state)}
            {capability.feature.reason && <small>{capability.feature.reason}</small>}
          </dd>
        </div>
        <div>
          <dt>配置</dt>
          <dd data-tone={configurationTone(capability.configuration.state)}>
            {configurationLabel(capability.configuration.state)}
            {capability.configuration.reason && <small>{capability.configuration.reason}</small>}
          </dd>
        </div>
        <div>
          <dt>操作审批</dt>
          <dd data-tone={actionApprovalTone(capability.actionApproval.state)}>
            {actionApprovalLabel(capability.actionApproval.state)}
          </dd>
        </div>
        <div>
          <dt>记忆写入</dt>
          <dd data-tone={memoryAcceptanceTone(capability.memoryAcceptance.state)}>
            {memoryAcceptanceLabel(capability.memoryAcceptance.state)}
          </dd>
        </div>
        <div>
          <dt>运行态探测</dt>
          <dd data-tone={runtimeProbeTone(capability.runtimeProbe.state)}>
            {runtimeProbeLabel(capability.runtimeProbe.state)}
            {capability.runtimeProbe.reason && <small>{capability.runtimeProbe.reason}</small>}
          </dd>
        </div>
      </dl>
      {capability.osPermissions.length > 0 && (
        <div className="settingsCapabilityOsPermissions">
          <span>所需系统权限</span>
          <ul aria-label={`${capability.label}所需系统权限列表`}>
            {capability.osPermissions.map((req) => (
              <li key={req.id}>
                <span>{OS_PERMISSION_COPY[req.id]?.label ?? req.id}</span>
                <em data-tone={OS_PERMISSION_STATE_COPY[req.status].tone}>
                  {OS_PERMISSION_STATE_COPY[req.status].label}
                </em>
              </li>
            ))}
          </ul>
        </div>
      )}
      {capability.guidance.length > 0 && (
        <div className="settingsCapabilityGuidance">
          <span>处理建议</span>
          <ul aria-label={`${capability.label}处理建议列表`}>
            {capability.guidance.map((item, index) => (
              <li key={`${capability.id}-guidance-${index}`}>{item}</li>
            ))}
          </ul>
          {showOfficeCliInstallActions && (
            <div className="settingsCapabilityGuidanceActions" role="group" aria-label="Office 文档安装辅助">
              <code>{OFFICECLI_INSTALL_COMMAND}</code>
              <div>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={copyingOfficeCliInstall}
                  onClick={() => void copyOfficeCliInstallCommand()}
                >
                  {copyingOfficeCliInstall ? '复制中…' : '复制 macOS/Linux 安装命令'}
                </Button>
                <a href={OFFICECLI_RELEASES_URL} target="_blank" rel="noreferrer noopener">
                  打开二进制下载页
                </a>
              </div>
            </div>
          )}
        </div>
      )}
      {/*
        PR-UX-POLISH-1 commit 2 (yuejing UX audit + xuan ROADMAP-SURFACE-0 +
        kenji boundary 1): unavailable pause/revoke chips looked like
        disabled toggles, which violates the capability presentation
        contract. Keep them hidden until there are real actions with
        `data-state="available"`.
      */}
      <div className="settingsCapabilityAuditSlot" aria-hidden={capability.auditEvents.length === 0}>
        {capability.auditEvents.length === 0 ? (
          <small>暂无审计记录。</small>
        ) : (
          <ul aria-label={`${capability.label}审计记录列表`}>
            {capability.auditEvents.slice(-3).map((event, index) => (
              <li key={`${capability.id}-audit-${index}`}>{event}</li>
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}

function OsPermissionRow(props: {
  snapshot: OsPermissionSnapshot;
  busy: boolean;
  pendingKey: 'request' | 'openSettings' | null;
  onRequest: () => void;
  onOpenSettings: () => void;
}) {
  const { snapshot, busy, pendingKey } = props;
  const copy = OS_PERMISSION_COPY[snapshot.id];
  const Icon = copy?.icon;
  const label = copy?.label ?? snapshot.id;
  const purpose = copy?.purpose ?? '';
  const impact = copy?.impact ?? '';
  const stateCopy = OS_PERMISSION_STATE_COPY[snapshot.status];

  const showRequest = snapshot.canRequest && snapshot.status !== 'granted';
  const showOpenSettings = snapshot.canOpenSettings && snapshot.status !== 'granted';

  return (
    <li className="settingsOsPermissionRow" data-state={snapshot.status}>
      <div className="settingsOsPermissionIcon" aria-hidden="true">
        {Icon ? <Icon size={18} /> : null}
      </div>
      <div className="settingsOsPermissionBody">
        <div className="settingsOsPermissionHeading">
          <strong>{label}</strong>
          <Badge variant={statusBadgeVariant(stateCopy.tone)}>{stateCopy.label}</Badge>
        </div>
        <small className="settingsOsPermissionPurpose">{purpose}</small>
        {impact ? (
          <small className="settingsOsPermissionImpact">
            <span className="settingsOsPermissionImpactLabel">影响功能</span>
            <span>{impact}</span>
          </small>
        ) : null}
        {snapshot.reason ? (
          <small className="settingsOsPermissionReason">{snapshot.reason}</small>
        ) : null}
      </div>
      {/* PR-PERMISSIONS-UNIFIED-CARD-0 (WAWQAQ msg `d3ea9a33`
          2026-06-26): the action buttons used to stack vertically with
          two competing button styles (primary + secondary). Order so
          the primary "请求授权" anchors the right edge, with the
          system-settings link as a quieter ghost variant on the left.
          When only one button is shown (e.g. the OS doesn't expose a
          request flow for the permission), it still falls under the
          primary slot — no awkward "lonely secondary" state. */}
      <div className="settingsOsPermissionActions">
        {/* Affordance honesty (round 8): ghost next to the primary read as a
            plain text label — a clickable action sitting beside a real button
            needs its own visible edge. Secondary keeps it quieter than
            请求授权 without hiding that it's a button. */}
        {showOpenSettings && (
          <Button
            type="button"
            variant={showRequest ? 'secondary' : 'default'}
            size="sm"
            onClick={props.onOpenSettings}
            disabled={busy}
            aria-busy={pendingKey === 'openSettings' ? 'true' : undefined}
          >
            {pendingKey === 'openSettings' ? '打开中…' : '前往系统设置'}
          </Button>
        )}
        {showRequest && (
          <Button
            type="button"
            size="sm"
            onClick={props.onRequest}
            disabled={busy}
            aria-busy={pendingKey === 'request' ? 'true' : undefined}
          >
            {pendingKey === 'request' ? '请求中…' : '请求授权'}
          </Button>
        )}
      </div>
    </li>
  );
}

function prettyCapabilityId(id: CapabilityId): string {
  return id;
}

function featureLabel(state: CapabilitySnapshot['feature']['state']): string {
  switch (state) {
    case 'enabled': return '已开启';
    case 'partial': return '部分可用';
    case 'disabled': return '已关闭';
    case 'not_available': return '未开放';
  }
}
function featureTone(state: CapabilitySnapshot['feature']['state']): 'neutral' | 'info' | 'success' | 'warning' | 'destructive' {
  if (state === 'enabled') return 'success';
  if (state === 'partial') return 'warning';
  if (state === 'disabled') return 'info';
  return 'neutral';
}

function configurationLabel(state: CapabilitySnapshot['configuration']['state']): string {
  switch (state) {
    case 'not_required': return '不需要配置';
    case 'missing': return '等待补齐配置';
    case 'present': return '已填写';
  }
}
function configurationTone(state: CapabilitySnapshot['configuration']['state']): 'neutral' | 'info' | 'success' | 'warning' | 'destructive' {
  if (state === 'present') return 'success';
  if (state === 'missing') return 'warning';
  return 'neutral';
}

function actionApprovalLabel(state: CapabilitySnapshot['actionApproval']['state']): string {
  switch (state) {
    case 'not_required': return '不需要审批';
    case 'required_per_action': return '每次调用都需审批';
    case 'pending': return '审批挂起';
    case 'approved': return '当前会话已批准';
    case 'denied': return '当前会话已拒绝';
  }
}
function actionApprovalTone(state: CapabilitySnapshot['actionApproval']['state']): 'neutral' | 'info' | 'success' | 'warning' | 'destructive' {
  if (state === 'approved') return 'success';
  if (state === 'denied') return 'destructive';
  if (state === 'pending') return 'warning';
  if (state === 'required_per_action') return 'info';
  return 'neutral';
}

function memoryAcceptanceLabel(state: CapabilitySnapshot['memoryAcceptance']['state']): string {
  switch (state) {
    case 'not_applicable': return '不涉及记忆写入';
    case 'disabled': return '记忆写入已关闭';
    case 'draft_required': return '需要先草拟 memory 协议';
    case 'accepted': return '记忆写入已接受';
  }
}
function memoryAcceptanceTone(state: CapabilitySnapshot['memoryAcceptance']['state']): 'neutral' | 'info' | 'success' | 'warning' | 'destructive' {
  if (state === 'accepted') return 'success';
  if (state === 'draft_required') return 'warning';
  return 'neutral';
}

function runtimeProbeLabel(state: CapabilitySnapshot['runtimeProbe']['state']): string {
  switch (state) {
    case 'not_available': return '尚无运行态探测';
    case 'not_run': return '探测未运行';
    case 'healthy': return '探测通过';
    case 'degraded': return '探测降级';
  }
}
function runtimeProbeTone(state: CapabilitySnapshot['runtimeProbe']['state']): 'neutral' | 'info' | 'success' | 'warning' | 'destructive' {
  if (state === 'healthy') return 'success';
  if (state === 'degraded') return 'destructive';
  if (state === 'not_run') return 'warning';
  return 'neutral';
}
