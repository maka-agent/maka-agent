import type { ReactNode } from 'react';
import { ChevronRight } from '@maka/ui/icons';
import type { BotChannelSettings, BotProvider } from '@maka/core';
import type { BotStatus } from '@maka/runtime';
import { BOT_PROVIDERS } from '@maka/core/settings';
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
  Button,
  Chip,
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
  RelativeTime,
} from '@maka/ui';
import { deriveBotChannelViewState } from './bot-settings-view-model';
import { BOT_LABELS, BotBrandLogo, botReadinessCopyForSupport, botStatusDetail } from './bot-chat-shared';

/**
 * Remote-access overview: the "正在使用" list of configured channels plus
 * the catalog of platforms that can still be connected. Pure presentation —
 * the page owns status fetching and routing, this component derives the
 * per-channel view rows during render.
 */
export function BotChatOverview(props: {
  channels: Record<BotProvider, BotChannelSettings>;
  statuses: Record<BotProvider, BotStatus> | null;
  statusLoadError: string | null;
  onOpenChannel(provider: BotProvider): void;
  onRefreshStatuses(): Promise<boolean>;
}) {
  const overviewChannels = BOT_PROVIDERS.map((provider, index) => {
    const providerChannel = props.channels[provider];
    const providerStatus = props.statuses?.[provider];
    const providerSupport = BOT_LABELS[provider].support;
    const providerViewState = deriveBotChannelViewState({
      channel: providerChannel,
      status: providerStatus,
    });
    const providerCopy = botReadinessCopyForSupport(providerSupport, providerViewState.readiness);
    return {
      provider,
      index,
      status: providerStatus,
      support: providerSupport,
      copy: providerCopy,
      configured: providerViewState.configured,
      needsAttention: providerViewState.needsAttention,
      currentError: providerViewState.currentError,
      liveOperational: providerViewState.liveOperational,
    };
  });
  const activeChannels = overviewChannels
    .filter((entry) => entry.configured)
    .sort((left, right) => {
      if (left.needsAttention !== right.needsAttention) return left.needsAttention ? -1 : 1;
      const activityDelta = (right.status?.lastEventAt ?? 0) - (left.status?.lastEventAt ?? 0);
      return activityDelta || left.index - right.index;
    });
  const availableChannels = overviewChannels.filter((entry) => !entry.configured);

  return (
    <div className="settingsRemoteAccessOverview">
      {props.statusLoadError && (
        <Alert variant="error">
          <AlertTitle>远程接入状态载入失败</AlertTitle>
          <AlertDescription>{props.statusLoadError}</AlertDescription>
          <AlertAction>
            <Button type="button" variant="secondary" onClick={() => void props.onRefreshStatuses()}>
              重新载入
            </Button>
          </AlertAction>
        </Alert>
      )}

      <section className="settingsRemoteAccessSection" aria-labelledby="remote-access-active-heading">
        <div className="settingsRemoteAccessSectionHeader">
          <h3 id="remote-access-active-heading">正在使用</h3>
          <span>按需要处理、最近活动排序</span>
        </div>
        <div className="settingsRemoteAccessActiveList">
          {activeChannels.length === 0 ? (
            <Item className="settingsRemoteAccessEmptyRow" interactive={false}>
              <ItemContent>
                <ItemTitle>还没有正在使用的渠道</ItemTitle>
                <ItemDescription>从下方选择一个消息平台开始配置。</ItemDescription>
              </ItemContent>
            </Item>
          ) : activeChannels.map((entry) => (
            <Item
              key={entry.provider}
              className="settingsRemoteAccessChannelRow"
              data-attention={entry.needsAttention ? 'true' : undefined}
              render={(
                <button
                  type="button"
                  aria-label={`管理 ${BOT_LABELS[entry.provider].label}，${entry.copy.label}`}
                  aria-describedby={`settings-remote-access-${entry.provider}-summary`}
                  onClick={() => props.onOpenChannel(entry.provider)}
                />
              )}
            >
              <ItemMedia><BotBrandLogo provider={entry.provider} /></ItemMedia>
              <ItemContent>
                <ItemTitle>
                  {BOT_LABELS[entry.provider].label}
                  <Chip dot size="sm" variant={entry.copy.tone}>{entry.copy.label}</Chip>
                </ItemTitle>
                <ItemDescription id={`settings-remote-access-${entry.provider}-summary`}>
                  {botOverviewDetail(entry.status, entry.currentError, entry.copy.detail, entry.liveOperational)}
                </ItemDescription>
              </ItemContent>
              <ItemActions><ChevronRight size={16} aria-hidden="true" /></ItemActions>
            </Item>
          ))}
        </div>
      </section>

      <section className="settingsRemoteAccessSection" aria-labelledby="remote-access-available-heading">
        <div className="settingsRemoteAccessSectionHeader">
          <h3 id="remote-access-available-heading">接入更多渠道</h3>
          <span>选择平台开始配置</span>
        </div>
        <div className="settingsRemoteAccessCatalog">
          {availableChannels.map((entry) => (
            <Item
              key={entry.provider}
              className="settingsRemoteAccessCatalogRow"
              data-support={entry.support}
              render={(
                <button
                  type="button"
                  aria-label={`接入 ${BOT_LABELS[entry.provider].label}`}
                  onClick={() => props.onOpenChannel(entry.provider)}
                />
              )}
            >
              <ItemMedia><BotBrandLogo provider={entry.provider} /></ItemMedia>
              <ItemContent>
                <ItemTitle>{BOT_LABELS[entry.provider].label}</ItemTitle>
                <ItemDescription>{BOT_LABELS[entry.provider].help}</ItemDescription>
              </ItemContent>
              <ItemActions><ChevronRight size={16} aria-hidden="true" /></ItemActions>
            </Item>
          ))}
        </div>
      </section>
    </div>
  );
}

function botOverviewDetail(
  status: BotStatus | undefined,
  currentError: string | undefined,
  fallback: string,
  liveOperational: boolean,
): ReactNode {
  const identity = status?.identity?.username ?? status?.identity?.displayName;
  if (liveOperational) {
    return (
      <>
        监听中{identity ? ` · ${identity}` : ''}
        {status?.lastEventAt ? <> · <RelativeTime ts={status.lastEventAt} /></> : ''}
      </>
    );
  }
  if (currentError) return currentError;
  if (status?.reason) return botStatusDetail(status);
  return fallback;
}
