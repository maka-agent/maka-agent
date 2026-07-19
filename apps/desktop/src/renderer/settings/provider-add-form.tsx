import { useState, type FormEvent } from 'react';
import { PROVIDER_DEFAULTS, validateSlug, type ProviderType } from '@maka/core';
import { providerAuthRequiresSecret, providerAuthSupportsApiKey } from '@maka/core/llm-connections';
import { Button, Chip, Input, useMountedRef, useUiLocale } from '@maka/ui';
import { buildCatalogRecommendedDefaultModel } from '../model-catalog-choices';
import { PasswordInput } from './password-input';
import { providerDisplay } from './provider-display';
import { useActionGuard } from './use-action-guard';
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
  const locale = useUiLocale();
  const defaults = PROVIDER_DEFAULTS[props.providerType];
  const display = providerDisplay(props.providerType, locale);
  const recommendedDefaultModel = buildCatalogRecommendedDefaultModel(props.providerType);
  const [slug, setSlug] = useState(() => nextSlug(props.providerType, props.existingSlugs));
  const [name, setName] = useState(display.name);
  const [baseUrl, setBaseUrl] = useState(defaults.baseUrl);
  const [cloudflareAccountId, setCloudflareAccountId] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submitGuard = useActionGuard<'submit'>();
  const addProviderMountedRef = useMountedRef();

  const isCloudflareWorkersAi = props.providerType === 'cloudflare-workers-ai';
  const requiresBaseUrl = !defaults.baseUrl && !isCloudflareWorkersAi;
  const isExperimental = defaults.status === 'phase3-experimental';
  const isWiredOAuth = isWiredOAuthProvider(props.providerType);
  const supportsApiKey = providerAuthSupportsApiKey(props.providerType);
  const requiresApiKey = providerAuthRequiresSecret(props.providerType) && supportsApiKey;
  const usesApiKeyDialog = usesQuickApiKeyDialog(props.providerType);

  async function submit() {
    if (submitGuard.current !== null) return;
    setError(null);
    const slugError = validateSlug(slug);
    if (slugError) return setError(slugError);
    if (props.existingSlugs.includes(slug)) return setError('连接标识已存在');
    const normalizedApiKey = apiKey.trim();
    if (requiresApiKey && !normalizedApiKey) return setError(`请填写 ${display.name} API Key`);
    const normalizedCloudflareAccountId = cloudflareAccountId.trim();
    if (isCloudflareWorkersAi && !normalizedCloudflareAccountId) {
      return setError('请填写 Cloudflare Account ID');
    }
    if (requiresBaseUrl && !baseUrl.trim()) return setError('这个供应商需要填写服务地址');
    if (isExperimental) {
      return setError(isWiredOAuth
        ? '请到账号连接完成登录；登录成功后会自动创建模型连接。'
        : '该账号登录暂未接入聊天发送；请先使用同一家厂商的模型密钥。');
    }
    submitGuard.begin('submit');
    setBusy(true);
    try {
      const resolvedBaseUrl = isCloudflareWorkersAi
        ? defaults.baseUrlTemplate?.replace(
            '${CLOUDFLARE_ACCOUNT_ID}',
            encodeURIComponent(normalizedCloudflareAccountId),
          )
        : baseUrl || undefined;
      const connection = await props.bridge.create({
        slug,
        name: name || display.name,
        providerType: props.providerType,
        baseUrl: resolvedBaseUrl,
        defaultModel: recommendedDefaultModel,
        ...(normalizedApiKey ? { apiKey: normalizedApiKey } : {}),
      });
      if (!addProviderMountedRef.current) return;
      await props.onCreated(connection.slug);
    } catch (err) {
      if (addProviderMountedRef.current) setError(providerPanelActionErrorMessage(err));
    } finally {
      submitGuard.finish();
      if (addProviderMountedRef.current) setBusy(false);
    }
  }

  function submitApiKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submit();
  }

  if (usesApiKeyDialog) {
    const errorId = `provider-key-dialog-${props.providerType}-error`;
    return (
      <form className="providerKeyDialogForm" onSubmit={submitApiKey}>
        <label>
          <span>API Key</span>
          <PasswordInput
            value={apiKey}
            onChange={(next) => {
              setApiKey(next);
              if (error) setError(null);
            }}
            placeholder="输入或粘贴 API Key"
            ariaLabel="API Key"
            ariaDescribedBy={error ? errorId : undefined}
            disabled={busy}
          />
        </label>
        {error && <p className="providerError" id={errorId} role="alert">{error}</p>}
        <div className="providerKeyDialogActions">
          <Button variant="ghost" type="button" disabled={busy} onClick={props.onCancel}>取消</Button>
          <Button type="submit" disabled={busy}>
            {busy ? '连接中…' : '连接并使用'}
          </Button>
        </div>
      </form>
    );
  }

  return (
    <div className="providerEditor">
      <div className="providerHeaderBadges">
        <Chip variant="neutral" size="sm">{categoryLabel(defaults.category)}</Chip>
      </div>
      {isExperimental && (
        <div className="providerUnavailableNotice">
          <strong>{isWiredOAuth ? '使用账号连接登录' : '账号登录暂未接入'}</strong>
          <span>{isWiredOAuth
            ? '不要在这里手动添加；请回到模型连接页的账号连接完成登录，Maka 会自动创建并刷新模型连接。'
            : '这类账号登录暂未接入聊天发送。当前请先使用同一家厂商的模型密钥。'}</span>
        </div>
      )}
      {supportsApiKey && (
        <label>
          <span>API Key（{requiresApiKey ? '必填' : '可选'}）</span>
          <PasswordInput
            value={apiKey}
            onChange={(next) => {
              setApiKey(next);
              if (error) setError(null);
            }}
            placeholder="输入或粘贴 API Key"
            ariaLabel={`${display.name} API Key`}
            disabled={isExperimental || busy}
          />
        </label>
      )}
      <label>
        <span>连接标识</span>
        <Input value={slug} onChange={(event) => setSlug(event.currentTarget.value)} placeholder="my-provider" disabled={isExperimental || busy} aria-label="模型供应商连接标识" />
      </label>
      <label>
        <span>显示名称</span>
        <Input value={name} onChange={(event) => setName(event.currentTarget.value)} placeholder={display.name} disabled={isExperimental || busy} aria-label="模型供应商显示名称" />
      </label>
      {isCloudflareWorkersAi ? (
        <label>
          <span>Cloudflare Account ID（必填）</span>
          <Input
            value={cloudflareAccountId}
            onChange={(event) => setCloudflareAccountId(event.currentTarget.value)}
            placeholder="填写账户 ID"
            disabled={busy}
            aria-label="Cloudflare 账户 ID"
          />
        </label>
      ) : (
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
      )}
      {error && <p className="providerError" role="alert">{error}</p>}
      <div className="providerActions">
        <Button variant="ghost" type="button" disabled={busy} onClick={props.onCancel}>取消</Button>
        <Button type="button" disabled={busy || isExperimental} onClick={submit}>
          {busy ? '保存中…' : '保存供应商'}
        </Button>
      </div>
    </div>
  );
}

function usesQuickApiKeyDialog(providerType: ProviderType): boolean {
  const defaults = PROVIDER_DEFAULTS[providerType];
  return defaults.authKind === 'api_key' && Boolean(defaults.baseUrl);
}
