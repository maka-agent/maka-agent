import {
  PROVIDER_AUTH_ACTIONS,
  type ProviderAuthAction,
  type ProviderAuthContract,
  type ProviderAuthState,
  type UiLocale,
} from '@maka/core';
import { getSettingsPreferencesCopy } from '../locales/settings-preferences-copy.js';

export type AccountAuthTone = 'neutral' | 'info' | 'success' | 'warning' | 'destructive';

export interface AccountAuthStatePresentation {
  stateLabel: string;
  label: string;
  detail: string;
  tone: AccountAuthTone;
}

export type AccountAuthActionKind = 'button' | 'guidance' | 'preview';

export interface AccountAuthActionPresentation {
  action: ProviderAuthAction;
  kind: AccountAuthActionKind;
  executable: boolean;
  label: string;
  detail: string;
  tone: AccountAuthTone;
}

const AUTH_STATE_TONE: Record<ProviderAuthState, AccountAuthTone> = {
  disabled: 'neutral',
  not_configured: 'warning',
  configured: 'info',
  validated: 'success',
  needs_reauth: 'warning',
  error: 'destructive',
  preview_only: 'info',
};

export function presentAccountAuthState(
  contract: ProviderAuthContract,
  locale: UiLocale,
): AccountAuthStatePresentation {
  const copy = getSettingsPreferencesCopy(locale).auth;
  const noCredential = contract.setupMode === 'none';
  const oauthValidated = contract.setupMode === 'oauth' && contract.state === 'validated';
  return {
    stateLabel: oauthValidated
      ? copy.oauthValidated
      : copy.stateLabels[contract.state],
    label: noCredential
      ? copy.noCredentialTitle
      : oauthValidated
        ? copy.oauthValidated
        : copy.stateTitles[contract.state],
    detail: noCredential
      ? copy.noCredentialDetail
      : oauthValidated
        ? copy.oauthValidatedDetail
        : copy.stateDetails[contract.state],
    tone: AUTH_STATE_TONE[contract.state],
  };
}

export function deriveAccountAuthActions(
  contract: ProviderAuthContract,
  locale: UiLocale,
): AccountAuthActionPresentation[] {
  const actions: AccountAuthActionPresentation[] = [];
  for (const action of PROVIDER_AUTH_ACTIONS) {
    const availability = contract.actionAvailability[action];
    if (availability === 'hidden') continue;
    if (availability === 'preview_only') {
      actions.push(previewAction(action, locale));
      continue;
    }
    actions.push(availableAction(contract, action, locale));
  }
  return actions;
}

function availableAction(
  contract: ProviderAuthContract,
  action: ProviderAuthAction,
  locale: UiLocale,
): AccountAuthActionPresentation {
  const copy = getSettingsPreferencesCopy(locale).auth;
  switch (action) {
    case 'test_credentials':
      if (contract.setupMode === 'none') {
        return {
          action,
          kind: 'button',
          executable: true,
          ...copy.localProbe,
          tone: 'info',
        };
      }
      return {
        action,
        kind: 'button',
        executable: true,
        ...(contract.setupMode === 'oauth' ? copy.testOauth : copy.testCredentials),
        tone: 'info',
      };
    case 'save_secret':
      return {
        action,
        kind: 'guidance',
        executable: false,
        ...copy.saveSecret,
        tone: 'neutral',
      };
    case 'fetch_models':
      return {
        action,
        kind: 'guidance',
        executable: false,
        label: contract.setupMode === 'none' ? copy.probeModels : copy.fetchModels,
        detail: copy.fetchModelsDetail,
        tone: 'neutral',
      };
    case 'revoke_auth':
      return {
        action,
        kind: 'guidance',
        executable: false,
        label: contract.setupMode === 'oauth' ? copy.signOut : copy.replaceCredential,
        detail: copy.revokeDetail,
        tone: 'neutral',
      };
    case 'start_oauth':
      return {
        action,
        kind: 'guidance',
        executable: false,
        ...copy.loginOauth,
        tone: 'neutral',
      };
    case 'refresh_oauth':
      return {
        action,
        kind: 'guidance',
        executable: false,
        ...copy.refreshOauth,
        tone: 'neutral',
      };
  }
}

function previewAction(action: ProviderAuthAction, locale: UiLocale): AccountAuthActionPresentation {
  const copy = getSettingsPreferencesCopy(locale).auth;
  return {
    action,
    kind: 'preview',
    executable: false,
    label: copy.previewLabels[action],
    detail: copy.previewDetail,
    tone: 'info',
  };
}
