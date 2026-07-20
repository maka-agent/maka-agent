export const COLLABORATION_MODES = ['agent', 'plan'] as const;

export type CollaborationMode = (typeof COLLABORATION_MODES)[number];

export function isCollaborationMode(value: unknown): value is CollaborationMode {
  return typeof value === 'string' && (COLLABORATION_MODES as readonly string[]).includes(value);
}
