import { createHash } from 'node:crypto';

export const WRITE_FILE_TRANSFORM = {
  id: 'maka.write.utf8',
  version: 1,
} as const;

export const EDIT_FILE_TRANSFORM = {
  id: 'maka.edit.compute_edited_source',
  version: 1,
} as const;

export function fileMutationArgsHash(args: Record<string, string>): string {
  return createHash('sha256').update(JSON.stringify(args), 'utf8').digest('hex');
}
