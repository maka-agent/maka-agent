import type { ConnectionTestResult, UpdateConnectionInput } from '@maka/core';

export function connectionTestStatusPatch(
  result: ConnectionTestResult,
  now = new Date(),
): Pick<UpdateConnectionInput, 'lastTestStatus' | 'lastTestAt' | 'lastTestMessage'> {
  if (result.ok) {
    return {
      lastTestStatus: 'verified',
      lastTestAt: now.toISOString(),
      lastTestMessage: 'Connection verified',
    };
  }

  if (result.errorClass === 'auth' || result.statusCode === 401 || result.statusCode === 403) {
    return {
      lastTestStatus: 'needs_reauth',
      lastTestAt: now.toISOString(),
      lastTestMessage: 'Authentication failed',
    };
  }

  return {
    lastTestStatus: 'error',
    lastTestAt: now.toISOString(),
    lastTestMessage: generalizedConnectionErrorMessage(result),
  };
}

function generalizedConnectionErrorMessage(result: ConnectionTestResult): string {
  if (result.errorClass === 'timeout') return 'Request timed out';
  if (result.errorClass === 'provider_unavailable') return 'Provider unavailable';
  if (result.errorClass === 'network') return 'Network error';
  if (result.statusCode && result.statusCode >= 500) return 'Provider unavailable';
  return 'Connection test failed';
}
