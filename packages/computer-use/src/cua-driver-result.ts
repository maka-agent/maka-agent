import {
  COMPUTER_USE_EFFECTS,
  isComputerUseErrorCode,
  type ComputerUseActionOutcome,
  type ComputerUseDispatchEvidence,
  type ComputerUseDispatchTier,
  type ComputerUseEffect,
  type ComputerUseEscalationEvidence,
} from '@maka/core';

export interface JsonRpcToolResult {
  content?: Array<{
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

const effects = new Set<string>(COMPUTER_USE_EFFECTS);

function escalationEvidence(value: unknown): ComputerUseEscalationEvidence | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const escalation = value as Record<string, unknown>;
  if (typeof escalation.recommended !== 'string') return undefined;
  return {
    recommended: escalation.recommended,
    ...(typeof escalation.reason === 'string' ? { reason: escalation.reason } : {}),
  };
}

function dispatchEvidence(
  structuredContent: Record<string, unknown> | undefined,
): ComputerUseDispatchEvidence | undefined {
  if (!structuredContent) return undefined;

  const path = typeof structuredContent.path === 'string'
    ? structuredContent.path
    : undefined;
  const effect = typeof structuredContent.effect === 'string'
    && effects.has(structuredContent.effect)
    ? structuredContent.effect as ComputerUseEffect
    : undefined;
  const escalation = escalationEvidence(structuredContent.escalation);

  if (path === undefined && effect === undefined && escalation === undefined) {
    return undefined;
  }
  return {
    ...(path !== undefined ? { path } : {}),
    ...(effect !== undefined ? { effect } : {}),
    ...(escalation !== undefined ? { escalation } : {}),
  };
}

function dispatchTier(path: string | undefined): ComputerUseDispatchTier {
  if (path?.endsWith('_fg')) return 'foreground-visible';
  if (path === 'ax') return 'ax';
  return 'coordinate-background';
}

function verification(
  structuredContent: Record<string, unknown> | undefined,
  effect: ComputerUseEffect | undefined,
): boolean | undefined {
  if (typeof structuredContent?.verified === 'boolean') {
    return structuredContent.verified;
  }
  if (effect === 'confirmed') return true;
  if (effect === 'unverifiable' || effect === 'suspected_noop') return false;
  return undefined;
}

function resultText(result: JsonRpcToolResult | undefined, fallback: string): string {
  return result?.content?.find(
    (content): content is typeof content & { text: string } =>
      content.type === 'text' && typeof content.text === 'string',
  )?.text ?? fallback;
}

export function normalizeCuaDriverOutcome(
  result: JsonRpcToolResult | undefined,
): ComputerUseActionOutcome {
  if (!result) {
    return {
      ok: false,
      error: 'capture_failed',
      message: 'cua-driver returned no result',
    };
  }

  const structuredContent = result.structuredContent;
  const evidence = dispatchEvidence(structuredContent);

  if (result.isError) {
    const rawError = structuredContent?.error;
    return {
      ok: false,
      error: isComputerUseErrorCode(rawError) ? rawError : 'capture_failed',
      message: resultText(result, 'cua-driver reported an error'),
      ...(evidence ? { evidence } : {}),
    };
  }

  if (evidence?.effect === 'suspected_noop') {
    return {
      ok: false,
      error: 'capture_failed',
      message: resultText(result, 'cua-driver reported a suspected no-op'),
      evidence,
    };
  }

  if (dispatchTier(evidence?.path) === 'foreground-visible') {
    return {
      ok: false,
      error: 'unsupported_action',
      message: 'cua-driver used a foreground-visible dispatch path that Maka does not permit',
      ...(evidence ? { evidence } : {}),
    };
  }

  return {
    ok: true,
    tier: dispatchTier(evidence?.path),
    verified: verification(structuredContent, evidence?.effect),
    ...(evidence ? { evidence } : {}),
  };
}
