import { useEffect, useState } from 'react';
import type { LlmConnection } from '@maka/core';
import { deriveProviderAuthContractFromConnection } from '@maka/core';
import { PROVIDER_DEFAULTS, providerAuthRequiresSecret } from '@maka/core/llm-connections';
import { Button, Chip, RelativeTime, useMountedRef, useToast, useUiLocale } from '@maka/ui';
import {
  deriveAccountAuthActions,
  presentAccountAuthState,
  type AccountAuthActionPresentation,
} from './account-auth-ui';
import {
  connectionUiStatusFromRecord,
  presentConnectionUiStatus,
  type ConnectionUiStatus,
} from '../connection-status';
import { SettingsRows, SettingRow } from './settings-rows';
import { settingsActionErrorMessage } from './settings-error-copy';
import {
  connectionLastTestMessageDisplay,
  connectionTestFailureMessage,
} from './provider-panel-shared';
import { useActionGuard } from './use-action-guard';
import { getSettingsPreferencesCopy } from '../locales/settings-preferences-copy.js';

type AccountSecretProbeStatus = boolean | 'loading' | 'error';
type AccountSecretProbeResult =
  | { slug: string; status: boolean }
  | { slug: string; status: 'error'; message: string };

// Account-page troubleshooting copy is broader than the Models sheet: a
// single list spans API-key and OAuth providers, so auth/recheck guidance
// cannot mention a specific field like the connection-detail sheet does.
export function AccountSettingsPage(props: {
  connections: LlmConnection[];
  defaultSlug: string | null;
  onRefresh(): Promise<void>;
}) {
  const locale = useUiLocale();
  const copy = getSettingsPreferencesCopy(locale).account;
  // Backend (xuan, 5ca1f8a) persists per-connection lastTestStatus. UI
  // derives the display status from `enabled + hasSecret + defaultModel +
  // lastTestStatus + authKind` per @kenji's status-contract priority list,
  // so we never produce mixed labels like "disabled + verified".
  const [secretMap, setSecretMap] = useState<Record<string, AccountSecretProbeStatus>>({});
  const [secretProbeError, setSecretProbeError] = useState<string | null>(null);
  const [testingSlug, setTestingSlug] = useState<string | null>(null);
  const connectionTestGuard = useActionGuard<string>();
  const accountPageMountedRef = useMountedRef();
  const toast = useToast();

  useEffect(() => {
    let cancelled = false;
    void Promise.all<AccountSecretProbeResult>(
      props.connections.map(async (connection) => {
        try {
          const has = await window.maka.connections.hasSecret(connection.slug);
          return { slug: connection.slug, status: has };
        } catch (error) {
          return { slug: connection.slug, status: 'error', message: settingsActionErrorMessage(error, locale) };
        }
      }),
    ).then((entries) => {
      if (cancelled) return;
      setSecretMap(Object.fromEntries(entries.map((entry) => [entry.slug, entry.status])));
      const failure = entries.find(
        (entry): entry is Extract<AccountSecretProbeResult, { status: 'error' }> => entry.status === 'error',
      );
      if (failure) {
        setSecretProbeError(failure.message);
        toast.error(copy.credentialReadFailed, failure.message);
      } else {
        setSecretProbeError(null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [copy.credentialReadFailed, locale, props.connections, toast]);

  async function testConnection(slug: string) {
    if (!connectionTestGuard.begin(slug)) return;
    setTestingSlug(slug);
    try {
      const result = await window.maka.connections.test(slug);
      if (!accountPageMountedRef.current || connectionTestGuard.current !== slug) return;
      if (result.ok) {
        toast.success(copy.verified, copy.latency(result.latencyMs ?? '?', result.modelTested));
      } else {
        toast.error(copy.connectionTestFailed, connectionTestFailureMessage(result, copy.testCopy));
      }
    } catch (error) {
      // Main is supposed to return a structured result; if something escapes
      // to throw form, surface the generalized message anyway.
      if (accountPageMountedRef.current && connectionTestGuard.current === slug) {
        toast.error(copy.testError, settingsActionErrorMessage(error, locale));
      }
    } finally {
      // Pull the freshest lastTestStatus/lastTestAt/lastTestMessage so the
      // row re-renders with the new derived status without a Settings reopen.
      if (accountPageMountedRef.current && connectionTestGuard.current === slug) {
        try {
          await props.onRefresh();
        } catch (error) {
          if (accountPageMountedRef.current && connectionTestGuard.current === slug) {
            toast.error(copy.refreshFailed, settingsActionErrorMessage(error, locale));
          }
        } finally {
          connectionTestGuard.finish();
          if (accountPageMountedRef.current) {
            setTestingSlug(null);
          }
        }
      } else if (connectionTestGuard.current === slug) {
        connectionTestGuard.finish();
      }
    }
  }

  const enabledCount = props.connections.filter((connection) => connection.enabled).length;
  const totalCount = props.connections.length;
  return (
    <div className="settingsStructuredPage">
      <SettingsRows>
        <SettingRow
          title={copy.defaultPermission}
          detail={copy.defaultPermissionDetail}
          value={copy.askPermission}
        />
        <SettingRow
          title={copy.credentialProtection}
          detail={copy.credentialProtectionDetail}
          value={copy.enabled}
        />
        <SettingRow
          title={copy.auditLog}
          detail={copy.auditLogDetail}
          value={copy.local}
        />
      </SettingsRows>

      <h3 className="settingsSubheading">{copy.modelConnections}</h3>
      {secretProbeError && (
        <div className="settingsNotice" role="alert">
          {copy.credentialProbeNotice} {secretProbeError}
        </div>
      )}
      {totalCount === 0 ? (
        <div className="settingsEmptyState">{copy.empty}</div>
      ) : (
        /* PR-CONNECTION-LIST-A11Y-0 (round 17/30): same fix as
           rounds 7 and 16. Was `<div role="list">` containing
           `<div role="listitem">` rows — invalid ARIA layering.
           Semantic `<ul>` / `<li>` so screen readers get the
           relationship from the elements themselves. */
        <ul className="settingsConnectionList" aria-label={copy.connectionList}>
          {props.connections.map((connection) => (
            <li key={connection.slug}>
              <AccountConnectionRow
                connection={connection}
                secretStatus={secretMap[connection.slug] ?? 'loading'}
                isDefault={connection.slug === props.defaultSlug}
                testing={testingSlug === connection.slug}
                canTest={testingSlug === null}
                onTest={() => void testConnection(connection.slug)}
              />
            </li>
          ))}
        </ul>
      )}
      <p className="settingsHelpText">
        {copy.summary(totalCount, enabledCount)}
      </p>

      {/*
        PR-CLAUDE-CARD-MOVE-0 (WAWQAQ msg ddecd729): the Claude
        subscription card was previously rendered here. It now
        lives in 设置 → 模型 (`provider-oauth-section.tsx → ModelOAuthSection`)
        alongside the other OAuth-bound providers (Codex / Cursor
        / Antigravity), because OAuth is a model-side concern and
        the 账户 panel should only carry identity / security state.
      */}
    </div>
  );
}

function AccountConnectionRow(props: {
  connection: LlmConnection;
  secretStatus: AccountSecretProbeStatus;
  isDefault: boolean;
  testing: boolean;
  canTest: boolean;
  onTest(): void;
}) {
  const locale = useUiLocale();
  const copy = getSettingsPreferencesCopy(locale).account;
  const requiresSecret = providerAuthRequiresSecret(props.connection.providerType);
  const secretProbePending = requiresSecret && (props.secretStatus === 'loading' || props.secretStatus === 'error');
  const hasSecretForKnownStatus = props.secretStatus === true;
  const status: ConnectionUiStatus = connectionUiStatusFromRecord(
    props.connection,
    secretProbePending ? true : hasSecretForKnownStatus,
  );
  const presentation = secretProbePending
    ? {
        label: props.secretStatus === 'loading' ? copy.loadingCredential : copy.unknownCredential,
        detail: props.secretStatus === 'loading'
          ? copy.loadingCredentialDetail
          : copy.unknownCredentialDetail,
        tone: props.secretStatus === 'loading' ? 'info' as const : 'warning' as const,
      }
    : presentConnectionUiStatus(status, locale);
  const authContract = secretProbePending
    ? undefined
    : deriveProviderAuthContractFromConnection(props.connection, hasSecretForKnownStatus);
  const authPresentation = authContract
    ? presentAccountAuthState(authContract, locale)
    : {
        label: copy.credentialStateLoading,
        detail: props.secretStatus === 'loading'
          ? copy.credentialStateLoadingDetail
          : copy.credentialStateErrorDetail,
        stateLabel: props.secretStatus === 'loading' ? copy.loading : copy.readFailed,
        tone: props.secretStatus === 'loading' ? 'info' as const : 'warning' as const,
      };
  const authActions = authContract ? deriveAccountAuthActions(authContract, locale) : [];
  const authContractState = authContract?.state ?? (props.secretStatus === 'loading' ? 'loading' : 'error');
  const subtitle = `${props.connection.providerType} · ${props.connection.defaultModel || copy.noDefaultModel}`;
  const lastTestAtMs = props.connection.lastTestAt
    ? Date.parse(props.connection.lastTestAt)
    : NaN;
  const lastTestMessage = connectionLastTestMessageDisplay(props.connection.lastTestMessage);
  return (
    <div
      className="settingsConnectionRow"
      data-status={status}
      data-default={props.isDefault ? 'true' : undefined}
    >
      <div className="settingsConnectionRowHead">
        <div className="settingsConnectionRowText">
          <div className="settingsConnectionRowName">
            <strong>{props.connection.name}</strong>
            {props.isDefault && (
              <span className="settingsConnectionDefaultBadge" aria-label={copy.defaultConnection}>{copy.defaultBadge}</span>
            )}
          </div>
          <small>{subtitle}</small>
        </div>
        <Chip variant={presentation.tone}>
          {presentation.label}
        </Chip>
      </div>
      <p className="settingsConnectionDetail">{presentation.detail}</p>
      <div className="settingsAuthContract" data-state={authContractState}>
        <div className="settingsAuthContractText">
          <strong>{authPresentation.label}</strong>
          <span>{authPresentation.detail}</span>
        </div>
        <span className="settingsAuthContractBadge" data-tone={authPresentation.tone}>
          {authPresentation.stateLabel}
        </span>
      </div>
      {(Number.isFinite(lastTestAtMs) || lastTestMessage) && (
        <p className="settingsConnectionMeta">
          {lastTestMessage && <span>{lastTestMessage}</span>}
          {Number.isFinite(lastTestAtMs) && (
            <RelativeTime ts={lastTestAtMs} className="settingsConnectionMetaTime" />
          )}
        </p>
      )}
      {authActions.length > 0 && (
        <div className="settingsConnectionActions" role="group" aria-label={copy.accountActions(props.connection.name)}>
          {authActions.map((action) => (
            <AccountAuthActionView
              key={action.action}
              action={action}
              disabled={!props.canTest}
              testing={action.action === 'test_credentials' && props.testing}
              onTest={props.onTest}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function AccountAuthActionView(props: {
  action: AccountAuthActionPresentation;
  disabled: boolean;
  testing: boolean;
  onTest(): void;
}) {
  const copy = getSettingsPreferencesCopy(useUiLocale()).account;
  if (props.action.executable && props.action.action === 'test_credentials') {
    return (
      <Button
        type="button"
        data-size="sm"
        size="sm"
        disabled={props.disabled}
        onClick={props.onTest}
        title={props.action.detail}
      >
        {props.testing ? copy.testing : props.action.label}
      </Button>
    );
  }
  // Non-interactive guidance label sitting next to the real 测试凭据 button.
  // Migrated onto the squared Chip primitive (tone→alpha authority); the
  // AccountAuthTone union (neutral/info/success/warning/destructive) maps 1:1
  // to Chip variants. The preview-kind dashed-border affordance stays in CSS.
  return (
    <Chip
      variant={props.action.tone}
      className="settingsAuthActionPill"
      data-kind={props.action.kind}
      data-tone={props.action.tone}
      title={props.action.detail}
    >
      {props.action.label}
    </Chip>
  );
}
