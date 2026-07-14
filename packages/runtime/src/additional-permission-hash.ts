import { createHash } from 'node:crypto';
import {
  serializeAdditionalPermissionProfile,
  type AdditionalPermissionProfile,
} from '@maka/core/additional-permissions';

export function hashAdditionalPermissionProfile(
  profile: AdditionalPermissionProfile,
): string {
  const serialized = serializeAdditionalPermissionProfile(profile);
  return `sha256:${createHash('sha256').update(serialized).digest('hex')}`;
}
