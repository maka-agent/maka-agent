import type { ToolExecutionFacts } from '@maka/core/permission';
import {
  createExternalPermissionProfile,
  type PermissionProfileExternal,
} from '@maka/core/permission-profile';

import type { RealBackendIsolation } from './isolation.js';

export const EXTERNAL_HEADLESS_EXECUTION_FACTS: ToolExecutionFacts = {
  isolation: 'remote',
  writesAffectHost: false,
  writeBack: 'diff_review',
  network: 'sandbox',
  secrets: 'brokered',
};

export function externalPermissionProfileForIsolation(
  isolation: RealBackendIsolation | undefined,
): PermissionProfileExternal | undefined {
  if (!isolation || isolation.kind !== 'external') return undefined;
  return createExternalPermissionProfile({ kind: 'enabled' });
}
