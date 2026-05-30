import { Notification, systemPreferences } from 'electron';
import {
  BOT_PROVIDERS,
  deriveCapabilityReadiness,
  runtimeProbeFromBotReadiness,
  type AppSettings,
  type BotProvider,
  type CapabilityActionApprovalSignal,
  type CapabilityConfigurationSignal,
  type CapabilityFeatureSignal,
  type CapabilityMemoryAcceptanceSignal,
  type CapabilityPermissionRequirement,
  type CapabilityRuntimeProbeSignal,
  type CapabilitySnapshot,
  type CapabilitySnapshotCollection,
  type OsPermissionId,
  type OsPermissionSnapshot,
  type OsPermissionState,
  type PermissionSnapshot,
} from '@maka/core';
import type { BotStatus } from '@maka/runtime';
import type { OfficeCliProbe } from './officecli-probe.js';

const MAC_TCC_PERMISSIONS: OsPermissionId[] = ['accessibility', 'screen_recording', 'microphone', 'automation'];

export function buildPermissionSnapshot(now = Date.now(), platform: NodeJS.Platform = process.platform): PermissionSnapshot {
  return {
    checkedAt: now,
    platform,
    permissions: {
      accessibility: accessibilitySnapshot(now, platform),
      screen_recording: mediaPermissionSnapshot('screen_recording', 'screen', now, platform),
      microphone: mediaPermissionSnapshot('microphone', 'microphone', now, platform),
      notifications: notificationSnapshot(now, platform),
      automation: automationSnapshot(now, platform),
    },
  };
}

export function buildCapabilitySnapshotCollection(input: {
  settings: AppSettings;
  permissions: PermissionSnapshot;
  botStatuses: Record<BotProvider, BotStatus>;
  officeCliProbe?: OfficeCliProbe;
  now?: number;
}): CapabilitySnapshotCollection {
  const now = input.now ?? Date.now();
  const permissions = input.permissions.permissions;
  const capabilities: CapabilitySnapshot[] = [
    staticCapability({
      id: 'computer_use',
      label: 'Computer Use',
      now,
      feature: { state: 'not_available', source: 'scaffold', reason: '本机控制需要独立权限确认与审计；当前不可执行' },
      requiredPermissions: [
        { id: 'accessibility', required: true, status: permissions.accessibility.status },
        { id: 'screen_recording', required: true, status: permissions.screen_recording.status },
      ],
      actionApproval: { state: 'required_per_action', source: 'capability_policy' },
      memoryAcceptance: { state: 'not_applicable', source: 'not_applicable' },
      runtimeProbe: { state: 'not_available', source: 'not_applicable' },
    }),
    staticCapability({
      id: 'activity_recorder',
      label: 'Activity Recorder',
      now,
      feature: {
        state: 'partial',
        source: 'runtime',
        reason: 'Daily Review 已聚合本地会话 / 工具 / 模型活动；当前不包含屏幕与应用级录制',
      },
      requiredPermissions: [
        { id: 'screen_recording', required: true, status: permissions.screen_recording.status },
      ],
      actionApproval: { state: 'not_required', source: 'not_applicable' },
      memoryAcceptance: { state: 'disabled', source: 'memory_contract' },
      runtimeProbe: {
        state: 'not_run',
        source: 'runtime_probe',
        reason: '打开 Daily Review 可查看本地活动聚合结果',
      },
    }),
    staticCapability({
      id: 'voice',
      label: 'Voice',
      now,
      feature: {
        state: 'partial',
        source: 'runtime',
        reason: '本地麦克风录音自检已可用；当前不包含 STT/TTS 生成通道',
      },
      requiredPermissions: [
        { id: 'microphone', required: true, status: permissions.microphone.status },
      ],
      actionApproval: { state: 'not_required', source: 'not_applicable' },
      memoryAcceptance: { state: 'disabled', source: 'memory_contract' },
      runtimeProbe: {
        state: 'not_run',
        source: 'runtime_probe',
        reason: '在 Settings · 语音模型运行本地录音自检',
      },
    }),
    staticCapability({
      id: 'open_gateway',
      label: 'Open Gateway',
      now,
      feature: {
        state: input.settings.openGateway.enabled ? 'enabled' : 'disabled',
        source: 'settings',
        reason: input.settings.openGateway.enabled ? undefined : '本地 Gateway 已关闭',
      },
      requiredPermissions: [],
      actionApproval: { state: 'required_per_action', source: 'capability_policy' },
      memoryAcceptance: { state: 'not_applicable', source: 'not_applicable' },
      runtimeProbe: {
        state: input.settings.openGateway.enabled && input.settings.openGateway.token ? 'not_run' : 'not_available',
        source: input.settings.openGateway.enabled ? 'runtime_probe' : 'not_applicable',
        reason: input.settings.openGateway.enabled && !input.settings.openGateway.token ? '等待生成访问 token' : undefined,
      },
    }),
    staticCapability({
      id: 'memory_write',
      label: 'Memory',
      now,
      feature: {
        state: 'partial',
        source: 'runtime',
        reason: '本地 MEMORY.md 已可见；自动抽取/写入仍需用户确认',
      },
      requiredPermissions: [],
      actionApproval: { state: 'not_required', source: 'not_applicable' },
      memoryAcceptance: { state: 'draft_required', source: 'memory_contract' },
      runtimeProbe: {
        state: 'not_run',
        source: 'runtime_probe',
        reason: '透明本地记忆为文件读写能力，不做后台探测',
      },
    }),
    officeDocumentsCapability(input.officeCliProbe, now),
    ...BOT_PROVIDERS.map((provider) =>
      botCapability(provider, input.settings, input.botStatuses[provider], now),
    ),
  ];

  return { checkedAt: now, capabilities };
}

function officeDocumentsCapability(probe: OfficeCliProbe | undefined, now: number): CapabilitySnapshot {
  const available = probe?.available === true;
  const feature: CapabilityFeatureSignal = {
    state: available ? 'enabled' : 'partial',
    source: 'runtime',
    reason: available
      ? 'Office 文档可通过本地 officecli 读取、校验与按次授权编辑。'
      : 'Office 文档工作流已接入；安装 officecli 并确认版本探测通过后即可读取、校验与按次授权编辑。',
  };
  const runtimeProbe: CapabilityRuntimeProbeSignal = available
    ? {
        state: 'healthy',
        source: 'runtime_probe',
        lastCheckedAt: probe.checkedAt,
        reason: `officecli ${probe.version}`,
      }
    : {
        state: 'degraded',
        source: 'runtime_probe',
        lastCheckedAt: probe?.checkedAt ?? now,
        reason: officeCliProbeReason(probe),
      };
  const guidance = available
    ? []
    : [
        '安装 officecli 后重启 Maka 或刷新能力快照。',
        '安装后在终端确认 `officecli --version` 可以输出版本号。',
      ];

  return staticCapability({
    id: 'office_documents',
    label: 'Office 文档',
    now,
    feature,
    requiredPermissions: [],
    actionApproval: { state: 'required_per_action', source: 'capability_policy' },
    memoryAcceptance: { state: 'not_applicable', source: 'not_applicable' },
    runtimeProbe,
    guidance,
  });
}

function officeCliProbeReason(probe: OfficeCliProbe | undefined): string {
  if (!probe) return '等待刷新 OfficeCLI 状态。';
  if (probe.available) return `officecli ${probe.version}`;
  switch (probe.reason) {
    case 'missing':
      return '未在 PATH 中找到 officecli。';
    case 'timeout':
      return 'officecli 版本探测超时。';
    case 'failed':
      return 'officecli 版本探测失败。';
  }
}

function staticCapability(input: {
  id: CapabilitySnapshot['id'];
  label: string;
  now: number;
  feature: CapabilityFeatureSignal;
  requiredPermissions: CapabilityPermissionRequirement[];
  actionApproval: CapabilityActionApprovalSignal;
  memoryAcceptance: CapabilityMemoryAcceptanceSignal;
  runtimeProbe: CapabilityRuntimeProbeSignal;
  guidance?: string[];
}): CapabilitySnapshot {
  const configuration: CapabilityConfigurationSignal = { state: 'not_required', source: 'not_applicable' };
  return {
    id: input.id,
    label: input.label,
    readiness: deriveCapabilityReadiness({
      feature: input.feature,
      configuration,
      osPermissions: input.requiredPermissions,
      runtimeProbe: input.runtimeProbe,
    }),
    feature: input.feature,
    configuration,
    osPermissions: input.requiredPermissions,
    actionApproval: input.actionApproval,
    memoryAcceptance: input.memoryAcceptance,
    runtimeProbe: input.runtimeProbe,
    canRevoke: false,
    canPause: input.feature.state === 'enabled',
    guidance: input.guidance ?? [],
    auditEvents: [],
    updatedAt: input.now,
  };
}

function botCapability(
  provider: BotProvider,
  settings: AppSettings,
  status: BotStatus,
  now: number,
): CapabilitySnapshot {
  const channel = settings.botChat.channels[provider];
  const hasConfig = Boolean(channel.token.trim() || channel.appId || channel.appSecret);
  const feature: CapabilityFeatureSignal = {
    state: channel.enabled ? 'enabled' : 'disabled',
    source: 'settings',
  };
  const configuration: CapabilityConfigurationSignal = hasConfig
    ? { state: 'present', source: 'settings' }
    : { state: 'missing', source: 'settings', reason: 'missing platform credentials' };
  const runtimeProbe = runtimeProbeFromBotReadiness(
    status.readiness,
    channel.readinessUpdatedAt,
    status.reason ?? channel.readinessReason,
  );

  return {
    id: `bot:${provider}`,
    label: `${provider} Bot`,
    readiness: deriveCapabilityReadiness({
      feature,
      configuration,
      osPermissions: [],
      runtimeProbe,
    }),
    feature,
    configuration,
    osPermissions: [],
    actionApproval: { state: 'not_required', source: 'not_applicable' },
    memoryAcceptance: { state: 'disabled', source: 'memory_contract' },
    runtimeProbe,
    canRevoke: channel.enabled || hasConfig,
    canPause: channel.enabled,
    guidance: [],
    auditEvents: [],
    updatedAt: now,
  };
}

function accessibilitySnapshot(now: number, platform: NodeJS.Platform): OsPermissionSnapshot {
  if (platform !== 'darwin') return unsupportedPermission('accessibility', now, 'macOS TCC only');
  try {
    const granted = systemPreferences.isTrustedAccessibilityClient(false);
    return {
      id: 'accessibility',
      status: granted ? 'granted' : 'not_determined',
      source: 'electron',
      checkedAt: now,
      reason: granted ? undefined : 'macOS does not expose denied vs not determined for Accessibility',
      canOpenSettings: true,
      canRequest: false,
    };
  } catch (error) {
    return unknownPermission('accessibility', now, generalizedReason(error), true);
  }
}

function mediaPermissionSnapshot(
  id: 'screen_recording' | 'microphone',
  mediaType: 'screen' | 'microphone',
  now: number,
  platform: NodeJS.Platform,
): OsPermissionSnapshot {
  if (platform !== 'darwin' && id === 'screen_recording') {
    return unsupportedPermission(id, now, 'macOS TCC only');
  }
  try {
    const status = mapMediaAccessStatus(systemPreferences.getMediaAccessStatus(mediaType));
    return {
      id,
      status,
      source: 'electron',
      checkedAt: now,
      canOpenSettings: platform === 'darwin',
      canRequest: id === 'microphone' && status === 'not_determined',
    };
  } catch (error) {
    return unknownPermission(id, now, generalizedReason(error), platform === 'darwin');
  }
}

function notificationSnapshot(now: number, platform: NodeJS.Platform): OsPermissionSnapshot {
  return {
    id: 'notifications',
    status: Notification.isSupported() ? 'unknown' : 'unsupported',
    source: 'electron',
    checkedAt: now,
    reason: Notification.isSupported() ? 'main process cannot read notification grant state yet' : 'Electron Notification unsupported',
    canOpenSettings: platform === 'darwin',
    canRequest: Notification.isSupported(),
  };
}

function automationSnapshot(now: number, platform: NodeJS.Platform): OsPermissionSnapshot {
  if (platform !== 'darwin') return unsupportedPermission('automation', now, 'macOS TCC only');
  return {
    id: 'automation',
    status: 'unknown',
    source: 'static',
    checkedAt: now,
    reason: 'no Electron API for per-target Apple Events TCC status',
    canOpenSettings: true,
    canRequest: false,
  };
}

function unsupportedPermission(id: OsPermissionId, now: number, reason: string): OsPermissionSnapshot {
  return {
    id,
    status: 'unsupported',
    source: MAC_TCC_PERMISSIONS.includes(id) ? 'platform' : 'static',
    checkedAt: now,
    reason,
    canOpenSettings: false,
    canRequest: false,
  };
}

function unknownPermission(
  id: OsPermissionId,
  now: number,
  reason: string,
  canOpenSettings: boolean,
): OsPermissionSnapshot {
  return {
    id,
    status: 'unknown',
    source: 'electron',
    checkedAt: now,
    reason,
    canOpenSettings,
    canRequest: false,
  };
}

function mapMediaAccessStatus(status: string): OsPermissionState {
  switch (status) {
    case 'granted':
      return 'granted';
    case 'denied':
    case 'restricted':
      return 'denied';
    case 'not-determined':
      return 'not_determined';
    default:
      return 'unknown';
  }
}

function generalizedReason(error: unknown): string {
  return error instanceof Error ? error.message : 'permission probe failed';
}
