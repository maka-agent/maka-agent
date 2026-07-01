import { useEffect, useRef, useState } from 'react';
import { PROVIDER_DEFAULTS, validateSlug, type ProviderType } from '@maka/core';
import { Button, Input } from '@maka/ui';
import { buildCatalogRecommendedDefaultModel } from '../model-catalog-choices';
import { providerDisplay } from './provider-display';
import {
  categoryLabel,
  isWiredOAuthProvider,
  nextSlug,
  providerPanelActionErrorMessage,
  type ConnectionsBridge,
} from './provider-panel-shared';

export function AddProviderForm(props: {
  bridge: ConnectionsBridge;
  providerType: ProviderType;
  existingSlugs: string[];
  onCancel(): void;
  onCreated(slug: string): Promise<void>;
}) {
  const defaults = PROVIDER_DEFAULTS[props.providerType];
  const display = providerDisplay(props.providerType);
  const recommendedDefaultModel = buildCatalogRecommendedDefaultModel(props.providerType);
  const [slug, setSlug] = useState(() => nextSlug(props.providerType, props.existingSlugs));
  const [name, setName] = useState(display.name);
  const [baseUrl, setBaseUrl] = useState(defaults.baseUrl);
  const [defaultModel, setDefaultModel] = useState(recommendedDefaultModel);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const addProviderMountedRef = useRef(false);

  const requiresBaseUrl = !defaults.baseUrl;
  const isExperimental = defaults.status === 'phase3-experimental';
  const isWiredOAuth = isWiredOAuthProvider(props.providerType);

  useEffect(() => {
    addProviderMountedRef.current = true;
    return () => {
      addProviderMountedRef.current = false;
      busyRef.current = false;
    };
  }, []);

  async function submit() {
    if (busyRef.current) return;
    setError(null);
    const slugError = validateSlug(slug);
    if (slugError) return setError(slugError);
    if (props.existingSlugs.includes(slug)) return setError('连接标识已存在');
    if (requiresBaseUrl && !baseUrl.trim()) return setError('这个供应商需要填写服务地址');
    if (isExperimental) {
      return setError(isWiredOAuth
        ? '请到 OAuth 分类完成账号登录；登录成功后会自动创建模型连接。'
        : '该账号登录暂未接入聊天发送；请先使用同一家厂商的模型密钥。');
    }
    busyRef.current = true;
    setBusy(true);
    try {
      const connection = await props.bridge.create({
        slug,
        name: name || display.name,
        providerType: props.providerType,
        baseUrl: baseUrl || undefined,
        defaultModel,
      });
      if (!addProviderMountedRef.current) return;
      await props.onCreated(connection.slug);
    } catch (err) {
      if (addProviderMountedRef.current) setError(providerPanelActionErrorMessage(err));
    } finally {
      busyRef.current = false;
      if (addProviderMountedRef.current) setBusy(false);
    }
  }

  return (
    <div className="providerEditor">
      <header>
        <div>
          <h3>{isExperimental && isWiredOAuth
            ? `${display.name} 通过 OAuth 登录`
            : isExperimental ? '账号登录暂未接入聊天发送' : `添加 ${display.name}`}</h3>
          <p>{display.description}</p>
        </div>
        <span className="settingsBadge">{categoryLabel(defaults.category)}</span>
      </header>
      {isExperimental && (
        <div className="providerUnavailableNotice">
          <strong>{isWiredOAuth ? '使用 OAuth 分类登录' : '账号登录暂未接入'}</strong>
          <span>{isWiredOAuth
            ? '不要在这里手动添加；请回到 OAuth 分类完成登录，Maka 会自动创建并刷新模型连接。'
            : '这类账号登录暂未接入聊天发送。当前请先使用同一家厂商的模型密钥。'}</span>
        </div>
      )}
      <label>
        <span>连接标识</span>
        <Input value={slug} onChange={(event) => setSlug(event.currentTarget.value)} placeholder="my-provider" disabled={isExperimental || busy} aria-label="模型供应商连接标识" />
      </label>
      <label>
        <span>显示名称</span>
        <Input value={name} onChange={(event) => setName(event.currentTarget.value)} placeholder={display.name} disabled={isExperimental || busy} aria-label="模型供应商显示名称" />
      </label>
      <label>
        <span>服务地址 {requiresBaseUrl ? '（必填）' : ''}</span>
        <Input
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.currentTarget.value)}
          placeholder={defaults.baseUrl || 'https://…'}
          disabled={isExperimental || busy}
          aria-label="模型供应商服务地址"
        />
      </label>
      <label>
        <span>默认模型</span>
        <Input
          value={defaultModel}
          onChange={(event) => setDefaultModel(event.currentTarget.value)}
          placeholder={recommendedDefaultModel || 'model-id'}
          disabled={isExperimental || busy}
          aria-label="模型供应商默认模型"
        />
      </label>
      {error && <p className="providerError">{error}</p>}
      <div className="providerActions">
        <Button variant="ghost" type="button" disabled={busy} onClick={props.onCancel}>取消</Button>
        <Button type="button" disabled={busy || isExperimental} onClick={submit}>
          {busy ? '保存中…' : '保存供应商'}
        </Button>
      </div>
    </div>
  );
}
