import { ChevronRight } from '@maka/ui/icons';
import { PROVIDER_DEFAULTS, type ProviderType } from '@maka/core';
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from '@maka/ui';
import { ProviderLogo, providerDisplay } from './provider-display';
import { isWiredOAuthProvider } from './provider-panel-shared';

export function ProviderCatalogCard(props: { type: ProviderType; count: number; onSelect(): void }) {
  const defaults = PROVIDER_DEFAULTS[props.type];
  const display = providerDisplay(props.type);
  const disabled = defaults.status !== 'ready';
  const disabledStatus = providerDisabledStatus(props.type);
  const title = disabled ? providerDisabledTitle(props.type) : `添加 ${display.name}`;

  if (disabled) {
    return (
      <Item
        className="providerCatalogRow rounded-none"
        data-provider={props.type}
        data-status={disabledStatus}
        data-disabled="true"
        aria-label={providerDisabledAriaLabel(props.type, display.name)}
        title={title}
      >
        <ItemMedia>
          <ProviderLogo type={props.type} />
        </ItemMedia>
        <ItemContent>
          <ItemTitle className="providerCatalogTitle">{display.name}</ItemTitle>
          <ItemDescription className="providerCatalogDesc">{display.description}</ItemDescription>
        </ItemContent>
        <ItemActions>
          <span className="providerCatalogBadge is-state" aria-hidden="true">
            {disabledStatus === 'experimental' ? '实验' : '未开放'}
          </span>
        </ItemActions>
      </Item>
    );
  }

  return (
    <Item
      className="providerCatalogRow rounded-none"
      data-provider={props.type}
      data-status="ready"
      aria-label={providerCatalogAriaLabel(display, props.count)}
      title={title}
      render={<button type="button" onClick={props.onSelect} />}
    >
      <ItemMedia>
        <ProviderLogo type={props.type} />
      </ItemMedia>
      <ItemContent>
        <ItemTitle className="providerCatalogTitle">{display.name}</ItemTitle>
        <ItemDescription className="providerCatalogDesc">
          {display.description}
          {props.count > 0 && <span className="providerCatalogCount">已配置 {props.count} 个</span>}
        </ItemDescription>
      </ItemContent>
      <ItemActions className="providerCatalogActions">
        {display.badge && <span className="providerCatalogBadge">{display.badge}</span>}
        <ChevronRight className="providerCatalogChevron" size={15} aria-hidden="true" />
      </ItemActions>
    </Item>
  );
}

function providerDisabledStatus(type: ProviderType): 'unavailable' | 'experimental' {
  return isWiredOAuthProvider(type) ? 'experimental' : 'unavailable';
}

function providerDisabledTitle(type: ProviderType): string {
  if (isWiredOAuthProvider(type)) {
    return '请在 OAuth 分类完成账号登录；登录成功后会自动出现在模型连接。';
  }
  return '该账号登录暂未接入聊天发送；当前请使用同一家厂商的模型密钥。';
}

function providerDisabledAriaLabel(type: ProviderType, name: string): string {
  if (isWiredOAuthProvider(type)) return `${name}（请从 OAuth 分类登录）`;
  return `${name}（账号登录暂未接入聊天发送）`;
}

function providerCatalogAriaLabel(display: ReturnType<typeof providerDisplay>, count: number): string {
  const parts = [`添加模型供应商：${display.name}`];
  if (display.badge) parts.push(`标签：${display.badge}`);
  parts.push(display.description.replace(/[。.!！？?]+$/u, ''));
  if (count > 0) parts.push(`已配置 ${count} 个`);
  return parts.join('，');
}
