export const FILE_EDIT_TOOLSETS = ['edit_write', 'apply_patch'] as const;

export type FileEditToolset = (typeof FILE_EDIT_TOOLSETS)[number];

export const DEFAULT_FILE_EDIT_TOOLSET: FileEditToolset = 'edit_write';

export function isFileEditToolset(value: unknown): value is FileEditToolset {
  return typeof value === 'string' && (FILE_EDIT_TOOLSETS as readonly string[]).includes(value);
}

export function resolveFileEditToolset(value: FileEditToolset | undefined): FileEditToolset {
  return value ?? DEFAULT_FILE_EDIT_TOOLSET;
}
